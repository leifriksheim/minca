/**
 * @module session/pairing
 * Handing an account to a phone. The desktop shows a QR code whose link
 * carries a one-time secret and a relay. Both sides meet in a room named after
 * the secret, swap ephemeral keys (the phone commits to its key first), and
 * show the same six digits. Once the person says they match, the desktop sends
 * the seed and the spaces, sealed for this exchange only. Afterwards the phone
 * is a full peer and never needs the desktop again.
 */
import type { PeerTransport } from '../network/transport.js';
import { channelKeyPair, deriveChannel, PAIRING_CHANNEL, type Channel } from '../identity/channel.js';
import {
  decodePairingTicket,
  encodePairingTicket,
  newPairingSecret,
  pairingCode,
  pairingCommitment,
  type PairingTicket,
} from '../identity/pairing.js';
import { RECOVERY_SEED_BYTES } from '../identity/recovery-code.js';
import { base64UrlDecode, base64UrlEncode } from '../utils/encoding.js';
import { isObject } from '../utils/guards.js';
import type { NetworkMessage } from '../types.js';
import { bytesField, meetOnChannel, type ChannelNetwork } from './channel-room.js';

/** Messages in a pairing room, in the order they are sent */
const COMMIT = 'pair:commit';
const KEY = 'pair:key';
const REVEAL = 'pair:reveal';
const HANDOVER = 'pair:handover';
const DONE = 'pair:done';

/** How long a code on screen works before a phone uses it. Default for `offerToPhone`. */
const OFFER_TTL_MS = 2 * 60_000;

/** What the desktop hands over */
export interface Handover {
  readonly seed: Uint8Array;
  readonly spaces: ReadonlyArray<string>;
}

export type PairingStage =
  | { readonly kind: 'waiting' }
  /** The phone's side: show the code, and wait for the person to confirm on the computer */
  | { readonly kind: 'confirm'; readonly code: string }
  /** The desktop's side: show the code and ask whether the phone shows the same */
  | {
      readonly kind: 'compare';
      readonly code: string;
      readonly same: () => void;
      readonly different: () => void;
    }
  /** The desktop sealing the account; on the phone, signing in with what arrived */
  | { readonly kind: 'sending' }
  /** The phone's side: joining the spaces that came with the account, one at a time */
  | { readonly kind: 'joining'; readonly joined: number; readonly total: number }
  | { readonly kind: 'sent'; readonly spaces: number }
  | { readonly kind: 'received'; readonly spaces: number }
  | { readonly kind: 'failed'; readonly reason: string };

/** A pairing offer the desktop is currently making */
export interface PairingOffer {
  /** The link the QR code encodes */
  readonly url: string;
  /** Stops listening. The link stops working for anyone still holding it. */
  stop(): void;
}

const failure = (error: unknown, fallback: string): PairingStage => ({
  kind: 'failed',
  reason: error instanceof Error ? error.message : fallback,
});

/**
 * Starts offering an account to a phone; the first relay goes in the link.
 *
 * One offer serves one phone: the first that commits is the only one answered.
 * The code stops working after `ttlMs` if no phone has used it, and as soon as
 * one has.
 */
