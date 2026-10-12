/**
 * @module identity/ucan
 * Delegations in Weave's JSON profile of UCAN 1.0 (spec 01 §7).
 *
 * UCAN 1.0's fields, command paths, policy language and chain rules, written
 * as canonical JSON and signed with ES256 over those bytes, in place of
 * DAG-CBOR and a varsig header. Not byte-compatible with other UCAN tools.
 *
 * A token is a plain JSON object, `{ payload, sig, type }`. A proof is the
 * chain of tokens behind a key, root first, as a version carries it: each
 * link's audience is the next link's issuer, and the last link's audience is
 * the key that uses it.
 */
import type { CryptoProvider } from '../types.js';
import { base64UrlEncode, base64UrlDecode, utf8Encode } from '../utils/encoding.js';
import { cidFromBytes } from '../utils/hash.js';
import { isRecord } from '../utils/guards.js';
import { canonicalize } from '../schema/version.js';
import { didToPublicKey, publicKeyToDid, P256_MULTICODEC } from './did.js';
import { evaluatePolicy, isJson, policyProblem, type Policy } from './policy.js';

/** The type tag: which profile, and which kind of token */
export const DELEGATION_TYPE = 'weave/ucan/dlg@1';

/** What a delegation says */
export interface DelegationPayload {
  /** Who signs it: a P-256 did:key */
  readonly iss: string;
  /** Who it is made out to: a did:key, for a note */
  readonly aud: string;
  /** What it is about: the account (its DID, the chain's root), or one space, `space:<id>` */
  readonly sub: string;
  /** The command it covers, and everything under it: `/` is every command */
  readonly cmd: string;
  /** Conditions on the arguments of what it is used for (`identity/policy.ts`) */
  readonly pol: Policy;
  /** Makes each token unique */
  readonly nonce: string;
  /** Signed, and read by no peer */
  readonly meta?: Readonly<Record<string, unknown>>;
  /** Unix seconds: not valid at or after. A note has one; only live checks read it. */
  readonly exp?: number;
  /** Unix seconds: not valid before. A note has one; only live checks read it. */
  readonly nbf?: number;
}

/** A signed delegation, exactly as it travels */
export interface Delegation {
  readonly type: typeof DELEGATION_TYPE;
  readonly payload: DelegationPayload;
  /** ES256 over the canonical JSON of `{ payload, type }`: `r ‖ s`, low S, base64url */
  readonly sig: string;
}

/** The tokens behind a key, root first */
export type Proof = ReadonlyArray<Delegation>;

/** How far a token's start is set back for clocks that disagree */
export const UCAN_CLOCK_SKEW_SECONDS = 300;

/** The longest chain a peer follows */
const MAX_CHAIN_LENGTH = 10;
/** The most bytes one token's canonical form may take */
const MAX_TOKEN_BYTES = 16 * 1024;

const PAYLOAD_FIELDS = new Set(['iss', 'aud', 'sub', 'cmd', 'pol', 'nonce', 'meta', 'exp', 'nbf']);
const REQUIRED_FIELDS = ['iss', 'aud', 'sub', 'cmd', 'pol', 'nonce'] as const;
const NONCE = /^[A-Za-z0-9_-]{1,64}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/;
const SPACE_SUBJECT = /^space:[A-Za-z0-9._~-]{1,128}$/;

/** The order of the P-256 group, and half of it: a signature's `s` above half is the high form */
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const HALF_N = N >> 1n;

const scalar = (bytes: Uint8Array): bigint => bytes.reduce((value, byte) => (value << 8n) | BigInt(byte), 0n);

/** The same signature with `s` in its low form, `n − s` when it was high */
function lowS(signature: Uint8Array): Uint8Array {
  const s = scalar(signature.subarray(32, 64));
  if (s <= HALF_N) return signature;
  const out = new Uint8Array(signature);
  let low = N - s;
  for (let i = 63; i >= 32; i--) {
    out[i] = Number(low & 0xffn);
    low >>= 8n;
  }
  return out;
}

/** Whether a command is well formed: lower case, starting with `/`, no empty segment, no trailing `/` */
export function isCommand(cmd: unknown): cmd is string {
  return (
    typeof cmd === 'string' &&
    cmd.length <= 256 &&
    cmd === cmd.toLowerCase() &&
    (cmd === '/' || /^(\/[^/]+)+$/.test(cmd))
  );
}

/** Whether a command covers another: itself, and every command under it */
export function commandCovers(granted: string, needed: string): boolean {
  return granted === '/' || granted === needed || needed.startsWith(`${granted}/`);
}

