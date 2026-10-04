/**
 * @module identity/abilities
 * What a note lets its key do, beyond writing records.
 *
 * A note (a UCAN from the account) grants abilities on spaces. Writing a
 * record takes `expression/write`. Three more are checked by every peer, so a
 * note can leave them out and its key can't do those things anywhere:
 *
 * - `collection/define`: define, change or remove a space's collections;
 * - `access/change`: anything else in the access history — roles, members,
 *   invites, revocations, the space's key, relays and keepers;
 * - `account/write`: the account's own spaces (its list of spaces, a
 *   carrier's passes) and its doors.
 *
 * A person's own sessions get `*`. A key the account trusts less — an agent,
 * a borrowed device — gets `expression/*`, and proposes what it can't do.
 */
import { isCapabilitySubset, parseUCAN, type Capability } from './ucan.js';

export const DEFINE_ABILITY = 'collection/define';
export const ACCESS_ABILITY = 'access/change';
export const ACCOUNT_ABILITY = 'account/write';

/**
 * Whether a note grants a capability, by what its leaf says. A version with no
 * note was signed by the account itself, which may do anything; a note that
 * can't be read grants nothing. Whether the chain is valid is the capability
 * gate's question, and a valid chain never grants more than its parents.
 */
export function noteGrants(encoded: string | null | undefined, required: Capability): boolean {
  if (!encoded) return true;
  try {
    return parseUCAN(encoded).payload.att.some((granted) => isCapabilitySubset(granted, required));
  } catch {
    return false;
  }
}
