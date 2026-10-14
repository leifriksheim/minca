/**
 * Popups for a shell that opens none: what a browser does for `window.open`,
 * `window.opener` and `postMessage`, done by the main process.
 *
 * Electrobun's windows open no popups, and the account home is one: the app
 * opens it, they say hello and request and grant over `postMessage`, and each
 * checks the other's `event.source` and `event.origin`. So each window here
 * gets a preload (`page.ts`) that stands in for those, and every message goes
 * through this module, which says where it came from.
 *
 * What a page sends can't be trusted to say which window it is: Electrobun
 * routes a page's events by an id the page itself supplies. So each window's
 * preload is made with a secret of its own and the one origin it was opened
 * for, and does nothing in a page at any other origin or in a frame. Here, a
 * message counts only by its secret, and its origin is the one that secret
 * was made for. Delivery checks the target page's origin once more, in it.
 */

/** A window, as the shell made it */
export interface PaneHost {
  /** Runs a script in the window's top page */
  run(js: string): void;
  close(): void;
  activate(): void;
  /** Moves the window by dragging: where the pointer started and is now, in screen points */
  drag(phase: 'start' | 'move' | 'end', x: number, y: number): void;
  /** Fills the screen, or stops */
  zoom(): void;
}

export interface Shell {
  /**
   * Makes a window at `url` with this preload. It calls `closed` once, when
   * the window goes, however it went.
   */
  open(params: {
    readonly url: string;
    readonly preload: string;
    readonly width: number;
    readonly height: number;
    /** A popup, opened by another window */
    readonly popup: boolean;
    /** The app's own window: the one that says which account it is connected as */
    readonly app: boolean;
    readonly closed: () => void;
  }): PaneHost;
  /** Opens a link in the person's own browser */
  openExternal(url: string): void;
  /**
   * The account the app's window says it is connected as, or null when none.
   * Only a window nothing opened says it: the app's own, not a popup.
   */
  account?(who: { readonly did: string; readonly name: string } | null): void;
  /** The preload for a window with this secret, at this origin */
  preload(params: {
    readonly secret: string;
    readonly origin: string;
    readonly popup: boolean;
    readonly app: boolean;
  }): string;
}

interface Pane {
  readonly secret: string;
  readonly origin: string;
  readonly host: PaneHost;
  /** The window that opened this one, while it is open */
  opener: Pane | null;
  /** What the opener calls this window */
  readonly ref: string | null;
  readonly name: string;
  readonly children: Map<string, Pane>;
  /** The app's own window, as the shell opened it: only it says which account it is connected as */
  readonly app: boolean;
  /** When this window last opened a link in the browser, or brought a window to the front */
  lastExternal: number;
  lastFocus: number;
  closed: boolean;
  /** For the shell's own side: what it hears, instead of a page */
  readonly hear?: (message: Record<string, unknown>) => void;
}

/** A window the shell itself opened, and talks to as its opener, as a page talks to its popup */
export interface ShellWindow {
  readonly closed: boolean;
  postMessage(data: unknown, targetOrigin: string): void;
  close(): void;
}

/** Largest message passed on, as JSON */
const MAX_MESSAGE = 1 << 20;
const MAX_REF = 64;
/**
 * The page asks for a click before it opens anything; these hold if a page
 * finds a way round that. A browser's popup blocker would stop it too.
 */
const MAX_CHILDREN = 8;
const EXTERNAL_EVERY_MS = 1000;
const POPUP_WIDTH = 460;
const POPUP_HEIGHT = 720;

export interface Bridge {
  /** Opens a window that no other opened */
  openWindow(
    url: string,
    size: { readonly width: number; readonly height: number },
    options?: { readonly app?: boolean },
  ): PaneHost | null;
  /**
   * Opens a window the shell is the opener of, at `origin` to the page: it
   * hears the page's messages through `hear`, as a page would hear them.
   */
  openFromShell(
    url: string,
    size: { readonly width: number; readonly height: number },
    opener: { readonly origin: string; readonly hear: (event: { data: unknown; origin: string }) => void },
  ): ShellWindow | null;
  /** A page's message, as Electrobun's `host-message` event carried it */
  receive(detail: unknown): void;
}