/** Whether a string is a P-256 did:key in its one spelling */
function isP256Did(did: unknown): did is string {
  if (typeof did !== 'string' || did.length > 128) return false;
  try {
    const { publicKeyBytes, multicodecPrefix } = didToPublicKey(did);
    return (
      multicodecPrefix.length === 2 &&
      multicodecPrefix[0] === P256_MULTICODEC[0] &&
      multicodecPrefix[1] === P256_MULTICODEC[1] &&
      publicKeyBytes.length === 33 &&
      publicKeyToDid(publicKeyBytes, P256_MULTICODEC) === did
    );
  } catch {
    return false;
  }
}

/** Whether a subject is one a delegation may name: a did:key, or one space */
const isSubject = (sub: unknown): sub is string =>
  typeof sub === 'string' && (SPACE_SUBJECT.test(sub) || isP256Did(sub));

/** Whether a time bound is present and usable */
const isTime = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** The canonical bytes a token's signature covers */
const signedBytes = (payload: DelegationPayload) =>
  utf8Encode(canonicalize({ payload, type: DELEGATION_TYPE }));

/** A token in canonical JSON: what its id hashes, and what caches know it by */
const delegationBytes = (token: Delegation) => utf8Encode(canonicalize(token));

/** A token's id: the content id of its canonical form, signature included (spec 02 §2) */
export const delegationId = (token: Delegation): Promise<string> => cidFromBytes(delegationBytes(token));

/** What is wrong with a token's shape, or null: the type, the exact fields, each one's form */
function shapeProblem(value: unknown): string | null {
  if (!isRecord(value)) return 'A token is an object';
  const fields = Object.keys(value);
  if (fields.length !== 3 || !('payload' in value) || !('sig' in value) || !('type' in value))
    return 'A token has exactly payload, sig and type';
  if (value.type !== DELEGATION_TYPE) return `Not a ${DELEGATION_TYPE} token`;
  if (typeof value.sig !== 'string' || !SIGNATURE.test(value.sig)) return 'Its signature is not 64 bytes';
  if (base64UrlEncode(base64UrlDecode(value.sig)) !== value.sig)
    return 'Its signature is not in its one spelling';
  const { payload } = value;
  if (!isRecord(payload)) return 'Its payload is not an object';
  for (const field of Object.keys(payload))
    if (!PAYLOAD_FIELDS.has(field)) return `Unknown payload field ${JSON.stringify(field)}`;
  for (const field of REQUIRED_FIELDS) if (!(field in payload)) return `Its payload has no ${field}`;
  if (!isP256Did(payload.iss)) return 'Its issuer is not a P-256 did:key';
  if (typeof payload.aud !== 'string' || payload.aud.length === 0 || payload.aud.length > 256)
    return 'Its audience is not a name';
  if (!isSubject(payload.sub)) return 'Its subject is neither a did:key nor space:<id>';
  if (!isCommand(payload.cmd)) return 'Its command is not a command path';
  const policy = policyProblem(payload.pol);
  if (policy) return policy;
  if (typeof payload.nonce !== 'string' || !NONCE.test(payload.nonce)) return 'Its nonce is not base64url';
  if ('meta' in payload && !(isRecord(payload.meta) && isJson(payload.meta)))
    return 'Its meta is not an object';
  if ('exp' in payload && !isTime(payload.exp)) return 'Its exp is not Unix seconds';
  if ('nbf' in payload && !isTime(payload.nbf)) return 'Its nbf is not Unix seconds';
  if (utf8Encode(canonicalize(value)).length > MAX_TOKEN_BYTES) return 'The token is too long';
  return null;
}

/**
 * A token from the wire, or null when it is not one in its exact shape. A
 * copy: nothing the caller holds changes it later. The signature is not checked.
 */
export function parseDelegation(value: unknown): Delegation | null {
  return shapeProblem(value) === null ? copyOf(value) : null;
}

/** A frozen copy through canonical JSON, after `shapeProblem` passed */
function copyOf(value: unknown): Delegation {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- shapeProblem checked every field
  return deepFreeze(JSON.parse(canonicalize(value))) as Delegation;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

/** A proof from the wire: one to {@link MAX_CHAIN_LENGTH} tokens, each in its exact shape; else null */
export function parseProof(value: unknown): Proof | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CHAIN_LENGTH) return null;
  const tokens: Delegation[] = [];
  for (const item of value) {
    const token = parseDelegation(item);
    if (!token) return null;
    tokens.push(token);
  }
  return Object.freeze(tokens);
}

