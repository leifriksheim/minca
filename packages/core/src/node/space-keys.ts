/**
 * @module node/space-keys
 * The keys of a private space.
 *
 * A private space's key changes when someone loses their place in it
 * (`sys.key`, part of the access history): whoever manages the space makes
 * a new one, and seals a copy to each member's member key (`sys.box`). The
 * key record carries every earlier key sealed under the new one, so holding
 * the current key opens everything written before it, as Keybase does.
 */
import { actsForAccount, ACCESS_COMMAND, grantsBeyondRecords } from '../identity/abilities.js';
import { openValueFrom, sealValueTo } from '../identity/hpke.js';
import { openValue, sealValue } from '../identity/envelope.js';
import { serial } from '../utils/serial.js';
import {
  EARLIER_KEYS_LABEL,
  generateSpaceKey,
  spaceKeyFromRaw,
  type SpaceKey,
} from '../privacy/space-encryption.js';
import {
  BOX_COLLECTION,
  BOX_LABEL,
  boxBound,
  boxKey,
  deriveReadKey,
  MEMBER_KEY_COLLECTION,
  SPACE_KEY_RECORD,
  SPACE_RELAYS_RECORD,
  memberKeyRecordKey,
} from '../space/space-access.js';
import {
  KEY_COLLECTION,
  MAX_RELAYS,
  RELAYS_COLLECTION,
  may,
  readers,
  type AccessState,
} from '../space/roles.js';
import { KEY_CHANGE, SPACE_RELAYS } from '../space/grants.js';
import { base64UrlDecode, base64UrlEncode } from '../utils/encoding.js';
import { isRecord, isStringList } from '../utils/guards.js';
import type { NodeNetworkConfig } from './types.js';
import type { Versions, SpaceBase } from './space-versions.js';
import type { History } from './space-history.js';
import type { Rules } from './space-rules.js';
import type { Profiles } from './space-profiles.js';
import { usableRelays } from './space-peers.js';
import type { ContactKeyPair } from '../identity/contact-key.js';

export interface KeysDeps extends SpaceBase {
  /** This account's member key here, which new keys are sealed to */
  readonly memberPair: ContactKeyPair | null;
  readonly network: NodeNetworkConfig | undefined;
  readonly versions: Versions;
  readonly history: History;
  readonly rules: Rules;
  readonly profiles: Profiles;
  readonly upsert: (collection: string, recordKey: string, body: unknown) => Promise<unknown>;
  readonly cannotWrite: () => Promise<string | null>;
  readonly recordsChanged: () => void;
  readonly onKeys: ((keys: ReadonlyArray<SpaceKey>, current: string) => Promise<void>) | undefined;
}

