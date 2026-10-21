/**
 * `minca app-node`: an app's node for the desktop shell (`apps/desktop`), in
 * a process of its own, so it keeps running with the app's window closed.
 *
 * In a browser the app's node lives in the page's worker, with a key the page
 * can't export. Here the shell starts this instead, and the window uses it
 * over a port, as a page uses its worker. One process holds the key, so the
 * window and the menu bar are one node: two signing with one key would fork
 * its lines (spec 02 §4.10).
 *
 * The folder holds the app's key (`key.sealed`), its grant (`grant.sealed`)
 * and its stores (`store/`, whose registry is sealed as spec 05 §15 seals an
 * account's). All are sealed under a key the shell keeps in the system's
 * keychain and hands over on stdin, never in an argument or the environment:
 * the folder alone opens nothing.
 *
 * It talks to the shell in JSON lines, stdin and stdout. The shell routes
 * them: the window's port, and the account home's window when connecting.
 * It listens on no port.
 */
import { mkdir, readdir, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import {
  base64UrlDecode,
  base64UrlEncode,
  createNode,
  didOf,
  directoryStores,
  openValue,
  sealValue,
  serveNode,
  watchNotifications,
  type P2PNode,
  type RootSigner,
} from '@minca/core';
import {
  checkGrant,
  connectToHome,
  GRANT_VERSION,
  grantSigner,
  joinGranted,
  nodeOptionsFromGrant,
  type ConnectRequest,
  type Grant,
} from '@minca/core/session';
import { openFsDirectory, writeWhole } from './fs-directory.js';
import { configuredRelays, enableWebRTC } from './agent.js';
import { isRecord, messageOf } from './json.js';
import { holdLock } from './writer-keys.js';

/** How long the shell asks a note to last: the home decides, and the key is sealed by the keychain */
export const DESKTOP_GRANT_DAYS = 30;

/** Labels of what is sealed in the folder, each bound to its file */
const KEY_LABEL = 'minca/desktop-app-key/v1';
const GRANT_LABEL = 'minca/desktop-grant/v1';

/** The window's view of the connection, as `MincaConnectionState` has it, less the node */
export type AppNodeStatus = 'starting' | 'disconnected' | 'connecting' | 'ready' | 'expired';

/** What it says to the shell, one JSON line each */
export type AppNodeOut =
  | {
      readonly t: 'state';
      readonly status: AppNodeStatus;
      readonly home: string | null;
      /** The grant, less the keys it carries: the window shows it, and never needs them */
      readonly grant: Grant | null;
      readonly error: string | null;
      /** Which serving of the node the window's port messages belong to; new each time */
      readonly session: number;
    }
  /** The window's port */
  | { readonly t: 'port'; readonly session: number; readonly data: unknown }
  /** The account home's window, while connecting: open it, post to it, close it */
  | { readonly t: 'home-open'; readonly url: string }
  | { readonly t: 'home-post'; readonly data: unknown; readonly origin: string }
  | { readonly t: 'home-close' }
  /** One of the app's automations matched a record that arrived */
  | { readonly t: 'notify'; readonly title: string; readonly space: string; readonly record: string };

/*
 * What the shell says, one JSON line each. First `init`: `sealKey` (32 bytes
 * from the keychain, base64url), `origin` (the app's), and `relays`, `nodes`
 * and `hosts`. Then any of: `connect` (`home`, `request`), `disconnect`,
 * `attach` and `detach` (the window opened or closed), `port` (`session`,
 * `data`), `home-message` (`data`, `origin`) and `home-closed`.
 */

/**
 * JSON for what crosses: bytes as a tagged base64url string, since a port
 * clones them and a line of JSON can't. The window decodes the same way
 * (`apps/example/src/desktop.ts`).
 */
const BYTES = '\u0000bytes';
export function encodeWire(value: unknown): unknown {
  if (value instanceof Uint8Array) return { [BYTES]: base64UrlEncode(value) };
  if (value instanceof ArrayBuffer) return { [BYTES]: base64UrlEncode(new Uint8Array(value)) };
  if (Array.isArray(value)) return value.map(encodeWire);
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) if (item !== undefined) out[key] = encodeWire(item);
    return out;
  }
  return value;
}
export function decodeWire(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeWire);
  if (isRecord(value)) {
    const bytes = value[BYTES];
    if (typeof bytes === 'string' && Object.keys(value).length === 1) return base64UrlDecode(bytes);
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = decodeWire(item);
    return out;
  }
  return value;
}

