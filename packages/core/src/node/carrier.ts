/**
 * @module node/carrier
 * A node that keeps an account's spaces online without being able to read them.
 *
 * It runs in a browser extension, for as long as the browser does: it holds
 * every space the account gave it a pass for (`space/pass.ts`), takes part in
 * each space's gossip, and — when it can reach the person's pod — writes
 * everything into it, so the pod is current even with no app open.
 *
 * What it holds: its own key, the key of its carry space (which holds nothing
 * but passes), and records exactly as they travel — private bodies still
 * encrypted. It has no seed, no space key, no write secret and no note, so it
 * signs nothing and writes nothing. Every record it takes in passes the same
 * gates as at any member's node.
 *
 * **Two copies, two peers.** Each space is kept in the carrier's own database,
 * and — while a pod is attached — in the pod as well, as a second runtime on a
 * local link (`network/local-transport.ts`). Sync keeps them level both ways:
 * the pod catches up on whatever arrived while it was out of reach, and writes
 * another site made to the folder reach the database, and from there the mesh.
 * The pod only ever sees `spaces/<id>`: the account file and its sealed
 * registry are never opened.
 */
import type { CryptoProvider } from '../types.js';
import { createP256Provider } from '../identity/crypto-p256.js';
import { didOf } from '../identity/did.js';
import { createSigner } from '../schema/signer.js';
import { createSchemaEngine } from '../schema/schema-engine.js';
import { createSpaceManager, parseSpaceInvite, type SpaceRecord } from '../space/space-manager.js';
import {
  carriedRecord,
  CARRY_CLOSED_KEY,
  openPass,
  PASS_COLLECTION,
  type OpenedPass,
} from '../space/pass.js';
import { readWake, wakes, WAKE_COLLECTION, type Wake } from '../space/own-automations.js';
import type { Version } from '../types.js';
import { createLocalHub, type LocalHub } from '../network/local-transport.js';
import { meshFor, openSpaceRuntime, type SpaceRuntime } from './space-runtime.js';
import { createWriters } from './writers.js';
import type { StoreFactory } from './stores.js';
import type { BlobStore } from '../storage/blob-store.js';
import { createListeners } from '../utils/events.js';
import { serial } from '../utils/serial.js';
import type { ConnectionState, NodeEvent, NodeNetworkConfig } from './types.js';

export interface CarrierConfig {
  /** Its own key — who it is to peers. Never the account's. */
  readonly key: CryptoKeyPair;
  /** The account it carries for: only passes the account wrote count */
  readonly account: string;
  /** The view-only invite to its carry space */
  readonly carry: string;
  /** Its own copy of every carried space */
  readonly stores: StoreFactory;
  readonly network?: NodeNetworkConfig;
  readonly provider?: CryptoProvider;
  /** How often to look for writes another site made to the pod. Default 2000. */
  readonly watchIntervalMs?: number;
}

/** A space the carrier holds, and how it is doing */
export interface CarriedSpace {
  readonly id: string;
  readonly name: string;
  readonly visibility: 'public' | 'private';
  /** True for the carry space itself, which holds the passes */
  readonly carry: boolean;
  readonly connection: ConnectionState;
  readonly peers: number;
  /** Whether it is being written into the pod now */
  readonly inPod: boolean;
}

export type CarrierEvent =
  /** The set of carried spaces changed */
  | { readonly type: 'spaces' }
  /** Records arrived, or peers came and went, in a space */
  | { readonly type: 'status'; readonly space: string }
  /** The account stopped using this carrier: forget everything */
  | { readonly type: 'closed' }
  /**
   * A record arrived that one of the account's wakes asks about. Only what
   * the carrier can see: which wake, which space, which record.
   */
  | {
      readonly type: 'wake';
      readonly wake: WakeView;
      readonly space: { readonly id: string; readonly name: string };
      readonly record: { readonly key: string; readonly collection: string; readonly createdAt: string };
    };

/**
 * A kind of record a carried space holds, as far as the carrier can tell. Its
 * name is on the outside of every record; a title and topic fields only where
 * the definition is readable — a public space. In a private one it is sealed.
 */
