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

const fail = (reason: string): GateResult => ({ passed: false, gate: 'crypto', reason });

/** Creates a gate that performs cryptographic validation of versions. */
export function createCryptoGate(provider: CryptoProvider): CryptoGate {
  return {
    async validate(version, resolvePublicKey) {
      try {
        // Only the envelope is signed; the id is its hash, and the body is in it as a hash.
        const envelope = signedPart(version);
        if (version.id !== (await getVersionId(envelope)))
          return fail('Version id does not match its content');

        const publicKey = await resolvePublicKey(version.author);
        const signature = base64UrlDecode(version.signature);
        const signed = await provider.verify(publicKey, signature, utf8Encode(canonicalize(envelope)));
        if (!signed) return fail('Signature verification failed');

        const problem = await bodyProblem(version);
        return problem ? fail(problem) : { passed: true, gate: 'crypto' };
      } catch (err) {
        return fail(messageOf(err, 'Unknown crypto error'));
      }
    },
  };
}
