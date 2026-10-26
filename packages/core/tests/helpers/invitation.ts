/**
 * Invitations made and changed by hand: a key that signs for itself, as anyone
 * passing an invite on could make one, and an invite rewritten and signed
 * again with it.
 */
import { createP256Provider } from '../../src/identity/crypto-p256.js';
import { didOf } from '../../src/identity/did.js';
import { signLoose, type LooseSigner } from '../../src/records/loose.js';
import { INVITATION_COLLECTION, readInvitation, writeInvitation } from '../../src/space/invitation.js';
import { base64UrlDecode } from '../../src/utils/encoding.js';
import { isRecord } from '../../src/utils/guards.js';

const provider = createP256Provider();

/** A fresh key that signs for itself: its own account, with no note */
export async function selfSigner(): Promise<LooseSigner> {
  const pair = await provider.generateKeyPair();
  return { did: await didOf(pair.publicKey, provider), key: pair.privateKey };
}

/** Rewrites an invite's body and signs it again with a key of one's own, as whoever passes it along could */
export async function resign(
  invite: string,
  change: (body: Record<string, unknown> & { space: Record<string, unknown> }) => void,
  signer?: LooseSigner,
): Promise<string> {
  const { version, secret } = readInvitation(invite);
  const body: unknown = structuredClone(version.body);
  if (!isRecord(body) || !isRecord(body.space)) throw new Error('not an invitation');
  change(Object.assign(body, { space: body.space }));
  const signed = await signLoose(signer ?? (await selfSigner()), INVITATION_COLLECTION, body, provider);
  return writeInvitation(signed, secret ? base64UrlDecode(secret) : undefined);
}
