/**
 * @module session/connect-code
 * Connecting a program that has no browser of its own (`minca connect`) to an
 * account. The program makes a one-time code and opens the account home with
 * it (`<home>/connect#mc_…`). The two meet on the code's channel
 * (`identity/channel.ts`, `CODE_CHANNEL`): the home says where it lives, the
 * program says which key it holds, the person signs in and allows it there,
 * and the home hands back a records-only note made out to the program's key.
 * The relay learns and changes nothing, and a recording of the room is no use
 * to someone who sees the code later.
 */
import type { PeerTransport } from '../network/transport.js';
import { channelKeyPair, CODE_CHANNEL, deriveChannel, type Channel } from '../identity/channel.js';

/** One side's ephemeral key for one exchange */
type ChannelKeys = Awaited<ReturnType<typeof channelKeyPair>>;
import { base64UrlDecode, base64UrlEncode } from '../utils/encoding.js';
import { sha256 } from '../utils/hash.js';
import { isObject } from '../utils/guards.js';
import type { NetworkMessage, PeerInfo } from '../types.js';
import { grantsRecordsOnly } from '../identity/abilities.js';
import { checkGrant, keyProof, type AppKey, type Grant, type IncomingRequest } from './connect.js';
import { bytesField, meetOnChannel } from './channel-room.js';

const CODE_PREFIX = 'mc_';
const SECRET_BYTES = 16;
/** base64url characters for the secret, unpadded */
const CODE_CHARS = Math.ceil((SECRET_BYTES * 4) / 3);

/** Messages on the channel: the key exchange in the clear, the rest sealed */
const HELLO = 'code:hello';
const KEY = 'code:key';
const POINT = 'code:point';
const HOME = 'code:home';
const ASK = 'code:ask';
const HEARD = 'code:heard';
const ANSWER = 'code:answer';
const DONE = 'code:done';

/** Longest name a program may give itself */
const MAX_NAME = 80;
/** Longest origin a home may give */
const MAX_ORIGIN = 200;
/** Peers either side runs an exchange with before the right one shows up */
const MAX_TRIED = 32;

/** Who is asking, as the program said */
export interface CodeAsking {
  /** The program's key: the note is made out to it */
  readonly did: string;
  /** What the program calls itself, e.g. "Agent on leifs-macbook". Shown, not trusted. */
  readonly name: string;
  /** The key's proof that it holds itself, for a records-only note (`keyProof`, `via: code`, the home's origin) */
  readonly proof: string;
}

/** What the home tells the program */
type Answer = { readonly grant: Grant } | { readonly denied: string };

/** Where the two sides meet */
interface CodeNetwork {
  /** Relays to meet on. The home's and the program's must share one. */
  readonly relays: ReadonlyArray<string>;
  /** A transport instead of WebRTC — for tests */
  readonly transport?: (did: string) => PeerTransport;
}

// ─── The code ────────────────────────────────────────────────────────

/** What the program says first: a hash of its point, so neither side can pick a key to steer the check code */
const commitTo = async (point: Uint8Array) => base64UrlEncode(await sha256(point));

const CHECK_LABEL = 'minca/code-check/v1';

/**
 * The six digits the home shows and the person gives the program, from the
 * exchange's channel: only the two ends of one exchange share them.
 */
async function connectCheck(channel: Channel): Promise<string> {
  const bytes = await channel.derive(CHECK_LABEL, 4);
  const value = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0) % 1_000_000;
  return String(value).padStart(6, '0');
}

/** A new code: `mc_` and 128 random bits */
export function newConnectCode(): string {
  return CODE_PREFIX + base64UrlEncode(globalThis.crypto.getRandomValues(new Uint8Array(SECRET_BYTES)));
}

/** Where the person allows a program: the home's connect page, with the code after `#` so it never reaches a server */
export const connectCodeUrl = (home: string, code: string): string =>
  `${new URL('/connect', home).href}#${code}`;

const CODE_PATTERN = new RegExp(`mc_([A-Za-z0-9_-]{${CODE_CHARS}})(?![A-Za-z0-9_-])`);

/**
 * The secret a code holds, from anything it is found in: the code, or the
 * link the program opened.
 * @throws When there is no code in it
 */
