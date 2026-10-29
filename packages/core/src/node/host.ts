/**
 * @module node/host
 * A carrier that never sleeps, for many accounts: what a hosting service runs.
 *
 * It is the extension's carrier (`node/carrier.ts`) with more than one carry
 * space. Each **subscription** (someone paying for hosting) is a key the
 * account made, a date it is paid until, and once a device hands it over, the
 * account's carry space. The spaces the carry spaces' passes name are held
 * once, whoever asks, so a space shared by two paying members is one space here.
 *
 * Blind, like any carrier: no seed, no space key, no note; it signs nothing and
 * takes in only what passes the same gates as any member's node. It learns
 * which spaces exist, their size, when they change, and which account asked
 * for which.
 *
 * A space can pay for itself: a subscription named `space:<id>` carries that
 * one space from its pass, handed over by any member's device.
 *
 * With `limits`, an account's subscription needs no payment: it is on the free
 * plan, and paying buys room. A space several accounts write in is free up to
 * a line, and past it, after a grace period, only its own subscription carries
 * it (spec 08 §1.1).
 */
import type { CryptoProvider, StorageAdapter, Version } from '../types.js';
import type { HostLimits, OverSpace, SpaceUsage } from '../session/hosting.js';
import { createUsageMeter } from './usage.js';
import { createP256Provider } from '../identity/crypto-p256.js';
import { createServerAuth } from '../network/peer-auth.js';
import { utf8Decode, utf8Encode } from '../utils/encoding.js';
import { isRecord } from '../utils/guards.js';
import { createCarryCore, type CarrierEvent } from './carrier.js';
import type { StoreFactory } from './stores.js';
import type { NodeNetworkConfig } from './types.js';
import type { BlobStore } from '../storage/blob-store.js';
import { deleteMirrored } from '../storage/mirror.js';
import { openPass } from '../space/pass.js';
import { parseSpaceInvite } from '../space/space-manager.js';
import { createListeners } from '../utils/events.js';

/** What names a space's own subscription at a host */
const SPACE_SUBSCRIPTION_PREFIX = 'space:';

/** A space's own subscription id: `space:<space id>` */
export const spaceSubscription = (spaceId: string) => `${SPACE_SUBSCRIPTION_PREFIX}${spaceId}`;

/** Someone paying for hosting, as the host knows them */
export interface Subscription {
  /** The subscription key's DID, which signs every call about it; or `space:<space id>` */
  readonly id: string;
  /** Unix seconds. Past it, the grace period; past that, it is dropped. */
  readonly paidUntil: number;
  /** When it was made, unix seconds */
  readonly since: number;
  /** The account and its carry space, once a device has handed them over */
  readonly carry?: { readonly account: string; readonly space: string; readonly invite: string };
  /** For a space's own subscription: the pass a member's device handed over */
  readonly pass?: unknown;
  /** The payment provider's reference for whoever pays; nothing else about them is kept */
  readonly customer?: string;
  /** A wallet payment asked for and not yet seen (`packages/cli/src/wallet.ts`) */
  readonly invoice?: Invoice;
  /** When one of its devices last made a signed call, unix seconds, to the day */
  readonly seen?: number;
}

/**
 * An account over its room at a host with limits, kept by account so a new
 * subscription key starts nothing anew.
 */
interface Room {
  /** Since when it was over */
  readonly full: number;
  /** Since when it fits again; the notice goes after a whole window of it */
  readonly fits?: number;
  /** Its carry space alone was over, so it is carried no more */
  readonly refused?: true;
  /** The spaces held back for want of room, each since when: past `keepDays` the host's copy goes */
  readonly held?: Readonly<Record<string, number>>;
}

/** A payment a host asked a wallet for: an exact amount, so the transfer that arrives says whose it is */
export interface Invoice {
  readonly plan: string;
  /** In the token's smallest unit, as a decimal string */
  readonly amount: string;
  /** When it was asked for, unix seconds: a transfer made before it pays nothing */
  readonly at: number;
}

export type SubscriptionState = 'active' | 'grace' | 'lapsed';

type Reason = OverSpace['reasons'][number];

/** Where a space stands against the free line */
interface Line {
  /** When it went over */
  readonly since: number;
  /** When its grace began */
  readonly from: number;
  readonly reasons: ReadonlyArray<Reason>;
  /** It was under the line when last looked at */
  readonly calm?: true;
  /** When it was last found over the line */
  readonly lastOver?: number;
  /** Since when it has been well under */
  readonly under?: number;
  /** When members' subscriptions stopped carrying it */
  readonly stopped?: number;
}

type Changes = { over: string[]; stopped: string[]; under: string[] };

