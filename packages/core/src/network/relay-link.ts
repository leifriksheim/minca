/**
 * A link to a relay of any kind: the topics it watches, kept across
 * reconnects, over one socket kept open (`relay-socket.ts`). Each kind
 * (`relay-minca.ts`, `relay-nostr.ts`) says only how it frames watching,
 * publishing and what comes back; this owns the rest.
 */
import { createEmitter } from '../utils/events.js';
import type { Emitter } from '../utils/events.js';
import { createRelaySocket } from './relay-socket.js';
import type { RelaySocketOptions } from './relay-socket.js';
import type { RelayLink, RelayLinkEvents } from './relays.js';

type Send = (message: unknown) => void;

/** What a link can do with a message it heard */
export interface LinkHearing {
  readonly send: Send;
  readonly emit: Emitter<RelayLinkEvents>['emit'];
  /** Whether the link watches this topic */
  readonly watching: (topic: string) => boolean;
  /** Says again that it watches every topic, as when the socket opens */
  readonly rewatch: () => void;
}

/** How one kind of relay says what a link does */
export interface LinkWire {
  /** What to dial: the relay's address without its kind's scheme */
  readonly dial: string;
  readonly watch: (send: Send, topic: string) => void;
  readonly unwatch: (send: Send, topic: string) => void;
  /** The message that hands a blob to whoever watches the topic */
  readonly publish: (topic: string, blob: string) => unknown;
  /** Each message the relay sends */
  readonly heard: (message: unknown, link: LinkHearing) => void;
  readonly ping?: RelaySocketOptions['ping'];
  /** The message asking for TURN passwords, for a kind that hands them out */
  readonly askIce?: unknown;
}

/** A link watching topics on one relay, saying so again every time its socket opens */
export function createTopicLink(url: string, wire: LinkWire): RelayLink {
  const topics = new Set<string>();
  const { on, off, emit } = createEmitter<RelayLinkEvents>();
  const watchAll = (send: Send) => {
    for (const topic of topics) wire.watch(send, topic);
  };
  const socket = createRelaySocket({
    url,
    dial: wire.dial,
    opened: watchAll,
    heard: (message, send) =>
      wire.heard(message, {
        send,
        emit,
        watching: (topic) => topics.has(topic),
        rewatch: () => watchAll(send),
      }),
    ...(wire.ping ? { ping: wire.ping } : {}),
  });
  socket.on('connected', () => emit('connected'));
  socket.on('disconnected', () => emit('disconnected'));
  socket.on('status', (status) => emit('status', status));
  const { askIce } = wire;

  return Object.freeze({
    url,
    connect: socket.connect,
    disconnect: () => {
      topics.clear();
      socket.disconnect();
    },
    reconnect: socket.reconnect,
    watch: (topic: string) => {
      if (topics.has(topic)) return;
      topics.add(topic);
      wire.watch(socket.send, topic);
      socket.count(topics.size);
    },
    unwatch: (topic: string) => {
      if (!topics.delete(topic)) return;
      wire.unwatch(socket.send, topic);
      socket.count(topics.size);
    },
    publish: (topic: string, blob: string) => socket.send(wire.publish(topic, blob)),
    ...(askIce === undefined ? {} : { requestIce: () => socket.send(askIce) }),
    isConnected: socket.isConnected,
    status: socket.status,
    on,
    off,
  });
}
