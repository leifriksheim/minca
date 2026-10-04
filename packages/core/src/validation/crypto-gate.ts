import { CryptoProvider, Version } from '../types.js';
import { utf8Encode, base64UrlDecode } from '../utils/encoding.js';
import { messageOf } from '../utils/errors.js';
import { bodyProblem, canonicalize, getVersionId, signedPart } from '../schema/version.js';

export interface GateResult {
  readonly passed: boolean;
  readonly gate: string;
  readonly reason?: string;
}

export interface CryptoGate {
  validate(version: Version, resolvePublicKey: (did: string) => Promise<CryptoKey>): Promise<GateResult>;
}

/** Creates a gate that performs cryptographic validation of versions. */
export function createCryptoGate(provider: CryptoProvider): CryptoGate {
  return {
    async validate(
      version: Version,
      resolvePublicKey: (did: string) => Promise<CryptoKey>,
    ): Promise<GateResult> {
      try {
        // Only the envelope is signed — the id is a hash of it, the signature
        // is not part of what was hashed, and the body is there as its hash.
        const { id, signature } = version;
        const unsignedPayload = signedPart(version);

        const expectedId = await getVersionId(unsignedPayload);
        if (id !== expectedId) {
          return { passed: false, gate: 'crypto', reason: 'Version id does not match its content' };
        }

        const data = utf8Encode(canonicalize(unsignedPayload));

        const publicKey = await resolvePublicKey(version.author);
        const sigBytes = base64UrlDecode(signature);

        const isValid = await provider.verify(publicKey, sigBytes, data);
        if (isValid) {
          const problem = await bodyProblem(version);
          if (problem) return { passed: false, gate: 'crypto', reason: problem };
          return { passed: true, gate: 'crypto' };
        } else {
          return { passed: false, gate: 'crypto', reason: 'Signature verification failed' };
        }
      } catch (err) {
        return { passed: false, gate: 'crypto', reason: messageOf(err, 'Unknown crypto error') };
      }
    },
  };
}