const NO_HOST: PaneHost = { run() {}, close() {}, activate() {}, drag() {}, zoom() {} };

export function createBridge(shell: Shell): Bridge {
  const panes = new Map<string, Pane>();

  function deliver(pane: Pane, message: Record<string, unknown>): void {
    if (pane.closed) return;
    if (pane.hear) return pane.hear(message);
    const json = JSON.stringify(message);
    // Only to a page still at the origin this window was opened for.
    pane.host.run(
      `location.origin === ${JSON.stringify(pane.origin)} && typeof window.__mincaReceive === 'function' && window.__mincaReceive(${json});`,
    );
  }

  function open(
    url: URL,
    size: { readonly width: number; readonly height: number },
    opener: Pane | null,
    ref: string | null,
    name: string,
    app = false,
  ): Pane {
    const secret = newSecret();
    const popup = opener !== null;
    let pane: Pane | null = null;
    const host = shell.open({
      url: url.href,
      preload: shell.preload({ secret, origin: url.origin, popup, app }),
      width: size.width,
      height: size.height,
      popup,
      app,
      closed: () => {
        if (pane) gone(pane);
      },
    });
    pane = {
      secret,
      origin: url.origin,
      host,
      opener,
      ref,
      name,
      app,
      children: new Map(),
      lastExternal: 0,
      lastFocus: 0,
      closed: false,
    };
    panes.set(secret, pane);
    if (opener && ref !== null) opener.children.set(ref, pane);
    return pane;
  }

  function gone(pane: Pane): void {
    if (pane.closed) return;
    pane.closed = true;
    panes.delete(pane.secret);
    const { opener } = pane;
    if (opener && pane.ref !== null) {
      opener.children.delete(pane.ref);
      deliver(opener, { t: 'closed', ref: pane.ref });
    }
    for (const child of pane.children.values()) {
      child.opener = null;
      deliver(child, { t: 'closed', ref: null });
    }
    pane.children.clear();
  }

  function receive(detail: unknown): void {
    if (!isRecord(detail) || typeof detail.s !== 'string' || typeof detail.m !== 'string') return;
    const pane = panes.get(detail.s);
    if (!pane || pane.closed || detail.m.length > MAX_MESSAGE) return;
    let message: unknown;
    try {
      message = JSON.parse(detail.m);
    } catch {
      return;
    }
    if (!isRecord(message)) return;
    if (message.t === 'open') openFrom(pane, message);
    else if (message.t === 'post') post(pane, message);
    else if (message.t === 'close') closeFrom(pane, message.to);
    else if (message.t === 'focus') focus(pane, message.to);
    else if (message.t === 'external') external(pane, message.url);
    else if (message.t === 'drag') drag(pane, message);
    else if (message.t === 'zoom') pane.host.zoom();
    else if (message.t === 'account' && pane.app) account(message.who);
  }

  function openFrom(pane: Pane, message: Record<string, unknown>): void {
    const { ref, name } = message;
    if (typeof ref !== 'string' || !ref || ref.length > MAX_REF || pane.children.has(ref)) return;
    const url = webUrl(message.url);
    if (!url) {
      deliver(pane, { t: 'closed', ref });
      return;
    }
    // A name already open from this window is that window, opened anew.
    const named = typeof name === 'string' && name && name !== '_blank' ? name.slice(0, 200) : '';
    if (named) {
      for (const child of pane.children.values()) if (child.name === named) child.host.close();
    }
    if (pane.children.size >= MAX_CHILDREN) {
      deliver(pane, { t: 'closed', ref });
      return;
    }
    open(
      url,
      { width: size(message.width, POPUP_WIDTH), height: size(message.height, POPUP_HEIGHT) },
      pane,
      ref,
      named,
    );
  }

  function post(pane: Pane, message: Record<string, unknown>): void {
    const to = target(pane, message.to);
    if (!to || to === pane || typeof message.data !== 'string') return;
    // As a browser does: to every origin, or only to the one named.
    if (message.origin !== '*' && message.origin !== to.origin) return;
    let data: unknown;
    try {
      data = JSON.parse(message.data);
    } catch {
      return;
    }
    // The target hears it from this window, at the origin it was opened for.
    deliver(to, { t: 'message', from: to.opener === pane ? null : pane.ref, origin: pane.origin, data });
  }

  /** Who `to` names, from this window: `null` its opener, a ref one it opened, 'self' itself */
  function target(pane: Pane, to: unknown): Pane | null {
    if (to === 'self') return pane;
    if (to === null) return pane.opener;
    if (typeof to === 'string') return pane.children.get(to) ?? null;
    return null;
  }

  function closeFrom(pane: Pane, to: unknown): void {
    // A page may close only itself when another opened it, and what it opened.
    if (to === 'self') {
      if (pane.ref !== null) pane.host.close();
      return;
    }
    if (typeof to === 'string') pane.children.get(to)?.host.close();
  }

  /** A page can bring itself or a window it opened to the front, now and then: not in a loop */
  function focus(pane: Pane, to: unknown): void {
    const now = Date.now();
    if (now - pane.lastFocus < EXTERNAL_EVERY_MS) return;
    pane.lastFocus = now;
    target(pane, to)?.host.activate();
  }

  function account(who: unknown): void {
    if (who === null) return shell.account?.(null);
    if (!isRecord(who) || typeof who.did !== 'string' || typeof who.name !== 'string') return;
    if (!who.did.startsWith('did:') || who.did.length > 200) return;
    shell.account?.({ did: who.did, name: who.name.slice(0, 80) });
  }

  function external(pane: Pane, raw: unknown): void {
    const url = webUrl(raw);
    const now = Date.now();
    if (!url || now - pane.lastExternal < EXTERNAL_EVERY_MS) return;
    pane.lastExternal = now;
    shell.openExternal(url.href);
  }

  function drag(pane: Pane, message: Record<string, unknown>): void {
    const { phase, x, y } = message;
    if (phase !== 'start' && phase !== 'move' && phase !== 'end') return;
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return;
    pane.host.drag(phase, x, y);
  }

  return {
    openFromShell(raw, size, { origin, hear }) {
      const url = webUrl(raw);
      if (!url) return null;
      const ref = 'shell';
      const shellPane: Pane = {
        secret: '',
        origin,
        host: NO_HOST,
        opener: null,
        ref: null,
        name: '',
        app: false,
        children: new Map(),
        lastExternal: 0,
        lastFocus: 0,
        closed: false,
        hear: (message) => {
          if (message.t === 'message' && message.from === ref && typeof message.origin === 'string')
            hear({ data: message.data, origin: message.origin });
        },
      };
      const opened = open(url, size, shellPane, ref, '');
      return {
        get closed() {
          return opened.closed;
        },
        postMessage(data, targetOrigin) {
          post(shellPane, { to: ref, origin: targetOrigin, data: JSON.stringify(data) });
        },
        close: () => opened.host.close(),
      };
    },
    openWindow(raw, size, options = {}) {
      const url = webUrl(raw);
      return url ? open(url, size, null, null, '', options.app ?? true).host : null;
    },
    receive,
  };
}

function newSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function webUrl(raw: unknown): URL | null {
  if (typeof raw !== 'string') return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

function size(raw: unknown, fallback: number): number {
  return typeof raw === 'number' && Number.isFinite(raw)
    ? Math.min(Math.max(Math.round(raw), 240), 2400)
    : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
