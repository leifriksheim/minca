/**
 * @module node-hosting
 * The hosts a node reaches: those the account pays for, those a space pays
 * for itself, and the sockets every space holds to them.
 *
 * A host is a carrier the account pays for. The subscription key lives in
 * the registry (`sys.hosting`), so every device signs as the same
 * subscription, and any of them hands the host the carry space once it is
 * paid — the one that paid, or the next one to notice.
 */
import { MAX_INVITE_NODES } from '../space/invite-link.js';
import { KEY_CHANGE, MEMBER_REMOVE } from '../space/grants.js';
import { makePass, type SpacePass } from '../space/pass.js';
import {
  connectorOffers,
  createHostClient,
  createSpaceHostClient,
  describeHost,
  hostPeerAddress,
  HOSTING_COLLECTION,
  HostError,
  newSubscriptionSeed,
  readStatus,
  subscriptionKey,
  type HostClient,
  type HostDescription,
  type Hosting,
  type HostStatus,
  type OverSpace,
  type SignedStatus,
} from '../session/hosting.js';
import { base64UrlDecode, base64UrlEncode } from '../utils/encoding.js';
import { isRecord } from '../utils/guards.js';
import { hashedKey } from '../utils/hash.js';
import type { SpaceRuntime } from './space-runtime.js';
import type {
  HostingView,
  NodeCarriers,
  NodeHosting,
  NodeRecord,
  NodeSpaces,
  SpaceHostingView,
} from './types.js';
import type { CarrierEntry } from './node-carriers.js';
import {
  attempt,
  cached,
  checkAddress,
  errorText,
  sameJson,
  sleep,
  type NodeContext,
} from './node-context.js';

interface HostingNeeds {
  readonly spaces: NodeSpaces;
  /** A host is a carrier: it is added as one once paid, and removed as one when stopped */
  readonly carriers: NodeCarriers;
  readonly liveCarriers: () => Promise<ReadonlyArray<CarrierEntry>>;
}

/** Last time each host was handed the spaces, or refused them — so asking again waits a while */
const HAND_AGAIN_MS = 60_000;
/** How long a space waits before asking its hosts again when nothing it names changed */
const SPACE_HOSTS_EVERY_MS = 10 * 60_000;

