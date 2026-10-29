/**
 * @module node/space-keys
 * The space's keys, and their upkeep.
 *
 * A private space's key changes when someone loses their place in it
 * (`sys.key`, part of the access history): whoever manages the space makes
 * a new one, and seals a copy to each member's member key (`sys.box`). The
 * key record carries every earlier key sealed under the new one, so holding
 * the current key opens everything written before it — which is how
 * someone who joins later reads the old records, and someone removed reads
 * nothing new. This is how Keybase changes a team's key.
 */
import type { CryptoProvider, Version } from '../types.js';
import type { SpaceRecord } from '../space/space-manager.js';
import type { ContactKeyPair } from '../identity/contact-key.js';
import { openValueFrom, sealValueTo } from '../identity/hpke.js';
import { openValue, sealValue } from '../identity/envelope.js';
import { ACCESS_COMMAND, actsForAccount } from '../identity/abilities.js';
import {
  EARLIER_KEYS_LABEL,
  generateSpaceKey,
  spaceKeyFromRaw,
  type SpaceKey,
} from '../privacy/space-encryption.js';
import {
  BOX_COLLECTION,
  BOX_LABEL,
  MEMBER_KEY_COLLECTION,
  SPACE_KEY_RECORD,
  SPACE_RELAYS_RECORD,
  boxBound,
  boxKey,
  deriveReadKey,
  memberKeyRecordKey,
} from '../space/space-access.js';
import {
  KEY_COLLECTION,
  MAX_RELAYS,
  RELAYS_COLLECTION,
  may,
  readers,
  type AccessHistory,
  type AccessState,
} from '../space/roles.js';
import { KEY_CHANGE, SPACE_RELAYS } from '../space/grants.js';
import type { StorageProvider } from '../storage/storage-provider.js';
import { base64UrlDecode, base64UrlEncode } from '../utils/encoding.js';
import { isRecord } from '../utils/guards.js';
import { serial } from '../utils/serial.js';
import type { Delegation } from '../identity/ucan.js';
import { grantsBeyondRecords, isStringList } from './space-common.js';

/** What the keys' upkeep reads and writes of the open space */
export interface KeysContext {
  readonly space: SpaceRecord['space'];
  readonly rootDid: string;
  readonly provider: CryptoProvider;
  /** The current note from the account, read fresh each time (`ActiveSession.proof`) */
  readonly proof: () => Delegation | undefined;
  /** The relays this node was configured with that a space may name (`usableRelays`) */
  readonly ownRelays: () => ReadonlyArray<string>;
  /** Only notes that grant `account/write` count here (`SpaceRuntimeDeps.accountOnly`) */
  readonly accountOnly: boolean | undefined;
  /** Every key of the space this node holds, by id: shared with whatever opens bodies */
  readonly keyring: Map<string, SpaceKey>;
  /** The key the space's record came with: what this node proves it may read with before it knows the history */
  readonly heldKey: SpaceKey | null;
  /** This account's member key here, which new keys are sealed to */
  readonly memberPair: ContactKeyPair | null;
  readonly storage: StorageProvider;
  readonly isClosed: () => boolean;
  readonly access: () => Promise<{ readonly history: AccessHistory }>;
  readonly judge: (version: Version) => Promise<{ readonly root: string | null }>;
  readonly boxIndex: () => Promise<Map<string, Version[]>>;
  readonly memberKeyMap: () => Promise<Map<string, string>>;
  readonly cannotWrite: () => Promise<string | null>;
  readonly upsert: (collection: string, recordKey: string, body: unknown) => Promise<unknown>;
  readonly onKeys: ((keys: ReadonlyArray<SpaceKey>, current: string) => Promise<void>) | undefined;
  /** A definition this node couldn't read may open with a key it learned */
  readonly forgetDefinitions: () => void;
  readonly recordsChanged: () => void;
}

export function createSpaceKeys(ctx: KeysContext) {
  const {
    space,
    rootDid,
    provider,
    proof,
    ownRelays,
    accountOnly,
    keyring,
    heldKey,
    memberPair,
    storage,
    isClosed,
    access,
    judge,
    boxIndex,
    memberKeyMap,
    cannotWrite,
    upsert,
    onKeys,
    forgetDefinitions,
    recordsChanged,
  } = ctx;

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
    return heldKey;
  }

  /** Box and key record versions already opened, so each is tried once */
  const opened = new Set<string>();
  /**
   * Key records already opened, for the keys the history named then. Which
   * key event counts, and which keys it names, can change as changes arrive,
   * so they are opened again when that does.
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
          if (version.collection !== BOX_COLLECTION || version.deleted || opened.has(version.id)) continue;
          const body = isRecord(version.body) ? version.body : null;
          if (body?.to !== rootDid || typeof body.keyId !== 'string' || typeof body.sealed !== 'string')
            continue;
          const epoch = epochs.find((known) => known.keyId === body.keyId);
          if (!epoch || keyring.has(epoch.keyId)) continue;
          opened.add(version.id);
          const content = await openValueFrom(
            memberPair,
            BOX_LABEL,
            boxBound(space.id, epoch.keyId, rootDid),
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
    forgetDefinitions();
    const writeWith = newestKey((await access()).history.current);
    if (writeWith) await onKeys?.([...keyring.values()], writeWith.id);
    recordsChanged();
  }

  /** Makes a new key current, with every key before it sealed inside, and seals it to each member */
  async function rotateKey(): Promise<void> {
    if (space.visibility !== 'private') throw new Error('A public space has no key to change');
    const { history } = await access();
    if (!may(history.current, rootDid, KEY_CHANGE, {}))
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
    await onKeys?.([...keyring.values()], next.id);
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
        if (root && (root === rootDid || may(state, root, KEY_CHANGE, {}))) boxed.add(body.to);
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
      await upsert(BOX_COLLECTION, await boxKey(epoch.keyId, did, rootDid), {
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
    if (!grantsBeyondRecords(proof(), space.id, ACCESS_COMMAND)) {
      if (space.visibility === 'private') await learnKeys();
      return;
    }
    await nameRelays();
    if (space.visibility !== 'private') return;
    if (accountOnly) {
      await learnKeys();
      return;
    }
    const mine = await memberKeyMap();
    if (
      memberPair &&
      mine.get(rootDid) !== memberPair.publicKey &&
      actsForAccount(proof()) &&
      !(await cannotWrite())
    ) {
      await upsert(MEMBER_KEY_COLLECTION, await memberKeyRecordKey(rootDid), {
        key: memberPair.publicKey,
      });
    }
    await learnKeys();
    const { history } = await access();
    const state = history.current;
    if (!currentKey(state)) return;
    if (!may(state, rootDid, KEY_CHANGE, {})) return;
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
    const own = ownRelays().slice(0, MAX_RELAYS);
    if (own.length === 0) return;
    const { history } = await access();
    if (history.current.relays.length > 0 || !may(history.current, rootDid, SPACE_RELAYS, {})) return;
    await upsert(RELAYS_COLLECTION, SPACE_RELAYS_RECORD, { relays: own });
  }

  /** Runs the upkeep once more after whatever changed — one run at a time */
  const keepingUp = serial(async () => {
    if (isClosed()) return;
    await upkeep().catch(() => {
      // A write refused, a peer's junk: the next change tries again.
    });
  });
  function keepUp(): void {
    if (!isClosed()) void keepingUp();
  }

  return Object.freeze({ currentKey, newestKey, rotateKey, keepUp, keepingUp });
}
