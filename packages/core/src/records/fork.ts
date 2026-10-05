/**
 * @module records/fork
 * Proof that a key forked its log (spec 02 §4.10).
 *
 * Every key's writes in a space form one line. Two versions that one key
 * signed at one place in that line can't both be the key's honest next
 * write: the key was used in two places at once. The pair proves it to anyone,
 * with nothing to trust but the signatures, so a peer that finds one can hand
 * it to every other, and each checks it for itself.
 */
import type { CryptoProvider, Version } from '../types.js';
import { didToPublicKey } from '../identity/did.js';
import { isRecord } from '../utils/guards.js';
import { createCryptoGate } from '../validation/crypto-gate.js';
import { stubOf } from '../schema/version.js';
import { checkVersionShape } from './version.js';

/** Whether a value has a signed version's fields, for the checks that follow to judge */
function signedVersion(value: Record<string, unknown>): value is Record<string, unknown> & Version {
  return (
    typeof value.id === 'string' &&
    typeof value.author === 'string' &&
    typeof value.signature === 'string' &&
    typeof value.collection === 'string' &&
    typeof value.createdAt === 'string'
  );
}

/** What a proven fork says: whose log, and from which place on */
export interface Fork {
  readonly writer: string;
  readonly from: number;
}

/**
 * The two versions as a `sys.fork` record carries them: stubs, without
 * bodies, in id order, so the same pair makes the same record wherever it is
 * found.
 */
export function forkProof(a: Version, b: Version): { readonly a: Version; readonly b: Version } {
  const [first, second] = a.id < b.id ? [a, b] : [b, a];
  return { a: stubOf(first), b: stubOf(second) };
}

/**
 * The fork two versions prove in a space, or why they prove none: both well
 * formed and validly signed, without bodies, by one key, in this space, at one
 * place in that key's log, and not the same version.
 */
export async function checkFork(
  a: unknown,
  b: unknown,
  spaceId: string,
  provider: CryptoProvider,
): Promise<Fork | string> {
  if (!isRecord(a) || !isRecord(b)) return 'A fork is proven by two versions';
  const gate = createCryptoGate(provider);
  const resolve = async (did: string) => provider.importPublicKey(didToPublicKey(did).publicKeyBytes);
  const versions: Version[] = [];
  for (const version of [a, b]) {
    if ('body' in version) return 'A fork is proven by versions without their bodies';
    if (!signedVersion(version)) return 'A fork is proven by signed versions';
    const shape = checkVersionShape(version);
    if (shape) return shape;
    if (version.space !== spaceId) return 'A fork is proven by versions of this space';
    const signed = await gate.validate(version, resolve);
    if (!signed.passed) return signed.reason ?? 'Its signature does not check out';
    versions.push(version);
  }
  const [first, second] = versions;
  if (!first || !second) return 'A fork is proven by two versions';
  if (first.id === second.id) return 'A fork is proven by two different versions';
  if (first.author !== second.author) return 'A fork is proven by versions one key signed';
  if (first.log?.n === undefined || first.log.n !== second.log?.n)
    return 'A fork is proven by versions at one place in their log';
  return { writer: first.author, from: first.log.n };
}