export interface HostConfig {
  /** The host's own key: who it is to peers */
  readonly key: CryptoKeyPair;
  readonly stores: StoreFactory;
  readonly network?: NodeNetworkConfig;
  readonly provider?: CryptoProvider;
  /** Days a lapsed subscription is kept, carried, before it is dropped. Default 30. */
  readonly graceDays?: number;
  /** Every subscription counts as paid: for someone hosting only themselves, and for trying it out */
  readonly free?: boolean;
  /** The accounts this host carries for, and no others. Absent: any account whose subscription is paid. */
  readonly allow?: ReadonlyArray<string>;
  /** Unix seconds now; for tests */
  readonly now?: () => number;
  /**
   * The host's bucket (`storage/blob/s3.ts`): every carried space and the
   * subscriptions are kept there too, so the host's disk is only a cache.
   */
  readonly mirror?: BlobStore;
  readonly watchIntervalMs?: number;
  /** Whether a carry space's subscription may take no more spaces: the host's storage limit */
  readonly full?: (carrySpace: string) => boolean;
  /** Free hosting within limits (spec 08 §1.1). Ignored with `free`. */
  readonly limits?: HostLimits;
  /** How many bytes a carried space takes: what the free line's `bytes` reads */
  readonly measure?: (spaceId: string) => Promise<number>;
  /** Spaces one account's carry space may have carried at most: those it names past that wait */
  readonly spacesPerCarry?: number;
  /** Accounts whose writes are not counted: the host's own bots */
  readonly ignore?: (account: string) => boolean | Promise<boolean>;
}

/** A host, as `createHostNode` starts it */
export type HostNode = Awaited<ReturnType<typeof createHostNode>>;

/** The space a subscription is a space's own for, or null for an account's */
const spaceIdOf = (id: string): string | null =>
  id.startsWith(SPACE_SUBSCRIPTION_PREFIX) && id.length > SPACE_SUBSCRIPTION_PREFIX.length && id.length <= 200
    ? id.slice(SPACE_SUBSCRIPTION_PREFIX.length)
    : null;

/** An account this host was not told to carry for */
export class NotAllowedError extends Error {
  constructor() {
    super('This host only carries spaces for the accounts its owner named');
  }
}

const DAY = 24 * 3600;
/** How far under every limit a space must stay, for its window, to be free again */
const UNDER = 0.8;
/** How long after the host first sees a space what arrives may be its history, rather than people writing now */
const CATCH_UP_SECONDS = 600;
/** Days of notice a space gets when it goes over again after its grace was spent */
const NOTICE_DAYS = 7;

