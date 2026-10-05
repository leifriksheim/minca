/**
 * @module session/pairing
 * Handing an account to a phone. The desktop shows a QR code whose link
 * carries a one-time secret and a relay. Both sides meet in a room named after
 * the secret, swap ephemeral keys (the phone commits to its key first), and
 * show the same six digits. Once the person says they match, the desktop sends
 * the seed and the spaces, sealed for this exchange only. Afterwards the phone
 * is a full peer and never needs the desktop again.
 */
import { createMesh } from '../network/mesh.js';
import { createNetworkManager, type NetworkManager } from '../network/network-manager.js';
import type { PeerTransport } from '../network/transport.js';
import {
  derivePairingChannel,
  decodePairingTicket,
  encodePairingTicket,
  newPairingSecret,
  openPairingPayload,
  pairingCommitment,
  pairingKeyPair,
  pairingRoomId,
  sealPairingPayload,
  type PairingChannel,
  type PairingTicket,
} from '../identity/pairing.js';
import { createP256Provider } from '../identity/crypto-p256.js';
import { didOf } from '../identity/did.js';
import { RECOVERY_SEED_BYTES } from '../identity/recovery-code.js';
import { base64UrlDecode, base64UrlEncode, utf8Decode, utf8Encode } from '../utils/encoding.js';
import { isObject } from '../utils/guards.js';
import type { NetworkMessage } from '../types.js';

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
  | { readonly kind: 'sending' }
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

/** Where the two devices meet */
interface PairingNetwork {
  readonly relays: ReadonlyArray<string>;
  /** A transport instead of WebRTC — for tests */
  readonly transport?: (did: string) => PeerTransport;
}

/**
 * Joins the room for a secret as a throwaway name. Neither side is anyone yet
 * on the wire: the phone has no account, and the desktop's session key would
 * tie the room to it.
 */
async function meet(network: PairingNetwork, secret: Uint8Array) {
  const did = await didOf((await createP256Provider().generateKeyPair()).publicKey);
  const room = await pairingRoomId(secret);
  const net: NetworkManager = network.transport
    ? createNetworkManager({ did, createTransport: () => network.transport!(did) })
    : createMesh({ relays: network.relays, did, introductions: false }).join(room);
  const send = (to: string, type: string, payload: unknown) => net.send(to, { type, from: did, payload });
  const seal = async (to: string, type: string, channel: PairingChannel, value: unknown) =>
    send(to, type, Array.from(await sealPairingPayload(utf8Encode(JSON.stringify(value)), channel.key)));
  /** What a sealed message says, or null when it was not sealed on this channel */
  const open = async (message: NetworkMessage, channel: PairingChannel): Promise<unknown> => {
    if (!Array.isArray(message.payload) || !message.payload.every((n) => Number.isInteger(n))) return null;
    try {
      return JSON.parse(utf8Decode(await openPairingPayload(new Uint8Array(message.payload), channel.key)));
    } catch {
      return null;
    }
  };
  // A moment for the last message to leave.
  const leave = () => globalThis.setTimeout(() => net.disconnect(), 500);
  return { net, send, seal, open, leave };
}

/** A base64url field of a plain message, as bytes, or null */
function field(message: NetworkMessage, name: string): Uint8Array | null {
  const value = isObject(message.payload) ? message.payload[name] : undefined;
  if (typeof value !== 'string') return null;
  try {
    return base64UrlDecode(value);
  } catch {
    return null;
  }
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
  const room = await meet({ relays, transport: params.transport }, secret);
  const mine = await pairingKeyPair();

  let phone: { readonly peer: string; readonly commit: string } | null = null;
  let channel: PairingChannel | null = null;
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

  const handOver = async (peer: string, open: PairingChannel) => {
    if (settled) return;
    onStage({ kind: 'sending' });
    try {
      const spaces = await params.invites();
      await room.seal(peer, HANDOVER, open, { seed: base64UrlEncode(seed), spaces });
    } catch (error) {
      finish(failure(error, 'Handover failed'));
    }
  };

  room.net.on('message', (message: NetworkMessage) => {
    if (settled) return;
    void (async () => {
      if (message.type === COMMIT && !phone) {
        const commit = field(message, 'commit');
        if (!commit) return;
        // The code is spent: nobody after this phone is answered.
        phone = { peer: message.from, commit: base64UrlEncode(commit) };
        globalThis.clearTimeout(expiry);
        room.send(message.from, KEY, { key: base64UrlEncode(mine.point) });
      } else if (message.type === REVEAL && phone && message.from === phone.peer && !channel) {
        const point = field(message, 'key');
        if (!point || (await pairingCommitment(point)) !== phone.commit) {
          finish({ kind: 'failed', reason: 'The phone did not pair cleanly. Show a new code.' });
          return;
        }
        try {
          const open = await derivePairingChannel({
            secret,
            privateKey: mine.privateKey,
            offer: mine.point,
            phone: point,
            peer: point,
          });
          channel = open;
          const peer = phone.peer;
          onStage({
            kind: 'compare',
            code: open.code,
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
      } else if (message.type === DONE && channel && phone && message.from === phone.peer) {
        const said = await room.open(message, channel);
        if (isObject(said) && typeof said.spaces === 'number') finish({ kind: 'sent', spaces: said.spaces });
      }
    })();
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
  } = {},
): Promise<Handover> {
  const secret = base64UrlDecode(ticket.secret);
  // The relay in the ticket: the computer showing the code is on it, and the
  // phone has no configuration.
  const room = await meet({ relays: [ticket.relay], transport: options.transport }, secret);
  const mine = await pairingKeyPair();
  const commit = await pairingCommitment(mine.point);

  return new Promise<Handover>((resolve, reject) => {
    let desktop: string | null = null;
    let channel: PairingChannel | null = null;
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

    room.net.on('message', (message: NetworkMessage) => {
      if (settled) return;
      void (async () => {
        if (message.type === KEY && !desktop) {
          const point = field(message, 'key');
          if (!point) return;
          try {
            const open = await derivePairingChannel({
              secret,
              privateKey: mine.privateKey,
              offer: point,
              phone: mine.point,
              peer: point,
            });
            desktop = message.from;
            channel = open;
            room.send(message.from, REVEAL, { key: base64UrlEncode(mine.point) });
            onStage({ kind: 'confirm', code: open.code });
            wait(
              options.confirmTimeoutMs ?? 10 * 60_000,
              'Nobody confirmed the code on the computer. Show a new code to try again.',
            );
          } catch (error) {
            fail(error instanceof Error ? error.message : 'The computer did not pair cleanly.');
          }
        } else if (message.type === HANDOVER && channel && message.from === desktop) {
          const handover = readHandover(await room.open(message, channel));
          if (!handover) {
            fail('That handover could not be read.');
            return;
          }
          // So the computer can say it arrived, and stop showing the code.
          await room.seal(message.from, DONE, channel, { spaces: handover.spaces.length });
          settle(() => resolve(handover));
        }
      })();
    });

    onStage({ kind: 'waiting' });
    wait(
      options.findTimeoutMs ?? 60_000,
      'The computer did not answer. Check the code is still showing, and that both devices are online.',
    );
    room.net.connect().catch(() => fail('Could not reach the relay from this phone.'));
  });
}
