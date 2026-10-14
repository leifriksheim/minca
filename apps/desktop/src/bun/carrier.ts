/**
 * The tray's node: a carrier for the person's account, like the Chrome
 * extension, kept in a folder (`minca carry`, `packages/cli/src/carry.ts`).
 * It holds a pass for each space and nothing that reads or writes them, and it
 * listens on no port.
 *
 * Connecting it is the one thing done here: the account home opens in a
 * window the shell is the opener of (`openFromShell` in `bridge.ts`), and
 * core's own `connectCarrier()` asks it for a carry grant for the carrier's
 * key, and checks what comes back. The grant goes into the folder, and the
 * CLI carries from there.
 *
 * The home knows a connection by its origin, so the carrier asks from one of
 * its own, never the app's: the home keeps one carrier per origin and one app
 * per origin, and two of them sharing one would each look like the other.
 */
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { createP256Provider, didOf } from '@minca/core';
import { connectCarrier, type CarryGrant } from '@minca/core/session';
import type { ShellWindow } from './bridge';

export type CarrierState =
  | { readonly state: 'starting' }
  | { readonly state: 'not-connected' }
  | { readonly state: 'connecting' }
  | { readonly state: 'carrying'; readonly account: string; readonly name: string; readonly spaces: number }
  | { readonly state: 'paused' }
  | { readonly state: 'stopped'; readonly error: string };

export interface Carrier {
  /**
   * Asks the account home for a carry grant for `account`, the one the app is
   * connected as, then carries it. A grant for any other account is refused:
   * the menu bar keeps only the app's account online.
   */
  connect(account: { readonly did: string; readonly name: string }): Promise<void>;
  /**
   * Stops carrying here, and keeps the folder. Only the account takes a carrier
   * off (its home's Disconnect): until then it counts on what this one stored.
   */
  pause(): Promise<void>;
  resume(): void;
  close(): void;
}

/** Opens the account home with the shell as its opener, at `origin` to the home */
export type OpenHome = (
  url: string,
  origin: string,
  hear: (event: { data: unknown; origin: string }) => void,
) => ShellWindow | null;

const GRANT_FILE = 'carry-grant.json';
const KEY_FILE = 'carrier-key';

/**
 * The folder, made if it isn't there, and refused if it isn't this user's own:
 * the carrier's seed and the carry space's key live in it.
 */
export async function carrierFolder(folder: string): Promise<string> {
  if (!isAbsolute(folder)) throw new Error(`The carrier's folder must be a full path: ${folder}`);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  await ownFile(folder, 'directory');
  return folder;
}

/** Refuses a link, or anything another user owns or can read */
async function ownFile(file: string, kind: 'file' | 'directory'): Promise<boolean> {
  const found = await lstat(file).catch(() => null);
  if (!found) return false;
  const right = kind === 'file' ? found.isFile() : found.isDirectory();
  const uid = process.getuid?.();
  if (
    !right ||
    found.isSymbolicLink() ||
    (uid !== undefined && found.uid !== uid) ||
    (found.mode & 0o077) !== 0
  )
    throw new Error(`${file} is not this user's own ${kind}, readable by them alone.`);
  return true;
}

/**
 * The carrier's key, from the seed in its folder: the CLI reads the same file
 * the same way (`hostKey` in `packages/cli/src/host-setup.ts`), so both are
 * one key. Made here when it isn't there yet, readable by this user alone.
 * With it, the origin the carrier asks the home from: a name nobody else can
 * know (a hash of the seed), on `.localhost`. Anything on this machine could
 * serve a `.localhost` name, but not this one without knowing the seed.
 */
export async function carrierKey(
  folder: string,
): Promise<{ keys: CryptoKeyPair; did: string; origin: string }> {
  const file = join(await carrierFolder(folder), KEY_FILE);
  let seed: Uint8Array;
  if (await ownFile(file, 'file')) {
    seed = new Uint8Array(Buffer.from((await readFile(file, 'utf8')).trim(), 'base64url'));
  } else {
    seed = crypto.getRandomValues(new Uint8Array(32));
    await writeFile(file, `${Buffer.from(seed).toString('base64url')}\n`, { mode: 0o600, flag: 'wx' });
  }
  const pair = await createP256Provider().deriveKeyPairFromSeed(seed);
  const keys = { publicKey: pair.publicKey, privateKey: pair.privateKey };
  const label = new TextEncoder().encode('minca/desktop-carrier-origin/v1');
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array([...label, ...seed])));
  const name = Array.from(hash.slice(0, 10), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return { keys, did: await didOf(keys.publicKey), origin: `http://carrier-${name}.localhost` };
}

/**
 * `connectCarrier()` is a page's: it opens the home with `open()` and hears it
 * on `message` events. This worker is the shell's, so it gets those for the one
 * call: `open` is a window the shell opens, and what that window says arrives
 * as a `message` event whose `source` is it. The home opens, and core listens,
 * before the call's first await, so `open` and `location` are put back straight
 * after; a test holds core to that.
 */
