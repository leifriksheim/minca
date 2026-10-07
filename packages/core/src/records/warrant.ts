/**
 * @module records/warrant
 * What a warrant is made of (docs/warrants.md).
 *
 * A warrant is proof that an account's key signed something the protocol
 * refuses, that no honest writer could have signed: judged as of what the
 * version itself says it had seen, so no race with a change elsewhere
 * explains it. The proof is the signed version, and what checking it needs,
 * so every peer judges it for itself and nobody has to take anyone's word.
 */
import type { Version } from '../types.js';
import { isRecord } from '../utils/guards.js';

/**
 * What a warrant can prove:
 * - `chain`: a version that doesn't follow the version its `prev` names (02 §4.7);
 * - `standing`: a version its author had no place, or no permission, to write,
 *   as of its own `seen` (03 §5.2);
 * - `access`: a change to who may do what its author had no power to make, as
 *   of its own `seen` (03 §4.5);
 */
const WARRANT_KINDS = ['chain', 'standing', 'access'] as const;
export type WarrantKind = (typeof WARRANT_KINDS)[number];

/** A warrant's body */
export interface Warrant {
  /** One of `WARRANT_KINDS`, or a kind a newer peer knows: kept and passed on, never acted on */
  readonly kind: string;
  /** The version that broke the rules first, then what checking it needs */
  readonly evidence: ReadonlyArray<Version>;
}

/** At most this many versions: the one, and the one before it */
const MAX_EVIDENCE = 2;

/** Whether this peer knows how to check a kind of warrant */
export const knownKind = (value: string): value is WarrantKind =>
  WARRANT_KINDS.some((kind) => kind === value);

/** Whether a value has a signed version's fields, for the checks that follow to judge */
function looksSigned(value: unknown): value is Version {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.author === 'string' &&
    typeof value.signature === 'string' &&
    typeof value.collection === 'string' &&
    typeof value.key === 'string' &&
    typeof value.seq === 'number'
  );
}

/** A warrant's body, if it is one: a kind, and one or two signed versions as evidence */
export function readWarrant(body: unknown): Warrant | null {
  if (!isRecord(body) || typeof body.kind !== 'string' || !/^[a-z]{1,32}$/.test(body.kind)) return null;
  const { evidence } = body;
  if (!Array.isArray(evidence) || evidence.length === 0 || evidence.length > MAX_EVIDENCE) return null;
  const versions: Version[] = [];
  for (const item of evidence) {
    if (!looksSigned(item)) return null;
    versions.push(item);
  }
  return { kind: body.kind, evidence: versions };
}