/** A grant without the keys in it: the account key, the contact key, and each space's member key */
function shownGrant(grant: Grant): Grant {
  const { accountKey: _account, contactKey: _contact, ...rest } = grant;
  return {
    ...rest,
    spaces: grant.spaces.map(({ memberKey: _member, ...space }) => space),
  };
}

/** What the window may ask for: an app's own connection, never a carrier's or a program's, for as long as the shell says */
function desktopRequest(raw: unknown): Omit<ConnectRequest, 'v' | 'audience' | 'proof' | 'via'> {
  if (!isRecord(raw)) throw new Error('The window asked for nothing.');
  const access = raw.access === 'read' ? 'read' : 'write';
  return {
    access,
    ...(typeof raw.name === 'string' ? { name: raw.name.slice(0, 80) } : {}),
    ...(raw.scope === 'account' || raw.scope === 'spaces' ? { scope: raw.scope } : {}),
    ...(raw.contacts === true ? { contacts: true } : {}),
    ...(raw.chooseSpaces === false ? { chooseSpaces: false } : {}),
    ...(raw.recordsOnly === true ? { recordsOnly: true } : {}),
    ...(Array.isArray(raw.create) ? { create: raw.create } : {}),
    days: DESKTOP_GRANT_DAYS,
  };
}

async function sealKeyFrom(text: string): Promise<CryptoKey> {
  const bytes = base64UrlDecode(text);
  if (bytes.length !== 32) throw new Error('The sealing key must be 32 bytes.');
  return globalThis.crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
}

/**
 * The app's key: made once, sealed in the folder, and used here only as a key
 * that can't be exported. Null when the one there doesn't open with this
 * keychain's key.
 */
async function appNodeKey(
  folder: string,
  seal: CryptoKey,
): Promise<{ keys: CryptoKeyPair; did: string } | null> {
  const text = await readFile(path.join(folder, 'key.sealed'), 'utf8').catch(() => null);
  if (text !== null) {
    const jwk = await openValue(seal, KEY_LABEL, { file: 'key.sealed' }, text.trim());
    if (!isRecord(jwk)) return null;
    if (!isRecord(jwk.privateKey) || !isRecord(jwk.publicKey)) return null;
    return importKey(jwk.privateKey, jwk.publicKey);
  }
  const made = await newKey();
  await made.keep(folder, seal);
  return made.key;
}

async function importKey(
  privateJwk: Record<string, unknown>,
  publicJwk: Record<string, unknown>,
): Promise<{ keys: CryptoKeyPair; did: string }> {
  const subtle = globalThis.crypto.subtle;
  const algorithm = { name: 'ECDSA', namedCurve: 'P-256' };
  const keys = {
    privateKey: await subtle.importKey('jwk', privateJwk, algorithm, false, ['sign']),
    publicKey: await subtle.importKey('jwk', publicJwk, algorithm, true, ['verify']),
  };
  return { keys, did: await didOf(keys.publicKey) };
}

/** A new key for the app, not yet kept: `keep` seals it into the folder, in place of the last */
async function newKey() {
  const subtle = globalThis.crypto.subtle;
  const made = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = {
    privateKey: await subtle.exportKey('jwk', made.privateKey),
    publicKey: await subtle.exportKey('jwk', made.publicKey),
  };
  // Used only as a key that can't be exported; the sealed copy is the one way to it.
  const algorithm = { name: 'ECDSA', namedCurve: 'P-256' };
  const keys = {
    privateKey: await subtle.importKey('jwk', jwk.privateKey, algorithm, false, ['sign']),
    publicKey: await subtle.importKey('jwk', jwk.publicKey, algorithm, true, ['verify']),
  };
  const key = { keys, did: await didOf(keys.publicKey) };
  return {
    key,
    keep: async (folder: string, seal: CryptoKey) =>
      writeWhole(
        path.join(folder, 'key.sealed'),
        `${await sealValue(seal, KEY_LABEL, { file: 'key.sealed' }, jwk)}\n`,
      ),
  };
}

async function loadGrant(
  folder: string,
  seal: CryptoKey,
): Promise<{ grant: Grant; request: unknown } | null> {
  const text = await readFile(path.join(folder, 'grant.sealed'), 'utf8').catch(() => null);
  if (text === null) return null;
  const kept = await openValue(seal, GRANT_LABEL, { file: 'grant.sealed' }, text.trim());
  if (!isRecord(kept) || !isRecord(kept.grant) || kept.grant.v !== GRANT_VERSION) return null;
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- written by saveGrant; checkGrant checks it before use
  return { grant: kept.grant as unknown as Grant, request: kept.request };
}

