import type { CryptoProvider, Version } from '../types.js';
import type { GateResult } from './crypto-gate.js';
import {
  isCapabilitySubset,
  resolveDelegationRoot,
  type Capability,
  type ProofResolver,
  UCAN_CLOCK_SKEW_SECONDS,
} from '../identity/ucan.js';

export interface CapabilityGateConfig {
  /** Crypto provider used to verify the UCANs in the chain */
  readonly provider: CryptoProvider;
  /** The capability an author must hold to write this version */
  readonly requiredCapability: (version: Version) => Capability;
  /**
   * Looks up a parent UCAN by CID when a proof chain is longer than one link.
   * Versions usually carry a single delegation, which needs no resolver.
   */
  readonly resolveProof?: ProofResolver;
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
 * delegated key carries a UCAN in `proof`, and the gate walks it back to a root
 * identity, refusing anything that is expired, misaddressed, over-broad, or
 * rooted in an identity the application does not trust.
 *
 * "Expired" means expired **when the record was signed**, judged by its
 * `createdAt`. A record stays valid after its session ends, which is what lets a
 * peer that shows up next week accept last week's data. The cost is that a
 * leaked session key could backdate records into its own window — which is why
 * session keys live in memory and are short-lived. A record dated in the future
 * is refused outright.
 */
export function createCapabilityGate(config: CapabilityGateConfig): CapabilityGate {
  const { provider, requiredCapability, resolveProof = () => null, isTrustedRoot } = config;

  return {
    async validate(version: Version): Promise<GateResult> {
      try {
        const required = requiredCapability(version);

        // No proof: the author is acting for itself, not on anyone's behalf.
        if (!version.proof) {
          if (isTrustedRoot && !(await isTrustedRoot(version.author, version))) {
            return fail(`Author ${version.author} is not authorized here`);
          }
          return { passed: true, gate: 'capability' };
        }

        const signedAt = Math.floor(Date.parse(version.createdAt) / 1000);
        if (!Number.isFinite(signedAt)) {
          return fail('Version has no valid creation time');
        }
        if (signedAt > Math.floor(Date.now() / 1000) + UCAN_CLOCK_SKEW_SECONDS) {
          return fail('Version is dated in the future');
        }

        const chain = await resolveDelegationRoot(version.proof, resolveProof, provider, { at: signedAt });
        if (!chain.valid || chain.rootDid === null) {
          return fail(chain.reason ?? 'Invalid delegation chain');
        }

        // The delegation has to name this author as its audience, or anyone
        // could attach someone else's valid UCAN to their own version.
        if (chain.audience !== version.author) {
          return fail('Proof was issued to a different key than the author');
        }

        if (!chain.capabilities.some((granted) => isCapabilitySubset(granted, required))) {
          return fail(`Proof does not grant ${required.can} on ${required.with}`);
        }

        if (isTrustedRoot && !(await isTrustedRoot(chain.rootDid, version))) {
          return fail(`Root identity ${chain.rootDid} is not authorized here`);
        }

        return { passed: true, gate: 'capability' };
      } catch (error) {
        return fail(error instanceof Error ? error.message : 'Capability check failed');
      }
    },
  };
}
