/**
 * @module session/connect-code
 * Connecting a program that has no browser of its own (`weave connect wv_…`)
 * with one code copied from an app. The two meet on the code's channel
 * (`identity/channel.ts`, `CODE_CHANNEL`): the app says where it lives, the
 * program says which key it holds and what it asks for, the app decides
 * whether to ask the account home for that, and the person allows it there.
 * The app hands back a note made out to the program's key, and the program
 * keeps it only if it comes from the account the code names. The relay learns
 * and changes nothing, and a recording of the room is no use to someone who
 * sees the code later.
 */
import type { PeerTransport } from '../network/transport.js';
import { channelKeyPair, CODE_CHANNEL, deriveChannel, type Channel } from '../identity/channel.js';
import { base64UrlDecode, base64UrlEncode, concatBytes, utf8Encode } from '../utils/encoding.js';
import { sha256 } from '../utils/hash.js';
import { isObject } from '../utils/guards.js';
import type { NetworkMessage, PeerInfo } from '../types.js';
import { grantsRecordsOnly } from '../identity/abilities.js';
import { checkGrant, keyProof, type AppKey, type Grant } from './connect.js';
import { bytesField, meetOnChannel } from './channel-room.js';

const CODE_PREFIX = 'wv_';
const SECRET_BYTES = 16;
/** How much of the account's fingerprint the code carries */
const ACCOUNT_BYTES = 8;
const ACCOUNT_LABEL = 'weave/code-account/v1';
/** base64url characters for the secret and the fingerprint together */
const CODE_CHARS = Math.ceil(((SECRET_BYTES + ACCOUNT_BYTES) * 4) / 3);

/** Messages on the channel: the key exchange in the clear, the rest sealed */
const HELLO = 'code:hello';
const KEY = 'code:key';
const APP = 'code:app';
const ASK = 'code:ask';
const HEARD = 'code:heard';
const ANSWER = 'code:answer';
const DONE = 'code:done';

/** Longest name a program may give itself */
const MAX_NAME = 80;
/** Longest origin an app may give */
const MAX_ORIGIN = 200;
/** Peers either side runs an exchange with before the right one shows up */
const MAX_TRIED = 32;

/** Who is asking, as the program said */
export interface CodeAsking {
  /** The program's key: the note is made out to it */
  readonly did: string;
  /** What the program calls itself, e.g. "Agent on leifs-macbook". Shown, not trusted. */
  readonly name: string;
  /** The key's proof that it holds itself, for the connect request (`keyProof`, `via: code`, this app's origin) */
  readonly proof: string;
  /**
   * Whether it asks for a note that grants records only. Only a request: the
   * app decides what to ask the home for. The proof binds what the program
   * asked, so an app that won't give that denies it.
   */
  readonly recordsOnly: boolean;
}

/** What the app tells the program */
type Answer = { readonly grant: Grant } | { readonly denied: string };

/** Where the two sides meet */
interface CodeNetwork {
  /** Relays to meet on. The app's and the program's must share one. */
  readonly relays: ReadonlyArray<string>;
  /** A transport instead of WebRTC — for tests */
  readonly transport?: (did: string) => PeerTransport;
}

// ─── The code ────────────────────────────────────────────────────────

/** What a code holds */
export interface ConnectCode {
  /** The channel's secret */
  readonly secret: Uint8Array;
  /** The start of the fingerprint of the account the app is signed in to: a grant must come from it */
  readonly account: Uint8Array;
}

/** The start of an account's fingerprint, as a code carries it */
async function accountFingerprint(account: string): Promise<Uint8Array> {
  return (await sha256(concatBytes(utf8Encode(ACCOUNT_LABEL), utf8Encode(account)))).slice(0, ACCOUNT_BYTES);
}

/** A new code for the app signed in to `account`: `wv_`, 128 random bits and the account's fingerprint */
export async function newConnectCode(account: string): Promise<string> {
  const secret = globalThis.crypto.getRandomValues(new Uint8Array(SECRET_BYTES));
  return CODE_PREFIX + base64UrlEncode(concatBytes(secret, await accountFingerprint(account)));
}

const CODE_PATTERN = new RegExp(`wv_([A-Za-z0-9_-]{${CODE_CHARS}})(?![A-Za-z0-9_-])`);

/**
 * What a code holds, for anything a person might paste — surrounding
 * spaces, quotes, the whole command.
 * @throws When there is no code in it
 */
export function readConnectCode(input: string): ConnectCode {
  const match = CODE_PATTERN.exec(input);
  const bytes = match ? base64UrlDecode(match[1]!) : null;
  if (!bytes || bytes.length !== SECRET_BYTES + ACCOUNT_BYTES) {
    throw new Error('That is not a connect code. Copy the whole command the app shows.');
  }
  return { secret: bytes.slice(0, SECRET_BYTES), account: bytes.slice(SECRET_BYTES) };
}