/** What to sign */
export interface IssueOptions {
  readonly issuer: { readonly did: string; readonly privateKey: CryptoKey };
  readonly audience: string;
  /** Default: the issuer's own DID, everything it may do */
  readonly subject?: string;
  readonly command: string;
  /** Default: no conditions */
  readonly policy?: Policy;
  /** Unix seconds. Default: an hour from now. `null`: none, for a token that time doesn't end */
  readonly expiration?: number | null;
  /** Unix seconds. Default: now, less the clock skew peers allow. `null`: none. */
  readonly notBefore?: number | null;
  readonly nonce?: string;
  readonly meta?: Readonly<Record<string, unknown>>;
}

/** Signs a delegation, its signature in the low-S form */
export async function issueDelegation(options: IssueOptions, provider: CryptoProvider): Promise<Delegation> {
  const now = Math.floor(Date.now() / 1000);
  const exp = options.expiration === undefined ? now + 3600 : options.expiration;
  const nbf = options.notBefore === undefined ? now - UCAN_CLOCK_SKEW_SECONDS : options.notBefore;
  const payload: DelegationPayload = {
    iss: options.issuer.did,
    aud: options.audience,
    sub: options.subject ?? options.issuer.did,
    cmd: options.command,
    pol: options.policy ?? [],
    nonce: options.nonce ?? base64UrlEncode(globalThis.crypto.getRandomValues(new Uint8Array(12))),
    ...(options.meta ? { meta: options.meta } : {}),
    ...(exp !== null ? { exp } : {}),
    ...(nbf !== null ? { nbf } : {}),
  };
  const signature = lowS(await provider.sign(options.issuer.privateKey, signedBytes(payload)));
  const token = { type: DELEGATION_TYPE, payload, sig: base64UrlEncode(signature) };
  const problem = shapeProblem(token);
  if (problem) throw new Error(`Not a delegation to sign: ${problem}`);
  return copyOf(token);
}

/** When to judge time bounds */
export interface VerifyOptions {
  /** Unix seconds to check `exp` and `nbf` against. Default: now. */
  readonly at?: number;
  /**
   * Judge no time at all: for a record, whose standing every peer must agree
   * on, so no clock may decide it (spec 01 §7.5). Live checks — a knock, a
   * live message, a handshake — are one node's own, and use the time.
   */
  readonly untimed?: boolean;
}

/** The outcome of checking one token */
export type Verified =
  { readonly valid: true; readonly token: Delegation } | { readonly valid: false; readonly reason: string };

/** Tokens whose signature checked out, by canonical form; the oldest let go first */
const signedTokens = new Set<string>();
const MAX_SIGNED_TOKENS = 1000;

/**
 * Checks one token: its shape, its signature by its issuer (low S only), and,
 * unless untimed, that `nbf ≤ at < exp`. A token without both bounds is never
 * valid at a time.
 */
export async function verifyDelegation(
  value: unknown,
  provider: CryptoProvider,
  options: VerifyOptions = {},
): Promise<Verified> {
  const problem = shapeProblem(value);
  if (problem) return { valid: false, reason: problem };
  const token = copyOf(value);
  const { payload } = token;
  if (!options.untimed) {
    const at = options.at ?? Math.floor(Date.now() / 1000);
    if (payload.exp === undefined || payload.nbf === undefined)
      return { valid: false, reason: 'Token must say when it starts and ends' };
    if (payload.exp <= at) return { valid: false, reason: 'Token has expired' };
    if (payload.nbf > at) return { valid: false, reason: 'Token not yet valid' };
  }
  const known = canonicalize(token);
  if (!signedTokens.has(known)) {
    const signature = base64UrlDecode(token.sig);
    // One token, one id: the other form of the same signature is refused.
    if (scalar(signature.subarray(32, 64)) > HALF_N)
      return { valid: false, reason: 'Its signature is in the high-S form' };
    try {
      const publicKey = await provider.importPublicKey(didToPublicKey(payload.iss).publicKeyBytes);
      if (!(await provider.verify(publicKey, signature, signedBytes(payload))))
        return { valid: false, reason: 'Invalid signature' };
    } catch {
      return { valid: false, reason: 'Invalid signature' };
    }
    signedTokens.add(known);
    if (signedTokens.size > MAX_SIGNED_TOKENS) signedTokens.delete(signedTokens.values().next().value!);
  }
  return { valid: true, token };
}

/** The outcome of checking a proof */
export type ChainCheck =
  | {
      readonly valid: true;
      readonly proof: Proof;
      /** The account at the root: the first link's issuer */
      readonly root: string;
      /** The key the proof is for: the last link's audience */
      readonly audience: string;
    }
  | { readonly valid: false; readonly reason: string };

/** Whether a link's subject is the account, the chain's root */
const isAccount = (sub: string, root: string) => sub === root;

