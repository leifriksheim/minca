/**
 * A local socket as a message port, so `serveNode` and `remoteNode` from core
 * work between two processes on one computer as they do between a page and a
 * worker: how the `minca mcp` sessions share this computer's agent.
 *
 * One message a line, as JSON. A node's calls are plain data apart from bytes
 * (a file, a picture) and `undefined` among a call's arguments, which a
 * worker's port clones and JSON can't say: those go as small tagged objects,
 * and an object that happens to have the tag's key goes as its entries, so
 * nothing a peer wrote is read as one.
 */
import type { Socket } from 'node:net';
import type { MessagePortLike } from '@minca/core';
import { isRecord } from './json.js';

const TAG = '$minca';

/** A message as one line of JSON */
export function encodeMessage(message: unknown): string {
  return JSON.stringify(message, function (this: unknown, key: string, value: unknown) {
    // Before `toJSON`, which a Buffer has.
    const raw: unknown = typeof this === 'object' && this !== null ? Reflect.get(this, key) : value;
    if (raw instanceof Uint8Array)
      return {
        [TAG]: 'bytes',
        base64: Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('base64'),
      };
    // A missing argument stays missing: JSON would make it null.
    if (value === undefined && Array.isArray(this)) return { [TAG]: 'undefined' };
    if (isRecord(value) && Object.hasOwn(value, TAG))
      return { [TAG]: 'object', entries: Object.entries(value) };
    return value;
  });
}

/** A line {@link encodeMessage} wrote, as the message it was */
export function decodeMessage(line: string): unknown {
  return JSON.parse(line, (_key, value: unknown) => {
    // An undefined item leaves a hole, which this fills.
    if (Array.isArray(value)) return Array.from<unknown>(value);
    if (!isRecord(value) || !Object.hasOwn(value, TAG)) return value;
    const { entries } = value;
    if (value[TAG] === 'bytes' && typeof value.base64 === 'string')
      return new Uint8Array(Buffer.from(value.base64, 'base64'));
    if (value[TAG] === 'undefined') return undefined;
    if (value[TAG] === 'object' && Array.isArray(entries))
      return Object.fromEntries(
        entries.filter(
          (entry): entry is [string, unknown] => Array.isArray(entry) && typeof entry[0] === 'string',
        ),
      );
    return value;
  });
}

/** The tag `node/remote.ts` puts on a node's messages */
const NODE = 'minca-node';

/**
 * `socket` as a port. Once it closes, every call still waiting for its
 * reply, and every call made after, is answered with an error: a worker's
 * port never goes away, a process can, and `remoteNode` would wait for ever.
 */
export function socketPort(socket: Socket): MessagePortLike {
  const listeners = new Set<(event: MessageEvent) => void>();
  const deliver = (data: unknown) => {
    const event = new MessageEvent('message', { data });
    for (const listener of listeners) listener(event);
  };
  const waiting = new Set<number>();
  const gone = (id: number) =>
    deliver({
      [NODE]: true,
      kind: 'reply',
      id,
      ok: false,
      error: { name: 'Error', message: "The session running this computer's agent went away" },
    });

  let buffered = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffered += chunk;
    let end: number;
    while ((end = buffered.indexOf('\n')) !== -1) {
      const line = buffered.slice(0, end);
      buffered = buffered.slice(end + 1);
      let message: unknown;
      try {
        message = decodeMessage(line);
      } catch {
        continue;
      }
      if (isRecord(message) && message.kind === 'reply' && typeof message.id === 'number')
        waiting.delete(message.id);
      deliver(message);
    }
  });
  // An error is followed by `close`, which is where it is dealt with.
  socket.on('error', () => {});
  socket.once('close', () => {
    for (const id of waiting) gone(id);
    waiting.clear();
  });

  return {
    postMessage(message) {
      const call =
        isRecord(message) && message.kind === 'call' && typeof message.id === 'number' ? message.id : null;
      if (socket.destroyed || !socket.writable) {
        if (call !== null) queueMicrotask(() => gone(call));
        return;
      }
      const line = encodeMessage(message);
      if (call !== null) waiting.add(call);
      socket.write(`${line}\n`);
    },
    addEventListener: (_type, listener) => void listeners.add(listener),
    removeEventListener: (_type, listener) => void listeners.delete(listener),
  };
}