export function connectThroughShell(params: {
  readonly home: string;
  readonly key: { keys: CryptoKeyPair; did: string; origin: string };
  readonly openHome: OpenHome;
}): Promise<CarryGrant> {
  const { origin } = params.key;
  let opened: ShellWindow | null = null;
  const open = (url: unknown) => {
    opened = params.openHome(String(url), origin, ({ data, origin: from }) => {
      const event = new MessageEvent('message', { data, origin: from });
      Object.defineProperty(event, 'source', { value: opened });
      globalThis.dispatchEvent(event);
    });
    return opened;
  };
  const saved = { open: Reflect.get(globalThis, 'open'), location: Reflect.get(globalThis, 'location') };
  Reflect.set(globalThis, 'open', open);
  Reflect.set(globalThis, 'location', { href: `${origin}/` });
  try {
    return connectCarrier({
      home: params.home,
      key: params.key,
      name: `Minca on ${hostname().replace(/\.local$/, '')}`,
    });
  } finally {
    Reflect.set(globalThis, 'open', saved.open);
    Reflect.set(globalThis, 'location', saved.location);
  }
}

function carryStatus(line: string): CarrierState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const state: unknown = Reflect.get(parsed, 'state');
  if (state === 'not-connected' || state === 'removed') return { state: 'not-connected' };
  if (state === 'carrying') {
    const account: unknown = Reflect.get(parsed, 'account');
    const name: unknown = Reflect.get(parsed, 'name');
    const spaces: unknown = Reflect.get(parsed, 'spaces');
    return {
      state: 'carrying',
      account: String(account),
      name: String(name),
      spaces: typeof spaces === 'number' ? spaces : 0,
    };
  }
  if (state === 'error') return { state: 'stopped', error: String(Reflect.get(parsed, 'error')) };
  return null;
}

export function createCarrier(options: {
  /** Where it keeps its key, its grant and what it carries: a full path */
  readonly folder: string;
  /** How to run the CLI: a command line, before `carry` */
  readonly cli: ReadonlyArray<string>;
  /** The account home it connects to */
  readonly home: string;
  readonly openHome: OpenHome;
  readonly changed: (state: CarrierState) => void;
}): Carrier {
  const { folder } = options;
  let child: ReturnType<typeof Bun.spawn> | null = null;
  let state: CarrierState = { state: 'starting' };
  const set = (next: CarrierState) => {
    state = next;
    options.changed(state);
  };

  function start(): void {
    void stop().then(() => {
      set({ state: 'starting' });
      const running = Bun.spawn([...options.cli, 'carry', '--data', folder], {
        stdout: 'pipe',
        stderr: 'inherit',
        onExit: (_process, code) => {
          if (child !== running) return;
          child = null;
          // Exiting 0 is how it says there is nothing (more) to carry.
          if (state.state === 'starting' || state.state === 'carrying')
            set(code === 0 ? { state: 'not-connected' } : { state: 'stopped', error: `exited (${code})` });
        },
      });
      child = running;
      void (async () => {
        let buffered = '';
        for await (const chunk of running.stdout.pipeThrough(new TextDecoderStream())) {
          buffered += chunk;
          const lines = buffered.split('\n');
          buffered = lines.pop() ?? '';
          for (const line of lines) {
            const next = carryStatus(line);
            if (next && child === running) set(next);
          }
        }
      })();
    });
  }

  /** Stops the CLI, and waits until it has, so nothing it writes lands after */
  async function stop(): Promise<void> {
    const running = child;
    child = null;
    if (!running) return;
    running.kill();
    await running.exited;
  }

  void carrierFolder(folder).then(start, (error: unknown) =>
    set({ state: 'stopped', error: error instanceof Error ? error.message : String(error) }),
  );
  return {
    async connect(account) {
      if (state.state === 'connecting') return;
      const before = state;
      set({ state: 'connecting' });
      try {
        const key = await carrierKey(folder);
        const grant = await connectThroughShell({ home: options.home, key, openHome: options.openHome });
        if (grant.did !== account.did)
          throw new Error(
            `That was “${grant.name}”, and Minca is connected as “${account.name}”: allow it from ${account.name}.`,
          );
        const file = join(folder, GRANT_FILE);
        // Another account's spaces aren't this one's to keep: what it carried goes.
        const was = await readFile(file, 'utf8').then(
          (text): unknown => Reflect.get(Object(JSON.parse(text)), 'did'),
          () => null,
        );
        if (was !== grant.did) {
          await stop();
          await rm(join(folder, 'store'), { recursive: true, force: true });
        }
        // Whole or not at all: the CLI may read it at any moment.
        const writing = `${file}.${crypto.randomUUID()}.tmp`;
        await writeFile(writing, JSON.stringify(grant), { mode: 0o600, flag: 'wx' });
        await rename(writing, file);
        start();
      } catch (error) {
        set(before);
        throw error;
      }
    },
    async pause() {
      await stop();
      set({ state: 'paused' });
    },
    resume: start,
    close: () => void stop(),
  };
}
