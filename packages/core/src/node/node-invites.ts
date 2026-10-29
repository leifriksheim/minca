/**
 * @module node-invites
 * A node's invites: the long invite to a space, the short link that seals
 * one in mailboxes (spec 03 §7.7), the links the account keeps alive, and
 * reading either kind back.
 *
 * The link holds a secret and the hash of one sealed invite; the invite
 * sits in mailboxes: the account's host's first, which keeps it while every
 * device is away, then the relays where the space's members meet.
 */
import {
  bareInvite,
  parseSpaceInvite,
  type InviteLinkOptions,
  type SpaceRecord,
} from '../space/space-manager.js';
import { MAX_RELAYS } from '../space/roles.js';
import { usableRelays } from './space-runtime.js';
import { deriveInviteKey } from '../space/space-access.js';
import {
  encodeInviteLink,
  inviteLinkKeys,
  isShortInvite,
  linkInviteSecret,
  linkTopic,
  MAX_LINK_PLACES,
  openInvite,
  parseInviteLink,
  pinOf,
  relayOfNode,
  sealInvite,
} from '../space/invite-link.js';
import { readInvitation, writeInvitation } from '../space/invitation.js';
import { isKeptLink, LINK_COLLECTION, type KeptLink } from '../space/account-registry.js';
import { base64UrlDecode, bytesToHex, hexToBytes } from '../utils/encoding.js';
import { unref } from '../utils/guards.js';
import { serial } from '../utils/serial.js';
import { cached, inBackground, sleep, type NodeContext } from './node-context.js';

/** The long invite a text names, and when its inviter stops sharing it */
interface Resolved {
  readonly long: string;
  readonly until?: number;
}

interface InvitesNeeds {
  /** The always-on nodes an invite to the space names */
  readonly nodesOf: (spaceId: string) => Promise<ReadonlyArray<string>>;
  /** Hands every carrier the account's passes, kept links among them */
  readonly passAll: () => Promise<void>;
}

