import type { CryptoProvider, Version, UnsignedVersion } from '../types.js';
import { bodyProblem, canonicalize, envelopeOf, getVersionId, signedPart } from './version.js';
import { utf8Encode, base64UrlEncode, base64UrlDecode } from '../utils/encoding.js';

/** JWS-style signing and verification for versions. */
export interface Signer {
  /** Signs an unsigned payload, returning a complete Version. */
  sign<T>(payload: UnsignedVersion<T>, privateKey: CryptoKey): Promise<Version<T> & { readonly body: T }>;

  /** Verifies the signature and ID of a Version. */
  verify<T>(version: Version<T>, publicKey: CryptoKey): Promise<boolean>;
}

export function createSigner(provider: CryptoProvider): Signer {
  return Object.freeze({
    async sign<T>(payload: UnsignedVersion<T>, privateKey: CryptoKey) {
      // The body is signed through its hash, so the envelope checks without it.
      const envelope = await envelopeOf(payload);
      const signature = base64UrlEncode(await provider.sign(privateKey, utf8Encode(canonicalize(envelope))));
      // Everything that was signed, and nothing else: listing fields one by
      // one would silently drop any field added later from the record.
      return Object.freeze({
        id: await getVersionId(envelope),
        ...envelope,
        body: payload.body,
        signature,
      });
    },

    async verify<T>(version: Version<T>, publicKey: CryptoKey): Promise<boolean> {
      const signed = signedPart(version);
      if ((await bodyProblem(version)) || version.id !== (await getVersionId(signed))) return false;
      const bytes = utf8Encode(canonicalize(signed));
      return provider.verify(publicKey, base64UrlDecode(version.signature), bytes);
    },
  });
}
