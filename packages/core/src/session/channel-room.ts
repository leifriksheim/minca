/**
 * @module session/channel-room
 * The room two sides of a channel meet in (`identity/channel.ts`): joined
 * under a throwaway name, with introductions off, sending plain messages for
 * the key exchange and sealed JSON after it. Pairing and connecting by code
 * both run here, and differ only in their messages.
 */
import { createMesh } from '../network/mesh.js';
import { createNetworkManager, type NetworkManager } from '../network/network-manager.js';
import type { PeerTransport } from '../network/transport.js';
import { channelRoom, type Channel, type ChannelKind } from '../identity/channel.js';
import { createP256Provider } from '../identity/crypto-p256.js';
import { didOf } from '../identity/did.js';
import { base64UrlDecode, utf8Decode, utf8Encode } from '../utils/encoding.js';
import { isObject } from '../utils/guards.js';
import type { NetworkMessage } from '../types.js';

/** Where the two sides meet */
export interface ChannelNetwork {
  /** Relays to meet on. Both sides must share one. */
  readonly relays: ReadonlyArray<string>;
  /** A transport instead of WebRTC — for tests */
  readonly transport?: (did: string) => PeerTransport;
}

/**
 * Joins the room for a secret as a throwaway name. Neither side is anyone yet
 * on the wire: a session key would tie the room to its account.
 */
export async function meetOnChannel(kind: ChannelKind, network: ChannelNetwork, secret: Uint8Array) {
  const keys = await createP256Provider().generateKeyPair();
  const did = await didOf(keys.publicKey);
  const room = await channelRoom(kind, secret);
  const net: NetworkManager = network.transport
    ? createNetworkManager({ did, createTransport: () => network.transport!(did) })
    : createMesh({ relays: network.relays, did, key: keys.privateKey, introductions: false }).join(room);
  const send = (to: string, type: string, payload: unknown) => net.send(to, { type, from: did, payload });
  const seal = async (to: string, type: string, channel: Channel, value: unknown) =>
    send(to, type, await channel.seal(type, utf8Encode(JSON.stringify(value))));
  /** What a sealed message says, or null when it is not the other side's next message on this channel */
  const open = async (message: NetworkMessage, channel: Channel): Promise<unknown> => {
    const plain = await channel.open(message.type, message.payload);
    if (!plain) return null;
    try {
      return JSON.parse(utf8Decode(plain));
    } catch {
      return null;
    }
  };
  // A moment for the last message to leave.
  const leave = () => globalThis.setTimeout(() => net.disconnect(), 500);
  return { did, net, send, seal, open, leave };
}

/** A base64url field of a plain message, as bytes, or null */
export function bytesField(message: NetworkMessage, name: string): Uint8Array | null {
  const value = isObject(message.payload) ? message.payload[name] : undefined;
  if (typeof value !== 'string' || value.length > 200) return null;
  try {
    return base64UrlDecode(value);
  } catch {
    return null;
  }
}