export function createNodeInvites(ctx: NodeContext, needs: InvitesNeeds) {
  const { config, provider, registry, mailbox } = ctx;

  /**
   * An invite to a space, naming where its members meet: the relays the space
   * names, or before it names any, this node's — so the joiner finds the
   * inviter even when their app uses other relays.
   */
  async function inviteTo(spaceId: string, options: InviteLinkOptions = {}): Promise<string> {
    const named = (await ctx.findRecord(spaceId))?.relays ?? [];
    const own = usableRelays(config.network).slice(0, MAX_RELAYS);
    const nodes = await needs.nodesOf(spaceId);
    return registry.createInvite(spaceId, ctx.looseSigner(), {
      ...options,
      ...(named.length ? {} : own.length ? { relays: own } : {}),
      ...(nodes.length ? { nodes } : {}),
    });
  }

  /** Where a link's sealed invite is left: its nodes' relays, then the space's or this node's */
  async function linkPlaces(spaceId: string, nodes: ReadonlyArray<string>): Promise<ReadonlyArray<string>> {
    const named = (await ctx.findRecord(spaceId))?.relays ?? [];
    const relays = named.length ? named : usableRelays(config.network).slice(0, MAX_RELAYS);
    return [...new Set([...nodes.map(relayOfNode), ...relays])];
  }

  /**
   * A short link to a space: the invite `inviteTo` would give, sealed under a
   * fresh secret and left in mailboxes. Where none takes it, or it is too large
   * for one, the long invite is given instead: it works the same.
   */
  async function shortInvite(
    spaceId: string,
    secret: Uint8Array,
    options: InviteLinkOptions,
    until: number | undefined,
  ): Promise<string> {
    const long = await inviteTo(spaceId, options);
    // The invitation as signed: its secret is the link's to give.
    const invite = parseSpaceInvite(long);
    const sealed = await sealInvite(secret, {
      invite: invite.signed,
      ...(until !== undefined ? { until } : {}),
    }).catch(() => null);
    if (!sealed) return long;
    const nodes = invite.nodes ?? [];
    const ttl = until !== undefined ? Math.max(60, Math.ceil((until - Date.now()) / 1000)) : undefined;
    const places = await linkPlaces(spaceId, nodes);
    const kept = await dropAt(places, await linkTopic(sealed.pin), sealed.blob, ttl);
    if (kept.length === 0) return long;
    await keepLink(spaceId, sealed, options, until);
    // A host first, which keeps it; then a relay, so one going away leaves the other.
    const hosts = new Set(nodes.map(relayOfNode));
    const named = [kept.find((place) => hosts.has(place)), kept.find((place) => !hosts.has(place))];
    const linked = named.filter((place) => place !== undefined);
    return encodeInviteLink({ secret, pin: sealed.pin, places: linked.slice(0, MAX_LINK_PLACES) });
  }

  /** Leaves a blob at each place; the places that took it */
  async function dropAt(
    places: ReadonlyArray<string>,
    topic: string,
    blob: string,
    ttl: number | undefined,
  ): Promise<string[]> {
    const drop = (place: string) =>
      mailbox.drop(place, topic, blob, ttl).then(
        () => place,
        () => null,
      );
    const taken = await Promise.all(places.map(drop));
    return taken.filter((place) => place !== null);
  }

  /** The links the account keeps, as its registry holds them */
  async function keptLinks(): Promise<ReadonlyArray<{ readonly key: string; readonly body: KeptLink }>> {
    if (ctx.narrowNote) return [];
    const records = await ctx.accountRecords<KeptLink>(
      { collection: LINK_COLLECTION },
      (record) => record.key.startsWith('link:') && isKeptLink(record.body),
    );
    return records.map((record) => ({ key: record.key, body: record.body! }));
  }

  /**
   * Keeps a short link's sealed invite in the account registry: what it is
   * for, never its secret. Every device then drops it again while it lasts,
   * and closes its invite when it ends; carriers serve it meanwhile.
   */
  async function keepLink(
    spaceId: string,
    sealed: { readonly blob: string; readonly pin: Uint8Array },
    options: InviteLinkOptions,
    until: number | undefined,
  ): Promise<void> {
    if (!ctx.accountSpaceId || ctx.narrowNote) return;
    const record = await ctx.findRecord(spaceId);
    const body: KeptLink = {
      space: spaceId,
      blob: sealed.blob,
      ...(options.secret ? { invite: (await deriveInviteKey(options.secret, provider)).did } : {}),
      ...(record?.key ? { keyId: record.key.id } : {}),
      ...(until !== undefined ? { until } : {}),
    };
    const registryRt = await ctx.runtime(ctx.accountSpaceId);
    await registryRt.upsertSystem(LINK_COLLECTION, `link:${bytesToHex(sealed.pin)}`, body);
    inBackground(needs.passAll());
  }

  /** Stops keeping the links `which` picks */
  async function forgetLinks(which: (link: KeptLink) => boolean): Promise<void> {
    if (!ctx.accountSpaceId || ctx.narrowNote) return;
    const registryRt = await ctx.runtime(ctx.accountSpaceId);
    let forgot = false;
    for (const { key, body } of await keptLinks())
      if (which(body)) {
        await registryRt.removeSystem(key);
        forgot = true;
      }
    if (forgot) inBackground(needs.passAll());
  }

  /**
   * Looks after every link the account keeps. One past its `until`, for a
   * space this device no longer holds, or carrying a key the space has moved
   * on from, has ended: its role invite is closed, so nobody holding the
   * space's current key can still join with it, and it is forgotten. The
   * rest are dropped again where the space's members meet; a relay already
   * holding one stores nothing new.
   */
  const keepLinks = serial(async () => {
    for (const { key, body } of await keptLinks()) {
      if (ctx.isClosed()) return;
      const record = await registry.get(body.space);
      // Ended only on what this device knows: one not holding the space yet would end a link
      // another device of the account just made.
      if (!record) continue;
      if (linkEnded(body, record)) {
        if (body.invite) await closeIfOpen(body.space, body.invite).catch(() => {});
        await forgetLinks((link) => link.blob === body.blob);
        continue;
      }
      const topic = await linkTopic(hexToBytes(key.slice('link:'.length)));
      const ttl = body.until !== undefined ? Math.ceil((body.until - Date.now()) / 1000) : undefined;
      for (const place of await linkPlaces(body.space, []))
        inBackground(mailbox.drop(place, topic, body.blob, ttl));
    }
  });

  /** Closes an invite unless it is closed already, or this account may not */
  async function closeIfOpen(spaceId: string, inviteDid: string): Promise<void> {
    const rt = await ctx.runtime(spaceId);
    const invite = (await rt.access()).invites.find((held) => held.key === inviteDid);
    if (invite?.open) await rt.closeInvite(inviteDid);
  }

  // Relays forget after two weeks or a restart: every hour, whatever is gone goes back.
  const linkTimer = setInterval(() => void keepLinks().catch(() => {}), 60 * 60 * 1000);
  unref(linkTimer);

  /** A short link's invite, fetched once and kept: a preview and the join that follows ask once */
  const resolved = new Map<string, Promise<Resolved>>();

  /** The long invite a text holds or a short link names, and when its inviter stops sharing it */
  function resolveInvite(text: string): Promise<Resolved> {
    const bare = bareInvite(text);
    if (!isShortInvite(bare)) return Promise.resolve({ long: bare });
    // A few links are remembered, not every one ever read.
    const oldest = resolved.keys().next().value;
    if (!resolved.has(bare) && resolved.size >= 16 && oldest !== undefined) resolved.delete(oldest);
    return cached(resolved, bare, () => fetchInvite(bare));
  }

  /**
   * Asks every place the link names, and this node's relays, for its topic.
   * Of what comes back, only the blob that hashes to the pin is taken — any
   * other, whoever left it, is ignored unopened.
   */
  async function fetchInvite(bare: string): Promise<Resolved> {
    const link = parseInviteLink(bare);
    const { topic, inviteSecret } = await inviteLinkKeys(link.secret, link.pin);
    const places = [...new Set([...link.places, ...usableRelays(config.network)])];
    if (places.length === 0)
      throw new Error('That invite names no place to find it, and this app knows none');
    // A slow place can't hold the join up for long: what has come back by then is all there is.
    const blobs = await fetchBlobs(places, topic, 20_000);
    // Only blobs whose hash is the pin; any other, whoever left it, is never opened.
    const named: string[] = [];
    for (const blob of blobs) if (await hasPin(blob, link.pin)) named.push(blob);
    // Only the inviter could make two blobs share a pin, and then neither is trusted.
    if (named.length > 1) throw new Error('That invite link names more than one invite, so it is not used');
    const opened = named[0] ? await openInvite(link, named[0]) : null;
    if (!opened)
      throw new Error('That invite was not found. It may have expired, or the places it names may be down.');
    const { invite, until } = opened;
    // The invitation as its inviter signed it, and beside it the secret the link's own gives a role link.
    const signed = readInvitation(writeInvitation(invite)).version;
    const long = writeInvitation(signed, typeof signed.body.role === 'string' ? inviteSecret : undefined);
    return { long, ...(until !== undefined ? { until } : {}) };
  }

  /** What the places hold under a topic, as much as came back within `waitMs` */
  async function fetchBlobs(
    places: ReadonlyArray<string>,
    topic: string,
    waitMs: number,
  ): Promise<Set<string>> {
    const blobs = new Set<string>();
    const fetchAt = async (place: string) => {
      for (const item of await mailbox.fetch(place, topic)) blobs.add(item.blob);
    };
    await Promise.race([sleep(waitMs), Promise.all(places.map((place) => fetchAt(place).catch(() => {})))]);
    return blobs;
  }

  /** The key of the invite a DID, a short link or a long invite names */
  async function inviteKeyOf(keyOrLink: string): Promise<string> {
    if (keyOrLink.startsWith('did:key:')) return keyOrLink;
    // The link itself will do: its secret names the invite.
    if (isShortInvite(bareInvite(keyOrLink))) {
      // A short link's invite secret is derived from its own; a view-only one has no record to close.
      const secret = await linkInviteSecret(parseInviteLink(bareInvite(keyOrLink)).secret);
      return (await deriveInviteKey(secret, provider)).did;
    }
    const secret = parseSpaceInvite(bareInvite(keyOrLink)).invite;
    if (!secret)
      throw new Error(
        'That invite is view-only — there is nothing to close. To stop it working, give the space a new key (changeKey).',
      );
    return (await deriveInviteKey(base64UrlDecode(secret), provider)).did;
  }

  return Object.freeze({
    inviteTo,
    shortInvite,
    resolveInvite,
    inviteKeyOf,
    keptLinks,
    forgetLinks,
    keepLinks,
    stop: () => clearInterval(linkTimer),
  });
}

/** Whether a sealed invite hashes to a link's pin */
async function hasPin(blob: string, pin: Uint8Array): Promise<boolean> {
  return (await pinOf(blob)).every((byte, i) => byte === pin[i]);
}

/** A kept link has ended once its time is up, or the space's key has moved on from the one it carries */
function linkEnded(link: KeptLink, record: SpaceRecord): boolean {
  if (link.until !== undefined && link.until <= Date.now()) return true;
  const { keyId } = link;
  if (keyId === undefined || record.key === null || record.key.id === keyId) return false;
  return (record.keys ?? []).some((held) => held.id === keyId);
}