export function createKeys(deps: KeysDeps) {
  const { record, keyring, storage, provider, session, memberPair, upsert, cannotWrite, recordsChanged } =
    deps;
  const { space } = record;
  const { judge } = deps.versions;
  const { access } = deps.history;
  const memberKeyMap = deps.profiles.memberKeys;
  /** Every key box, read once until records change */
  let boxCache: ReturnType<typeof storage.histories> | null = null;
  const boxIndex = () => (boxCache ??= storage.histories('box:'));

  /** The key the history names now, if this node holds it */
  function currentKey(state: AccessState): SpaceKey | null {
    const epoch = state.keys.at(-1);
    return epoch ? (keyring.get(epoch.keyId) ?? null) : null;
  }

  /** The newest key this node holds that the history names — what it proves it may read with while behind */
  function newestKey(state: AccessState): SpaceKey | null {
    for (const epoch of [...state.keys].reverse()) {
      const held = keyring.get(epoch.keyId);
      if (held) return held;
    }
    return record.key;
  }

  /** Box and key record versions already boxesOpened, so each is tried once */
  const boxesOpened = new Set<string>();
  /**
   * Key records already boxesOpened, for the keys the history named then. Which
   * key event counts, and which keys it names, can change as changes arrive,
   * so they are boxesOpened again when that does.
   */
  const openedKeyRecords = new Set<string>();
  let openedFor = '';
  /**
   * Keys whose key change is malformed: its earlier keys don't open, or leave
   * out the space's first key, which every reader needs for onePer keys
   * (03 §9.3). Nothing is taken from them, and a manager replaces them.
   */
  const malformedKeys = new Set<string>();

  /** Takes in what this node can open: boxes sealed to its member key, and the earlier keys each key record carries */
  async function learnKeys(): Promise<void> {
    const { history } = await access();
    const epochs = history.current.keys;
    const learned: SpaceKey[] = [];
    const take = (found: SpaceKey) => {
      if (keyring.has(found.id)) return false;
      keyring.set(found.id, found);
      learned.push(found);
      return true;
    };

    if (memberPair && epochs.some((epoch) => !keyring.has(epoch.keyId))) {
      for (const versions of (await boxIndex()).values()) {
        for (const version of versions) {
          if (version.collection !== BOX_COLLECTION || version.deleted || boxesOpened.has(version.id))
            continue;
          const body = isRecord(version.body) ? version.body : null;
          if (body?.to !== deps.rootDid || typeof body.keyId !== 'string' || typeof body.sealed !== 'string')
            continue;
          const epoch = epochs.find((known) => known.keyId === body.keyId);
          if (!epoch || keyring.has(epoch.keyId)) continue;
          boxesOpened.add(version.id);
          const content = await openValueFrom(
            memberPair,
            BOX_LABEL,
            boxBound(space.id, epoch.keyId, deps.rootDid),
            body.sealed,
          );
          if (!isRecord(content) || typeof content.key !== 'string') continue;
          // Whoever sealed it, it is the key the history names or it is nothing.
          const found = await spaceKeyFromRaw(base64UrlDecode(content.key)).catch(() => null);
          if (found?.id === epoch.keyId && (await deriveReadKey(found, provider)).did === epoch.readKey)
            take(found);
        }
      }
    }

    const named = epochs.map((epoch) => `${epoch.keyId}/${epoch.readKey}/${epoch.event}`).join('|');
    if (named !== openedFor) {
      openedFor = named;
      openedKeyRecords.clear();
      malformedKeys.clear();
    }
    // Each newer key opens the ones before it — which may open more.
    let more = true;
    while (more) {
      more = false;
      for (const versions of (await storage.histories('key:')).values()) {
        for (const version of versions) {
          const body = isRecord(version.body) ? version.body : null;
          if (
            version.collection !== KEY_COLLECTION ||
            openedKeyRecords.has(version.id) ||
            typeof body?.keyId !== 'string'
          )
            continue;
          // Only the key change that counted for that key: anyone may store a version at `key:space`.
          const epoch = epochs.find((known) => known.keyId === body.keyId);
          if (!epoch || epoch.event !== version.id) continue;
          const holder = keyring.get(body.keyId);
          if (!holder) continue;
          openedKeyRecords.add(version.id);
          const earlier = await openValue(
            holder.seal,
            EARLIER_KEYS_LABEL,
            { space: space.id, keyId: holder.id },
            body.earlier,
          );
          const found: SpaceKey[] = [];
          for (const raw of isStringList(earlier) ? earlier.slice(0, 1000) : []) {
            const key = await spaceKeyFromRaw(base64UrlDecode(raw)).catch(() => null);
            if (key) found.push(key);
          }
          // Without the first key, a reader holding only this one couldn't derive onePer keys (02 §7.3).
          if (!isStringList(earlier) || !found.some((key) => key.id === space.encryptionKeyId)) {
            malformedKeys.add(body.keyId);
            continue;
          }
          // And only keys the history names, each with the read key it names.
          for (const key of found) {
            const named = epochs.find((known) => known.keyId === key.id);
            if (named && (await deriveReadKey(key, provider)).did === named.readKey && take(key)) more = true;
          }
        }
      }
    }

    if (learned.length === 0) return;
    // A definition this node couldn't read may open now.
    deps.rules.forgetDefinitions();
    const writeWith = newestKey((await access()).history.current);
    if (writeWith) await deps.onKeys?.([...keyring.values()], writeWith.id);
    recordsChanged();
  }

  /** Makes a new key current, with every key before it sealed inside, and seals it to each member */
  async function rotateKey(): Promise<void> {
    if (space.visibility !== 'private') throw new Error('A public space has no key to change');
    const { history } = await access();
    if (!may(history.current, deps.rootDid, KEY_CHANGE, {}))
      throw new Error(`Only someone granted ${KEY_CHANGE} in "${space.name}" can change its key`);
    if (!currentKey(history.current))
      throw new Error(`This device doesn't hold the current key of "${space.name}" yet`);
    // Every key change carries the first key, so every reader holds it (03 §9.3).
    if (!space.encryptionKeyId || !keyring.has(space.encryptionKeyId))
      throw new Error(`This device doesn't hold the first key of "${space.name}"`);
    const next = await generateSpaceKey();
    const earlier = [...keyring.values()].map((held) => base64UrlEncode(held.raw));
    const body = {
      keyId: next.id,
      readKey: (await deriveReadKey(next, provider)).did,
      earlier: await sealValue(next.seal, EARLIER_KEYS_LABEL, { space: space.id, keyId: next.id }, earlier),
    };
    keyring.set(next.id, next);
    try {
      await upsert(KEY_COLLECTION, SPACE_KEY_RECORD, body);
    } catch (error) {
      keyring.delete(next.id);
      throw error;
    }
    await deps.onKeys?.([...keyring.values()], next.id);
    await boxForMembers();
  }

  /**
   * Seals the current key to each member who has no copy from someone who
   * manages the space. Members show their member key on their profile; one
   * who hasn't yet gets their copy once they do.
   */
  async function boxForMembers(): Promise<void> {
    const { history } = await access();
    const state = history.current;
    const epoch = state.keys.at(-1);
    const key = currentKey(state);
    if (!epoch || !key) return;

    const boxed = new Set<string>();
    for (const versions of (await boxIndex()).values()) {
      for (const version of versions) {
        const body = isRecord(version.body) ? version.body : null;
        if (
          version.collection !== BOX_COLLECTION ||
          body?.keyId !== epoch.keyId ||
          typeof body.to !== 'string'
        )
          continue;
        const { root } = await judge(version);
        if (root && (root === deps.rootDid || may(state, root, KEY_CHANGE, {}))) boxed.add(body.to);
      }
    }
    const memberKeys = await memberKeyMap();
    const raw = base64UrlEncode(key.raw);
    for (const did of [...readers(state)].sort()) {
      const publicKey = memberKeys.get(did);
      if (boxed.has(did) || !publicKey) continue;
      const sealed = await sealValueTo(publicKey, BOX_LABEL, boxBound(space.id, epoch.keyId, did), {
        key: raw,
      });
      await upsert(BOX_COLLECTION, await boxKey(epoch.keyId, did, deps.rootDid), {
        keyId: epoch.keyId,
        to: did,
        sealed,
      });
    }
  }

  /**
   * Keeps the keys in step with the history: says where to seal this
   * account's copy, learns what it can, and — managing the space — changes
   * the key when due and seals it to whoever lacks it.
   */
  async function upkeep(): Promise<void> {
    // A note that can't change access keeps no keys for others: it only reads.
    if (!grantsBeyondRecords(session.proof(), space.id, ACCESS_COMMAND)) {
      if (space.visibility === 'private') await learnKeys();
      return;
    }
    await nameRelays();
    if (space.visibility !== 'private') return;
    if (deps.accountOnly) {
      await learnKeys();
      return;
    }
    const mine = await memberKeyMap();
    if (
      memberPair &&
      mine.get(deps.rootDid) !== memberPair.publicKey &&
      actsForAccount(session.proof()) &&
      !(await cannotWrite())
    ) {
      await upsert(MEMBER_KEY_COLLECTION, await memberKeyRecordKey(deps.rootDid), {
        key: memberPair.publicKey,
      });
    }
    await learnKeys();
    const { history } = await access();
    const state = history.current;
    if (!currentKey(state)) return;
    if (!may(state, deps.rootDid, KEY_CHANGE, {})) return;
    // A current key whose change left out the first key is replaced, as one that is due.
    const malformed = malformedKeys.has(state.keys.at(-1)?.keyId ?? '');
    if (state.keyDue || (malformed && space.encryptionKeyId && keyring.has(space.encryptionKeyId)))
      await rotateKey();
    else await boxForMembers();
  }

  /**
   * A space nobody has said where to meet yet: whoever manages it names the
   * relays this node uses, so the invites and devices that follow meet there.
   */
  async function nameRelays(): Promise<void> {
    const own = usableRelays(deps.network).slice(0, MAX_RELAYS);
    if (own.length === 0) return;
    const { history } = await access();
    if (history.current.relays.length > 0 || !may(history.current, deps.rootDid, SPACE_RELAYS, {})) return;
    await upsert(RELAYS_COLLECTION, SPACE_RELAYS_RECORD, { relays: own });
  }

  /** Runs the upkeep once more after whatever changed — one run at a time */
  const keepingUp = serial(async () => {
    if (deps.isClosed()) return;
    await upkeep().catch(() => {
      // A write refused, a peer's junk: the next change tries again.
    });
  });
  function keepUp(): void {
    if (!deps.isClosed()) void keepingUp();
  }

  /**
   * A change that took someone's place makes a new key due. The node that
   * made it changes the key before the call returns, not later in the
   * background: one that closes straight after a removal would otherwise
   * leave the removed member reading everything written since.
   */
  async function changeKeyNow(): Promise<void> {
    if (space.visibility === 'private' && (await access()).history.current.keyDue) await keepingUp();
  }

  return {
    currentKey,
    newestKey,
    rotateKey,
    keepUp,
    keepingUp,
    changeKeyNow,
    forget(): void {
      boxCache = null;
    },
  };
}

export type Keys = ReturnType<typeof createKeys>;