export interface CarriedCollection {
  readonly name: string;
  readonly title?: string;
  /** Topic fields, for "mentions me"; empty when there are none, or the definition is sealed */
  readonly topics: ReadonlyArray<string>;
  /** How many records it holds now */
  readonly records: number;
}

/** A wake as the carrier holds it: what it looks at, where a click goes */
export interface WakeView {
  readonly id: string;
  readonly collection: string;
  /** The spaces it looks at, by name; empty for every space */
  readonly spaces: ReadonlyArray<string>;
  readonly open?: string;
  readonly paused: boolean;
}

interface Carried {
  readonly record: SpaceRecord;
  readonly hub: LocalHub;
  readonly runtime: SpaceRuntime;
  pod: Promise<SpaceRuntime> | null;
}

/** An account's carry space, as a carrying node holds it */
interface Carry {
  readonly account: string;
  /** The spaces it carries for it: those its passes named last time they were read, but those `full` or `skip` held back */
  wants: ReadonlySet<string>;
  /** Every space its passes named, carried or not */
  named: ReadonlySet<string>;
  /** Its wakes, by key, as last read */
  wakes: ReadonlyMap<string, Wake>;
}

export interface CarryCoreConfig {
  readonly key: CryptoKeyPair;
  readonly stores: StoreFactory;
  readonly network?: NodeNetworkConfig;
  readonly provider?: CryptoProvider;
  readonly watchIntervalMs?: number;
  readonly emit: (event: CarrierEvent) => void;
  /** An account wrote `carry:closed` into its carry space: it stopped using this node */
  readonly onClosed: (carrySpace: string) => void;
  /** A file store every carried space is also kept in — a host's bucket */
  readonly mirror?: BlobStore;
  /** A space nobody asks for any more was let go — not one opened again after a key change */
  readonly onRelease?: (spaceId: string) => Promise<void>;
  /**
   * Whether an account's carry space may name no more spaces: those it names
   * already stay, and a new one is taken only once this says no — a host's
   * storage limit
   */
  readonly full?: (carrySpace: string) => boolean;
  /**
   * Whether no account's passes carry this space, though they name it: only
   * a pass handed over alone does — a host's free line, for a community that
   * has to pay for itself
   */
  readonly skip?: (spaceId: string) => boolean;
  /** Versions that reached a carried space from a peer and passed its gates, a carry space's too */
  readonly onArrived?: (spaceId: string, version: Version) => void;
  /** Spaces one carry space may have carried at most: those its passes name past that wait */
  readonly most?: number;
}

/**
 * What a carrier and a host share: carry spaces — one per account it carries
 * for — and every space their passes name, each held once however many
 * accounts ask for it.
 */
