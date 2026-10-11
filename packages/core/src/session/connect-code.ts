/**
 * @module session/connect-code
 * Connecting a program that has no browser of its own (`weave connect wv_…`)
 * with one code copied from an app. The two meet on the code's channel
 * (`identity/channel.ts`, `CODE_CHANNEL`): the program says which key it
 * holds and what it asks for, the person allows it at their account home, and
 * the app hands back a note made out to that key. The relay learns and
 * changes nothing, and a recording of the room is no use to someone who sees
 * the code later.
 */
import type { PeerTransport } from '../network/transport.js';
import { channelKeyPair, CODE_CHANNEL, deriveChannel, type Channel } from '../identity/channel.js';
import { parseUCAN } from '../identity/ucan.js';
import { base64UrlDecode, base64UrlEncode } from '../utils/encoding.js';
import { isObject } from '../utils/guards.js';
import type { NetworkMessage, PeerInfo } from '../types.js';
import { grantsRecordsOnly } from '../identity/abilities.js';
import { checkGrant, type Grant } from './connect.js';
import { bytesField, meetOnChannel } from './channel-room.js';

const CODE_PREFIX = 'wv_';
const SECRET_BYTES = 16;

/** Messages on the channel: the key exchange in the clear, the rest sealed */
const HELLO = 'code:hello';
const KEY = 'code:key';
const ASK = 'code:ask';
const HEARD = 'code:heard';
const ANSWER = 'code:answer';
const DONE = 'code:done';

/** Longest name a program may give itself */
const MAX_NAME = 80;
/** Peers either side runs an exchange with before the right one shows up */
const MAX_TRIED = 32;

/** Who is asking, as the program said */
export interface CodeAsking {
  /** The program's key: the note is made out to it */
  readonly did: string;
  /** What the program calls itself, e.g. "Agent on leifs-macbook". Shown, not trusted. */
  readonly name: string;
  /** The key's proof that it holds itself, for the connect request (`keyProof`, `via: code`) */
  readonly proof: string;
  /** Whether it asks for a note that grants records only */
  readonly recordsOnly: boolean;
}

/** What the app tells the program */
type Answer = { readonly grant: Grant } | { readonly denied: string };

interface CodeNetwork {
  /** Relays to meet on. The app's and the program's must share one. */
  readonly relays: ReadonlyArray<string>;
  /** A transport instead of WebRTC — for tests */
  readonly transport?: (did: string) => PeerTransport;
}

// ─── The code ────────────────────────────────────────────────────────

/** A new code: `wv_` and 128 random bits */
export function newConnectCode(): string {
  return CODE_PREFIX + base64UrlEncode(globalThis.crypto.getRandomValues(new Uint8Array(SECRET_BYTES)));
}

/**
 * The secret in a code, for anything a person might paste — surrounding
 * spaces, quotes, the whole command.
 * @throws When there is no code in it
 */
export function readConnectCode(input: string): Uint8Array {
  const match = /wv_([A-Za-z0-9_-]{22})(?![A-Za-z0-9_-])/.exec(input);
  const secret = match ? base64UrlDecode(match[1]!) : null;
  if (!secret || secret.length !== SECRET_BYTES) {
    throw new Error('That is not a connect code. Copy the whole command the app shows.');
  }
  return secret;
}

function readAsk(value: unknown): CodeAsking | null {
  if (!isObject(value)) return null;
  const { did, proof, name, recordsOnly } = value;
  if (typeof did !== 'string' || !did.startsWith('did:key:') || did.length > 200) return null;
  // Without its proof the home would refuse the request anyway.
  if (typeof proof !== 'string' || proof.length > 200) return null;
  if (typeof recordsOnly !== 'boolean') return null;
  const shown = typeof name === 'string' && name.trim() ? name.trim().slice(0, MAX_NAME) : 'A program';
  return { did, proof, name: shown, recordsOnly };
}

// ─── The app's side ──────────────────────────────────────────────────