export async function offerToPhone(
  params: {
    readonly seed: Uint8Array;
    /**
     * An invite to every space the account holds. Invites carry everything a
     * peer needs to open a space, the key of a private one included.
     */
    readonly invites: () => Promise<ReadonlyArray<string>>;
    readonly relays: ReadonlyArray<string>;
    readonly link: string;
    readonly ttlMs?: number;
    readonly transport?: (did: string) => PeerTransport;
  },
  onStage: (stage: PairingStage) => void,
): Promise<PairingOffer> {
  const { seed, relays } = params;
  const relay = relays[0];
  if (!relay && !params.transport) throw new Error('Pairing needs a relay, and none is configured.');

  const secret = newPairingSecret();
  const ticket: PairingTicket = { v: 2, secret: base64UrlEncode(secret), relay: relay ?? '' };
  const url = `${params.link}#pair=${encodePairingTicket(ticket)}`;
  const room = await meetOnChannel(PAIRING_CHANNEL, { relays, transport: params.transport }, secret);
  const mine = await channelKeyPair();

  let phone: { readonly peer: string; readonly commit: string } | null = null;
  let channel: Channel | null = null;
  let settled = false;
  const finish = (stage: PairingStage) => {
    if (settled) return;
    settled = true;
    globalThis.clearTimeout(expiry);
    room.leave();
    onStage(stage);
  };
  const expiry = globalThis.setTimeout(
    () => finish({ kind: 'failed', reason: 'The code expired. Show a new one.' }),
    params.ttlMs ?? OFFER_TTL_MS,
  );

  const handOver = async (peer: string, open: Channel) => {
    if (settled) return;
    onStage({ kind: 'sending' });
    try {
      const spaces = await params.invites();
      await room.seal(peer, HANDOVER, open, { seed: base64UrlEncode(seed), spaces });
    } catch (error) {
      finish(failure(error, 'Handover failed'));
    }
  };

  /** The first phone to commit spends the code: nobody after it is answered */
  const onCommit = (message: NetworkMessage) => {
    const commit = bytesField(message, 'commit');
    if (!commit) return;
    phone = { peer: message.from, commit: base64UrlEncode(commit) };
    globalThis.clearTimeout(expiry);
    room.send(message.from, KEY, { key: base64UrlEncode(mine.point) });
  };

  const onReveal = async (message: NetworkMessage, { peer, commit }: NonNullable<typeof phone>) => {
    const point = bytesField(message, 'key');
    if (!point || (await pairingCommitment(point)) !== commit) {
      finish({ kind: 'failed', reason: 'The phone did not pair cleanly. Show a new code.' });
      return;
    }
    try {
      const open = await deriveChannel({
        kind: PAIRING_CHANNEL,
        secret,
        privateKey: mine.privateKey,
        offer: mine.point,
        join: point,
        side: 'offer',
      });
      channel = open;
      onStage({
        kind: 'compare',
        code: await pairingCode(open),
        same: () => void handOver(peer, open),
        different: () =>
          finish({
            kind: 'failed',
            reason: 'The codes did not match, so nothing was sent. Show a new code to try again.',
          }),
      });
    } catch (error) {
      finish(failure(error, 'The phone did not pair cleanly.'));
    }
  };

  const onDone = async (message: NetworkMessage, open: Channel) => {
    const said = await room.open(message, open);
    if (isObject(said) && typeof said.spaces === 'number') finish({ kind: 'sent', spaces: said.spaces });
  };

  room.net.on('message', (message: NetworkMessage) => {
    if (settled) return;
    const fromPhone = phone !== null && message.from === phone.peer;
    if (message.type === COMMIT && !phone) onCommit(message);
    else if (message.type === REVEAL && phone && fromPhone && !channel) void onReveal(message, phone);
    else if (message.type === DONE && channel && fromPhone) void onDone(message, channel);
  });

  room.net.on('error', () => {
    if (!room.net.isConnected())
      finish({ kind: 'failed', reason: 'Could not reach the relay from this page.' });
  });

  onStage({ kind: 'waiting' });
  await room.net.connect();
  return {
    url,
    stop: () => {
      settled = true;
      globalThis.clearTimeout(expiry);
      room.net.disconnect();
    },
  };
}

