import type { CryptoProvider, Version } from '../types.js';
import type { GateResult } from './crypto-gate.js';
import { noteCovers, verifyNote, type Requirement } from '../identity/ucan.js';

export interface CapabilityGateConfig {
  /** Crypto provider used to verify the note */
  readonly provider: CryptoProvider;
  /** What an author must be granted to write this version */
  readonly required: (version: Version) => Requirement;
  /**
   * Decides whether a root identity may write this version at all — space
   * membership, an allow-list, or whatever the application's policy is.
   * Defaults to accepting any root: the signature still proves who wrote it.
   */
  readonly isTrustedRoot?: (rootDid: string, version: Version) => boolean | Promise<boolean>;
}

export interface CapabilityGate {
  validate(version: Version): Promise<GateResult>;
}

const fail = (reason: string): GateResult => ({ passed: false, gate: 'capability', reason });

/**
 * Creates a gate that checks an author was *authorized* to write a version.
 *
 * The crypto gate proves a version came from the key it claims. This one
 * answers the next question: may that key write here? A version signed by a
 * delegated key carries its note from the root identity in `proof`, one
 * token, and the gate refuses anything misaddressed, over-broad, passed on
 * (a chain of more than one token), or from an identity the application
 * does not trust.
 *
 * No time is judged: not the note's `exp` or `nbf`, not the record's
 * `createdAt`, by no one's clock. A record's standing is something every peer
 * must agree on whenever it looks. What ends a key's writes is a revoke, with
 * its cutoff (spec 03 §6.4); a note's time bounds only live checks.
 */
export function createCapabilityGate(config: CapabilityGateConfig): CapabilityGate {
  const { provider, required, isTrustedRoot } = config;

  return {
    async validate(version: Version): Promise<GateResult> {
      try {
        // No proof: the author is acting for itself, not on anyone's behalf.
        if (version.proof === undefined) {
          if (isTrustedRoot && !(await isTrustedRoot(version.author, version))) {
            return fail(`Author ${version.author} is not authorized here`);
          }
          return { passed: true, gate: 'capability' };
        }

        // A date sync can order by, though it decides nothing here.
        if (!Number.isFinite(Date.parse(version.createdAt)))
          return fail('Version has no valid creation time');
        const checked = await verifyNote(version.proof, provider, { untimed: true });
        if (!checked.valid) return fail(checked.reason);

        // The note has to be made out to this author, or anyone could attach
        // someone else's valid note to their own version.
        if (checked.audience !== version.author) {
          return fail('Proof was issued to a different key than the author');
        }

        const needed = required(version);
        if (!noteCovers(checked.note, needed)) {
          return fail(`Proof does not grant ${needed.cmd} here`);
        }

        if (isTrustedRoot && !(await isTrustedRoot(checked.root, version))) {
          return fail(`Root identity ${checked.root} is not authorized here`);
        }

        return { passed: true, gate: 'capability' };
      } catch (error) {
        return fail(error instanceof Error ? error.message : 'Capability check failed');
      }
    },
  };
}