export function readConnectCode(input: string): Uint8Array {
  const match = CODE_PATTERN.exec(input);
  const bytes = match ? base64UrlDecode(match[1]!) : null;
  if (!bytes || bytes.length !== SECRET_BYTES) {
    throw new Error('That is not a connect code. Open the whole link the program showed.');
  }
  return bytes;
}

/** The code in a link the home was opened at, or null: `#mc_…` */
export function connectCodeIn(hash: string): string | null {
  const match = CODE_PATTERN.exec(hash);
  return match && base64UrlDecode(match[1]!)?.length === SECRET_BYTES ? match[0] : null;
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
  const { did, proof, name } = value;
  if (typeof did !== 'string' || !did.startsWith('did:key:') || did.length > 200) return null;
  // Without its proof the home refuses to sign anything for it.
  if (typeof proof !== 'string' || proof.length > 200) return null;
  const shown = typeof name === 'string' && name.trim() ? name.trim().slice(0, MAX_NAME) : 'A program';
  return { did, proof, name: shown };
}

// ─── The home's side ─────────────────────────────────────────────────

export type ConnectCodeStage =
  | { readonly kind: 'waiting' }
  /**
   * The program is there. Show `check`, for the person to give the program,
   * then sign it a records-only note and `allow` it, or `deny`.
   */
  | {
      readonly kind: 'asking';
      readonly asking: CodeAsking;
      readonly check: string;
      allow(grant: Grant): Promise<void>;
      deny(reason?: string): void;
    }
  | { readonly kind: 'connected'; readonly asking: CodeAsking }
  | { readonly kind: 'failed'; readonly reason: string };

/**
 * Answers the program that opened the home with a code. Keep it running while
 * the page is open: the first program whose sealed ask opens is the one asked
 * about, and nobody after it.
 *
 * @param options.code The code from the link the home was opened at
 * @param options.origin Where this home lives: the program's proof names it. Default: this page's.
 * @returns A way to stop listening; the code stops working
 */
