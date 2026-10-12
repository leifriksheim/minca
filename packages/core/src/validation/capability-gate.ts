import type { CryptoProvider, Version } from '../types.js';
import type { GateResult } from './crypto-gate.js';
import { proofGrants, verifyProof, type Requirement } from '../identity/ucan.js';

export interface CapabilityGateConfig {
  /** Crypto provider used to verify the delegations in the chain */
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
 * delegated key carries its chain of delegations in `proof`, root first, and
 * the gate checks every link back to the root identity, refusing anything
 * misaddressed, over-broad, or rooted in an identity the application does
 * not trust.
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
        const chain = await verifyProof(version.proof, provider, { untimed: true });
        if (!chain.valid) return fail(chain.reason);

        // The chain has to end at this author, or anyone could attach someone
        // else's valid proof to their own version.
        if (chain.audience !== version.author) {
          return fail('Proof was issued to a different key than the author');
        }

        const needed = required(version);
        if (!proofGrants(chain.proof, needed)) {
          return fail(`Proof does not grant ${needed.cmd} here`);
        }

        if (isTrustedRoot && !(await isTrustedRoot(chain.root, version))) {
          return fail(`Root identity ${chain.root} is not authorized here`);
        }

        return { passed: true, gate: 'capability' };
      } catch (error) {
        return fail(error instanceof Error ? error.message : 'Capability check failed');
      }
    },
  };
}
