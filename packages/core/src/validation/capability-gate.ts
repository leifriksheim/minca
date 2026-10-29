import type { CryptoProvider, Version } from '../types.js';
import type { GateResult } from './crypto-gate.js';
import { noteCovers, verifyNote, type Requirement } from '../identity/ucan.js';

export interface CapabilityGateConfig {
  /** Crypto provider used to verify the note */
  readonly provider: CryptoProvider;
  /** What an author must be granted to write this version */
  readonly required: (version: Version) => Requirement;
  /** Whether a root identity may write this version at all; defaults to any root */
  readonly isTrustedRoot?: (rootDid: string, version: Version) => boolean | Promise<boolean>;
}

export interface CapabilityGate {
  validate(version: Version): Promise<GateResult>;
}

const PASSED: GateResult = Object.freeze({ passed: true, gate: 'capability' });
const fail = (reason: string): GateResult => ({ passed: false, gate: 'capability', reason });

/**
 * Creates a gate that checks an author was *authorized* to write a version.
 *
 * A version signed by a delegated key carries one note from the root identity
 * in `proof`; the gate refuses anything misaddressed, over-broad, passed on,
 * or from a root the application does not trust.
 *
 * No time is judged, by no one's clock: every peer must agree on a record's
 * standing whenever it looks. A revoke with its cutoff ends a key's writes
 * (spec 03 §6.4).
 */
export function createCapabilityGate(config: CapabilityGateConfig): CapabilityGate {
  const { provider, required, isTrustedRoot } = config;
  const trusted = async (root: string, version: Version) =>
    !isTrustedRoot || (await isTrustedRoot(root, version));

  async function check(version: Version): Promise<GateResult> {
    // No proof: the author acts for itself.
    if (version.proof === undefined) {
      return (await trusted(version.author, version))
        ? PASSED
        : fail(`Author ${version.author} is not authorized here`);
    }
    // A date sync can order by, though it decides nothing here.
    if (!Number.isFinite(Date.parse(version.createdAt))) return fail('Version has no valid creation time');

    const checked = await verifyNote(version.proof, provider, { untimed: true });
    if (!checked.valid) return fail(checked.reason);
    // Otherwise anyone could attach someone else's note to their own version.
    if (checked.audience !== version.author)
      return fail('Proof was issued to a different key than the author');

    const needed = required(version);
    if (!noteCovers(checked.note, needed)) return fail(`Proof does not grant ${needed.cmd} here`);
    if (!(await trusted(checked.root, version)))
      return fail(`Root identity ${checked.root} is not authorized here`);
    return PASSED;
  }

  return {
    async validate(version) {
      try {
        return await check(version);
      } catch (error) {
        return fail(error instanceof Error ? error.message : 'Capability check failed');
      }
    },
  };
}
