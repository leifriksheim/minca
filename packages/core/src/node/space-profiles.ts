/**
 * @module node/space-profiles
 * What each member says of themselves in a space: their profile, and the
 * member key a new key of the space is sealed to.
 *
 * Each person says who they are in a space with one record, keyed by their
 * identity (`profileKey`), whose versions are always retained. The fold
 * takes the newest version signed by the identity the key names, so nobody
 * can rename anyone else: a version written by someone else under your key
 * is simply never the answer, and it cannot push yours out, because yours
 * are kept.
 */
import { isContactPublicKey } from '../identity/contact-key.js';
import { MEMBER_KEY_COLLECTION, memberKeyRecordKey } from '../space/space-access.js';
import { PROFILE_COLLECTION, isAvatarRef } from '../space/account-registry.js';
import { hashedKey } from '../utils/hash.js';
import { isRecord } from '../utils/guards.js';
import type { SpaceProfile } from './types.js';
import type { Versions, SpaceBase } from './space-versions.js';
import type { StandingJudge } from './space-standing.js';

/**
 * The key of a person's profile record in a space: one per identity, named by
 * a hash of it (record keys are lower case; a did:key is not).
 */
export async function profileKey(did: string): Promise<string> {
  return hashedKey('profile', did);
}

export function createProfiles({
  storage,
  versions,
  standing,
}: SpaceBase & { readonly versions: Versions; readonly standing: StandingJudge }) {
  const { judge, openBody } = versions;
  const { standingOf } = standing;

  let profilesCache: Promise<Map<string, SpaceProfile>> | null = null;
  const profileMap = () => (profilesCache ??= loadProfiles());

  async function loadProfiles(): Promise<Map<string, SpaceProfile>> {
    const result = new Map<string, SpaceProfile>();
    // By key: the current version may be anyone's.
    for (const [key, versions] of await storage.histories('profile:')) {
      let found: SpaceProfile | null = null;
      for (const version of versions) {
        if (version.collection !== PROFILE_COLLECTION) continue;
        const verdict = await judge(version);
        if (!verdict.verified || !verdict.root || (await profileKey(verdict.root)) !== key) continue;
        if (!(await standingOf(version)).ok) continue;
        if (version.deleted) break; // they took it down
        const opened = (await openBody(version)).body;
        const body = isRecord(opened) ? opened : null;
        if (!found) {
          const name = body?.name;
          if (typeof name !== 'string' || !name.trim()) break;
          found = { did: verdict.root, name: name.trim().slice(0, 64), updatedAt: version.createdAt };
        }
        // The picture, from the newest version: one without it shows none (the older stay kept, as retained).
        if (!found.avatar && found.updatedAt === version.createdAt && isAvatarRef(body?.avatar))
          found = { ...found, avatar: body.avatar };
        // The contact key from the newest version that has one: it never changes, and an app
        // without it that wrote a newer version first must not hide it.
        if (isContactPublicKey(body?.contactKey)) {
          found = { ...found, contactKey: body.contactKey };
          break;
        }
      }
      if (found) result.set(found.did, found);
    }
    return result;
  }

  /**
   * Each member's member key, from their own record of it — kept in the
   * clear, so someone who holds only an older key of the space can still say
   * where to seal the new one.
   */
  let memberKeysCache: Promise<Map<string, string>> | null = null;
  const memberKeyMap = () => (memberKeysCache ??= loadMemberKeys());

  async function loadMemberKeys(): Promise<Map<string, string>> {
    const found = new Map<string, string>();
    // By key: the current version may be anyone's.
    for (const [key, versions] of await storage.histories('memberkey:')) {
      for (const version of versions) {
        if (version.collection !== MEMBER_KEY_COLLECTION || version.deleted) continue;
        const verdict = await judge(version);
        if (!verdict.verified || !verdict.root || (await memberKeyRecordKey(verdict.root)) !== key) continue;
        if (!(await standingOf(version)).ok) continue;
        const body = isRecord(version.body) ? version.body : null;
        if (isContactPublicKey(body?.key)) {
          found.set(verdict.root, body.key);
          break;
        }
      }
    }
    return found;
  }

  return {
    profiles: profileMap,
    memberKeys: memberKeyMap,
    forget(): void {
      profilesCache = null;
      memberKeysCache = null;
    },
  };
}

export type Profiles = ReturnType<typeof createProfiles>;
