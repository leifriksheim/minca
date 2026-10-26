/**
 * Real sessions for meeting through relays, and messages signed and sealed by
 * hand the way a peer says them in a room (spec 04 §2). The label is written
 * out here rather than taken from `src`, so a change to it breaks a test.
 */
import { createP256Provider } from '../../src/identity/crypto-p256.js';
import { didOf } from '../../src/identity/did.js';
import { sealValue } from '../../src/identity/envelope.js';
import { rendezvousKeys } from '../../src/network/rendezvous.js';
import { base64UrlEncode, utf8Encode } from '../../src/utils/encoding.js';

export interface Session {
  readonly did: string;
  readonly key: CryptoKey;
}

const provider = createP256Provider();

/** A fresh session key and the `did:key` naming it */
export async function session(): Promise<Session> {
  const pair = await provider.generateKeyPair();
  return { did: await didOf(pair.publicKey, provider), key: pair.privateKey };
}

/** `N` sessions, as a tuple so each can be named */
type Sessions<N extends number, Got extends Session[] = []> = Got['length'] extends N
  ? Got
  : Sessions<N, [...Got, Session]>;

/** `n` sessions, lowest DID first: the lower of two is the one that offers */
export async function sessionsInOrder<N extends number>(n: N): Promise<Sessions<N>> {
  const all = await Promise.all(Array.from({ length: n }, session));
  all.sort((a, b) => (a.did < b.did ? -1 : a.did > b.did ? 1 : 0));
  // eslint-disable-next-line typescript/consistent-type-assertions -- an array of length n is the n-tuple
  return all as Sessions<N>;
}

export interface RoomMessage {
  readonly kind: string;
  readonly id: string;
  readonly at: number;
  readonly from: string;
  readonly box: string;
  readonly to?: string;
  readonly [field: string]: unknown;
}

/** What `sig` covers: every field, the sealed description too */
const rendezvousSigLabel = (topic: string, m: RoomMessage) =>
  utf8Encode(
    `minca/rendezvous-sig/v1|${topic}|${m.kind}|${m.id}|${m.at}|${m.from}|${m.box}|${m.to ?? ''}|${typeof m.sdp === 'string' ? m.sdp : ''}`,
  );

/** `message`, signed by `signer` and sealed under `room`'s key, as a relay carries it */
export async function sealedSigned(room: string, signer: Session, message: RoomMessage): Promise<string> {
  const { topic, key } = await rendezvousKeys(room);
  const sig = base64UrlEncode(await provider.sign(signer.key, rendezvousSigLabel(topic, message)));
  return sealValue(key, 'minca/rendezvous/v1', { topic }, { ...message, sig });
}

/** A hello from `signer` in `room`, under its own name unless `from` says otherwise */
export function signedHello(
  room: string,
  signer: Session,
  box: string,
  options: { id?: string; at?: number; from?: string } = {},
): Promise<string> {
  return sealedSigned(room, signer, {
    kind: 'hello',
    id: options.id ?? base64UrlEncode(crypto.getRandomValues(new Uint8Array(12))),
    at: options.at ?? Date.now(),
    from: options.from ?? signer.did,
    box,
  });
}