const saveGrant = async (folder: string, seal: CryptoKey, grant: Grant, request: unknown) =>
  writeWhole(
    path.join(folder, 'grant.sealed'),
    `${await sealValue(seal, GRANT_LABEL, { file: 'grant.sealed' }, { grant, request })}\n`,
  );

const expired = (grant: Grant) => grant.expiresAt <= Math.floor(Date.now() / 1000);

/**
 * Runs until stdin ends. `send` writes a line for the shell; `lines` are the
 * shell's. Globals a page would have (`open`, `location`, message events) are
 * lent to `connectToHome` for one call, as the carrier's connect does.
 */
export async function runAppNode(options: {
  readonly data: string;
  readonly lines: AsyncIterable<string>;
  readonly send: (message: AppNodeOut) => void;
  readonly log: (line: string) => void;
  /** Starts the node; a test hands in one that stays offline */
  readonly start?: (params: StartParams) => Promise<P2PNode>;
}): Promise<void> {
  const { data: folder, send, log } = options;
  const iterator = options.lines[Symbol.asyncIterator]();
  const first = await iterator.next();
  const init: unknown = first.done ? null : JSON.parse(first.value);
  if (
    !isRecord(init) ||
    init.t !== 'init' ||
    typeof init.sealKey !== 'string' ||
    typeof init.origin !== 'string'
  )
    throw new Error('The shell must say init first, with the sealing key and the app’s origin.');
  const seal = await sealKeyFrom(init.sealKey);
  const origin = init.origin;
  const strings = (value: unknown) =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  const network = { relays: strings(init.relays), nodes: strings(init.nodes), hosts: strings(init.hosts) };

  /** One process signs with the key: two at once would fork its lines */
  const lockFolder = async () => {
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const held = await holdLock(path.join(folder, 'lock'));
    if (!held) throw new Error('Another app node is running from this folder.');
    return held;
  };
  let release = await lockFolder();
  let found = await appNodeKey(folder, seal);
  if (!found) {
    // Sealed under a key the keychain no longer has: nothing here opens, so it
    // is set aside, not deleted, and this starts again as a new connection.
    await release();
    const aside = `${folder}.unreadable-${Date.now()}`;
    await rename(folder, aside);
    log(`The folder doesn’t open with the keychain’s key; moved to ${aside}.`);
    release = await lockFolder();
    found = await appNodeKey(folder, seal);
    if (!found) throw new Error('A new key for the app does not open.');
  }
  let key = found;
  const start = options.start ?? startDesktopNode;
  /** Each account's stores apart, as a browser keeps them (`minca-app:<did>`) */
  const storesRoot = path.join(folder, 'store');
  const storesFor = (did: string) => path.join(storesRoot, did.replace(/[^A-Za-z0-9]/g, '_'));

  let grant: Grant | null = null;
  let request: unknown = null;
  let node: P2PNode | null = null;
  let status: AppNodeStatus = 'starting';
  let error: string | null = null;
  let session = 0;
  let attached = false;
  let stopServing: (() => void) | null = null;
  let stopWatching: (() => void) | null = null;
  let expiry: ReturnType<typeof setTimeout> | null = null;
  /** Counts connections asked for, and disconnections: an answer to one that was superseded is dropped */
  let generation = 0;
  const portListeners = new Set<(event: MessageEvent) => void>();

  const say = () =>
    send({
      t: 'state',
      status,
      home: grant?.home ?? null,
      grant: grant ? shownGrant(grant) : null,
      error,
      session,
    });

  /** The note the node acts under: the newest grant's */
  const signer = grantSigner(() => grant);

  /** Serves the node to the window, anew: a window that loaded again gets a session of its own */
  function serve(): void {
    stopServing?.();
    stopServing = null;
    if (!attached || !node || status !== 'ready') return;
    session += 1;
    const mine = session;
    const port = {
      postMessage: (message: unknown) => send({ t: 'port', session: mine, data: encodeWire(message) }),
      addEventListener: (_type: 'message', listener: (event: MessageEvent) => void) =>
        void portListeners.add(listener),
      removeEventListener: (_type: 'message', listener: (event: MessageEvent) => void) =>
        void portListeners.delete(listener),
    };
    // The window's view: closing it lets go, and leaves the node running for the menu bar.
    stopServing = serveNode(Object.freeze({ ...node, close: async () => {} }), port);
  }

  function watchExpiry(): void {
    if (expiry) clearTimeout(expiry);
    if (!grant) return;
    const left = grant.expiresAt * 1000 - Date.now();
    expiry = setTimeout(
      () => {
        if (grant && expired(grant)) {
          // Nothing runs on a note that ran out: no automations, no syncing.
          status = 'expired';
          serve();
          void stop().then(say);
        } else watchExpiry();
      },
      Math.min(Math.max(left, 0), 2 ** 31 - 1),
    );
  }

  /** Stops the node, and what runs on it: the window's view and the automations */
  async function stop(): Promise<void> {
    stopWatching?.();
    stopWatching = null;
    stopServing?.();
    stopServing = null;
    const was = node;
    node = null;
    await was?.close().catch(() => {});
  }

  /**
   * Starts the node under a grant, anew each time: a renewed grant may give
   * less than the last. Only that account's stores are kept: another
   * account's spaces must never reach this one's registry.
   */
  async function open(next: Grant): Promise<void> {
    // Only a note made out to the key it signs with: anything else every peer refuses.
    await checkGrant(next, key.did);
    await stop();
    grant = next;
    const mine = storesFor(next.did);
    for (const entry of await readdir(storesRoot).catch(() => []))
      if (path.join(storesRoot, entry) !== mine)
        await rm(path.join(storesRoot, entry), { recursive: true, force: true });
    await mkdir(mine, { recursive: true, mode: 0o700 });
    const started = await start({ grant: next, key, stores: mine, seal, signer, network });
    node = started;
    started.subscribe((event) => {
      if (event.type === 'revoked' && node === started) void end('Your account home disconnected this app.');
    });
    stopWatching = watchNotifications(started, {
      origin,
      onNotify: ({ automation, record }) =>
        void started.spaces
          .get(record.space)
          .then((space) =>
            send({
              t: 'notify',
              title: automation.then.kind === 'notify' ? automation.then.text : automation.name,
              space: space?.name ?? '',
              record: record.key,
            }),
          )
          .catch(() => {}),
      onError: (problem) => log(`notifications: ${messageOf(problem)}`),
    });
    status = 'ready';
    error = null;
    watchExpiry();
    serve();
    say();
  }

  /**
   * Forgets the grant, what the node kept, and the key: a key the home has
   * revoked, or that the person disconnected, stays revoked, so connecting
   * again asks for a new one, as a browser's app does (`forgetAppKey`).
   */
  async function end(why: string | null): Promise<void> {
    generation += 1;
    if (expiry) clearTimeout(expiry);
    await stop();
    grant = null;
    request = null;
    status = 'disconnected';
    error = why;
    await rm(path.join(folder, 'grant.sealed'), { force: true });
    await rm(storesRoot, { recursive: true, force: true });
    await rm(path.join(folder, 'key.sealed'), { force: true });
    const fresh = await appNodeKey(folder, seal);
    if (fresh) key = fresh;
    say();
  }

  /** The shell has gone: stop, and keep everything for next time */
  async function shutdown(): Promise<void> {
    if (expiry) clearTimeout(expiry);
    await stop();
  }

  // The home's window while connecting, as a page would see its popup.
  let home: { closed: boolean; postMessage(data: unknown, origin: string): void; close(): void } | null =
    null;
  const events = new EventTarget();
  for (const name of ['addEventListener', 'removeEventListener', 'dispatchEvent'] as const)
    if (typeof Reflect.get(globalThis, name) !== 'function')
      Reflect.set(globalThis, name, Reflect.get(events, name).bind(events));

  /**
   * Asks the home with the app's key. Renewing keeps it, as a page's app
   * does: a new key would have the home revoke the last, withdrawing
   * whatever it wrote that the home hadn't seen (03 §6.4). Only leaving an
   * account changes it (`end`), so a grant for another account than the one
   * connected is not used: the app leaves the last account, and asks to be
   * connected again with a new key. One key never holds two accounts' notes.
   */
  async function connect(address: string, asked: unknown): Promise<void> {
    if (status === 'connecting') return;
    const was = status;
    const mine = ++generation;
    status = 'connecting';
    error = null;
    say();
    const saved = { open: Reflect.get(globalThis, 'open'), location: Reflect.get(globalThis, 'location') };
    let window: { closed: boolean; postMessage(data: unknown, origin: string): void; close(): void } | null =
      null;
    try {
      const wanted = desktopRequest(asked);
      window = {
        closed: false,
        postMessage: (message: unknown, target: string) =>
          send({ t: 'home-post', data: message, origin: target }),
        close: () => send({ t: 'home-close' }),
      };
      home = window;
      Reflect.set(globalThis, 'open', (url: unknown) => {
        send({ t: 'home-open', url: String(url) });
        return window;
      });
      Reflect.set(globalThis, 'location', { href: `${origin}/` });
      // connectToHome opens the window, and listens, before its first await.
      const asking = connectToHome({ home: address, request: wanted, key });
      Reflect.set(globalThis, 'open', saved.open);
      Reflect.set(globalThis, 'location', saved.location);
      const given = await asking;
      // Disconnected, or asked again, meanwhile: this answer is no longer wanted.
      if (mine !== generation) return;
      if (grant && grant.did !== given.did) {
        await end(
          `You were connected as ${grant.name}, and your account home answered as ${given.name}. Connect again to use ${given.name}.`,
        );
        return;
      }
      await saveGrant(folder, seal, given, wanted);
      request = wanted;
      await open(given);
    } catch (problem) {
      Reflect.set(globalThis, 'open', saved.open);
      Reflect.set(globalThis, 'location', saved.location);
      if (mine !== generation) return;
      // A grant that came but whose node didn't start leaves no node to be ready with.
      status = was === 'ready' && !node ? (grant && expired(grant) ? 'expired' : 'disconnected') : was;
      error = messageOf(problem);
      say();
    } finally {
      if (home === window) home = null;
    }
  }

  // What was kept from before.
  try {
    const kept = await loadGrant(folder, seal);
    if (kept) {
      await checkGrant(kept.grant, key.did);
      request = kept.request;
      if (expired(kept.grant)) {
        grant = kept.grant;
        status = 'expired';
        say();
      } else await open(kept.grant);
    } else {
      status = 'disconnected';
      say();
    }
  } catch (problem) {
    // A grant that isn't for this key: leave it all, key included, rather than ask with a key it may have reached.
    await end(messageOf(problem));
  }

  const handle = (raw: string) => {
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (!isRecord(message)) return;
    if (message.t === 'port' && message.session === session && attached) {
      const event = new MessageEvent('message', { data: decodeWire(message.data) });
      for (const listener of portListeners) listener(event);
    } else if (message.t === 'attach') {
      attached = true;
      serve();
      say();
    } else if (message.t === 'detach') {
      attached = false;
      stopServing?.();
      stopServing = null;
    } else if (message.t === 'connect' && typeof message.home === 'string') {
      // Renewing from the menu bar asks for what the window asked for last.
      void connect(message.home, message.request ?? request);
    } else if (message.t === 'disconnect') void end(null);
    else if (message.t === 'home-message' && home && typeof message.origin === 'string') {
      const event = new MessageEvent('message', { data: message.data, origin: message.origin });
      Object.defineProperty(event, 'source', { value: home });
      globalThis.dispatchEvent(event);
    } else if (message.t === 'home-closed' && home) home.closed = true;
  };

  for (;;) {
    const next = await iterator.next();
    if (next.done) break;
    handle(next.value);
  }
  await shutdown();
  await release();
}