/**
 * What is wrong with a chain whose tokens each checked out, or null: a note's
 * shape on every link (a did:key audience, both time bounds), each link's
 * audience the next one's issuer, and each link no wider than its parent — a
 * command under the parent's, the same subject or one space of the account's.
 * Policies need no comparing: every link's policy is checked where the proof is used.
 */
function chainProblem(proof: Proof): string | null {
  const root = proof[0]!.payload.iss;
  for (let i = 0; i < proof.length; i++) {
    const link = proof[i]!.payload;
    if (!isP256Did(link.aud)) return `Link ${i} is not made out to a key`;
    if (link.exp === undefined || link.nbf === undefined) return `Link ${i} has no exp or nbf`;
    if (link.sub.startsWith('did:') && !isAccount(link.sub, root))
      return `Link ${i} is about an account other than its root`;
    if (i === 0) continue;
    const parent = proof[i - 1]!.payload;
    if (parent.aud !== link.iss) return `Link ${i} is not signed by the key link ${i - 1} names`;
    if (!commandCovers(parent.cmd, link.cmd)) return `Link ${i} widens its command`;
    // The same subject, or one space where the parent had the whole account.
    if (link.sub !== parent.sub && !isAccount(parent.sub, root)) return `Link ${i} widens its subject`;
  }
  return null;
}

/**
 * Checks a proof: every token (shape, signature, and time unless untimed)
 * and every link (`chainProblem`). The root is the first link's issuer.
 */
export async function verifyProof(
  value: unknown,
  provider: CryptoProvider,
  options: VerifyOptions = {},
): Promise<ChainCheck> {
  if (!Array.isArray(value) || value.length === 0) return { valid: false, reason: 'No delegation chain' };
  if (value.length > MAX_CHAIN_LENGTH)
    return { valid: false, reason: `Delegation chain longer than ${MAX_CHAIN_LENGTH} links` };
  const tokens: Delegation[] = [];
  for (const item of value) {
    const checked = await verifyDelegation(item, provider, options);
    if (!checked.valid) return { valid: false, reason: `Invalid token in chain: ${checked.reason}` };
    tokens.push(checked.token);
  }
  const proof = Object.freeze(tokens);
  const problem = chainProblem(proof);
  if (problem) return { valid: false, reason: `Delegation chain broken: ${problem}` };
  return { valid: true, proof, root: proof[0]!.payload.iss, audience: proof[proof.length - 1]!.payload.aud };
}

/**
 * What a key needs for one thing it does: a command, where (a space, or
 * `null` for the account as a whole), and the arguments every link's policy
 * is checked against (spec 01 §8).
 */
export interface Requirement {
  readonly space: string | null;
  readonly cmd: string;
  readonly args: Readonly<Record<string, unknown>>;
}

/**
 * Whether a proof grants a requirement: on every link, the command covers
 * it, the subject is the account or the space, and the policy holds for its
 * arguments. Reads the tokens only; whether the chain is sound is
 * {@link verifyProof}'s question.
 */
export function proofGrants(proof: Proof, required: Requirement): boolean {
  const root = proof[0]?.payload.iss;
  if (root === undefined) return false;
  return proof.every(
    ({ payload }) =>
      commandCovers(payload.cmd, required.cmd) &&
      (isAccount(payload.sub, root) ||
        (required.space !== null && payload.sub === `space:${required.space}`)) &&
      evaluatePolicy(payload.pol, required.args),
  );
}

/**
 * Passes on part of what a proof grants: a token from the proof's audience
 * to another key, no wider than the last link, and no longer-lived.
 * @returns The longer proof, root first
 */
export async function extendProof(
  proof: Proof,
  options: Omit<IssueOptions, 'subject'> & { readonly subject?: string },
  provider: CryptoProvider,
): Promise<Proof> {
  const last = proof[proof.length - 1]?.payload;
  if (!last) throw new Error('There is no proof to extend');
  if (last.aud !== options.issuer.did) throw new Error('Only the key a proof is made out to can extend it');
  if (!commandCovers(last.cmd, options.command))
    throw new Error('That command is wider than the proof grants');
  const subject = options.subject ?? last.sub;
  const root = proof[0]!.payload.iss;
  if (subject !== last.sub && !isAccount(last.sub, root))
    throw new Error('That subject is wider than the proof grants');
  const exp = options.expiration === undefined || options.expiration === null ? last.exp : options.expiration;
  if (exp === undefined || (last.exp !== undefined && exp > last.exp))
    throw new Error('A delegation cannot outlive the one it passes on');
  const token = await issueDelegation({ ...options, subject, expiration: exp }, provider);
  return Object.freeze([...proof, token]);
}
