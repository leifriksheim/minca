/**
 * @module root-signer
 * Who holds the identity key. It signs one thing: a note letting a session key
 * write until a time. Abstracting that one signature lets the key live in an
 * account home instead of the page; the seed never crosses the boundary.
 */

import type { CryptoProvider } from '../types.js';
import { issueDelegation, type Delegation } from './ucan.js';
import type { Policy } from './policy.js';

/** What a root signer is asked to sign: a note from the account to a key (spec 01 §7) */
export interface NoteRequest {
  /** The key's DID */
  readonly audience: string;
  /** What it may do, and everything under it: `/` for everything, `/record` for records only */
  readonly command: string;
  /** Default: the account itself. `space:<id>` for one space. */
  readonly subject?: string;
  /** Conditions on what it is used for. Default: none. */
  readonly policy?: Policy;
  /** Unix seconds after which live checks refuse it */
  readonly expiration: number;
}

/** What a session needs from an identity, wherever that identity is kept */
export interface RootSigner {
  /** The identity being acted for */
  readonly did: string;
  /**
   * Where the key lives. Worth showing: "your key is in your account home" and
   * "your key is in this tab" are different promises to make to someone.
   */
  readonly custody: 'local' | 'remote';
  /** Signs a note from the identity to a key: the session's, an app's, a program's */
  delegate(params: NoteRequest): Promise<Delegation>;
}

/**
 * A signer for a key this page is holding.
 *
 * The ordinary case: the seed was unlocked here, so the key is in memory and
 * signing is a local operation.
 */
export function createLocalRootSigner(
  identity: { did: string; privateKey: CryptoKey },
  provider: CryptoProvider,
): RootSigner {
  return Object.freeze({
    did: identity.did,
    custody: 'local' as const,

    async delegate(params: NoteRequest): Promise<Delegation> {
      return issueDelegation(
        {
          issuer: { did: identity.did, privateKey: identity.privateKey },
          audience: params.audience,
          command: params.command,
          ...(params.subject !== undefined ? { subject: params.subject } : {}),
          ...(params.policy ? { policy: params.policy } : {}),
          expiration: params.expiration,
        },
        provider,
      );
    },
  });
}