/** An origin as a browser reports one, e.g. `https://app.example`, or null */
function readOrigin(value: unknown): string | null {
  if (!isObject(value) || typeof value.origin !== 'string' || value.origin.length > MAX_ORIGIN) return null;
  try {
    const { origin } = new URL(value.origin);
    return origin === value.origin && origin !== 'null' ? origin : null;
  } catch {
    return null;
  }
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
 * asked about, and nobody after it. What the program asks for is only a
 * request: on `asking`, the app decides whether to ask the home for it, or
 * denies it.
 *
 * @param options.account The account this app is signed in to: the code names it, and the program takes a note from no other
 * @param options.origin Where this app lives, as the home will see it. Default: this page's.
 */
export async function offerConnectCode(
  options: CodeNetwork & { readonly account: string; readonly origin?: string },
  onStage: (stage: ConnectCodeStage) => void,
): Promise<ConnectCodeOffer> {
  if (options.relays.length === 0 && !options.transport)
    throw new Error('Connecting by code needs a relay, and none is configured.');
  const origin = options.origin ?? globalThis.location?.origin;
  if (!origin || readOrigin({ origin }) === null)
    throw new Error('Connecting by code needs the app’s origin.');
  const code = await newConnectCode(options.account);
  const { secret } = readConnectCode(code);
  const room = await meetOnChannel(CODE_CHANNEL, options, secret);
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
      // Where the app lives: the program's proof names it, so the proof is no use from anywhere else.
      await room.seal(message.from, APP, channel, { origin });
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
          if (grant.note.payload.aud !== asking.did) throw new Error('That note is for a different key.');
          if (grant.did !== options.account) throw new Error('That note is from a different account.');
          if (asking.recordsOnly && !grantsRecordsOnly(grant.note))
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
 * @param params.key This program's key — the note will be made out to it, and it signs the proof for the app's origin
 * @param params.name What the person sees, e.g. "Agent on leifs-macbook"
 * @param params.recordsOnly Ask for a note that grants records only, and refuse any other
 * @param params.onWaiting Told once the app has heard, and the person is deciding, with where the app lives
 * @returns The grant, checked: from the account the code names
 * @throws When the code is wrong or stale, the person says no, or nothing answers in time
 */
export async function connectWithCode(params: {
  readonly code: string;
  readonly key: AppKey;
  readonly name: string;
  readonly recordsOnly: boolean;
  readonly network: CodeNetwork;
  readonly onWaiting?: (app: { readonly origin: string }) => void;
  /** How long to wait for the app to answer at all. Default 60 s. */
  readonly findTimeoutMs?: number;
  /** How long the person has to decide. Default 10 minutes. */
  readonly decideTimeoutMs?: number;
}): Promise<Grant> {
  const { secret, account } = readConnectCode(params.code);
  const room = await meetOnChannel(CODE_CHANNEL, params.network, secret);
  const mine = await channelKeyPair();
  const hello = { key: base64UrlEncode(mine.point) };

  return new Promise<Grant>((resolve, reject) => {
    const channels = new Map<string, Channel>();
    /** Where each peer that holds the code says its app lives, once it has said */
    const origins = new Map<string, string>();
    let app: { readonly peer: string; readonly channel: Channel; readonly origin: string } | null = null;
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
      } else if (message.type === APP && !app) {
        const channel = channels.get(message.from);
        if (!channel || origins.has(message.from)) return;
        const origin = readOrigin(await room.open(message, channel));
        if (!origin) return;
        origins.set(message.from, origin);
        // The proof names the app's origin: a home it is shown at from anywhere else refuses it.
        const proof = await keyProof(params.key, { via: 'code', recordsOnly: params.recordsOnly, origin });
        await room.seal(message.from, ASK, channel, {
          did: params.key.did,
          proof,
          name: params.name.slice(0, MAX_NAME),
          recordsOnly: params.recordsOnly,
        });
      } else if (message.type === HEARD && !app) {
        const channel = channels.get(message.from);
        const origin = origins.get(message.from);
        // Only an app that holds the code, at the other end of this exchange, can seal this.
        if (!channel || !origin || !(await room.open(message, channel))) return;
        app = { peer: message.from, channel, origin };
        params.onWaiting?.({ origin });
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
          await checkGrant(grant, params.key.did, { recordsOnly: params.recordsOnly });
          // Whoever else holds the code could answer first, with a note from their own account.
          const from = await accountFingerprint(grant.did);
          if (!from.every((byte, i) => byte === account[i]))
            throw new Error('That note is from a different account than the code names.');
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