export function createNodeHosting(ctx: NodeContext, needs: HostingNeeds) {
  const { config, provider, registry, runtimes } = ctx;
  const { spaces, carriers } = needs;

  // ─── The account's hosts ───────────────────────────────────────────

  const hostingKey = (url: string) => hashedKey('hosting', url);

  /** The hosting records the account wrote, live */
  async function hostingRecords(): Promise<ReadonlyArray<Hosting>> {
    const records = await ctx.accountRecords<Hosting>(
      { collection: HOSTING_COLLECTION },
      (record) => typeof record.body?.url === 'string' && typeof record.body.seed === 'string',
    );
    return records.map((record) => record.body!);
  }

  async function hostClient(hosting: Hosting): Promise<{ client: HostClient; subscription: string }> {
    const key = await subscriptionKey(base64UrlDecode(hosting.seed), provider);
    return { client: createHostClient(hosting.url, hosting.host, key, provider), subscription: key.did };
  }

  /** What the host at a known address says about itself — refused when it's another host now */
  async function describeKnown(hosting: Hosting): Promise<HostDescription> {
    const description = await describeHost(hosting.url);
    if (description.did !== hosting.host)
      throw new Error("The host at this address has another key now, so it's another host");
    return description;
  }

  const handedAt = new Map<string, number>();
  /** Handovers under way, so a second look waits for the first instead of reporting the spaces not carried */
  const handing = new Map<string, Promise<{ status: HostStatus; receipt: SignedStatus }>>();

  /**
   * Keeps what the host signed in the registry, so every device shows it and
   * the person holds the host's word — written only when what it says changed.
   */
  async function keepReceipt(
    hosting: Hosting,
    kept: HostStatus | null,
    status: HostStatus,
    receipt: SignedStatus,
    description: HostDescription,
  ): Promise<void> {
    if (ctx.narrowNote || !ctx.accountSpaceId) return;
    const { name } = description;
    const peer = hostPeerAddress(hosting.url, description) ?? undefined;
    if (kept && sameStatus(kept, status) && hosting.name === name && hosting.peer === peer) return;
    const { peer: _before, ...rest } = hosting;
    const record: Hosting = { ...rest, name, receipt, ...(peer ? { peer } : {}) };
    const registryRt = await ctx.runtime(ctx.accountSpaceId);
    await registryRt.upsertSystem<Hosting>(HOSTING_COLLECTION, await hostingKey(hosting.url), record);
  }

  /** Asks a host how it stands, and hands it the spaces if it is paid for but not carrying them */
  async function viewHosting(hosting: Hosting, force = false): Promise<HostingView> {
    const { client, subscription } = await hostClient(hosting);
    const kept = hosting.receipt ? await readStatus(hosting.receipt, hosting.host, provider) : null;
    const base = { url: hosting.url, host: hosting.host, subscription, since: hosting.since };
    try {
      const description = await describeKnown(hosting);
      const { status, receipt } = await handOverIfDue(hosting, client, description, force);
      await keepReceipt(hosting, kept, status, receipt, description);
      const live = { status, live: true, fund: fundOf(description), reminds: description.remind === true };
      return { ...base, name: description.name, ...live };
    } catch (error) {
      const name = hosting.name ?? new URL(hosting.url).host;
      return {
        ...base,
        name,
        status: kept,
        live: false,
        fund: null,
        reminds: false,
        error: errorText(error),
      };
    }
  }

  /** How a host stands, after handing it the spaces if it is paid for but not carrying them */
  async function handOverIfDue(
    hosting: Hosting,
    client: HostClient,
    description: HostDescription,
    force: boolean,
  ): Promise<{ status: HostStatus; receipt: SignedStatus }> {
    const told = await client.status();
    if (told.status.carrying) return told;
    // Another look is handing the spaces over now: wait for it, rather than answer "not carrying".
    const inFlight = handing.get(hosting.url);
    if (inFlight) return (await inFlight.catch(() => null)) ?? told;
    const due = force || Date.now() - (handedAt.get(hosting.url) ?? 0) > HAND_AGAIN_MS;
    if (!accountPaid(told.status, description) || !due || ctx.narrowNote) return told;
    handedAt.set(hosting.url, Date.now());
    const attaching = carriers
      .add({ did: hosting.host, name: new URL(hosting.url).host })
      .then(({ invite }) => client.attach(config.signer.did, invite));
    handing.set(hosting.url, attaching);
    try {
      return await attaching;
    } catch (error) {
      // Not paid after all (it lapsed in between): the status says so.
      if (error instanceof HostError && error.status === 402) return told;
      throw error;
    } finally {
      handing.delete(hosting.url);
    }
  }

  /** Every device keeps its hosts carrying: after the registry changes, ask each once more */
  async function keepHosted(): Promise<void> {
    if (ctx.narrowNote) return;
    for (const hosting of await hostingRecords()) await viewHosting(hosting).catch(() => {});
  }

  async function requireHosting(url: string): Promise<Hosting> {
    const found = (await hostingRecords()).find((hosting) => hosting.url === url);
    if (!found) throw new Error(`This account doesn't use the host at ${url}`);
    return found;
  }

  // ─── A space paying for itself ─────────────────────────────────────
  //
  // A space names the hosts it pays in `std.host` records, which only those
  // who may manage it write. Any member's device holding the space key hands
  // such a host the space's pass once someone has paid there, and again when
  // the space's key changes, so the host carries it without reading it.

  /** When each space last asked its hosts, and what it named then: asked again after a while, or when that changed */
  const spaceHostsAsked = new Map<string, { at: number; named: string }>();

  async function namedHosts(spaceId: string): Promise<ReadonlyArray<NamedHost>> {
    const rt = await ctx.runtime(spaceId);
    // Only where the space keeps hosts: listing a collection makes a space held in part hold it.
    if (!(await rt.collections()).some((c) => c.name === 'std.host' && c.version !== null)) return [];
    const records = await rt.list<unknown>({ collection: 'std.host' });
    return records.map(namedHostOf).filter((host) => host !== null);
  }

  async function askSpaceHost(spaceId: string, named: NamedHost, hand: boolean): Promise<SpaceHostingView> {
    try {
      const { client, description } = await reachNamedHost(named);
      let { status } = await client.status(spaceId);
      const record = hand && spacePaid(status, description) ? await ctx.findRecord(spaceId) : null;
      if (record && (record.space.visibility === 'public' || record.key)) {
        const pass = await makePass(record);
        if (!status.carrying || (pass.read && status.readKey !== currentReadKey(pass)))
          ({ status } = await client.hand(spaceId, pass));
      }
      const runsBots = description.bots === true;
      return {
        url: named.url,
        name: named.name ?? description.name,
        host: description.did,
        status,
        free: description.free === true,
        fund: fundOf(description),
        reminds: description.remind === true,
        runsBots,
        bots: status.bots ?? [],
        connectors: runsBots ? connectorOffers(description.connectors) : [],
      };
    } catch (error) {
      const name = named.name ?? new URL(named.url).hostname;
      return { url: named.url, name, ...UNREACHED_HOST, error: errorText(error) };
    }
  }

  /** A client for a host a space names, checked to be the host it chose */
  async function reachNamedHost(named: NamedHost) {
    const description = await describeHost(named.url);
    // A host whose key changed since the space chose it is not the host it chose.
    if (named.did && named.did !== description.did) throw new Error('The host’s key changed');
    return { description, client: createSpaceHostClient(named.url, description.did, provider) };
  }

  async function requireNamedHost(spaceId: string, url: string): Promise<NamedHost> {
    const named = (await namedHosts(spaceId)).find((known) => known.url === url);
    if (!named) throw new Error('This space doesn’t use the host at that address');
    return named;
  }

  const spaceHostClient = async (spaceId: string, url: string) =>
    (await reachNamedHost(await requireNamedHost(spaceId, url))).client;

  /** Hands the hosts a space names its pass, when they were paid and don't carry it with its key yet */
  async function keepSpaceHosts(spaceId: string): Promise<void> {
    // Only while it is open: a change heard as it closed must not open it again.
    if ((await ctx.kindOf(spaceId)) || !runtimes.has(spaceId)) return;
    const hosts = await namedHosts(spaceId);
    await reachHosts(spaceId, hosts);
    if (ctx.narrowNote) return;
    const named = hosts.map((h) => h.url).join(' ');
    const asked = spaceHostsAsked.get(spaceId);
    if (!hosts.length || (asked?.named === named && Date.now() - asked.at < SPACE_HOSTS_EVERY_MS)) return;
    spaceHostsAsked.set(spaceId, { at: Date.now(), named });
    for (const known of hosts) await askSpaceHost(spaceId, known, true);
  }

  // ─── Reaching hosts ────────────────────────────────────────────────
  //
  // A host is reached over its socket, at the address its description names
  // (`peer`). Every space holds one to each host the account uses, as the
  // account's carry space names them all; a space also holds one to each host
  // it pays itself (`std.host`). The account registry also tries the hosts
  // the node was built with (`network.hosts`), so a new device with only the
  // recovery code finds its registry there, and every space from it.

  const describedPeers = new Map<string, Promise<string | null>>();
  /** A host's socket address, as its description said: asked once, and again after a failure */
  function describedPeer(url: string): Promise<string | null> {
    const describe = async () => {
      const description = await describeHost(url);
      return pinnedTo(hostPeerAddress(url, description), description.did);
    };
    return cached(describedPeers, url, describe).catch(() => null);
  }

  /**
   * A host's socket address: the one written down with it, or its
   * description's. Pinned to the key written down with it when there is one,
   * else the key it described itself with, so another node answering there is refused.
   */
  async function peerOf(host: HostAddress): Promise<string | null> {
    const address =
      (host.peer ? hostPeerAddress(host.url, { peer: host.peer }) : null) ?? (await describedPeer(host.url));
    return pinnedTo(address, host.host ?? host.did);
  }

  /** What each space was last told to reach, so nothing reconnects when nothing changed */
  const reaching = new Map<string, string>();

  /** Gives a space's runtime the hosts to hold sockets to: the account's, and those it pays itself */
  async function reachHosts(spaceId: string, spaceHosts?: ReadonlyArray<HostAddress>): Promise<void> {
    if (!config.network) return;
    const open = runtimes.get(spaceId);
    if (!open) return;
    const hosts: HostAddress[] = [...(await hostingRecords())];
    if (spaceId === ctx.accountSpaceId) hosts.push(...(config.network.hosts ?? []).map((url) => ({ url })));
    // Asked only while it is still open: asking would open it again.
    if (!(await ctx.kindOf(spaceId)) && runtimes.get(spaceId) === open)
      hosts.push(...(spaceHosts ?? (await namedHosts(spaceId))));
    const invited = await invitedNodes(spaceId, open);
    const found = [...(await Promise.all(hosts.map(peerOf))), ...invited].filter((peer) => peer !== null);
    const peers = [...new Set(found)].sort();
    const said = peers.join(' ');
    if (reaching.get(spaceId) === said || runtimes.get(spaceId) !== open) return;
    reaching.set(spaceId, said);
    (await open).useNodes(peers);
  }

  /**
   * The nodes the invite that brought this node here named: the inviter's hosts, reached before the
   * space's records are. Once the space names keepers, only those: an invite is unauthenticated.
   */
  async function invitedNodes(spaceId: string, open: Promise<SpaceRuntime>): Promise<string[]> {
    const named = (await registry.get(spaceId))?.nodes ?? [];
    if (named.length === 0) return [];
    const access = await (await open).access().catch(() => null);
    const keepers = new Set((access?.keepers ?? []).map((keeper) => keeper.did));
    return named.filter((node) => keepers.size === 0 || keepers.has(nodeDid(node)));
  }

  /**
   * The always-on nodes an invite names, so a joiner reaches one with nobody
   * else online: the account's hosts, the space's own, and those the invite
   * that brought this node here named. A host that can't be described in a
   * few seconds is left out rather than holding the invite up.
   */
  async function nodesOf(spaceId: string): Promise<ReadonlyArray<string>> {
    if (!config.network) return [];
    const hosts: HostAddress[] = [
      ...(await hostingRecords()),
      ...((await ctx.kindOf(spaceId)) ? [] : await namedHosts(spaceId).catch(() => [])),
    ];
    const inTime = (host: HostAddress) =>
      Promise.race([peerOf(host).catch(() => null), sleep(3000).then(() => null)]);
    // Not the nodes an invite gave this node: nothing vouches for them, so they are never passed on.
    const peers = await Promise.all(hosts.map(inTime));
    const pinned = peers.filter((peer): peer is string => peer !== null && peer.includes('#did:key:'));
    return [...new Set(pinned)].slice(0, MAX_INVITE_NODES);
  }

  // ─── The API ───────────────────────────────────────────────────────

  const hosting = Object.freeze<NodeHosting>({
    async space(spaceId) {
      const hand = !ctx.narrowNote;
      const views = await Promise.all(
        (await namedHosts(spaceId)).map((known) => askSpaceHost(spaceId, known, hand)),
      );
      if (hand) spaceHostsAsked.set(spaceId, { at: Date.now(), named: views.map((v) => v.url).join(' ') });
      return views;
    },

    async list() {
      return Promise.all((await hostingRecords()).map((known) => viewHosting(known)));
    },

    async over(spaceId) {
      const found: Array<{ url: string; name: string; over: OverSpace }> = [];
      for (const hosting of await hostingRecords()) {
        const status = hosting.receipt ? await readStatus(hosting.receipt, hosting.host, provider) : null;
        const over = status?.over?.find((one) => one.space === spaceId);
        if (over) found.push({ url: hosting.url, name: hosting.name ?? new URL(hosting.url).host, over });
      }
      return found;
    },

    async use(address) {
      const registryRt = await ctx.requireAccount('Using a host');
      const base = checkAddress(address, 'A host').origin;
      const known = (await hostingRecords()).find((existing) => existing.url === base);
      if (known) return viewHosting(known, true);
      const description = await describeHost(base);
      const peer = hostPeerAddress(base, description);
      const record: Hosting = {
        url: base,
        host: description.did,
        name: description.name,
        ...(peer ? { peer } : {}),
        seed: base64UrlEncode(newSubscriptionSeed()),
        since: new Date().toISOString(),
      };
      await registryRt.upsertSystem<Hosting>(HOSTING_COLLECTION, await hostingKey(base), record);
      return viewHosting(record, true);
    },

    async pay(url, payment) {
      return (await hostClient(await requireHosting(url))).client.pay(payment);
    },

    async remind(url, email) {
      await (await hostClient(await requireHosting(url))).client.remind(email);
    },

    async payForSpace(spaceId, url, payment) {
      return (await spaceHostClient(spaceId, url)).pay(spaceId, payment);
    },

    async remindForSpace(spaceId, url, email) {
      await (await spaceHostClient(spaceId, url)).remind(spaceId, email);
    },

    async stopForSpace(spaceId, url) {
      const named = await requireNamedHost(spaceId, url);
      // Which bots are the host's is its own word, signed: asked before it is let go.
      const view = await askSpaceHost(spaceId, named, false);
      // Un-named first, so no device hands it the key that follows.
      const rt = await ctx.runtime(spaceId);
      for (const record of await rt.list<unknown>({ collection: 'std.host' })) {
        const body = record.body;
        if (record.deleted || !isRecord(body) || typeof body.url !== 'string') continue;
        const address = body.url;
        if (attempt(() => new URL(address).origin) === url) await rt.remove(record.key);
      }
      const access = await spaces.access(spaceId);
      const members = new Map(access.members.map((member) => [member.did, member.roles]));
      const bots: string[] = [];
      for (const bot of view.bots.map((one) => one.bot)) {
        const roles = members.get(bot);
        if (roles && (await spaces.may(spaceId, MEMBER_REMOVE, { self: false, roles }))) bots.push(bot);
      }
      if (bots.length === 0 && !(await spaces.may(spaceId, KEY_CHANGE))) return { bots: [], newKey: false };
      for (const bot of bots) await spaces.removeMember(spaceId, bot);
      // A host that can't say whether it holds a pass is taken to hold one.
      const handed = view.status ? view.status.carrying : true;
      const newKey = access.key !== null && (bots.length > 0 || handed);
      // Removing a member changes the key by itself; with none removed it is changed here.
      if (newKey && bots.length === 0) await spaces.changeKey(spaceId);
      return { bots, newKey };
    },

    async startBot(spaceId, url, bot) {
      const client = await spaceHostClient(spaceId, url);
      const invite = await spaces.invite(spaceId, bot.role ? { role: bot.role } : {});
      const { bot: did, status } = await client.startBot(spaceId, bot.name, invite);
      return { bot: did, status };
    },

    async stop(url) {
      const registryRt = await ctx.requireAccount('Stopping a host');
      const known = await requireHosting(url);
      const { client } = await hostClient(known);
      await client.detach().catch(() => {});
      const carrier = (await needs.liveCarriers()).find(({ body }) => body.did === known.host);
      if (carrier) await carriers.remove(carrier.carry.space.id);
      await registryRt.removeSystem(await hostingKey(known.url));
    },
  });

  return Object.freeze({
    hosting,
    nodesOf,
    keepHosted,
    keepSpaceHosts,
    reachHosts,
    /** Forgets what a closed space was told to reach, so it is told again when it opens */
    forgetReach: (spaceId: string) => void reaching.delete(spaceId),
  });
}

