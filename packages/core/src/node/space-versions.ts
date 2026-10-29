/**
 * @module node/space-versions
 * What a version is: who signed it, what it says, and which record it
 * continues. Every verdict on a version starts here, and every read of its
 * body: a sealed one opens with the keys of the space this node holds.
 */
import { setCapped } from '../utils/map.js';
import type { CryptoProvider, Link, Space, Version } from '../types.js';
import type { SpaceRecord } from '../space/space-manager.js';
import { verifyNote, type Delegation } from '../identity/ucan.js';
import { writeRequirement } from '../identity/abilities.js';
import { bodyProblem, getVersionId, isStub, signedPart } from '../schema/version.js';
import type { StorageProvider } from '../storage/storage-provider.js';
import { checkLinks } from '../records/links.js';
import { createVersionCheck } from '../validation/check-version.js';
import { isSealedBody, openBody as openSealedBody, type SpaceKey } from '../privacy/space-encryption.js';
import { isRecord } from '../utils/guards.js';

/** The key that signs, and the delegation that lets it */
export interface ActiveSession {
  readonly did: string;
  readonly key: CryptoKey;
  /** The current note from the account — it is renewed, so always read it fresh. None for a key that signs for itself. */
  readonly proof: () => Delegation | undefined;
}

/** What every part of an open space works from */
export interface SpaceBase {
  readonly record: SpaceRecord;
  readonly space: Space;
  readonly storage: StorageProvider;
  readonly provider: CryptoProvider;
  /** Every key of the space this node holds, by id: a sealed body names its key, the history the current one */
  readonly keyring: Map<string, SpaceKey>;
  readonly session: ActiveSession;
  /** The account this node acts for */
  readonly rootDid: string;
  /** Only notes that grant `account/write` count here (`SpaceRuntimeDeps.accountOnly`) */
  readonly accountOnly: boolean;
  readonly isClosed: () => boolean;
}

/** Decrypted bodies kept in memory per space, the oldest let go first */
const MAX_OPENED = 100_000;

export interface Verdict {
  readonly verified: boolean;
  readonly root: string | null;
  readonly reason?: string;
}

export type Standing =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly later?: boolean;
      /** Passes every check but one: a later change took its author's access away. Kept, never counted (02 §9.5). */
      readonly withdrawn?: true;
      /** A stub whose grant reads the body it doesn't carry, at a node that reads the space: judged once whole */
      readonly bodyNeeded?: true;
    };
export type Refusal = Extract<Standing, { readonly ok: false }>;
export const STANDS: Standing = { ok: true };
export const ACCESS_LATER: Standing = Object.freeze({
  ok: false,
  reason: 'Access changes it depends on have not arrived yet',
  later: true,
});

/** Whether a version goes in the store: it stands, or stood until a later change withdrew it */
export const storable = (standing: Standing): boolean => standing.ok || !!standing.withdrawn;

/** How a version fares under its collection's contract, as this node reads it */
export type ChecksVerdict =
  | { readonly passes: true }
  | { readonly passes: false; readonly reason: string }
  /** No contract, or none this node can judge */
  | { readonly passes: null }
  /** Not judged here (spec 09 §2): a line key this library doesn't know, or something sealed. Not counted */
  | { readonly passes: null; readonly unjudged: string }
  /** A version it cites hasn't arrived */
  | { readonly pending: true };
export const NO_CHECKS: ChecksVerdict = { passes: null };
/** Checks this node can't judge yet: what they read can't be opened here. Never cached. */
export const UNJUDGED: ChecksVerdict = Object.freeze({
  passes: null,
  unjudged: 'Something it reads is sealed with a key this node doesn’t hold',
});

export type Opened = {
  readonly body: unknown;
  readonly links: ReadonlyArray<Link>;
  readonly encrypted: boolean;
};

/** A signature never changes, but the id doesn't cover it: a mangled copy shares the genuine one's id */
export const signedKey = (version: Version) => `${version.id}|${version.signature}`;

/**
 * What the caches of verdicts on a version are keyed by: its id and
 * signature, which a stub shares with the whole version, and which of the
 * two it is. A verdict on a stub never stands for the whole.
 */
export const copyKey = (version: Version) => `${signedKey(version)}|${isStub(version) ? 'stub' : 'whole'}`;

/** A set of ids as one cache key */
export const idsKey = (ids: ReadonlyArray<string>) => [...new Set(ids)].sort().join(',');

/** The key a sealed body names, as the keyring is looked up by */
export const sealedKeyId = (body: unknown) => String(isRecord(body) ? body.keyId : undefined);

const isLinks = (links: unknown): links is ReadonlyArray<Link> => checkLinks(links) === null;

