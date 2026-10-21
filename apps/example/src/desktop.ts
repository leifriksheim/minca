/**
 * In the desktop app (apps/desktop), this app's node runs in the shell, not
 * in the page: one node for the window and the menu bar, which keeps running
 * with the window closed. `desktopConnection` is the same `MincaConnection`
 * over it, so nothing else in the app changes. The menu bar is also told
 * which account the app is connected as. Anywhere else there is no shell,
 * and both do nothing.
 */
import { base64UrlDecode, base64UrlEncode, remoteNode, type P2PNode } from '@minca/core';
import {
  homeAddress,
  proposeToHome,
  type Grant,
  type MincaConnection,
  type MincaConnectionConfig,
  type MincaConnectionState,
} from '@minca/core/session';

interface NodeChannel {
  send(data: unknown): void;
  listen(listener: (data: unknown) => void): void;
}

interface Desktop {
  account(who: { readonly did: string; readonly name: string } | null): void;
  readonly node?: NodeChannel;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDesktop(value: unknown): value is Desktop {
  return isRecord(value) && typeof value.account === 'function';
}

function isChannel(value: unknown): value is NodeChannel {
  return isRecord(value) && typeof value.send === 'function' && typeof value.listen === 'function';
}

function desktop(): Desktop | null {
  const found: unknown = Reflect.get(globalThis, 'mincaDesktop');
  return isDesktop(found) ? found : null;
}

/**
 * JSON for what crosses to the shell: bytes as tagged base64url text, as the
 * node encodes them (`packages/cli/src/app-node.ts`).
 */
const BYTES = '\u0000bytes';
function encodeWire(value: unknown): unknown {
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
function decodeWire(value: unknown): unknown {
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

/** The connection as the node says it is */
interface NodeSaid {
  readonly status: MincaConnectionState['status'];
  readonly home: string | null;
  readonly grant: Grant | null;
  readonly error: string | null;
  readonly session: number;
}

function said(value: unknown): NodeSaid | null {
  if (!isRecord(value)) return null;
  const { status, home, grant, error, session } = value;
  if (
    status !== 'starting' &&
    status !== 'disconnected' &&
    status !== 'connecting' &&
    status !== 'ready' &&
    status !== 'expired'
  )
    return null;
  return {
    status,
    home: typeof home === 'string' ? home : null,
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the node checked it before keeping it, and strips its keys
    grant: isRecord(grant) ? (grant as unknown as Grant) : null,
    error: typeof error === 'string' ? error : null,
    session: typeof session === 'number' ? session : 0,
  };
}

/**
 * The app's connection through the desktop shell's node, or null outside the
 * desktop app. The shell connects to the home at this app's origin, with a
 * key of its own that never reaches the page.
 */
export function desktopConnection(
  config: Pick<MincaConnectionConfig, 'home' | 'request'>,
): MincaConnection | null {
  const channel = desktop()?.node;
  if (!isChannel(channel)) return null;

  let state: MincaConnectionState = Object.freeze({
    status: 'starting',
    home: homeAddress(config.home),
    grant: null,
    node: null,
    error: null,
    accounts: [],
  });
  const listeners = new Set<(state: MincaConnectionState) => void>();
  // The shell's node acts for one account: the one it is connected as is all there is to switch to.
  const update = (patch: Partial<MincaConnectionState>) => {
    const grant = patch.grant === undefined ? state.grant : patch.grant;
    const accounts = grant ? [{ did: grant.did, name: grant.name, expiresAt: grant.expiresAt }] : [];
    state = Object.freeze({ ...state, ...patch, accounts });
    for (const listener of listeners) listener(state);
  };
  /** Who waits for the node to say it has finished connecting or disconnecting */
  const settled = new Set<() => void>();

  /** The node as served to this page, one session at a time */
  let session = 0;
  let portListeners = new Set<(event: MessageEvent) => void>();

  function serve(said: NodeSaid): void {
    session = said.session;
    const mine = new Set<(event: MessageEvent) => void>();
    portListeners = mine;
    const port = {
      postMessage: (message: unknown) =>
        channel?.send({ kind: 'port', session: said.session, data: encodeWire(message) }),
      addEventListener: (_type: 'message', listener: (event: MessageEvent) => void) =>
        void mine.add(listener),
      removeEventListener: (_type: 'message', listener: (event: MessageEvent) => void) =>
        void mine.delete(listener),
    };
    void remoteNode(port).then(
      (node: P2PNode) => {
        if (session !== said.session) return;
        update({ status: 'ready', home: said.home ?? state.home, grant: said.grant, node, error: null });
      },
      (error: unknown) => update({ error: error instanceof Error ? error.message : String(error) }),
    );
  }

  channel.listen((data) => {
    if (!isRecord(data)) return;
    if (data.kind === 'port' && data.session === session) {
      const event = new MessageEvent('message', { data: decodeWire(data.data) });
      for (const listener of portListeners) listener(event);
      return;
    }
    if (data.kind !== 'state') return;
    const now = said(data.state);
    if (!now) return;
    if (now.status === 'ready') {
      // Ready to this page once it serves it, under a session of its own.
      if (now.session > 0 && now.session !== session) serve(now);
      else if (now.session === session && state.node) update({ grant: now.grant, error: null });
    } else {
      if (now.status === 'disconnected') {
        session = 0;
        portListeners = new Set();
      }
      update({
        status: now.status,
        home: now.home ?? state.home,
        grant: now.grant,
        node: now.status === 'disconnected' ? null : state.node,
        error: now.error,
      });
    }
    if (now.status !== 'connecting' && now.status !== 'starting') {
      for (const done of settled) done();
      settled.clear();
    }
  });

  const until = () => new Promise<void>((resolve) => settled.add(resolve));
  let started: Promise<void> | null = null;

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start() {
      started ??= (async () => {
        channel.send({ kind: 'attach' });
        await until();
      })();
      return started;
    },
    async connect(home) {
      let address: string;
      try {
        address = home === undefined ? state.home : homeAddress(home);
      } catch (error) {
        update({ error: error instanceof Error ? error.message : String(error) });
        return;
      }
      update({ status: 'connecting', error: null });
      channel.send({ kind: 'connect', home: address, request: config.request });
      await until();
    },
    async use(did) {
      if (state.grant?.did !== did)
        throw new Error('The desktop app acts for one account. Disconnect it to use another.');
    },
    async disconnect() {
      channel.send({ kind: 'disconnect' });
      await until();
    },
    async propose(automations) {
      if (!state.grant) throw new Error('Connect to your account home first.');
      const answer = await proposeToHome({
        home: state.grant.home,
        automations,
        ...(config.request.name ? { name: config.request.name } : {}),
      });
      // The home's window closes now: take what it wrote rather than wait to meet it over the network.
      if (Array.isArray(answer.versions) && answer.versions.length > 0)
        await state.node?.automations.take(answer.versions).catch(() => 0);
      return answer;
    },
  };
}

/**
 * The menu bar keeps this app's account's spaces online, and only that
 * account's: so it is told which account this app is connected as, whenever
 * that changes.
 */
export function tellDesktop(connection: MincaConnection): void {
  const shell = desktop();
  if (!shell) return;
  let told: string | null | undefined;
  const tell = () => {
    const { status, grant } = connection.getState();
    // Starting says nothing yet: the grant kept from before may still be loading.
    if (status === 'starting' || status === 'connecting') return;
    const who = status === 'ready' && grant ? { did: grant.did, name: grant.name } : null;
    if ((who?.did ?? null) === told) return;
    told = who?.did ?? null;
    shell.account(who);
  };
  connection.subscribe(tell);
  tell();
}
