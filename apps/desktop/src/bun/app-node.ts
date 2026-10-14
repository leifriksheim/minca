/**
 * The app's node, which the window and the menu bar share: `minca app-node`
 * (`packages/cli/src/app-node.ts`), run by the Bun this app ships, in a
 * process of its own. It keeps running with the window closed, so the
 * account's automations still notify, and the window opens onto a node that
 * is already up to date.
 *
 * The window uses it over a port, as a page uses its worker; the account home
 * opens in a window the shell is the opener of, at the app's origin, as the
 * app's popup would. Everything here only routes: the node holds the key,
 * and checks the grant.
 *
 * The node's folder is sealed under a key kept in the system's keychain
 * (`Bun.secrets`), handed to it on stdin. Copied without that key, the folder
 * opens nothing.
 */
import type { ShellWindow } from './bridge';

export type AppNodeStatus = 'starting' | 'disconnected' | 'connecting' | 'ready' | 'expired';

/** The connection as the node says it is: what the window and the menu bar show */
export interface AppNodeState {
  readonly status: AppNodeStatus;
  readonly home: string | null;
  /** The grant, less its keys: who is connected, until when */
  readonly grant: {
    readonly did: string;
    readonly name: string;
    readonly expiresAt: number;
    readonly [field: string]: unknown;
  } | null;
  readonly error: string | null;
  readonly session: number;
}

/** What the window and the node say to each other, through the shell */
export type WindowMessage =
  | { readonly kind: 'state'; readonly state: AppNodeState }
  | { readonly kind: 'port'; readonly session: number; readonly data: unknown };

export interface AppNode {
  readonly state: () => AppNodeState;
  /** The window says something: it loaded (`attach`), its port, connect or disconnect */
  fromWindow(message: unknown): void;
  /** The window closed: stop serving it, and keep the node */
  detach(): void;
  /** Asks the home again for what the window asked for last: from the menu bar */
  renew(): void;
  close(): void;
}

/** The keychain entry that seals the node's folder */
const KEYCHAIN = { service: 'org.minca.desktop', name: 'app-node-seal' };

