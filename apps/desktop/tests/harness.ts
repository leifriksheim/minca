/**
 * The real preload (`page.ts`), run in a `vm` context for each window's top
 * page, wired to the real bridge (`bridge.ts`) and node link (`node-link.ts`)
 * the way `index.ts` wires them. Only the DOM and the socket are faked, and
 * only as far as the preload uses them.
 */
import vm from 'node:vm';
import { createBridge, type PaneHost } from '../src/bun/bridge.ts';
import { createNodeLink, nodeUrl, type LinkSocket } from '../src/bun/node-link.ts';
import { preloadFor } from '../src/bun/page.ts';

type Task = () => void;
type Listener = (event: unknown) => void;

export interface Heard {
  readonly data: unknown;
  readonly origin: unknown;
  readonly source: unknown;
}

export interface Page {
  readonly context: vm.Context;
  readonly heard: Heard[];
  /** The person clicks in the page: a trusted event, which no script in it can make */
  click(): void;
}

interface Win {
  readonly url: string;
  readonly popup: boolean;
  closed: boolean;
  page: Page;
  close(): void;
  /** The page loads again, at this address */
  load(url: string): void;
}

interface PageSetup {
  /** A frame, not the window's top page */
  readonly frame?: boolean;
  /** Runs in the page before anything else, as the page's own first script would after the preload */
  readonly before?: string;
}

function isFunction(value: unknown): value is (...args: unknown[]) => unknown {
  return typeof value === 'function';
}

/** Calls a function the page has, as the page would */
export function call(page: Page, name: string, ...args: unknown[]): unknown {
  const fn: unknown = Reflect.get(page.context, name);
  if (!isFunction(fn)) throw new Error(`the page has no ${name}`);
  return Reflect.apply(fn, page.context, args);
}

export function setupHarness() {
  const windows: Win[] = [];
  const external: string[] = [];
  /** What the system was asked to show */
  const notified: Array<{ title: string; body: string }> = [];
  /** What the app's window said to its node */
  const toNode: unknown[] = [];
  /** Every envelope a page handed Electrobun's bridge */
  const envelopes: string[] = [];
  const queue: Task[] = [];
  /** The pages' clock, in milliseconds; tests move it on */
  const clock = { now: 1_000_000 };
  const flush = () => {
    for (let i = 0; i < 10_000 && queue.length > 0; i++) queue.shift()?.();
  };

  /** A WebSocket as the page sees it, reaching the link as Bun's server would: from the page's origin */
  function socketFor(origin: string) {
    return class FakeSocket {
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: unknown }) => void) | null = null;
      constructor(url: string) {
        // It connects once the page has loaded, as a real one does: after the window is made.
        queue.push(() => {
          const request = new Request(url.replace(/^ws/, 'http'), { headers: { origin } });
          const token = link.accept(request);
          if (token === null) return;
          const socket: LinkSocket = {
            data: { token },
            send: (text) => queue.push(() => this.onmessage?.({ data: text })),
            close: () => {
              if (sockets.delete(socket)) link.closed(socket);
            },
          };
          sockets.add(socket);
          link.opened(socket);
          this.toLink = (text) => queue.push(() => link.message(socket, text));
          this.onopen?.();
        });
      }
      private toLink: ((text: string) => void) | null = null;
      // On the prototype, where the preload takes it from.
      send(text: string): void {
        this.toLink?.(text);
      }
    };
  }

  function makePage(url: string, preload: string, setup: PageSetup = {}): Page {
    const address = new URL(url);
    const listeners = new Map<string, Listener[]>();
    const heard: Heard[] = [];
    const fire = (type: string, event: unknown) => {
      for (const listener of listeners.get(type) ?? []) listener(event);
    };
    const listen = (type: string, listener: Listener) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    };
    const page: Page = {
      context: {},
      heard,
      click: () => {
        for (const type of ['pointerdown', 'mousedown', 'click']) fire(type, { type, isTrusted: true });
      },
    };
    const context: Record<string, unknown> = {
      URL,
      Uint8Array,
      WebSocket: socketFor(address.origin),
      crypto: globalThis.crypto,
      // As WebKit does when the shell runs a script: it counts as a gesture.
      navigator: { userActivation: { isActive: true } },
      performance: { now: () => clock.now },
      setTimeout: (task: Task) => queue.push(task),
      requestAnimationFrame: (task: Task) => queue.push(task),
      location: { origin: address.origin, href: address.href },
      MessageEvent: class {
        readonly type: string;
        readonly data: unknown;
        readonly origin: unknown;
        constructor(type: string, init: { data: unknown; origin: unknown }) {
          this.type = type;
          this.data = init.data;
          this.origin = init.origin;
        }
      },
      Element: class {},
      HTMLAnchorElement: class {},
      document: { addEventListener() {}, documentElement: { setAttribute() {} } },
      addEventListener: listen,
      dispatchEvent: (event: unknown) => {
        fire(String(Reflect.get(Object(event), 'type')), event);
        return true;
      },
      __electrobunWebviewId: 1,
      __electrobunEventBridge: {
        postMessage(envelope: string) {
          envelopes.push(envelope);
          const parsed: unknown = JSON.parse(envelope);
          const payload: unknown = Reflect.get(Object(parsed), 'payload');
          const detail: unknown = JSON.parse(String(Reflect.get(Object(payload), 'detail')));
          queue.push(() => bridge.receive(detail));
        },
      },
    };
    context.window = context;
    context.top = setup.frame ? {} : context;
    vm.createContext(context);
    Object.assign(page, { context });
    listen('message', (event) =>
      heard.push({
        data: Reflect.get(Object(event), 'data'),
        origin: Reflect.get(Object(event), 'origin'),
        source: Reflect.get(Object(event), 'source'),
      }),
    );
    vm.runInContext(preload, context);
    if (setup.before) vm.runInContext(setup.before, context);
    return page;
  }

  const sockets = new Set<LinkSocket>();
  const bridge = createBridge({
    preload: ({ secret, origin, popup, app, node }) =>
      preloadFor({
        secret,
        origin,
        popup,
        app,
        dragInset: app ? 28 : 0,
        nodeUrl: node ? nodeUrl(origin, node) : null,
      }),
    openExternal: (url) => external.push(url),
    notify: (shown) => notified.push(shown),
    open({ url, preload, popup, closed }) {
      const win: Win = {
        url,
        popup,
        closed: false,
        page: makePage(url, preload),
        close() {
          if (win.closed) return;
          win.closed = true;
          closed();
        },
        load(next) {
          win.page = makePage(next, preload);
        },
      };
      windows.push(win);
      const host: PaneHost = {
        run: (js) => {
          if (!win.closed) vm.runInContext(js, win.page.context);
        },
        close: () => win.close(),
        activate: () => {},
        drag: () => {},
        zoom: () => {},
      };
      return host;
    },
  });

  /** Opens the app's window, and returns it */
  function openApp(): Win {
    bridge.openWindow('http://127.0.0.1:47830/app', { width: 1200, height: 820 });
    const app = windows[windows.length - 1];
    if (!app) throw new Error('no window opened');
    return app;
  }

  const link = createNodeLink({
    origin: 'http://127.0.0.1:47830',
    isToken: (token) => bridge.isNodeToken(token),
    fromWindow: (message) => toNode.push(message),
  });

  return {
    bridge,
    link,
    sockets,
    windows,
    external,
    notified,
    envelopes,
    toNode,
    flush,
    openApp,
    makePage,
    clock,
  };
}