export type ConnectCodeStage =
  | { readonly kind: 'waiting' }
  /** The program is there. Call `allow` from a click (it opens the home), or `deny`. */
  | {
      readonly kind: 'asking';
      readonly asking: CodeAsking;
      allow(grant: Grant): Promise<void>;
      deny(reason?: string): void;
    }
  | { readonly kind: 'connected'; readonly asking: CodeAsking }
  | { readonly kind: 'failed'; readonly reason: string };

export interface ConnectCodeOffer {
  /** What the person pastes: `wv_…` */
  readonly code: string;
  /** Stops listening. The code stops working. */
  stop(): void;
}

/**
 * Starts offering a connection to a program, by code. Keep it running while
 * the code is on screen: the first program whose sealed ask opens is the one
 * asked about, and nobody after it.
 */
export async function offerConnectCode(
  network: CodeNetwork,
  onStage: (stage: ConnectCodeStage) => void,
): Promise<ConnectCodeOffer> {
  if (network.relays.length === 0 && !network.transport)
    throw new Error('Connecting by code needs a relay, and none is configured.');
  const code = newConnectCode();
  const secret = readConnectCode(code);
  const room = await meetOnChannel(CODE_CHANNEL, network, secret);
  const mine = await channelKeyPair();

  /** An exchange with each peer that said hello, until one asks */
  const channels = new Map<string, Channel>();
  let asked: { readonly peer: string; readonly channel: Channel; readonly asking: CodeAsking } | null = null;
  let settled = false;
  const finish = (stage?: ConnectCodeStage) => {
    if (settled) return;
    settled = true;
    room.leave();
    if (stage) onStage(stage);
  };

  const handle = async (message: NetworkMessage): Promise<void> => {
    if (settled) return;
    if (message.type === HELLO && !asked) {
      if (channels.has(message.from) || channels.size >= MAX_TRIED) return;
      const point = bytesField(message, 'key');
      if (!point) return;
      const channel = await deriveChannel({
        kind: CODE_CHANNEL,
        secret,
        privateKey: mine.privateKey,
        offer: mine.point,
        join: point,
        side: 'offer',
      }).catch(() => null);
      if (!channel) return;
      channels.set(message.from, channel);
      room.send(message.from, KEY, { key: base64UrlEncode(mine.point) });
    } else if (message.type === ASK && !asked) {
      const channel = channels.get(message.from);
      if (!channel) return;
      // Opens only for a program that holds the code and is the other end of this exchange.
      const asking = readAsk(await room.open(message, channel));
      if (!asking) return;
      const peer = message.from;
      // The code is spent: nobody after this program is answered.
      asked = { peer, channel, asking };
      // So the program knows it was right, and the person is deciding.
      await room.seal(peer, HEARD, channel, {});
      onStage({
        kind: 'asking',
        asking,
        allow: async (grant) => {
          if (parseUCAN(grant.token).payload.aud !== asking.did)
            throw new Error('That note is for a different key.');
          if (asking.recordsOnly && !grantsRecordsOnly(grant.token))
            throw new Error('That note grants more than the program asked for.');
          await room.seal(peer, ANSWER, channel, { grant } satisfies Answer);
        },
        deny: (reason = 'The person said no.') => {
          void room
            .seal(peer, ANSWER, channel, { denied: reason } satisfies Answer)
            .then(() => finish({ kind: 'failed', reason: 'You said no. Make a new code to try again.' }));
        },
      });
    } else if (message.type === DONE && asked && message.from === asked.peer) {
      if (await room.open(message, asked.channel)) finish({ kind: 'connected', asking: asked.asking });
    }
  };
  // One message at a time, in the order they came: each may depend on what the one before settled.
  let handling: Promise<void> = Promise.resolve();
  room.net.on('message', (message: NetworkMessage) => {
    handling = handling.then(() => handle(message)).catch(() => {});
  });

  onStage({ kind: 'waiting' });
  await room.net.connect();
  return {
    code,
    stop: () => {
      finish();
      room.net.disconnect();
    },
  };
}

// ─── The program's side ──────────────────────────────────────────────

