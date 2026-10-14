/**
 * The app's window and its node (`app-node.ts`), over a WebSocket to the
 * shell's own server, at the app's origin. Not through Electrobun's bridge:
 * each message a page sends there reaches Bun as a threadsafe FFI callback,
 * and a burst of them, as a sync makes, corrupts Bun's heap and crashes the
 * app. The socket is Bun's own, with no FFI in it.
 *
 * Anything on this machine can reach a loopback port, and any web page can
 * try one, so the socket opens only from a page at the app's origin, with
 * the token the bridge made for the app's own window (`isNodeToken` in
 * `bridge.ts`), and only while that window is open. One window, one socket:
 * the page loaded again opens a new one, which takes the last one's place.
 */

/** Where the app's page opens the socket, on the shell's server */
export const NODE_PATH = '/__minca/node';
/** Largest message from the window, as JSON: a record can be large */
export const MAX_NODE_MESSAGE = 16 << 20;

/** The socket, as Bun's server holds it */
export interface LinkSocket {
  readonly data: { readonly token: string };
  send(text: string): unknown;
  close(code?: number, reason?: string): void;
}

export interface NodeLink {
  /** The token a request to open the socket carries, if it may open one; null if not */
  accept(request: Request): string | null;
  opened(socket: LinkSocket): void;
  message(socket: LinkSocket, data: string | Uint8Array): void;
  closed(socket: LinkSocket): void;
  /** Says something to the app's window, from its node */
  toWindow(message: unknown): void;
  /** The window closed */
  close(): void;
}

/** The socket's address for a page at `origin`, with its window's token */
export function nodeUrl(origin: string, token: string): string {
  const url = new URL(NODE_PATH, origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('t', token);
  return url.href;
}

export function createNodeLink(params: {
  /** The app's origin: only a page there opens the socket */
  readonly origin: string;
  readonly isToken: (token: string) => boolean;
  readonly fromWindow: (message: unknown) => void;
}): NodeLink {
  let current: LinkSocket | null = null;
  const decoder = new TextDecoder();

  return {
    accept(request) {
      const url = new URL(request.url);
      if (url.pathname !== NODE_PATH) return null;
      if (request.headers.get('origin') !== params.origin) return null;
      const token = url.searchParams.get('t') ?? '';
      return params.isToken(token) ? token : null;
    },
    opened(socket) {
      const last = current;
      current = socket;
      last?.close(1000, 'replaced');
    },
    message(socket, data) {
      // A window that has closed, or a socket another took the place of, says nothing more.
      if (socket !== current || !params.isToken(socket.data.token)) return socket.close(1008, 'gone');
      const text = typeof data === 'string' ? data : decoder.decode(data);
      if (text.length > MAX_NODE_MESSAGE) return;
      let message: unknown;
      try {
        message = JSON.parse(text);
      } catch {
        return;
      }
      params.fromWindow(message);
    },
    closed(socket) {
      if (current === socket) current = null;
    },
    toWindow(message) {
      if (current && params.isToken(current.data.token)) current.send(JSON.stringify(message));
    },
    close() {
      const last = current;
      current = null;
      last?.close(1000, 'closed');
    },
  };
}
