/**
 * @module node-context
 * What every part of a node shares: the account and its spaces, the way to
 * open a space, and the small helpers each part would otherwise repeat.
 * `createNode` (`packages/core/src/node/node.ts`) makes one and hands it to
 * each part.
 */
import type { CryptoProvider } from '../types.js';
import type { ContactKeyPair } from '../identity/contact-key.js';
import type { LooseSigner } from '../records/loose.js';
import type { SpaceManager, SpaceRecord } from '../space/space-manager.js';
import type { MailboxClient } from '../network/relays.js';
import type { SpaceRuntime } from './space-runtime.js';
import type { DefineCollection, ListOptions, NodeConfig, NodeEvent, NodeRecord } from './types.js';
import { isRecord, unref } from '../utils/guards.js';

/** Which of the account's own spaces a space is */
export type OwnSpaceKind = 'registry' | 'contacts' | 'carry';

export interface NodeContext {
  readonly config: NodeConfig;
  readonly provider: CryptoProvider;
  /** The spaces this node holds, as its own store lists them */
  readonly registry: SpaceManager;
  /** The account registry, with an account key */
  readonly account: SpaceRecord | null;
  readonly accountSpaceId: string | null;
  /** The contacts space, when derived here from the account key */
  readonly contactsRecord: SpaceRecord | null;
  /** The contacts space: derived, or named in the config */
  readonly contactsSpaceId: string | null;
  /** The contact key, for a node allowed to open contact requests */
  readonly contactKeys: ContactKeyPair | null;
  /** The note doesn't let this node act as the account itself (spec 01 §8) */
  readonly narrowNote: boolean;
  readonly mailbox: MailboxClient;
  readonly emit: (event: NodeEvent) => void;
  readonly isClosed: () => boolean;
  /** What signs this node's loose versions — invitations, knocks */
  readonly looseSigner: () => LooseSigner;
  /** A space's runtime, opened on first use */
  readonly runtime: (spaceId: string) => Promise<SpaceRuntime>;
  /** The runtimes open now, or opening */
  readonly runtimes: ReadonlyMap<string, Promise<SpaceRuntime>>;
  readonly findRecord: (spaceId: string) => Promise<SpaceRecord | null>;
  /** Which of the account's own spaces this is, or null for one it uses */
  readonly kindOf: (spaceId: string) => Promise<OwnSpaceKind | null>;
  /** Takes in an invite; the space it is for may now have one waiting */
  readonly joinRegistry: (invite: string) => Promise<SpaceRecord>;
  /** The account registry, or why `what` can't be done without it */
  readonly requireAccount: (what: string) => Promise<SpaceRuntime>;
  /** What this account wrote in a collection that `check` takes: only it writes its own lists */
  readonly ownRecords: <T>(
    rt: SpaceRuntime,
    options: ListOptions,
    check?: (record: NodeRecord<T>) => boolean,
  ) => Promise<NodeRecord<T>[]>;
  /** The same, in the account registry; none without one */
  readonly accountRecords: <T>(
    options: ListOptions,
    check?: (record: NodeRecord<T>) => boolean,
  ) => Promise<NodeRecord<T>[]>;
}

/** What an error says: its message when it has one */
export function errorText(error: unknown): string {
  return String((isRecord(error) ? error.message : undefined) ?? error);
}

/** Lets work run on its own: a failure is dropped, and the next change tries again */
export function inBackground(work: Promise<unknown>): void {
  void work.catch(() => {});
}

/** Resolves after `ms`, without keeping the process alive */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => unref(setTimeout(resolve, ms)));
}

/** Whether `work` settled within `waitMs` */
export function within(work: Promise<unknown>, waitMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), waitMs);
    const settle = (done: boolean) => () => {
      clearTimeout(timer);
      resolve(done);
    };
    void work.then(settle(true), settle(false));
  });
}

/** The value `make` gives, or null if it throws */
export function attempt<T>(make: () => T): T | null {
  try {
    return make();
  } catch {
    return null;
  }
}

export const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** An address a device may reach: https://, or http:// on this machine */
export function checkAddress(address: string, what: string): URL {
  const url = new URL(address);
  const local = ['localhost', '127.0.0.1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))
    throw new Error(`${what} is reached over https://`);
  return url;
}

/** Defines a collection in a space that has none by that name yet */
export async function ensureDefined(open: SpaceRuntime, definition: DefineCollection): Promise<void> {
  if (
    (await open.collections()).some(
      (collection) => collection.name === definition.name && collection.version !== null,
    )
  )
    return;
  try {
    await open.define(definition);
  } catch {
    throw new Error(
      `This space has no ${definition.title ?? definition.name} collection yet, and you can't add one here. Ask someone who manages it.`,
    );
  }
}