export async function answerConnectCode(
  options: CodeNetwork & {
    readonly code: string;
    readonly origin?: string;
    /** How long to wait for the program to ask. Default 60 s: it is waiting when its link opens, unless it has gone or another home answered it. */
    readonly findTimeoutMs?: number;
  },
  onStage: (stage: ConnectCodeStage) => void,
): Promise<{ stop(): void }> {
  if (options.relays.length === 0 && !options.transport)
    throw new Error('Connecting by code needs a relay, and none is configured.');
  const origin = options.origin ?? globalThis.location?.origin;
  if (!origin || readOrigin({ origin }) === null)
    throw new Error('Connecting by code needs the home’s origin.');
  const secret = readConnectCode(options.code);
  const room = await meetOnChannel(CODE_CHANNEL, options, secret);
  /**
   * What each peer that said hello committed to, and the key made for that
   * exchange alone (one key for every peer would let a peer learn it in one
   * exchange and steer the check in another), then its exchange once it
   * showed its point, until one asks
   */
  const commits = new Map<string, { readonly commit: string; readonly mine: ChannelKeys }>();
  const channels = new Map<string, Channel>();
  let asked: { readonly peer: string; readonly channel: Channel; readonly asking: CodeAsking } | null = null;
  let settled = false;
  const finish = (stage?: ConnectCodeStage) => {
    if (settled) return;
    settled = true;
    globalThis.clearTimeout(timer);
    room.leave();
    if (stage) onStage(stage);
  };

  const handle = async (message: NetworkMessage): Promise<void> => {
    if (settled) return;
    if (message.type === HELLO && !asked) {
      if (commits.has(message.from) || commits.size >= MAX_TRIED) return;
      const commit = bytesField(message, 'commit');
      if (!commit) return;
      const mine = await channelKeyPair();
      commits.set(message.from, { commit: base64UrlEncode(commit), mine });
      // Its point comes only after this one: it committed to it before seeing it.
      room.send(message.from, KEY, { key: base64UrlEncode(mine.point) });
    } else if (message.type === POINT && !asked) {
      if (channels.has(message.from)) return;
      const point = bytesField(message, 'key');
      const said = commits.get(message.from);
      if (!point || !said || (await commitTo(point)) !== said.commit) return;
      const channel = await deriveChannel({
        kind: CODE_CHANNEL,
        secret,
        privateKey: said.mine.privateKey,
        offer: said.mine.point,
        join: point,
        side: 'offer',
      }).catch(() => null);
      if (!channel) return;
      channels.set(message.from, channel);
      // Where the home lives: the program's proof names it, so the proof is no use anywhere else.
      await room.seal(message.from, HOME, channel, { origin });
    } else if (message.type === ASK && !asked) {
      const channel = channels.get(message.from);
      if (!channel) return;
      // Opens only for a program that holds the code and is the other end of this exchange.
      const asking = readAsk(await room.open(message, channel));
      if (!asking) return;
      const peer = message.from;
      // The code is spent: nobody after this program is answered.
      asked = { peer, channel, asking };
      globalThis.clearTimeout(timer);
      // So the program knows it was right, and the person is deciding.
      await room.seal(peer, HEARD, channel, {});
      onStage({
        kind: 'asking',
        asking,
        check: await connectCheck(channel),
        allow: async (grant) => {
          if (grant.note.payload.aud !== asking.did) throw new Error('That note is for a different key.');
          if (!grantsRecordsOnly(grant.note))
            throw new Error('A program connected by code gets records only.');
          await room.seal(peer, ANSWER, channel, { grant } satisfies Answer);
        },
        deny: (reason = 'The person said no.') => {
          void room
            .seal(peer, ANSWER, channel, { denied: reason } satisfies Answer)
            .then(() => finish({ kind: 'failed', reason: 'You said no. The program can ask again.' }));
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
  // Declared last: everything above that clears it runs only once the room is joined.
  const timer = globalThis.setTimeout(
    () =>
      finish({ kind: 'failed', reason: 'The program that opened this link isn’t waiting for it any more.' }),
    options.findTimeoutMs ?? 60_000,
  );
  await room.net.connect();
  return {
    stop: () => {
      finish();
      room.net.disconnect();
    },
  };
}

/** How long a program connected by code stays in sync before it asks again */
const CODE_DAYS = 30;

/**
 * The account home's connect page, opened at a code: answers the program and
 * hands its ask to the same approval as an app's, as a request for records in
 * the whole account. `approve` sends the note, `deny` says no. `onAnswered`
 * says how it went, since this page was opened by a person, not an app, and
 * stays open: allowed only once the program says it has the note.
 *
 * @returns The program's request, or null when none came
 */
export function receiveConnectCode(
  options: CodeNetwork & {
    readonly code: string;
    readonly origin?: string;
    readonly onAnswered?: (answer: { readonly allowed: boolean }) => void;
  },
): Promise<IncomingRequest | null> {
  const origin = options.origin ?? globalThis.location?.origin ?? '';
  return new Promise((resolve) => {
    let asked = false;
    void answerConnectCode({ ...options, origin }, (stage) => {
      // The room is left by the exchange itself, after a moment for the last message to go.
      if (stage.kind === 'connected') options.onAnswered?.({ allowed: true });
      if (stage.kind === 'failed') {
        if (asked) options.onAnswered?.({ allowed: false });
        else resolve(null);
      }
      if (stage.kind !== 'asking') return;
      asked = true;
      const { asking, check } = stage;
      resolve({
        origin,
        check,
        request: {
          v: 1,
          audience: asking.did,
          proof: asking.proof,
          name: asking.name,
          access: 'write',
          scope: 'account',
          chooseSpaces: false,
          recordsOnly: true,
          via: 'code',
          days: CODE_DAYS,
        },
        approve: (answer) => {
          if (!('note' in answer)) return stage.deny('The home answered with something other than a note.');
          void stage
            .allow({ ...answer, home: `${origin}/connect` })
            .catch(() => stage.deny('The home could not send the note.'));
        },
        deny: (reason) => stage.deny(reason),
      });
    }).catch(() => resolve(null));
  });
}

// ─── The program's side ──────────────────────────────────────────────

/**
 * Connects this program with a code it made ({@link newConnectCode}): open
 * {@link connectCodeUrl} for the person, then wait here for their home.
 *
 * @param params.home The account home it opened: only a peer saying it is that home is asked, and the grant keeps it
 * @param params.key This program's key — the note will be made out to it, and it signs the proof for the home's origin
 * @param params.name What the person sees, e.g. "Agent on leifs-macbook"
 * @param params.onWaiting Told once the home has heard, and the person is deciding, with where the home lives
 * @returns The grant, checked: a records-only note for this key, with `home` the one it opened
 * @throws When the person says no, or nothing answers in time
 */
export async function connectWithCode(params: {
  readonly code: string;
  readonly home: string;
  readonly key: AppKey;
  readonly name: string;
  readonly network: CodeNetwork;
  readonly onWaiting?: (home: { readonly origin: string }) => void;
  /**
   * Asks the person for the check code the home shows, until `matches` says
   * it does; rejecting gives up. The note is kept only once it matches: so a
   * home the person never saw can't connect it.
   */
  readonly check: (matches: (typed: string) => boolean) => Promise<void>;
  /** How long to wait for the home to open at all. Default 10 minutes: the person may make an account first. */
  readonly findTimeoutMs?: number;
  /** How long the person has to decide once it has. Default 30 minutes. */
  readonly decideTimeoutMs?: number;
}): Promise<Grant> {
  const secret = readConnectCode(params.code);
  const opened = new URL('/connect', params.home);
  const room = await meetOnChannel(CODE_CHANNEL, params.network, secret);
  /** A key for each peer it says hello to, for that exchange alone, as the home makes one for each */
  const keys = new Map<string, Promise<ChannelKeys>>();

  return new Promise<Grant>((resolve, reject) => {
    /** The person giving the check code: started once the home has heard */
    let checked: Promise<void> | null = null;
    const channels = new Map<string, Channel>();
    /** Where each peer that holds the code says its home lives, once it has said */
    const origins = new Map<string, string>();
    let home: { readonly peer: string; readonly channel: Channel; readonly origin: string } | null = null;
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
      if (home || keys.has(peer.did) || keys.size >= MAX_TRIED) return;
      const mine = channelKeyPair();
      keys.set(peer.did, mine);
      void mine
        .then(async ({ point }) => room.send(peer.did, HELLO, { commit: await commitTo(point) }))
        .catch(() => {});
    });

    const handle = async (message: NetworkMessage): Promise<void> => {
      if (settled) return;
      if (message.type === KEY && !home) {
        if (channels.has(message.from)) return;
        const point = bytesField(message, 'key');
        const mine = await keys.get(message.from);
        if (!point || !mine) return;
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
        room.send(message.from, POINT, { key: base64UrlEncode(mine.point) });
      } else if (message.type === HOME && !home) {
        const channel = channels.get(message.from);
        if (!channel || origins.has(message.from)) return;
        const origin = readOrigin(await room.open(message, channel));
        // Only the home it opened: the proof names it, and so does the grant it keeps.
        if (origin !== opened.origin) return;
        origins.set(message.from, origin);
        // The proof names the home's origin: any other home refuses it.
        const proof = await keyProof(params.key, { via: 'code', recordsOnly: true, origin });
        await room.seal(message.from, ASK, channel, {
          did: params.key.did,
          proof,
          name: params.name.slice(0, MAX_NAME),
        });
      } else if (message.type === HEARD && !home) {
        const channel = channels.get(message.from);
        const origin = origins.get(message.from);
        // Only a home that holds the code, at the other end of this exchange, can seal this.
        if (!channel || !origin || !(await room.open(message, channel))) return;
        home = { peer: message.from, channel, origin };
        params.onWaiting?.({ origin });
        const expected = await connectCheck(channel);
        checked = params.check((typed) => typed.replace(/\D/g, '') === expected);
        checked.catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
        // Once the home has the question, the person gets longer to answer it.
        wait(params.decideTimeoutMs ?? 30 * 60_000, 'Nobody answered at the account home. Try again.');
      } else if (message.type === ANSWER && home && message.from === home.peer) {
        const answer = await room.open(message, home.channel);
        if (!isObject(answer)) return;
        if (typeof answer.denied === 'string') {
          fail(answer.denied.slice(0, 200));
          return;
        }
        try {
          // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- checkGrant checks it
          const grant = answer.grant as Grant;
          await checkGrant(grant, params.key.did, { recordsOnly: true });
          // Kept only once the person gave the code their own home showed.
          await checked;
          await room.seal(message.from, DONE, home.channel, {});
          // Where to connect again is the home it opened, never one the answer names.
          settle(() => resolve({ ...grant, home: opened.href }));
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

    wait(params.findTimeoutMs ?? 10 * 60_000, 'The account home was not opened in time. Try again.');
    room.net.connect().catch(() => fail('Could not reach the relay.'));
  });
}