/** The folder's sealing key, from the keychain: made once, on first run */
export async function keychainKey(
  secrets: {
    get(options: { service: string; name: string }): Promise<string | null>;
    set(options: { service: string; name: string; value: string }): Promise<void>;
  } = Bun.secrets,
): Promise<string> {
  const kept = await secrets.get(KEYCHAIN);
  if (kept && /^[A-Za-z0-9_-]{43}$/.test(kept)) return kept;
  // Something else under its name is left as it is: replacing it could lose what it holds.
  if (kept !== null)
    throw new Error(
      `The keychain holds something under ${KEYCHAIN.service} that Minca didn’t make. Remove it in Keychain Access to start again.`,
    );
  const made = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
  await secrets.set({ ...KEYCHAIN, value: made });
  return made;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stateFrom(message: Record<string, unknown>): AppNodeState | null {
  const { status, home, grant, error, session } = message;
  if (
    status !== 'starting' &&
    status !== 'disconnected' &&
    status !== 'connecting' &&
    status !== 'ready' &&
    status !== 'expired'
  )
    return null;
  const shown =
    isRecord(grant) &&
    typeof grant.did === 'string' &&
    typeof grant.name === 'string' &&
    typeof grant.expiresAt === 'number'
      ? { ...grant, did: grant.did, name: grant.name, expiresAt: grant.expiresAt }
      : null;
  return {
    status,
    home: typeof home === 'string' ? home : null,
    grant: shown,
    error: typeof error === 'string' ? error : null,
    session: typeof session === 'number' ? session : 0,
  };
}

export function createAppNode(options: {
  /** How to run the CLI: a command line, before `app-node` */
  readonly cli: ReadonlyArray<string>;
  /** Where the node keeps its key, its grant and its stores: a full path */
  readonly folder: string;
  /** The app's origin: what the home knows the app by */
  readonly origin: string;
  /** The home to ask when the window names none */
  readonly home: string;
  readonly network?: {
    readonly relays?: ReadonlyArray<string>;
    readonly nodes?: ReadonlyArray<string>;
    readonly hosts?: ReadonlyArray<string>;
  };
  /** The folder's sealing key (`keychainKey`) */
  readonly sealKey: () => Promise<string>;
  /** Opens the account home with the shell as its opener, at `origin` to the home */
  readonly openHome: (
    url: string,
    origin: string,
    hear: (event: { data: unknown; origin: string }) => void,
  ) => ShellWindow | null;
  /** Says something to the app's window, when it is open */
  readonly toWindow: (message: WindowMessage) => void;
  readonly changed: (state: AppNodeState) => void;
  /** One of the app's automations matched */
  readonly notify?: (match: { title: string; space: string; record: string }) => void;
  readonly log?: (line: string) => void;
}): AppNode {
  let state: AppNodeState = { status: 'starting', home: null, grant: null, error: null, session: 0 };
  let child: ReturnType<typeof Bun.spawn<'pipe', 'pipe', 'inherit'>> | null = null;
  let home: ShellWindow | null = null;
  let watchHome: ReturnType<typeof setInterval> | null = null;
  let attached = false;
  let closing = false;

  const say = (message: Record<string, unknown>) => {
    if (!child) return;
    void child.stdin.write(`${JSON.stringify(message)}\n`);
    void child.stdin.flush();
  };

  function homeGone(): void {
    if (watchHome) clearInterval(watchHome);
    watchHome = null;
    home = null;
  }

  function heard(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(message)) return;
    if (message.t === 'state') {
      const next = stateFrom(message);
      if (!next) return;
      state = next;
      options.changed(state);
      if (attached) options.toWindow({ kind: 'state', state });
    } else if (message.t === 'port' && typeof message.session === 'number') {
      if (attached) options.toWindow({ kind: 'port', session: message.session, data: message.data });
    } else if (message.t === 'home-open' && typeof message.url === 'string') {
      home?.close();
      homeGone();
      const opened = options.openHome(message.url, options.origin, ({ data, origin }) =>
        say({ t: 'home-message', data, origin }),
      );
      if (!opened) return say({ t: 'home-closed' });
      home = opened;
      // A page learns its popup closed by looking; the node, by being told.
      watchHome = setInterval(() => {
        if (home !== opened || !opened.closed) return;
        homeGone();
        say({ t: 'home-closed' });
      }, 250);
    } else if (message.t === 'home-post' && typeof message.origin === 'string') {
      home?.postMessage(message.data, message.origin);
    } else if (message.t === 'home-close') {
      home?.close();
    } else if (
      message.t === 'notify' &&
      typeof message.title === 'string' &&
      typeof message.space === 'string' &&
      typeof message.record === 'string'
    ) {
      options.notify?.({ title: message.title, space: message.space, record: message.record });
    }
  }

  async function start(): Promise<void> {
    const sealKey = await options.sealKey();
    if (closing) return;
    const running = Bun.spawn([...options.cli, 'app-node', '--data', options.folder], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'inherit',
      onExit: (_process, code) => {
        if (child !== running) return;
        child = null;
        homeGone();
        if (closing) return;
        state = { ...state, status: 'disconnected', error: `The app’s node stopped (${code}).` };
        options.changed(state);
        if (attached) options.toWindow({ kind: 'state', state });
      },
    });
    child = running;
    say({
      t: 'init',
      sealKey,
      origin: options.origin,
      ...(options.network?.relays ? { relays: options.network.relays } : {}),
      ...(options.network?.nodes ? { nodes: options.network.nodes } : {}),
      ...(options.network?.hosts ? { hosts: options.network.hosts } : {}),
    });
    if (attached) say({ t: 'attach' });
    let buffered = '';
    for await (const chunk of running.stdout.pipeThrough(new TextDecoderStream())) {
      buffered += chunk;
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      for (const line of lines) if (child === running) heard(line);
    }
  }

  void start().catch((error: unknown) => {
    state = {
      ...state,
      status: 'disconnected',
      error: error instanceof Error ? error.message : String(error),
    };
    options.log?.(`app node: ${state.error}`);
    options.changed(state);
  });

  return {
    state: () => state,
    fromWindow(message) {
      if (!isRecord(message)) return;
      if (message.kind === 'attach') {
        attached = true;
        // What it is now at once; the node says again once it serves this window.
        options.toWindow({ kind: 'state', state });
        say({ t: 'attach' });
      } else if (message.kind === 'port' && typeof message.session === 'number') {
        say({ t: 'port', session: message.session, data: message.data });
      } else if (message.kind === 'connect') {
        const asked = typeof message.home === 'string' ? message.home : (state.home ?? options.home);
        say({ t: 'connect', home: asked, request: message.request });
      } else if (message.kind === 'disconnect') say({ t: 'disconnect' });
    },
    detach() {
      attached = false;
      say({ t: 'detach' });
    },
    renew() {
      say({ t: 'connect', home: state.home ?? options.home });
    },
    close() {
      closing = true;
      home?.close();
      homeGone();
      // Ending stdin is how it stops: it closes the node and lets go of its folder.
      void child?.stdin.end();
    },
  };
}
