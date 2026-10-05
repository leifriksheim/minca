/**
 * @module records/fork
 * Proof that a key forked its log (spec 02 §4.10).
 *
 * Every key's writes in a space form one line. Two versions that one key
 * signed at one place in that line can't both be the key's honest next
 * write: the key was used in two places at once — a **fork**. A version whose
 * `prev` names anything but its key's version one place before can't be one
 * either — a **break**. Either pair proves it to anyone, with nothing to trust
 * but the signatures, so a peer that finds one can hand it to every other, and
 * each checks it for itself.
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

/**
 * Whether `next`, which names `previous` as the version before it in its
 * key's log, can't follow it: another key's, another space's, or not one
 * place before.
 */
export function breaksLine(next: Version, previous: Version): boolean {
  return (
    next.log?.prev === previous.id &&
    (previous.author !== next.author ||
      previous.space !== next.space ||
      previous.log?.n === undefined ||
      previous.log.n !== next.log.n - 1)
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
 * What two versions prove in a space, or why they prove nothing: both well
 * formed and validly signed, without bodies, in this space, and either a fork
 * (one key, one place, two versions) or a break (one names the other as the
 * place before it, and it isn't). A break is the naming version's key's, from
 * its own place on.
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
  for (const [next, previous] of [
    [first, second],
    [second, first],
  ] as const) {
    if (next.log && breaksLine(next, previous)) return { writer: next.author, from: next.log.n };
  }
  if (first.author !== second.author) return 'A fork is proven by versions one key signed';
  if (first.log?.n === undefined || first.log.n !== second.log?.n)
    return 'A fork is proven by versions at one place in their log';
  return { writer: first.author, from: first.log.n };
}