/** Where a host is, and the key it is pinned to when one was written down */
interface HostAddress {
  readonly url: string;
  readonly peer?: string;
  readonly host?: string;
  readonly did?: string;
}

/** A host a space names in a `std.host` record */
interface NamedHost {
  readonly url: string;
  readonly did?: string;
  readonly name?: string;
}

/** A node address pinned to a key (spec 04 §5.2); one without a key to pin stays as it is */
function pinnedTo(address: string | null, did: string | undefined): string | null {
  return address && did?.startsWith('did:key:') ? `${address.split('#')[0]}#${did}` : address;
}

/** The DID a node address is pinned to, or '' */
const nodeDid = (node: string) => decodeURIComponent(node.split('#')[1] ?? '');

/** The read key a space is carried with now, as a DID: what a host should hold */
const currentReadKey = (pass: SpacePass): string | undefined => pass.readKey ?? pass.space.readKey;

/** A `std.host` record's host, when its address is one a device may reach */
function namedHostOf(record: NodeRecord<unknown>): NamedHost | null {
  const body = record.body;
  if (!record.verified || record.deleted || !isRecord(body) || typeof body.url !== 'string') return null;
  const address = body.url;
  const url = attempt(() => checkAddress(address, 'A host').origin);
  if (!url) return null;
  return {
    url,
    ...(typeof body.did === 'string' ? { did: body.did } : {}),
    ...(typeof body.name === 'string' ? { name: body.name } : {}),
  };
}

interface PaidState {
  readonly state: string;
}

/** Paid, or on the host's free plan: a host with limits keeps an account's spaces with nothing paid */
function accountPaid(status: PaidState, description: HostDescription): boolean {
  const free = description.free || description.limits !== undefined;
  return status.state === 'active' || status.state === 'grace' || (free && status.state !== 'lapsed');
}

/** Paid, or at a free host that hasn't let it lapse */
function spacePaid(status: PaidState, description: HostDescription): boolean {
  return (
    status.state === 'active' || status.state === 'grace' || (description.free && status.state !== 'lapsed')
  );
}

const fundOf = (description: HostDescription) => (description.free ? null : (description.fund ?? null));

function sameStatus(a: HostStatus, b: HostStatus): boolean {
  return (
    a.state === b.state &&
    a.paidUntil === b.paidUntil &&
    a.renews === b.renews &&
    a.plan === b.plan &&
    sameJson(a.over ?? [], b.over ?? [])
  );
}

/** What a space host's view says when the host can't be reached */
const UNREACHED_HOST = {
  host: null,
  status: null,
  free: false,
  fund: null,
  reminds: false,
  runsBots: false,
  bots: [],
  connectors: [],
} as const;