export async function createCarryCore(config: CarryCoreConfig) {
  const provider = config.provider ?? createP256Provider();
  const signer = createSigner(provider);
  const schemas = createSchemaEngine();
  const { emit } = config;
  const did = await didOf(config.key.publicKey, provider);
  // It never writes, so it never needs a note; the session only names it on the wire.
  const session = { did, key: config.key.privateKey, proof: () => undefined };
  // The pod copy is a peer of its own on the local link, so it needs a name of its own.
  const podKeys = await provider.generateKeyPair();
  const podDid = await didOf(podKeys.publicKey, provider);
  const podSession = { did: podDid, key: podKeys.privateKey, proof: () => undefined };
  // Its own key outlives it, so its places in each log are kept; the pod's dies with it.
  const kept = await config.stores('writers');
  const writers = createWriters((writer) => (writer === did ? kept : null));

  // Carry spaces are joined like any space: their keys are the only ones a carrier holds.
  const registryStore = await config.stores('registry');
  const registry = createSpaceManager(registryStore, provider);

  let closed = false;
  let podStores: StoreFactory | null = null;
  const carries = new Map<string, Carry>();
  const carried = new Map<string, Carried>();
  /** Spaces carried from a pass handed over alone, not through a carry space: a space paying for itself */
  const direct = new Map<string, SpaceRecord>();

  const mesh = meshFor(config.network, did);
  const open = (
    record: SpaceRecord,
    stores: StoreFactory,
    as: typeof session,
    network: NodeNetworkConfig,
    onEvent: (event: NodeEvent) => void,
    onArrived?: (version: Version) => void,
  ) =>
    openSpaceRuntime({
      ...(onArrived ? { onArrived } : {}),
      // Carried spaces meet through relays; the copy in the pod only over the local link.
      ...(as === session && mesh ? { mesh } : {}),
      ...(as === session && config.mirror ? { mirrors: [config.mirror] } : {}),
      record,
      stores,
      provider,
      signer,
      schemas,
      session: as,
      writers,
      rootDid: as.did,
      network,
      watchIntervalMs: config.watchIntervalMs ?? 2000,
      // It keeps spaces for others: their files too, so they are there while the writer is away.
      fetchFiles: 'all',
      emit: onEvent,
    });

  function openPod(record: SpaceRecord, hub: LocalHub, stores: StoreFactory): Promise<SpaceRuntime> {
    const opening = open(record, stores, podSession, { transports: () => [hub.transport(podDid)] }, () => {});
    opening.catch(() => {
      // A folder that went away, or lost its permission; the carrier's own copy goes on.
      const held = carried.get(record.space.id);
      if (held?.pod === opening) held.pod = null;
      emit({ type: 'status', space: record.space.id });
    });
    return opening;
  }

  async function carry(record: SpaceRecord): Promise<void> {
    const spaceId = record.space.id;
    if (carried.has(spaceId) || closed) return;
    const hub = createLocalHub();
    const network: NodeNetworkConfig = {
      ...config.network,
      transports: (space, sessionDid) => [
        ...(config.network?.transports?.(space, sessionDid) ?? []),
        hub.transport(did),
      ],
    };
    const runtime = await open(
      record,
      config.stores,
      session,
      network,
      (event) => {
        if (event.type === 'records' || event.type === 'status') emit({ type: 'status', space: spaceId });
        if (event.type === 'records' && carries.has(spaceId)) void refresh();
      },
      (version) => {
        config.onArrived?.(spaceId, version);
        arrived(record, version);
      },
    );
    if (closed) return void (await runtime.close());
    const entry: Carried = { record, hub, runtime, pod: null };
    carried.set(spaceId, entry);
    if (podStores) entry.pod = openPod(record, hub, podStores);
  }

  /** Records already said something about — one can arrive twice, from a peer and from the pod */
  const noticed = new Set<string>();

  /** A record arrived in a space: does any wake of an account carrying it ask about it? */
  function arrived(record: SpaceRecord, version: Version): void {
    const spaceId = record.space.id;
    if (noticed.has(version.id) || carries.has(spaceId)) return;
    for (const entry of carries.values()) {
      if (!entry.wants.has(spaceId)) continue;
      for (const [id, wake] of entry.wakes) {
        if (!wakes(wake, spaceId, version, entry.account)) continue;
        noticed.add(version.id);
        if (noticed.size > 1000) noticed.delete(noticed.values().next().value!);
        emit({
          type: 'wake',
          wake: view(id, wake),
          space: { id: spaceId, name: record.space.name },
          record: { key: version.key, collection: version.collection, createdAt: version.createdAt },
        });
      }
    }
  }

  const view = (id: string, sub: Wake): WakeView => ({
    id,
    collection: sub.collection,
    spaces:
      sub.spaces === 'all'
        ? []
        : sub.spaces.map((space) => carried.get(space)?.record.space.name ?? 'a space'),
    ...(sub.open ? { open: sub.open } : {}),
    paused: sub.paused,
  });

  async function drop(spaceId: string): Promise<void> {
    const entry = carried.get(spaceId);
    if (!entry) return;
    carried.delete(spaceId);
    await (await entry.pod?.catch(() => null))?.close();
    await entry.runtime.close();
  }

  /** Carries what the passes say, and nothing else. */
  const refresh = serial(() =>
    refreshOnce().catch((error: unknown) => {
      if (!closed) console.error('Could not read a carry space:', error);
    }),
  );

  async function refreshOnce(): Promise<void> {
    if (closed) return;
    const wanted = new Map<string, SpaceRecord>();
    for (const [carrySpace, entry] of carries) {
      const carryRuntime = carried.get(carrySpace)?.runtime;
      if (!carryRuntime) continue;
      const records = (await carryRuntime.list<unknown>({ collection: PASS_COLLECTION })).filter(
        (record) => record.verified && record.root === entry.account,
      );
      if (records.some((record) => record.key === CARRY_CLOSED_KEY)) {
        entry.wants = new Set();
        entry.named = new Set();
        config.onClosed(carrySpace);
        continue;
      }
      const found = new Map<string, Wake>();
      for (const record of await carryRuntime.list<unknown>({ collection: WAKE_COLLECTION })) {
        if (!record.verified || record.root !== entry.account) continue;
        const wake = readWake(record.body);
        if (wake) found.set(record.key, wake);
      }
      entry.wakes = found;
      const wants = new Set<string>();
      const named = new Set<string>();
      const passes: OpenedPass[] = [];
      for (const record of records) {
        if (!record.key.startsWith('pass:')) continue;
        const pass = await openPass(record.body, provider);
        if (!pass || carries.has(pass.space.id)) continue;
        named.add(pass.space.id);
        if (!config.skip?.(pass.space.id)) passes.push(pass);
      }
      // What it carries already comes first, so a cap keeps those and turns away only new ones.
      passes.sort((a, b) => Number(entry.wants.has(b.space.id)) - Number(entry.wants.has(a.space.id)));
      for (const pass of passes) {
        // Over its limit: no new space, though one held already for someone else costs nothing more.
        const more = !entry.wants.has(pass.space.id) && !carried.has(pass.space.id);
        if (more && config.full?.(carrySpace)) continue;
        // Counted as it goes, so one handed over with thousands of passes takes no more than it may.
        if (config.most !== undefined && wants.size >= config.most) continue;
        wants.add(pass.space.id);
        // Two accounts naming one space: a pass for a later key beats one for the space's first,
        // since an account whose pass is behind just hasn't caught up yet.
        const known = wanted.get(pass.space.id);
        const later = (read: SpaceRecord['read']) => !!read && read.did !== pass.space.readKey;
        if (!known || (!later(known.read) && later(pass.read)))
          wanted.set(pass.space.id, carriedRecord(pass));
      }
      entry.wants = wants;
      entry.named = named;
    }
    for (const [spaceId, record] of direct) {
      const known = wanted.get(spaceId);
      const later = (read: SpaceRecord['read']) => !!read && read.did !== record.space.readKey;
      if (!known || (!later(known.read) && later(record.read))) wanted.set(spaceId, record);
    }
    let changed = false;
    for (const [spaceId, record] of wanted) {
      const held = carried.get(spaceId);
      if (held && held.record.read?.did === record.read?.did) continue;
      // The space's key changed: carried again, proving the new read key.
      if (held) await drop(spaceId);
      await carry(record);
      changed = true;
    }
    for (const spaceId of [...carried.keys()]) {
      if (carries.has(spaceId) || wanted.has(spaceId)) continue;
      await drop(spaceId);
      await config.onRelease?.(spaceId).catch(() => {});
      changed = true;
    }
    if (changed) emit({ type: 'spaces' });
  }

  const carriedView: ReadonlyMap<string, Carried> = carried;
  const carriesView: ReadonlyMap<string, Carry> = carries;
  return {
    did,
    podDid,
    carried: carriedView,
    carries: carriesView,
    /** Reads every carry space's passes again: after what `full` or `skip` says changed */
    refresh,

    /**
     * Starts carrying for an account: joins its carry space and every space
     * its passes name.
     * @returns The carry space's id
     * @throws When the invite is not a readable invite to a private space
     */
    async addCarry(account: string, invite: string): Promise<string> {
      const carrySpace = parseSpaceInvite(invite).space.id;
      const record = (await registry.get(carrySpace)) ?? (await registry.join(invite));
      if (record.space.visibility !== 'private' || !record.key) {
        await registry.remove(carrySpace);
        throw new Error('That is not an invite to a carry space.');
      }
      if (!carries.has(carrySpace))
        carries.set(carrySpace, { account, wants: new Set(), named: new Set(), wakes: new Map() });
      await carry(record);
      await refresh();
      return carrySpace;
    },

    /**
     * Carries one space from its pass alone, with no carry space: a space
     * whose members pay for it together. A later pass for the same space (its
     * key changed) replaces the one before.
     * @returns The space's id
     * @throws When the pass can't be opened
     */
    async addPass(value: unknown): Promise<string> {
      const pass = await openPass(value, provider);
      if (!pass) throw new Error('That is not a pass for a space.');
      if (carries.has(pass.space.id)) throw new Error('That is a carry space, not a space to carry.');
      direct.set(pass.space.id, carriedRecord(pass));
      await refresh();
      return pass.space.id;
    },

    /** Stops carrying a space held from its pass alone, unless an account's passes still name it */
    async removePass(spaceId: string): Promise<void> {
      if (!direct.delete(spaceId)) return;
      await refresh();
    },

    /** The read key a space is carried with now, as a DID: null for a public space, or one not carried */
    readKeyOf: (spaceId: string): string | null => carried.get(spaceId)?.record.read?.did ?? null,

    /** Stops carrying for an account: its carry space, and every space nobody else still asks for */
    async removeCarry(carrySpace: string): Promise<void> {
      if (!carries.delete(carrySpace)) return;
      await drop(carrySpace);
      await registry.remove(carrySpace);
      await config.onRelease?.(carrySpace).catch(() => {});
      await refresh();
    },

    /**
     * Also keeps every carried space in a pod — stores rooted at the account's
     * data path in it. Null stops writing there; the carrier's own copy goes on.
     */
    setPod: async (stores: StoreFactory | null) => {
      podStores = stores;
      for (const entry of carried.values()) {
        const was = entry.pod;
        entry.pod = null;
        await (await was?.catch(() => null))?.close();
        if (stores) entry.pod = openPod(entry.record, entry.hub, stores);
      }
      emit({ type: 'spaces' });
    },

    /** The account's wakes, as this carrier holds them */
    wakes: async (): Promise<ReadonlyArray<WakeView>> => {
      await refresh.done();
      return [...carries.values()].flatMap((entry) => [...entry.wakes].map(([id, wake]) => view(id, wake)));
    },

    /** What a carried space holds, by kind — what the extension can offer to notify about. Empty for a space it doesn't carry. */
    collections: async (spaceId: string): Promise<ReadonlyArray<CarriedCollection>> => {
      const entry = carried.get(spaceId);
      if (!entry || carries.has(spaceId)) return [];
      return (await entry.runtime.collections()).map((found) => ({
        name: found.name,
        ...(found.title ? { title: found.title } : {}),
        topics: found.topics,
        records: found.records,
      }));
    },

    spaces: async (): Promise<ReadonlyArray<CarriedSpace>> => {
      const found: CarriedSpace[] = [];
      for (const [spaceId, entry] of carried) {
        const status = await entry.runtime.status();
        found.push({
          id: spaceId,
          name: entry.record.space.name,
          visibility: entry.record.space.visibility,
          carry: carries.has(spaceId),
          connection: status.connection,
          peers: status.peers.filter((peer) => peer !== podDid).length,
          inPod: entry.pod !== null,
        });
      }
      return found;
    },

    async close() {
      if (closed) return;
      closed = true;
      await refresh.done();
      await Promise.all([...carried.keys()].map((spaceId) => drop(spaceId)));
      await registryStore.close();
    },
  };
}

/** A carrier, as `createCarrierNode` starts it */
export type CarrierNode = Awaited<ReturnType<typeof createCarrierNode>>;

/**
 * Starts a carrier.
 * @throws When the carry invite is not a readable invite to a private space
 */
export async function createCarrierNode(config: CarrierConfig) {
  const events = createListeners<CarrierEvent>('carrier');
  const core = await createCarryCore({
    ...config,
    emit: events.emit,
    onClosed: () => events.emit({ type: 'closed' }),
  });
  const carrySpace = await core.addCarry(config.account, config.carry);
  return Object.freeze({
    did: core.did,
    /** The carry space's id */
    carrySpace,
    spaces: core.spaces,
    usePod: core.setPod,
    wakes: core.wakes,
    collections: core.collections,
    subscribe: events.subscribe,
    async close() {
      await core.close();
      events.clear();
    },
  });
}
