/**
 * The page's half of the popup bridge (`bridge.ts`), as the preload a window
 * is made with. It runs before the page's own scripts, and keeps what it
 * needs from then: the page may replace `JSON` or anything else later, and
 * must still never see the secret.
 */

export interface PageOptions {
  readonly secret: string;
  /** The origin this window was opened for; a page anywhere else gets nothing */
  readonly origin: string;
  /** Opened by another window: it has an opener */
  readonly popup: boolean;
  /** The app's own window, which says which account it is connected as */
  readonly app: boolean;
  /**
   * For the app's own window, which has no title bar: how far from the top
   * an empty spot drags the window. 0 for none.
   */
  readonly dragInset: number;
  /**
   * For the app's own window, the socket its node is reached over
   * (`node-link.ts`); null for every other window.
   */
  readonly nodeUrl: string | null;
}

export function preloadFor(options: PageOptions): string {
  // A bundler that keeps function names wraps them in __name; the page has none.
  return `(() => { const __name = (f) => f; (${page.toString()})(${JSON.stringify(options)}); })();`;
}

/** Runs in the page. Self-contained: it is sent as source. */
function page(options: PageOptions): void {
  if (window !== window.top || location.origin !== options.origin) return;
  const bridge: unknown = Reflect.get(window, '__electrobunEventBridge');
  const webviewId: unknown = Reflect.get(window, '__electrobunWebviewId');
  if (typeof bridge !== 'object' || bridge === null) return;
  const postToShell: unknown = Reflect.get(bridge, 'postMessage');
  if (typeof postToShell !== 'function') return;
  const post = postToShell;
  const stringify = JSON.stringify;
  const later = setTimeout;
  const defineProperty = Object.defineProperty;
  const apply = Reflect.apply;
  const dispatch = window.dispatchEvent.bind(window);
  const Message = MessageEvent;
  const parse = JSON.parse;
  const Socket = WebSocket;
  const socketSend: unknown = Reflect.get(Socket.prototype, 'send');

  // WebKit in this shell drops, without a word, any message to a SharedWorker
  // that holds a CryptoKey, and a node's worker is started with its session
  // key: it would never start, and each page would wait 30 s for it before
  // running the node itself. With none, pages use a dedicated worker, as in a
  // browser that has no shared ones. Each app here has one window anyway.
  defineProperty(window, 'SharedWorker', { value: undefined, configurable: true, writable: true });
  // A passkey in an app's web view works only for a domain the app is tied
  // to (Associated Domains, which needs a signed app and a file on that
  // domain); here WebKit offers no authenticator, so a passkey can only fail.
  // Without the API the account home offers a password, as in a browser
  // that has no passkeys.
  defineProperty(window, 'PublicKeyCredential', { value: undefined, configurable: true, writable: true });
  const random = crypto.getRandomValues.bind(crypto);
  const now = performance.now.bind(performance);
  // Whether the person just clicked or typed here, as a browser asks before it opens a popup.
  // Not navigator.userActivation: a script the shell runs, which is how every message
  // arrives, counts as a gesture to WebKit. Only the input itself is trusted, and the page
  // can't make that.
  let lastInput = -Infinity;
  for (const type of ['mousedown', 'pointerdown', 'keydown', 'touchend', 'click']) {
    window.addEventListener(
      type,
      (event) => {
        if (event.isTrusted) lastInput = now();
      },
      true,
    );
  }
  const clicked = () => now() - lastInput < 1000;

  // The secret is joined in by hand, never put in an object a page could reach with toJSON.
  const secret = stringify(options.secret);
  function send(message: object): void {
    const detail = '{"s":' + secret + ',"m":' + stringify(stringify(message)) + '}';
    const envelope =
      '{"id":"webviewEvent","type":"message","payload":{"id":' +
      stringify(webviewId) +
      ',"eventName":"host-message","detail":' +
      stringify(detail) +
      '}}';
    // Electrobun waits a tick before each event too (a race with Bun's FFI).
    later(() => {
      apply(post, bridge, [envelope]);
    });
  }

  interface Proxy {
    closed: boolean;
    postMessage(data: unknown, target?: unknown): void;
    close(): void;
    focus(): void;
  }

  function targetOrigin(target: unknown): string {
    const raw: unknown =
      typeof target === 'object' && target !== null ? Reflect.get(target, 'targetOrigin') : target;
    if (raw === undefined || raw === '/') return location.origin;
    if (raw === '*') return '*';
    // Throws on a bad one, as postMessage does.
    return new URL(typeof raw === 'string' ? raw : '').origin;
  }

  function proxy(to: string | null): Proxy {
    return {
      closed: false,
      postMessage(data, target) {
        send({ t: 'post', to, origin: targetOrigin(target), data: stringify(data) });
      },
      close() {
        send({ t: 'close', to: to ?? 'self' });
      },
      focus() {
        send({ t: 'focus', to: to ?? 'self' });
      },
    };
  }

  const opened = new Map<string, Proxy>();
  /** Who hears the app's node: the app's own window only */
  let nodeListener: ((data: unknown) => void) | null = null;
  // The node's socket, opened before the page's own scripts run, so its handlers are these.
  // What the page says before it opens waits for it.
  const nodeSocket = options.app && !options.popup && options.nodeUrl ? new Socket(options.nodeUrl) : null;
  let nodeWaiting: string[] | null = [];
  if (nodeSocket) {
    nodeSocket.onopen = () => {
      const waiting = nodeWaiting ?? [];
      nodeWaiting = null;
      for (const text of waiting) sendOnSocket(nodeSocket, text);
    };
    nodeSocket.onmessage = (event) => {
      if (nodeListener && typeof event.data === 'string') nodeListener(parse(event.data));
    };
  }
  function sendOnSocket(socket: WebSocket, text: string): void {
    if (typeof socketSend === 'function') apply(socketSend, socket, [text]);
  }
  function toNode(data: unknown): void {
    if (!nodeSocket) return;
    const text = stringify(data);
    if (nodeWaiting) nodeWaiting.push(text);
    else sendOnSocket(nodeSocket, text);
  }
  const opener = options.popup ? proxy(null) : null;

  defineProperty(window, 'open', {
    value: (url?: string | URL, name?: string, features?: string) => {
      let href: string;
      try {
        href = new URL(String(url ?? ''), location.href).href;
      } catch {
        return null;
      }
      if (!clicked()) return null;
      // A blank window opened on a click, to be sent somewhere once the page knows where
      // (a checkout): that address opens in the person's own browser, once.
      if (href === 'about:blank') {
        let sent = false;
        const go = (to: unknown) => {
          if (sent || typeof to !== 'string' || !/^https?:/.test(to)) return;
          sent = true;
          send({ t: 'external', url: to });
        };
        return {
          opener: null,
          closed: false,
          close() {},
          focus() {},
          postMessage() {},
          location: {
            set href(to: unknown) {
              go(to);
            },
            assign: go,
            replace: go,
          },
        };
      }
      if (!/^https?:/.test(href)) return null;
      // With no opener, the page can't reach back: the person's own browser, which shows its address too.
      if (/(?:^|,)\s*no(?:opener|referrer)\s*(?:$|,|=\s*(?:1|yes|true))/i.test(features ?? '')) {
        send({ t: 'external', url: href });
        return null;
      }
      // Random, so a page loaded again can't name a window the last one opened.
      const ref =
        'w' + Array.from(random(new Uint8Array(12)), (byte) => byte.toString(16).padStart(2, '0')).join('');
      const child = proxy(ref);
      opened.set(ref, child);
      const sized = (key: string) => {
        const found = new RegExp('(?:^|,)\\s*' + key + '\\s*=\\s*(\\d+)').exec(features ?? '');
        return found ? Number(found[1]) : undefined;
      };
      send({ t: 'open', ref, url: href, name: name ?? '', width: sized('width'), height: sized('height') });
      return child;
    },
  });
  defineProperty(window, 'opener', { get: () => opener, configurable: false });
  if (opener) defineProperty(window, 'close', { value: () => send({ t: 'close', to: 'self' }) });

  // What the shell sends: messages, and windows that closed.
  defineProperty(window, '__mincaReceive', {
    value: (message: {
      t: string;
      from?: string | null;
      ref?: string | null;
      origin?: string;
      data?: unknown;
    }) => {
      if (message.t === 'closed') {
        const closed = message.ref === null ? opener : opened.get(message.ref ?? '');
        if (closed) closed.closed = true;
        if (message.ref) opened.delete(message.ref);
        return;
      }
      if (message.t !== 'message') return;
      const source = message.from === null ? opener : opened.get(message.from ?? '');
      if (!source) return;
      const event = new Message('message', { data: message.data, origin: message.origin });
      defineProperty(event, 'source', { value: source });
      dispatch(event);
    },
  });

  // A link to a new window, or to another site, opens in the person's own browser: this
  // window stays at its origin (its navigation rules refuse the rest).
  document.addEventListener(
    'click',
    (event) => {
      const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!(link instanceof HTMLAnchorElement) || !/^https?:/.test(link.href)) return;
      if (link.target !== '_blank' && new URL(link.href).origin === options.origin) return;
      event.preventDefault();
      if (event.isTrusted) send({ t: 'external', url: link.href });
    },
    true,
  );

  // The app's own window says which account it is connected as: the menu bar
  // keeps only that account's spaces online (apps/example/src/desktop.ts).
  if (options.app) {
    defineProperty(window, 'mincaDesktop', {
      value: Object.freeze({
        account(who: unknown) {
          const did: unknown = typeof who === 'object' && who !== null ? Reflect.get(who, 'did') : null;
          const name: unknown = typeof who === 'object' && who !== null ? Reflect.get(who, 'name') : null;
          send({
            t: 'account',
            who: typeof did === 'string' && typeof name === 'string' ? { did, name } : null,
          });
        },
        // The app's node runs in the shell, and the window uses it over this (apps/example/src/desktop.ts).
        node: Object.freeze({
          send(data: unknown) {
            toNode(data);
          },
          listen(listener: unknown) {
            nodeListener =
              typeof listener === 'function' ? (data) => void apply(listener, null, [data]) : null;
          },
        }),
      }),
    });
  }

  if (!options.dragInset) return;
  document.documentElement.setAttribute('data-desktop', '');
  // An empty spot near the top moves the window, as a title bar would.
  const interactive =
    'a, button, input, select, textarea, label, summary, [role="button"], [role="tab"], [contenteditable]';
  const inBar = (event: MouseEvent) =>
    event.clientY < options.dragInset &&
    event.target instanceof Element &&
    !event.target.closest(interactive);
  let dragging = false;
  let queued: MouseEvent | null = null;
  document.addEventListener(
    'mousedown',
    (event) => {
      if (event.button !== 0 || event.detail > 1 || !inBar(event)) return;
      dragging = true;
      event.preventDefault();
      send({ t: 'drag', phase: 'start', x: event.screenX, y: event.screenY });
    },
    true,
  );
  window.addEventListener(
    'mousemove',
    (event) => {
      if (!dragging) return;
      // One move a frame at most.
      if (!queued)
        requestAnimationFrame(() => {
          if (queued) send({ t: 'drag', phase: 'move', x: queued.screenX, y: queued.screenY });
          queued = null;
        });
      queued = event;
    },
    true,
  );
  window.addEventListener(
    'mouseup',
    (event) => {
      if (!dragging) return;
      dragging = false;
      send({ t: 'drag', phase: 'end', x: event.screenX, y: event.screenY });
    },
    true,
  );
  document.addEventListener(
    'dblclick',
    (event) => {
      if (inBar(event)) send({ t: 'zoom' });
    },
    true,
  );
}