/** Starts a host */
export async function createHostNode(config: HostConfig) {
  const provider = config.provider ?? createP256Provider();
  const now = config.now ?? (() => Math.floor(Date.now() / 1000));
  const graceSeconds = (config.graceDays ?? 30) * DAY;
  const allowed = (account: string) => !config.allow || config.allow.includes(account);
  const store: StorageAdapter = await config.stores('host');
  const events = createListeners<CarrierEvent>('host');
  const limits = config.free ? null : (config.limits ?? null);
  const lineGrace = (limits?.graceDays ?? 0) * DAY;
  const keepSeconds = (limits?.keepDays ?? 0) * DAY;

  // Each kind of record is kept in the host's store and in the bucket, which a new disk starts from.
  const kept = {
    subscriptions: shelf(store, config.mirror, 'subscription:', {
      ...bucketNames('host/subscriptions/', { encoded: true, suffix: '.json' }),
      nameOf: (_key, bytes) => subscriptionIdIn(bytes),
    }),
    lines: shelf(store, config.mirror, 'line:', bucketNames('host/lines/', { suffix: '.json' })),
    rooms: shelf(store, config.mirror, 'room:', bucketNames('host/rooms/', { encoded: true })),
    struck: shelf(store, config.mirror, 'struck:', bucketNames('host/struck/')),
  };

  const read = async (id: string): Promise<Subscription | null> => {
    const text = await kept.subscriptions.get(id);
    // Only `write` puts anything here; a check would turn a damaged record into a missing one.
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- this host's own writes
    return text ? (JSON.parse(text) as Subscription) : null;
  };
  const write = async (subscription: Subscription): Promise<Subscription> => {
    await kept.subscriptions.put(subscription.id, JSON.stringify(subscription));
    return subscription;
  };
  const list = async (): Promise<Subscription[]> => {
    const all = await Promise.all((await kept.subscriptions.names()).map(read));
    return all.filter((subscription) => subscription !== null);
  };

  const state = (subscription: Subscription): SubscriptionState => {
    if (config.free || subscription.paidUntil >= now()) return 'active';
    // With limits an account needs no payment: not paying is the free plan.
    if (limits && !spaceIdOf(subscription.id)) return 'active';
    return subscription.paidUntil + graceSeconds >= now() ? 'grace' : 'lapsed';
  };

  /** Which room an account's subscription has, at a host with limits; null otherwise */
  const plan = (subscription: Subscription): 'free' | 'paid' | null => {
    if (!limits || spaceIdOf(subscription.id)) return null;
    return subscription.paidUntil >= now() ? 'paid' : 'free';
  };

  // ─── The free line ─────────────────────────────────────────────────

  const meter = limits
    ? await createUsageMeter({
        store: await config.stores('host-usage'),
        windowDays: limits.space.windowDays,
        now,
      })
    : null;

  const lines = new Map<string, Line>();
  /** Each account over its room */
  const rooms = new Map<string, Room>();
  /** Spaces members' subscriptions once stopped carrying, and when: one back over the line gets no new grace */
  const struck = new Map<string, number>();
  if (limits) {
    for (const [spaceId, text] of await kept.lines.load()) {
      const line = parseLine(JSON.parse(text));
      if (line) lines.set(spaceId, line);
    }
    for (const [account, text] of await kept.rooms.load()) {
      const room = parseRoom(JSON.parse(text));
      if (room) rooms.set(account, room);
    }
    for (const [spaceId, text] of await kept.struck.load()) {
      const at = Number(text);
      if (Number.isFinite(at)) struck.set(spaceId, at);
    }
  }

  async function writeLine(spaceId: string, line: Line | null): Promise<void> {
    if (line) {
      lines.set(spaceId, line);
      await kept.lines.put(spaceId, JSON.stringify(line));
    } else {
      lines.delete(spaceId);
      await kept.lines.delete(spaceId);
    }
  }

  async function writeRoom(account: string, room: Room | null): Promise<void> {
    if (sameJson(room, rooms.get(account) ?? null)) return;
    if (room) {
      rooms.set(account, room);
      await kept.rooms.put(account, JSON.stringify(room));
    } else {
      rooms.delete(account);
      await kept.rooms.delete(account);
    }
  }

  async function strike(spaceId: string, at: number): Promise<void> {
    struck.set(spaceId, at);
    await kept.struck.put(spaceId, String(at));
  }

  async function unstrike(spaceId: string): Promise<void> {
    if (!struck.delete(spaceId)) return;
    await kept.struck.delete(spaceId);
  }

  const accountOf = (subscription: Subscription) => subscription.carry?.account;
  const roomOf = (subscription: Subscription) => rooms.get(accountOf(subscription) ?? '');

  /** Whether a subscription's account is past its notice of being over its room */
  const outOfRoom = (subscription: Subscription) => {
    const room = roomOf(subscription);
    return room !== undefined && room.full + lineGrace <= now();
  };

  /** Each carry space's spaces held back for want of its room */
  const holds = new Map<string, ReadonlySet<string>>();
  /** Those whose copy the host still keeps: held back less than `keepDays` for some account */
  const roomHeld = new Set<string>();
  /** Held back longer, their copy already deleted: not deleted again until the host restarts */
  const dropped = new Set<string>();
  /** Spaces members' subscriptions no longer carry, being over the line with nobody paying */
  const skipped = new Set([...lines].filter(([, line]) => line.stopped !== undefined).map(([id]) => id));

  /**
   * A version reached a carried space: its account wrote there, unless it is
   * the host's own. Counted by when it arrived, except while the host first
   * catches up on a space: then what is older than the window is history.
   */
  const counted = (spaceId: string, version: Version) => {
    if (!meter || !limits) return;
    const account = version.proof?.payload.iss ?? version.author;
    const written = Date.parse(version.createdAt) / 1000;
    const old = Number.isFinite(written) && written < now() - limits.space.windowDays * DAY;
    const count = async () => {
      const catchingUp = now() - (await meter.firstSeen(spaceId)) < CATCH_UP_SECONDS;
      if (old && catchingUp) return;
      if (!(await config.ignore?.(account))) await meter.wrote(spaceId, account);
    };
    void count().catch(() => {});
  };

  /** Whether anyone but the account holds a role in its carry space: then it is a shared space */
  const sharedCarry = async (carrySpace: string, account: string): Promise<boolean> => {
    const entry = core.carried.get(carrySpace);
    if (!entry) return false;
    const { members } = await entry.runtime.access();
    return members.some((member) => member.did !== account && (member.founder || member.roles.length > 0));
  };

  /** Stops a carry space being any subscription's */
  const letCarryGo = async (carrySpace: string) => {
    for (const subscription of await list()) {
      if (subscription.carry?.space !== carrySpace) continue;
      const { carry: _gone, ...rest } = subscription;
      await write(rest);
    }
    await core.removeCarry(carrySpace);
  };

  /** The accounts that are members of a carried space now: only their writes count */
  const membersOf = async (spaceId: string): Promise<ReadonlyArray<string> | undefined> => {
    const entry = core.carried.get(spaceId);
    if (!entry) return undefined;
    return (await entry.runtime.access()).members.map((member) => member.did);
  };

  await kept.subscriptions.restore();

  /** The account's carry space being let go, after it wrote `carry:closed` */
  let closing: Promise<void> = Promise.resolve();
  /** Whether the carry core below is made, so its events may look at it */
  let opened = false;
  const core = await createCarryCore({
    key: config.key,
    stores: config.stores,
    ...(config.network ? { network: config.network } : {}),
    provider,
    ...(config.watchIntervalMs !== undefined ? { watchIntervalMs: config.watchIntervalMs } : {}),
    emit: (event) => {
      // A space newly carried: what arrives over the next minutes is it catching up.
      if (event.type === 'spaces' && meter && opened)
        for (const spaceId of core.carried.keys()) void meter.firstSeen(spaceId).catch(() => {});
      events.emit(event);
    },
    ...(config.full ? { full: config.full } : {}),
    ...(limits
      ? {
          skip: (spaceId: string) => skipped.has(spaceId),
          held: (carrySpace: string) => holds.get(carrySpace),
          onArrived: counted,
        }
      : {}),
    ...(config.spacesPerCarry !== undefined ? { most: config.spacesPerCarry } : {}),
    ...(config.mirror ? { mirror: config.mirror, onRelease: releaseMirrored(config.mirror) } : {}),
    // The account stopped using this host: forget its carry space; the subscription stays paid.
    onClosed: (carrySpace) => {
      closing = closing.then(() => letCarryGo(carrySpace));
    },
  });
  opened = true;

  /** One stopped for being over the line is kept a while, so a fund brings it back as it was */
  function releaseMirrored(mirror: BlobStore) {
    return async (spaceId: string) => {
      if (!skipped.has(spaceId) && !roomHeld.has(spaceId)) await deleteMirrored(mirror, spaceId);
    };
  }

  await carryAgain();

  /** Carries again what was carried before a restart: the store caches the spaces, but the list is ours */
  async function carryAgain(): Promise<void> {
    for (const subscription of await list()) {
      if (state(subscription) === 'lapsed') continue;
      const fail = (error: unknown) =>
        console.error(`Could not carry for subscription ${subscription.id}:`, error);
      if (subscription.pass !== undefined) await core.addPass(subscription.pass).catch(fail);
      // An account taken off the list since is not carried again.
      else if (subscription.carry && allowed(subscription.carry.account))
        await core.addCarry(subscription.carry.account, subscription.carry.invite).catch(fail);
    }
  }

  /** Stops carrying a carry space, unless another subscription still carries it */
  const releaseCarry = async (carrySpace: string, except: string) => {
    const others = await list();
    if (others.some((other) => other.id !== except && other.carry?.space === carrySpace)) return;
    await core.removeCarry(carrySpace);
  };

  /** Whether a space's own subscription pays for it now: the free line does not apply then */
  const paysItself = async (spaceId: string) => {
    const own = await read(spaceSubscription(spaceId));
    return !!own && state(own) === 'active';
  };

  /** The spaces the free line is about: those accounts' passes name, and the carry spaces too */
  const metered = (): ReadonlySet<string> => {
    const named = [...core.carries.values()].flatMap((entry) => [...entry.named]);
    // An account's own carry space has one writer; a shared space handed over as one is held to the line.
    return new Set([...named, ...core.carried.keys()]);
  };

  const measure = async (spaceId: string) => (await config.measure?.(spaceId).catch(() => 0)) ?? 0;

  /** Where one space stands now: its counts, its size, and the line it is held to */
  async function standing(spaceId: string, before: Line | undefined, own: boolean): Promise<Line | null> {
    if (!limits || !meter) return null;
    const t = now();
    // Members stopped carrying it, so nothing it does reaches here: it stays, and is forgotten after a while.
    if (before?.stopped !== undefined && !own) return before.stopped + keepSeconds <= t ? null : before;
    // Not carried now, so its members can't be read: it stays as it was until it is.
    const members = await membersOf(spaceId);
    if (!members) return before ?? null;

    const counts = await meter.usage(spaceId, members);
    const bytes = await measure(spaceId);
    const shared = counts.writers >= 2;
    // One writer is never a community, whatever the limit says.
    const most = Math.max(limits.space.writers, 1);
    const reasons: Reason[] = [];
    if (counts.writers > most) reasons.push('writers');
    if (shared && bytes > limits.space.bytes) reasons.push('bytes');
    const wellUnder = counts.writers <= most * UNDER && (!shared || bytes <= limits.space.bytes * UNDER);

    let line: Line | null = before ?? null;
    if (reasons.length > 0) {
      // A grace spent once, by a stop or by running out while under, buys only a short notice next time.
      const notice = t - lineGrace + NOTICE_DAYS * DAY;
      const spent = before ? before.calm === true && before.from + lineGrace <= t : struck.has(spaceId);
      const from = spent ? Math.max(before?.from ?? notice, notice) : (before?.from ?? t);
      line = { since: before?.since ?? t, from, reasons, lastOver: t };
    } else if (line && wellUnder) {
      const under = line.under ?? t;
      // Free again only after a whole window well under, so a busy week does not flip it.
      if (t - under >= limits.space.windowDays * DAY) return null;
      line = { ...line, calm: true, under };
    } else if (line) {
      const { under: _gone, ...rest } = line;
      line = { ...rest, calm: true };
    }
    if (!line) return null;

    // While it pays for itself the line does not apply, but its grace is not given again.
    if (own) {
      const { stopped: _paid, ...rest } = line;
      return rest;
    }
    // Stopped once its grace runs out if it is over then, or was in the last days before:
    // going under for an hour as the date passes buys nothing.
    const until = line.from + lineGrace;
    const lately = (line.lastOver ?? 0) >= until - NOTICE_DAYS * DAY;
    const stops = (reasons.length > 0 || lately) && until <= t && line.stopped === undefined;
    return stops ? { ...line, stopped: t } : line;
  }

  /**
   * Holds each space to the free line, and lets members' subscriptions go of
   * those past it. Run now and then. Says which spaces went over, stopped, or
   * came back under.
   */
  async function evaluate(): Promise<Changes> {
    const changed: Changes = { over: [], stopped: [], under: [] };
    if (!limits || !meter) return changed;
    await meter.prune();
    const spaces = metered();
    for (const spaceId of new Set([...spaces, ...lines.keys()]))
      await evaluateOne(spaceId, spaces, changed).catch((error: unknown) => {
        // Judged again next time; the others go on.
        console.error(`Could not hold space ${spaceId} to the free line:`, error);
      });
    await core.refresh();
    return changed;
  }

  async function evaluateOne(spaceId: string, spaces: ReadonlySet<string>, changed: Changes): Promise<void> {
    if (!meter || !limits) return;
    const before = lines.get(spaceId);
    const own = await paysItself(spaceId);
    // A space nobody names for a while keeps its line, never dropped because it was let go for an hour.
    const after = spaces.has(spaceId) || before ? await standing(spaceId, before, own) : null;

    // A stop long forgotten, and a window more under: its grace is its own again.
    const struckAt = struck.get(spaceId);
    const forgotten = ((limits.keepDays ?? 0) + limits.space.windowDays) * DAY;
    if (!before && !after && struckAt !== undefined && struckAt + forgotten <= now()) await unstrike(spaceId);

    if (!sameJson(after, before ?? null)) await writeLine(spaceId, after);
    if (after && !before) changed.over.push(spaceId);
    if (after?.stopped !== undefined && before?.stopped === undefined) {
      changed.stopped.push(spaceId);
      await strike(spaceId, after.stopped);
      // Skipped first, so letting a carry space go keeps the bucket's copy.
      skipped.add(spaceId);
      if (core.carries.has(spaceId)) await letCarryGo(spaceId);
    }
    // A carry space someone else came to hold a role in is a shared space.
    const account = core.carries.get(spaceId)?.account;
    if (account && (await sharedCarry(spaceId, account))) await letCarryGo(spaceId);
    if (before && !after) changed.under.push(spaceId);
    if (before && !after && before.stopped === undefined) await unstrike(spaceId);

    if (after?.stopped !== undefined && !own) skipped.add(spaceId);
    else skipped.delete(spaceId);

    // Forgotten after it was kept a while: the host's copy goes too, unless something carries it.
    if (before?.stopped !== undefined && !after) {
      await meter.forget(spaceId);
      if (config.mirror && !core.carried.has(spaceId))
        await deleteMirrored(config.mirror, spaceId).catch(() => {});
    }
  }

  /** The spaces over the line among these, as a status says them */
  const overOf = (spaceIds: Iterable<string>): ReadonlyArray<OverSpace> =>
    [...spaceIds].flatMap((spaceId) => {
      const line = lines.get(spaceId);
      // One back under and carried keeps its line quietly, until free again.
      const over = line && (!line.calm || line.stopped !== undefined);
      return over
        ? [{ space: spaceId, since: line.since, until: line.from + lineGrace, reasons: line.reasons }]
        : [];
    });

  /** Makes a subscription if there is none by this id, and returns it */
  const subscribe = async (id: string): Promise<Subscription> => {
    if (!id.startsWith('did:key:') && !spaceIdOf(id))
      throw new Error('A subscription is named by its key, or by the space it is for');
    return (await read(id)) ?? write({ id, paidUntil: 0, since: now() });
  };

  /** Which spaces are held back now, in a form to compare */
  const holdsSignature = () =>
    [...holds]
      .map(([space, held]) => `${space}:${[...held].sort().join(',')}`)
      .sort()
      .join(' ');

  /** The spaces some account holds back for less than `keepDays`, whose copy the host keeps */
  function recountRoomHeld(t: number): void {
    roomHeld.clear();
    for (const room of rooms.values())
      for (const [spaceId, since] of Object.entries(room.held ?? {}))
        if (since + keepSeconds > t) roomHeld.add(spaceId);
  }

  /** Held back longer than `keepDays` for every account that holds it: the host's copy goes, as for a stop */
  async function dropLongHeld(): Promise<void> {
    for (const held of holds.values())
      for (const spaceId of held) {
        if (
          roomHeld.has(spaceId) ||
          dropped.has(spaceId) ||
          skipped.has(spaceId) ||
          core.carried.has(spaceId)
        )
          continue;
        dropped.add(spaceId);
        if (config.mirror) await deleteMirrored(config.mirror, spaceId).catch(() => {});
      }
    // Carried again: should it be held that long again, its copy goes again.
    for (const spaceId of dropped) if (core.carried.has(spaceId)) dropped.delete(spaceId);
  }

  return Object.freeze({
    did: core.did,
    /** The short links its accounts keep, under a mailbox topic: what its relay answers besides drops */
    linksAt: core.linksAt,
    subscribe,
    get: read,
    list,
    /** Whether a subscription is paid, in its grace period, or lapsed */
    state,
    /** At a host with limits, which room an account's subscription has: null at one without */
    plan,
    /** The limits it keeps to, or null when it has none */
    limits,

    /**
     * Whether a subscription's spaces take more than its room. The notice runs
     * from when they first did, and goes only after a whole window of fitting.
     */
    async setFull(id: string, over: boolean): Promise<void> {
      const subscription = await read(id);
      const account = subscription && accountOf(subscription);
      if (!account || !limits) return;
      const room = rooms.get(account);
      const t = now();
      if (over) {
        await writeRoom(account, {
          full: room?.full ?? t,
          ...(room?.refused ? { refused: true } : {}),
          ...(room?.held ? { held: room.held } : {}),
        });
        return;
      }
      if (!room) return;
      const fits = room.fits ?? t;
      // A refusal stays until the host's owner says.
      const fitWholeWindow = t - fits >= limits.space.windowDays * DAY && !room.refused;
      await writeRoom(account, fitWholeWindow ? null : { ...room, fits });
    },

    /** Whether a subscription is past its notice of being over its room */
    outOfRoom,

    /** Holds back these solo spaces of a subscription's for want of room, and no others: kept, unserved, until they fit */
    async holdForRoom(id: string, spaceIds: ReadonlyArray<string>): Promise<void> {
      const subscription = await read(id);
      const carrySpace = subscription?.carry?.space;
      const account = subscription && accountOf(subscription);
      if (!carrySpace || !account) return;
      const t = now();
      const room = rooms.get(account);
      if (room) {
        const { held: before = {}, ...rest } = room;
        const held = Object.fromEntries(spaceIds.map((spaceId) => [spaceId, before[spaceId] ?? t]));
        await writeRoom(account, Object.keys(held).length ? { ...rest, held } : rest);
      }
      const before = holdsSignature();
      if (spaceIds.length) holds.set(carrySpace, new Set(spaceIds));
      else holds.delete(carrySpace);
      recountRoomHeld(t);
      await dropLongHeld();
      if (holdsSignature() !== before) await core.refresh();
    },

    /** Stops carrying a carry space over its room by itself past its notice, until the host's owner says */
    async refuse(id: string): Promise<void> {
      const subscription = await read(id);
      if (!subscription?.carry) return;
      const { carry, ...rest } = subscription;
      await writeRoom(carry.account, { ...(rooms.get(carry.account) ?? { full: now() }), refused: true });
      await write(rest);
      await releaseCarry(carry.space, id);
    },

    async seen(id: string): Promise<void> {
      const subscription = await read(id);
      if (!subscription || (subscription.seen !== undefined && now() - subscription.seen < DAY)) return;
      await write({ ...subscription, seen: now() });
    },

    /** A session key proved it reads a carried space: counted, though readers only ever hint */
    read(spaceId: string, session: string): void {
      if (core.carried.has(spaceId)) meter?.read(spaceId, session);
    },

    evaluate,

    /** The spaces over the free line that a subscription names, or its own space when it is one */
    async overFor(id: string): Promise<ReadonlyArray<OverSpace>> {
      const own = spaceIdOf(id);
      if (own) return overOf([own]);
      const space = (await read(id))?.carry?.space;
      const named = space ? [space, ...(core.carries.get(space)?.named ?? [])] : [];
      // One its own fund pays for is nothing its members need to hear about.
      const unpaid: string[] = [];
      for (const spaceId of named)
        if (lines.has(spaceId) && !(await paysItself(spaceId))) unpaid.push(spaceId);
      return overOf(unpaid);
    },

    /** How a space is used, as a status says it; null at a host without limits */
    async usage(spaceId: string): Promise<SpaceUsage | null> {
      if (!meter) return null;
      const { writers, readers, windowDays } = await meter.usage(spaceId, await membersOf(spaceId));
      const bytes = core.carried.has(spaceId) ? await measure(spaceId) : 0;
      return { writers, readers, bytes, windowDays };
    },

    /** When a subscription's notice of being over its room runs out, or null when it is not over */
    fullUntil: (subscription: Subscription): { since: number; until: number } | null => {
      const room = roomOf(subscription);
      return room ? { since: room.full, until: room.full + lineGrace } : null;
    },

    /** Whether members' subscriptions hold a space back, being past the free line */
    heldBack: (spaceId: string): boolean => skipped.has(spaceId),

    /** Whether a space pays for itself now, so no account's room counts it */
    paysItself,

    /** Moves a subscription's paid-until date: the one thing payments do */
    async extend(id: string, until: number, customer?: string): Promise<Subscription> {
      const subscription = await subscribe(id);
      const extended = await write({
        ...subscription,
        paidUntil: Math.max(subscription.paidUntil, until),
        ...(customer ? { customer } : {}),
      });
      // Paid again in time: carry again what the grace period had kept.
      if (extended.carry && !core.carries.has(extended.carry.space))
        await core.addCarry(extended.carry.account, extended.carry.invite);
      if (extended.pass !== undefined) await core.addPass(extended.pass).catch(() => {});
      return extended;
    },

    /** Sets a paid-until date outright, earlier too: what a fund's estimate says as it is spent */
    async setPaidUntil(id: string, until: number): Promise<Subscription> {
      const subscription = await subscribe(id);
      if (subscription.paidUntil === until) return subscription;
      const set = await write({ ...subscription, paidUntil: until });
      if (set.pass !== undefined && state(set) !== 'lapsed') await core.addPass(set.pass).catch(() => {});
      return set;
    },

    /** Keeps a wallet payment asked for, or drops it (null) once it arrived */
    async setInvoice(id: string, invoice: Invoice | null) {
      const { invoice: _before, ...subscription } = await subscribe(id);
      return write(invoice ? { ...subscription, invoice } : subscription);
    },

    /**
     * Starts carrying an account's spaces for a subscription: its carry space,
     * and every space its passes name. Replaces what the subscription carried.
     * @throws When the subscription is lapsed, or the invite is not a carry space's
     */
    async attach(id: string, account: string, invite: string) {
      const subscription = await read(id);
      if (!subscription || state(subscription) === 'lapsed')
        throw new Error('That subscription is not paid for');
      if (!account.startsWith('did:key:')) throw new Error('An account is named by its DID');
      if (!allowed(account)) throw new NotAllowedError();
      await liftRefusal(account, plan(subscription));
      const asked = parseSpaceInvite(invite).space.id;
      await checkCarrySpace(asked);
      const space = await core.addCarry(account, invite);
      // Anyone else holding a role there makes it a shared space, which members' own passes carry.
      if (limits && (await sharedCarry(space, account))) {
        await releaseCarry(space, id);
        throw new Error('That is a space others are members of, not a carry space');
      }
      const before = subscription.carry;
      const attached = await write({ ...subscription, carry: { account, space, invite } });
      if (before && before.space !== space) await releaseCarry(before.space, id);
      return attached;
    },

    /** Stops carrying for a subscription; the subscription stays */
    async detach(id: string) {
      const subscription = await read(id);
      if (!subscription?.carry) return;
      const { carry, ...rest } = subscription;
      await write(rest);
      await releaseCarry(carry.space, id);
    },

    /**
     * Carries a space for its own subscription, from a pass. A later pass (the
     * space's key changed) replaces the one before.
     * @throws When the subscription is lapsed, or the pass is not for its space
     */
    async carrySpace(id: string, pass: unknown) {
      const spaceId = spaceIdOf(id);
      if (!spaceId) throw new Error('Only a space’s own subscription carries a space from a pass');
      const subscription = await read(id);
      if (!subscription || state(subscription) === 'lapsed') throw new Error('That space is not paid for');
      const opened = await openPass(pass, provider);
      if (!opened || opened.space.id !== spaceId) throw new Error('That is not a pass for this space');
      await core.addPass(pass);
      return write({ ...subscription, pass });
    },

    /** The read key a space's own subscription carries it with, as a DID: null when public or not carried */
    readKeyOf(id: string) {
      const spaceId = spaceIdOf(id);
      return spaceId ? core.readKeyOf(spaceId) : null;
    },

    /** Drops what lapsed past its grace period, and free subscriptions idle too long. Run now and then. */
    async sweep(): Promise<ReadonlyArray<string>> {
      const gone: string[] = [];
      for (const subscription of await list()) {
        if (!(await expired(subscription))) continue;
        await kept.subscriptions.delete(subscription.id);
        const spaceId = spaceIdOf(subscription.id);
        if (spaceId) await core.removePass(spaceId);
        if (subscription.carry) await releaseCarry(subscription.carry.space, subscription.id);
        gone.push(subscription.id);
      }
      return gone;
    },

    spaces: core.spaces,
    /** Reads every account's passes again, taking a space that waited for room: after what `full` says changed */
    recheck: () => core.refresh(),

    /** Every space a subscription's carry space names, carried or not */
    async namedFor(id: string): Promise<ReadonlyArray<string>> {
      const space = (await read(id))?.carry?.space;
      return [...(space ? (core.carries.get(space)?.named ?? []) : [])];
    },

    /** How many spaces a subscription's account asks the host to carry */
    async carriedFor(id: string) {
      const space = (await read(id))?.carry?.space;
      return space ? (core.carries.get(space)?.wants.size ?? 0) : 0;
    },

    /** The spaces a subscription is carried for now: its carry space and those its passes name, or a space's own */
    async spacesOf(id: string): Promise<ReadonlyArray<string>> {
      const subscription = await read(id);
      const own = spaceIdOf(id);
      if (own) return subscription?.pass !== undefined ? [own] : [];
      const space = subscription?.carry?.space;
      return space ? [space, ...(core.carries.get(space)?.wants ?? [])] : [];
    },

    /** For a server taking sockets: checks a connecting peer against the space's history. Null for a space not carried. */
    async authenticator(spaceId: string) {
      const entry = core.carried.get(spaceId);
      if (!entry) return null;
      const read = entry.record.space.visibility === 'private' ? entry.runtime.readAccess() : null;
      return createServerAuth(spaceId, read, config.key.privateKey, provider);
    },

    subscribeEvents: events.subscribe,

    async close() {
      await closing;
      await core.close();
      await store.close();
      events.clear();
    },
  });

  /** A refused account comes back only by paying, since a balance has no room; a new key brings nothing back */
  async function liftRefusal(account: string, room: 'free' | 'paid' | null): Promise<void> {
    const refused = rooms.get(account);
    if (!refused?.refused) return;
    if (room !== 'paid')
      throw new Error('This host stopped carrying for this account: its carry space was over its room');
    const { refused: _lifted, ...rest } = refused;
    await writeRoom(account, rest);
  }

  /** Refuses as a carry space one that is others' to carry */
  async function checkCarrySpace(spaceId: string): Promise<void> {
    // Stopped for being over the line, it comes back only through its own fund.
    if (lines.get(spaceId)?.stopped !== undefined && !(await paysItself(spaceId)))
      throw new Error('That space is over this host’s free line: only its own fund carries it');
    if (!limits || core.carries.has(spaceId)) return;
    // Taking it would take it from them, and letting it go again would drop the host's copy.
    const others =
      core.carried.has(spaceId) || [...core.carries.values()].some((entry) => entry.named.has(spaceId));
    if (others) throw new Error('That is a space others are members of, not a carry space');
  }

  /** Lapsed past its grace, or a free subscription idle too long */
  async function expired(subscription: Subscription): Promise<boolean> {
    const idle = limits?.idleDays !== undefined ? limits.idleDays * DAY : null;
    if (idle === null || plan(subscription) !== 'free') return state(subscription) === 'lapsed';
    let seen = subscription.seen;
    // One from before idle subscriptions were dropped counts from now, not from when it was made.
    if (seen === undefined) {
      seen = now();
      await write({ ...subscription, seen });
    }
    return state(subscription) === 'lapsed' || seen + idle < now();
  }
}

