/**
 * A Nostr relay small enough to read, for tests: NIP-01 events and
 * subscriptions filtered by kind, `#x` and `since`; ephemeral kinds passed on
 * and never kept; NIP-40 expiry; and, when asked, NIP-42 authentication before
 * anything is taken. It checks every event's id and signature, as a real
 * relay does, so the library's events must be well formed to get through.
 */
import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8Encode } from '../../src/utils/encoding.js';
import { isObject } from '../../src/utils/guards.js';
import { portOf } from './net.js';

interface Event {
  readonly id: string;
  readonly pubkey: string;
  readonly created_at: number;
  readonly kind: number;
  readonly tags: string[][];
  readonly content: string;
  readonly sig: string;
}

interface Filter {
  readonly kinds?: number[];
  readonly '#x'?: string[];
  readonly since?: number;
  readonly limit?: number;
}

function isEvent(value: unknown): value is Event {
  return (
    isObject(value) &&
    typeof value.id === 'string' &&
    typeof value.pubkey === 'string' &&
    typeof value.created_at === 'number' &&
    typeof value.kind === 'number' &&
    Array.isArray(value.tags) &&
    value.tags.every((tag) => Array.isArray(tag) && tag.every((part) => typeof part === 'string')) &&
    typeof value.content === 'string' &&
    typeof value.sig === 'string'
  );
}

/** Whether an event's id is the hash of its fields and its signature checks out */
function verifies(event: Event): boolean {
  const hash = sha256(
    utf8Encode(JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content])),
  );
  if (bytesToHex(hash) !== event.id) return false;
  try {
    return schnorr.verify(hexToBytes(event.sig), hash, hexToBytes(event.pubkey));
  } catch {
    return false;
  }
}

const tag = (event: Event, name: string) => event.tags.find((t) => t[0] === name)?.[1];

function matches(event: Event, filter: Filter): boolean {
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter['#x'] && !filter['#x'].includes(tag(event, 'x') ?? '')) return false;
  if (filter.since !== undefined && event.created_at < filter.since) return false;
  return true;
}

export interface TestNostrRelay {
  readonly url: string;
  /** Events kept: regular kinds only */
  readonly kept: () => ReadonlyArray<Event>;
  /** Every event taken, kept or passed on */
  readonly taken: () => ReadonlyArray<Event>;
  readonly close: () => void;
}

export async function startNostrRelay(options: { requireAuth?: boolean } = {}): Promise<TestNostrRelay> {
  const kept: Event[] = [];
  const taken: Event[] = [];
  const subscriptions = new Map<WebSocket, Map<string, Filter>>();
  const wss = new WebSocketServer({ noServer: true });
  const server = createServer();
  server.on('upgrade', (req, socket, head) =>
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws)),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `nostr+ws://127.0.0.1:${portOf(server)}`;

  wss.on('connection', (ws: WebSocket) => {
    const mine = new Map<string, Filter>();
    subscriptions.set(ws, mine);
    const challenge = bytesToHex(globalThis.crypto.getRandomValues(new Uint8Array(8)));
    let authed = !options.requireAuth;
    if (options.requireAuth) ws.send(JSON.stringify(['AUTH', challenge]));
    const say = (message: unknown) => ws.send(JSON.stringify(message));
    ws.on('close', () => subscriptions.delete(ws));
    ws.on('message', (data) => {
      let message: unknown;
      try {
        message = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : '');
      } catch {
        return say(['NOTICE', 'not JSON']);
      }
      if (!Array.isArray(message)) return say(['NOTICE', 'not an array']);
      const parts: unknown[] = message;
      const [type, ...rest] = parts;
      if (type === 'AUTH') {
        const event = rest[0];
        if (
          isEvent(event) &&
          verifies(event) &&
          event.kind === 22242 &&
          tag(event, 'challenge') === challenge
        )
          authed = true;
        return say(['OK', isEvent(event) ? event.id : '', authed, authed ? '' : 'auth-required: bad auth']);
      }
      if (type === 'EVENT') {
        const event = rest[0];
        if (!isEvent(event) || !verifies(event)) return say(['OK', '', false, 'invalid: bad event']);
        if (!authed) return say(['OK', event.id, false, 'auth-required: authenticate first']);
        taken.push(event);
        const ephemeral = event.kind >= 20000 && event.kind < 30000;
        if (!ephemeral) {
          if (kept.some((held) => held.id === event.id))
            return say(['OK', event.id, true, 'duplicate: have it']);
          kept.push(event);
        }
        say(['OK', event.id, true, '']);
        for (const [other, filters] of subscriptions)
          for (const [id, filter] of filters)
            if (matches(event, filter)) other.send(JSON.stringify(['EVENT', id, event]));
        return;
      }
      if (type === 'REQ') {
        const [id, filter] = rest;
        if (typeof id !== 'string' || !isObject(filter)) return say(['NOTICE', 'bad REQ']);
        if (!authed) return say(['CLOSED', id, 'auth-required: authenticate first']);
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- a test relay takes the filter as given
        const asked = filter as Filter;
        mine.set(id, asked);
        const now = Math.floor(Date.now() / 1000);
        const found = kept.filter(
          (event) => matches(event, asked) && Number(tag(event, 'expiration') ?? Infinity) > now,
        );
        for (const event of found.slice(-(asked.limit ?? 500))) say(['EVENT', id, event]);
        return say(['EOSE', id]);
      }
      if (type === 'CLOSE' && typeof rest[0] === 'string') mine.delete(rest[0]);
    });
  });

  return {
    url,
    kept: () => kept,
    taken: () => taken,
    close: () => {
      for (const ws of subscriptions.keys()) ws.terminate();
      wss.close();
      server.close();
    },
  };
}