/**
 * Connects this program with the code from the app.
 *
 * @param params.did This program's key — the note will be made out to it
 * @param params.proof That key's `keyProof` with `via: code` and the same `recordsOnly`
 * @param params.name What the person sees, e.g. "Agent on leifs-macbook"
 * @param params.recordsOnly Ask for a note that grants records only, and refuse any other
 * @param params.onWaiting Told once the app has heard, and the person is deciding
 * @returns The grant, checked
 * @throws When the code is wrong or stale, the person says no, or nothing answers in time
 */
export async function connectWithCode(params: {
  readonly code: string;
  readonly did: string;
  readonly proof: string;
  readonly name: string;
  readonly recordsOnly: boolean;
  readonly network: CodeNetwork;
  readonly onWaiting?: () => void;
  /** How long to wait for the app to answer at all. Default 60 s. */
  readonly findTimeoutMs?: number;
  /** How long the person has to decide. Default 10 minutes. */
  readonly decideTimeoutMs?: number;
}): Promise<Grant> {
  const secret = readConnectCode(params.code);
  const room = await meetOnChannel(CODE_CHANNEL, params.network, secret);
  const mine = await channelKeyPair();
  const hello = { key: base64UrlEncode(mine.point) };

  return new Promise<Grant>((resolve, reject) => {
    const channels = new Map<string, Channel>();
    let app: { readonly peer: string; readonly channel: Channel } | null = null;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (done: () => void) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      room.leave();
      done();
    };
    const fail = (reason: string) => settle(() => reject(new Error(reason)));
    const wait = (ms: number, reason: string) => {
      globalThis.clearTimeout(timer);
      timer = globalThis.setTimeout(() => fail(reason), ms);
    };

    room.net.on('peer-connected', (peer: PeerInfo) => {
      if (!app) room.send(peer.did, HELLO, hello);
    });

    const handle = async (message: NetworkMessage): Promise<void> => {
      if (settled) return;
      if (message.type === KEY && !app) {
        if (channels.has(message.from) || channels.size >= MAX_TRIED) return;
        const point = bytesField(message, 'key');
        if (!point) return;
        const channel = await deriveChannel({
          kind: CODE_CHANNEL,
          secret,
          privateKey: mine.privateKey,
          offer: point,
          join: mine.point,
          side: 'join',
        }).catch(() => null);
        if (!channel) return;
        channels.set(message.from, channel);
        await room.seal(message.from, ASK, channel, {
          did: params.did,
          proof: params.proof,
          name: params.name.slice(0, MAX_NAME),
          recordsOnly: params.recordsOnly,
        });
      } else if (message.type === HEARD && !app) {
        const channel = channels.get(message.from);
        // Only an app that holds the code, at the other end of this exchange, can seal this.
        if (!channel || !(await room.open(message, channel))) return;
        app = { peer: message.from, channel };
        params.onWaiting?.();
        // Once the app has the question, the person gets longer to answer it.
        wait(
          params.decideTimeoutMs ?? 10 * 60_000,
          'Nobody answered in the app. Make a new code and try again.',
        );
      } else if (message.type === ANSWER && app && message.from === app.peer) {
        const answer = await room.open(message, app.channel);
        if (!isObject(answer)) return;
        if (typeof answer.denied === 'string') {
          fail(answer.denied.slice(0, 200));
          return;
        }
        try {
          // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- checkGrant checks it
          const grant = answer.grant as Grant;
          await checkGrant(grant, params.did, { recordsOnly: params.recordsOnly });
          await room.seal(message.from, DONE, app.channel, {});
          settle(() => resolve(grant));
        } catch (error) {
          settle(() => reject(error instanceof Error ? error : new Error(String(error))));
        }
      }
    };
    // One message at a time, in the order they came: an answer counts only once `heard` has opened.
    let handling: Promise<void> = Promise.resolve();
    room.net.on('message', (message: NetworkMessage) => {
      handling = handling.then(() => handle(message)).catch(() => {});
    });

    wait(
      params.findTimeoutMs ?? 60_000,
      'The app did not answer. Check the window that showed the code is still open, or make a new code there.',
    );
    room.net.connect().catch(() => fail('Could not reach the relay.'));
  });
}