/** How a kind of record is named in the bucket */
interface BucketNames {
  readonly prefix: string;
  readonly key: (name: string) => string;
  /** The name a bucket file restores under, or null to skip it */
  readonly nameOf: (key: string, bytes: Uint8Array) => string | null;
}

function bucketNames(prefix: string, { encoded = false, suffix = '' } = {}): BucketNames {
  return {
    prefix,
    key: (name) => `${prefix}${encoded ? encodeURIComponent(name) : name}${suffix}`,
    nameOf: (key) => {
      const name = key.slice(prefix.length, key.length - suffix.length);
      return (encoded ? decodeURIComponent(name) : name) || null;
    },
  };
}

/** Records kept as text in the host's store under `prefix`, and in the bucket too */
function shelf(store: StorageAdapter, mirror: BlobStore | undefined, prefix: string, bucket: BucketNames) {
  const at = (name: string) => `${prefix}${name}`;
  const names = async () => (await store.list(prefix)).map((key) => key.slice(prefix.length));

  async function get(name: string): Promise<string | null> {
    const bytes = await store.get(at(name));
    return bytes ? utf8Decode(bytes) : null;
  }

  /** A fresh disk starts from the bucket's copy */
  async function restore(): Promise<void> {
    if (!mirror || (await names()).length > 0) return;
    for (const key of await mirror.list(bucket.prefix)) {
      const bytes = await mirror.get(key);
      const name = bytes && bucket.nameOf(key, bytes);
      if (bytes && name) await store.put(at(name), bytes);
    }
  }

  return {
    get,
    names,
    restore,
    async put(name: string, text: string): Promise<void> {
      const bytes = utf8Encode(text);
      await store.put(at(name), bytes);
      await mirror?.put(bucket.key(name), bytes);
    },
    async delete(name: string): Promise<void> {
      await store.delete(at(name));
      await mirror?.delete(bucket.key(name));
    },
    /** Every record, after restoring from the bucket */
    async load(): Promise<Array<[string, string]>> {
      await restore();
      const entries: Array<[string, string]> = [];
      for (const name of await names()) {
        const text = await get(name);
        if (text !== null) entries.push([name, text]);
      }
      return entries;
    },
  };
}

function subscriptionIdIn(bytes: Uint8Array): string | null {
  const subscription: unknown = JSON.parse(utf8Decode(bytes));
  return isRecord(subscription) && typeof subscription.id === 'string' ? subscription.id : null;
}

function parseLine(value: unknown): Line | null {
  const fits =
    isRecord(value) &&
    typeof value.since === 'number' &&
    typeof value.from === 'number' &&
    Array.isArray(value.reasons);
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- this host's own writes, shape checked
  return fits ? (value as unknown as Line) : null;
}

function parseRoom(value: unknown): Room | null {
  if (!isRecord(value) || typeof value.full !== 'number') return null;
  const given = isRecord(value.held) ? Object.entries(value.held) : [];
  const held = Object.fromEntries(
    given.filter((entry): entry is [string, number] => typeof entry[1] === 'number'),
  );
  return {
    full: value.full,
    ...(typeof value.fits === 'number' ? { fits: value.fits } : {}),
    ...(value.refused === true ? { refused: true } : {}),
    ...(Object.keys(held).length ? { held } : {}),
  };
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