export function createVersions({ space, storage, provider, keyring }: SpaceBase) {
  // The note behind a key must cover this space; whether its account may write is the history's question.
  const checkVersion = createVersionCheck({
    provider,
    required: (version) => writeRequirement(space.id, version.collection),
  });

  /** Signature verdicts. Only passes are kept: failures are what a stranger can mint for free. */
  const verdicts = new Map<string, Verdict>();
  /** Copies checked to be what their id names, envelope and body */
  const copiesChecked = new WeakSet<Version>();

  /**
   * Why a copy isn't what its id names, or null when it is: its id hashes its
   * envelope, and its `bodyHash` names its body. Asked before any verdict
   * cached by id and signature is used.
   */
  async function copyProblem(version: Version): Promise<string | null> {
    if (copiesChecked.has(version)) return null;
    const problem =
      (await bodyProblem(version)) ??
      (version.id === (await getVersionId(signedPart(version)))
        ? null
        : 'Its id is not the hash of what it says');
    if (!problem) copiesChecked.add(version);
    return problem;
  }

  /** Whether a version is signed, and by a key whose note covers this space — and which account that is */
  async function judge(version: Version): Promise<Verdict> {
    const problem = await copyProblem(version);
    if (problem) return { verified: false, root: null, reason: problem };
    const cached = verdicts.get(signedKey(version));
    if (cached) return cached;
    const result = await checkVersion(version);
    if (!result.passed)
      return { verified: false, root: null, ...(result.reason ? { reason: result.reason } : {}) };
    const note =
      version.proof !== undefined ? await verifyNote(version.proof, provider, { untimed: true }) : null;
    const verdict = { verified: true, root: note?.valid ? note.root : version.author };
    verdicts.set(signedKey(version), verdict);
    return verdict;
  }

  /** Bodies already opened, by version id. A failure is not kept: a key that arrives later may open it. */
  const openedBodies = new Map<string, Opened>();

  /** A version's content: its body and its links, sealed together in a private space */
  async function openBody(version: Version): Promise<Opened> {
    // A stub's content is forgotten: read like one this node holds no key for.
    if (isStub(version)) return { body: null, links: version.links ?? [], encrypted: false };
    if (!isSealedBody(version.body))
      return { body: version.body, links: version.links ?? [], encrypted: false };
    const known = openedBodies.get(version.id);
    if (known) return known;
    const sealedWith = keyring.get(sealedKeyId(version.body));
    if (!sealedWith) return { body: null, links: [], encrypted: true };
    try {
      // Bound to this record: a body copied from another record, space or collection does not open.
      const bound = { space: space.id, collection: version.collection, key: version.key };
      const content = await openSealedBody(version.body, sealedWith, bound);
      const opened = isRecord(content) ? content : null;
      const sealedLinks = opened?.links ?? [];
      const links = isLinks(sealedLinks) ? sealedLinks : [];
      const result: Opened = Object.freeze({ body: opened?.body ?? null, links, encrypted: true });
      // An id names its content, so what opened once opens the same way again.
      setCapped(openedBodies, version.id, result, MAX_OPENED);
      return result;
    } catch {
      return { body: null, links: [], encrypted: true };
    }
  }

  /** Whether a version's content is sealed with a key this node doesn't hold */
  const unreadable = (opened: Opened) => opened.body === null && opened.encrypted;

  /**
   * Whether `first` can be the first version of `version`'s record. A later
   * version names its first itself; taking that on trust would let anyone
   * point at a record with no rules, or in another collection.
   */
  const firstOf = (version: Version, first: Version | null): first is Version =>
    !!first && first.seq === 0 && first.key === version.key && first.collection === version.collection;

  /** The first version a version names: itself at seq 0. Not yet checked to be its record's. */
  const namedFirst = async (version: Version): Promise<Version | null> =>
    version.seq === 0 ? version : version.genesis ? storage.getVersion(version.genesis) : null;

  /** A version's first version, checked to be its record's (02 §4.5): never the lowest id at its key, which anyone could grind */
  async function genesisOf(version: Version): Promise<Version | null> {
    const first = await namedFirst(version);
    return firstOf(version, first) ? first : null;
  }

  /** Whether a version is one to show: its first version is held and its record's. Checked on arrival too (02 §4.7). */
  async function consistent(version: Version): Promise<boolean> {
    return version.seq === 0 || (await genesisOf(version)) !== null;
  }

  /** The version before this one in its record's chain, when it names one */
  const previousOf = (version: Version) =>
    version.seq > 0 && version.prev ? storage.getVersion(version.prev) : Promise.resolve(null);

  /** Display order: when a record was created, then its key. It decides nothing. */
  const createdAtOf = async (version: Version) => (await genesisOf(version))?.createdAt ?? version.createdAt;

  return {
    copyProblem,
    judge,
    openBody,
    unreadable,
    firstOf,
    namedFirst,
    genesisOf,
    consistent,
    previousOf,
    createdAtOf,
  };
}

export type Versions = ReturnType<typeof createVersions>;
