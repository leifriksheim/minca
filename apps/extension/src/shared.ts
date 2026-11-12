/**
 * What the extension's pages share: the messages between them, the one record
 * it keeps (the grant), and how it reads the build's settings.
 *
 * Four pieces:
 *
 * - **worker** — the service worker. Chrome stops it after half a minute of
 *   quiet, so it only makes sure the offscreen page exists, sets the badge,
 *   and shows notifications.
 * - **offscreen** — a hidden page that lives as long as Chrome does. The
 *   node runs here.
 * - **welcome** — a full tab: connecting to the account home, the pod, status.
 * - **popup** — the toolbar button: status at a glance.
 *
 * The offscreen page may only use `chrome.runtime`, so everything it keeps is
 * in IndexedDB, which every page of the extension shares.
 */
import type { P2PNode } from '@minca/core';
import { GRANT_VERSION, MAX_GRANT_DAYS, type ConnectOptions, type Grant } from '@minca/core/session';
import type { Shown } from '@minca/app-shared/notify';

declare const __MINCA_HOME__: string;
declare const __MINCA_RELAYS__: string;

/** The account home offered first; people can type their own */
export const DEFAULT_HOME = __MINCA_HOME__;

/** Relays built in; the home's own arrive with the grant */
export const BUILT_IN_RELAYS: ReadonlyArray<string> = __MINCA_RELAYS__
  .split(',')
  .map((url) => url.trim())
  .filter(Boolean);

/** What the extension calls itself to the home */
const EXTENSION_NAME = 'Minca for Chrome';

/** The name its key is kept under (`appKey`) */
export const KEY_NAME = 'app';

/**
 * What it asks the home for: every space, to write records in and nothing
 * more, for as long as a home gives. Write, not read, so that disconnecting
 * it revokes its key, and it hears that and forgets.
 */
export const CONNECT_REQUEST: ConnectOptions['request'] = {
  name: EXTENSION_NAME,
  access: 'write',
  scope: 'account',
  recordsOnly: true,
  days: MAX_GRANT_DAYS,
};

/** With this many days left, it starts asking to be connected again */
export const RENEW_WITHIN_DAYS = 14;

/** Whole days until a grant runs out; zero or less once it has */
export const daysLeft = (expiresAt: number) => Math.floor((expiresAt - Date.now() / 1000) / 86_400);

/** How the pod is doing */
export type PodState =
  /** No folder has been picked here */
  | 'not-picked'
  /** Picked, but Chrome wants a click before it may be written again */
  | 'needs-permission'
  /** Being kept up to date */
  | 'writing';

/** A space it keeps online, and whether it reaches anyone there */
export interface KeptSpace {
  readonly id: string;
  readonly name: string;
  readonly connection: Awaited<ReturnType<P2PNode['spaces']['status']>>['connection'];
  readonly peers: number;
}

export interface ExtensionStatus {
  /** `expired`: its grant ran out, and it syncs nothing until it is connected again */
  readonly state: 'not-connected' | 'starting' | 'running' | 'expired' | 'error';
  /** Set when the account stopped using this extension, until it connects again */
  readonly removed?: boolean;
  readonly account?: { readonly name: string; readonly did: string; readonly home: string };
  /** When its grant runs out, Unix seconds */
  readonly expiresAt?: number;
  readonly spaces: ReadonlyArray<KeptSpace>;
  readonly pod: { readonly state: PodState; readonly folder: string | null };
  readonly error?: string;
}

/** Messages to the offscreen page, and what it answers */
export type Request =
  | { readonly to: 'offscreen'; readonly type: 'status' }
  /** The grant or the pod changed: start again from what is stored */
  | { readonly to: 'offscreen'; readonly type: 'reload' }
  /** Forget everything */
  | { readonly to: 'offscreen'; readonly type: 'disconnect' };

/** Messages to the worker */
export type WorkerMessage =
  | { readonly to: 'worker'; readonly type: 'ensure' }
  | { readonly to: 'worker'; readonly type: 'badge'; readonly status: ExtensionStatus }
  /** Something the account asked to hear about arrived: a burst in one space */
  | { readonly to: 'worker'; readonly type: 'notify'; readonly shown: Shown };

/** Broadcast by the offscreen page whenever the status changes */
export interface StatusChanged {
  readonly to: 'pages';
  readonly type: 'status';
  readonly status: ExtensionStatus;
}

/** Asks the offscreen page something, making sure it is running first. */
export async function ask(request: Request): Promise<ExtensionStatus> {
  await chrome.runtime.sendMessage({ to: 'worker', type: 'ensure' } satisfies WorkerMessage);
  return chrome.runtime.sendMessage(request);
}

// ─── The grant, kept in IndexedDB ───────────────────────────────────────

const DB = 'minca-extension';
const STORE = 'kv';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error(`Could not open ${DB}`));
  });
}

async function kv<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = run(db.transaction(STORE, mode).objectStore(STORE));
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- each key only ever holds what its save function below put there
      request.onsuccess = () => resolve(request.result as T);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
    });
  } finally {
    db.close();
  }
}

export const loadGrant = () =>
  kv<Grant | undefined>('readonly', (store) => store.get('grant')).then((grant) =>
    // One kept in another format, a carrier's from before among them, connects nothing now.
    grant?.v === GRANT_VERSION ? grant : null,
  );
export const saveGrant = (grant: Grant) => kv<void>('readwrite', (store) => store.put(grant, 'grant'));
export const forgetGrant = () => kv<void>('readwrite', (store) => store.delete('grant'));

/** The account's folder inside the pod the person picked: its path there, and the pod's name to show */
export interface PickedPod {
  readonly dataPath: string;
  readonly folder: string;
}
export const loadPickedPod = () =>
  kv<PickedPod | undefined>('readonly', (store) => store.get('pod')).then((pod) => pod ?? null);
export const savePickedPod = (pod: PickedPod) => kv<void>('readwrite', (store) => store.put(pod, 'pod'));
export const forgetPickedPod = () => kv<void>('readwrite', (store) => store.delete('pod'));

/** Which grant's end it has already said is near, so it says so once */
export const loadWarnedExpiry = () =>
  kv<number | undefined>('readonly', (store) => store.get('warned')).then((at) => at ?? null);
export const saveWarnedExpiry = (expiresAt: number) =>
  kv<void>('readwrite', (store) => store.put(expiresAt, 'warned'));

/** Whether the account removed this extension last time — shown once, until it connects again */
export const loadRemoved = () =>
  kv<boolean | undefined>('readonly', (store) => store.get('removed')).then(Boolean);
export const setRemoved = (removed: boolean) =>
  kv<void>('readwrite', (store) => store.put(removed, 'removed'));

/** The databases its node keeps one account in: the ones `startConnectedNode` opens */
export const storePrefix = (did: string) => `minca-app:${did}`;