/** The pairing link in this page's URL, if the phone arrived from a QR code. */
export function readPairingTicket(): PairingTicket | null {
  const match = /[#&]pair=([^&]+)/.exec(globalThis.location?.hash ?? '');
  if (!match?.[1]) return null;
  try {
    return decodePairingTicket(match[1]);
  } catch {
    return null;
  }
}

/** Drops the pairing link from the address bar once it has been used. */
export function clearPairingTicket(): void {
  if (!globalThis.location || !globalThis.history) return;
  globalThis.history.replaceState(null, '', globalThis.location.pathname + globalThis.location.search);
}

function readHandover(value: unknown): Handover | null {
  if (!isObject(value) || typeof value.seed !== 'string') return null;
  if (!Array.isArray(value.spaces) || !value.spaces.every((s) => typeof s === 'string')) return null;
  try {
    const seed = base64UrlDecode(value.seed);
    return seed.length === RECOVERY_SEED_BYTES ? { seed, spaces: value.spaces } : null;
  } catch {
    return null;
  }
}

/**
 * The phone's side: meets the desktop, shows the code (`confirm`), and
 * resolves with the account and its spaces once the person confirms on the
 * computer.
 * @throws When the desktop does not answer, the person says the codes differ,
 *   or what arrives is not a handover
 */
export async function receiveFromDesktop(
  ticket: PairingTicket,
  onStage: (stage: PairingStage) => void,
  options: {
    /** How long to wait for the computer to answer at all. Default 60 s. */
    readonly findTimeoutMs?: number;
    /** How long the person has to compare the codes. Default 10 minutes. */
    readonly confirmTimeoutMs?: number;
    readonly transport?: (did: string) => PeerTransport;
    /** Stops it: the phone leaves the room, and the promise rejects. */
    readonly signal?: AbortSignal;
  } = {},
): Promise<Handover> {
  const secret = base64UrlDecode(ticket.secret);
  // The relay in the ticket: the computer showing the code is on it, and the
  // phone has no configuration.
  const network: ChannelNetwork = { relays: [ticket.relay], transport: options.transport };
  const room = await meetOnChannel(PAIRING_CHANNEL, network, secret);
  const mine = await channelKeyPair();
  const commit = await pairingCommitment(mine.point);

  return new Promise<Handover>((resolve, reject) => {
    let desktop: string | null = null;
    let channel: Channel | null = null;
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

    room.net.on('peer-connected', (peer: { did: string }) => {
      if (!desktop) room.send(peer.did, COMMIT, { commit });
    });

    const onKey = async (message: NetworkMessage) => {
      const point = bytesField(message, 'key');
      if (!point) return;
      try {
        const open = await deriveChannel({
          kind: PAIRING_CHANNEL,
          secret,
          privateKey: mine.privateKey,
          offer: point,
          join: mine.point,
          side: 'join',
        });
        const code = await pairingCode(open);
        desktop = message.from;
        channel = open;
        room.send(message.from, REVEAL, { key: base64UrlEncode(mine.point) });
        onStage({ kind: 'confirm', code });
        wait(
          options.confirmTimeoutMs ?? 10 * 60_000,
          'Nobody confirmed the code on the computer. Show a new code to try again.',
        );
      } catch (error) {
        fail(error instanceof Error ? error.message : 'The computer did not pair cleanly.');
      }
    };

    const onHandover = async (message: NetworkMessage, open: Channel) => {
      const handover = readHandover(await room.open(message, open));
      // Stopped while it opened: the room is left, and the computer is told nothing.
      if (settled) {
        handover?.seed.fill(0);
        return;
      }
      if (!handover) return fail('That handover could not be read.');
      // So the computer can say it arrived, and stop showing the code.
      await room.seal(message.from, DONE, open, { spaces: handover.spaces.length });
      settle(() => resolve(handover));
    };

    room.net.on('message', (message: NetworkMessage) => {
      if (settled) return;
      if (message.type === KEY && !desktop) void onKey(message);
      else if (message.type === HANDOVER && channel && message.from === desktop)
        void onHandover(message, channel);
    });

    if (options.signal?.aborted) return fail('Pairing stopped.');
    options.signal?.addEventListener('abort', () => fail('Pairing stopped.'), { once: true });
    onStage({ kind: 'waiting' });
    wait(
      options.findTimeoutMs ?? 60_000,
      'The computer did not answer. Check the code is still showing, and that both devices are online.',
    );
    room.net.connect().catch(() => fail('Could not reach the relay from this phone.'));
  });
}