export interface StartParams {
  readonly grant: Grant;
  readonly key: { keys: CryptoKeyPair; did: string };
  /** The stores' folder */
  readonly stores: string;
  /** Seals the registry: the space keys */
  readonly seal: CryptoKey;
  readonly signer: RootSigner;
  readonly network: { relays: string[]; nodes: string[]; hosts: string[] };
}

/** The node itself, as `startConnectedNode` starts a page's, from a folder whose registry is sealed */
async function startDesktopNode(params: StartParams): Promise<P2PNode> {
  await enableWebRTC();
  const { relays, ...keys } = nodeOptionsFromGrant(params.grant, [
    ...params.network.relays,
    ...configuredRelays(),
  ]);
  const node = await createNode({
    signer: params.signer,
    sessionKey: params.key.keys,
    stores: directoryStores(await openFsDirectory(params.stores), { localKey: params.seal }),
    cache: {},
    network: {
      relays,
      ...(params.network.nodes.length ? { nodes: params.network.nodes } : {}),
      ...(params.network.hosts.length ? { hosts: params.network.hosts } : {}),
    },
    ...keys,
  });
  await joinGranted(node, params.grant, () => {});
  return node;
}

/** stdin as lines, for `minca app-node` */
export function stdinLines(): AsyncIterable<string> {
  return createInterface({ input: process.stdin, crlfDelay: Infinity });
}
