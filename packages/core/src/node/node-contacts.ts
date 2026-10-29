/**
 * @module node-contacts
 * The account as others meet it: its profile, its contacts and the spaces
 * for two they talk in, and its inbox.
 */
import { cached } from '../utils/map.js';
import { parseSpaceInvite } from '../space/space-manager.js';
import { checkInvitation } from '../space/invitation.js';
import { checkSpace } from '../space/constitution.js';
import { team } from '../space/presets.js';
import {
  isAvatarRef,
  PROFILE_COLLECTION,
  PROFILE_KEY,
  type AccountProfile,
  type AvatarRef,
} from '../space/account-registry.js';
import { contactPublicKey, deriveInboxKeyBytes, deriveInboxSignKeyBytes } from '../identity/contact-key.js';
import {
  contact as contactSchema,
  contactRequest as contactRequestSchema,
  inbox as inboxSchema,
  knock as knockSchema,
  spaceInvite as spaceInviteSchema,
  type Contact,
  type ContactRequestRecord,
  type Inbox,
  type Knock,
  type SpaceInviteRecord,
} from '../schemas/contacts.js';
import { claimUsername, formatUsername, parseUsername, resolveUsername } from '../inbox/names.js';
import {
  clip,
  encodeInbox,
  inboxTopic,
  KNOCK_TTL_SECONDS,
  knockId,
  MAX_INBOX_PLACES,
  openKnock,
  readInbox as readInboxCode,
  sealKnock,
  signPurge,
  type OpenedKnock,
} from '../inbox/inbox.js';
import { relayKind } from '../network/relays.js';
import { base64UrlDecode } from '../utils/encoding.js';
import { isRecord } from '../utils/guards.js';
import type { SpaceRuntime } from './space-runtime.js';
import { usableRelays } from './space-peers.js';
import type {
  AccountProfileView,
  ContactRequest,
  ContactView,
  InboxView,
  KnockView,
  NodeAccount,
  NodeContacts,
  NodeInbox,
  NodeRecord,
  SpaceInviteView,
} from './types.js';
import { ensureDefined, errorText, inBackground, type NodeContext } from './node-context.js';

const DAY_MS = 24 * 3600 * 1000;

export function createNodeContacts(ctx: NodeContext) {
  const { config, provider, registry, mailbox, accountSpaceId, contactsSpaceId, contactKeys } = ctx;

  // ─── The profile ───────────────────────────────────────────────────
  //
  // The account's name and picture, kept in its registry, and told to each
  // space it uses as that space opens.

  /**
   * The account's profile, from its registry — null without an account key,
   * or before one is set. One record: its current version is the name, by the
   * ordering rule, the same on every device whatever their clocks say.
   */
  async function ownProfile(): Promise<AccountProfileView | null> {
    if (!accountSpaceId) return null;
    const profile = await (await ctx.runtime(accountSpaceId)).get<AccountProfile>(PROFILE_KEY);
    if (!profile?.verified || profile.root !== config.signer.did || typeof profile.body?.name !== 'string')
      return null;
    const avatar = profile.body.avatar;
    return {
      name: profile.body.name,
      updatedAt: profile.updatedAt,
      ...(isAvatarRef(avatar) ? { avatar } : {}),
    };
  }
  const ownName = async () => (await ownProfile())?.name ?? config.accountName ?? null;

  /**
   * Tells a space who this account is. Done when the space opens and when the
   * name changes — not by opening every space, which would start syncing them
   * all; a space not open now hears on its next open.
   */
  async function publishProfile(spaceId: string, open: SpaceRuntime): Promise<void> {
    if (ctx.narrowNote || (await ctx.kindOf(spaceId))) return;
    const own = await ownProfile();
    if (!own) return;
    const base = { name: own.name, ...(contactKeys ? { contactKey: contactKeys.publicKey } : {}) };
    const held = await heldAvatar(open);
    const copied = held?.source === own.avatar?.hash ? held : undefined;
    // The name goes out now with the picture the space has; a new picture follows once copied,
    // which may wait on its bytes reaching this device.
    const shown = own.avatar ? (copied ?? held) : undefined;
    await open.publishProfile({ ...base, ...(shown ? { avatar: shown } : {}) });
    if (own.avatar && !copied)
      inBackground(
        avatarIn(spaceId, open, own.avatar).then((avatar) => open.publishProfile({ ...base, avatar })),
      );
  }

  /** The account's picture as this space shows it */
  async function heldAvatar(open: SpaceRuntime): Promise<AvatarRef | undefined> {
    const avatar = (await open.profiles()).find((profile) => profile.did === config.signer.did)?.avatar;
    return isAvatarRef(avatar) ? avatar : undefined;
  }

  const avatarCopies = new Map<string, Promise<AvatarRef>>();
  /**
   * The account's picture as a file of this space: members can't read the
   * registry, so each space holds its own copy, made once per picture.
   */
  function avatarIn(spaceId: string, open: SpaceRuntime, avatar: AvatarRef): Promise<AvatarRef> {
    return cached(avatarCopies, `${spaceId}:${avatar.hash}`, async () => {
      const held = await heldAvatar(open);
      if (held?.source === avatar.hash) return held;
      const registryRt = await ctx.requireAccount('Copying the picture');
      const copy = await open.addFile(await registryRt.readFile(avatar));
      return { ...copy, mime: avatar.mime, source: avatar.hash };
    });
  }

  async function publishProfileToOpenSpaces(): Promise<void> {
    for (const [spaceId, open] of ctx.runtimes) {
      await open.then((rt) => publishProfile(spaceId, rt)).catch(() => {});
    }
  }

  /** Writes the account's profile, and tells every open space */
  async function writeProfile(registryRt: SpaceRuntime, profile: AccountProfile) {
    const written = await registryRt.upsertSystem<AccountProfile>(PROFILE_COLLECTION, PROFILE_KEY, profile);
    ctx.emit({ type: 'account' });
    await publishProfileToOpenSpaces();
    return { ...profile, updatedAt: written.updatedAt };
  }

  const account = Object.freeze<NodeAccount>({
    profile: ownProfile,
    async setName(name) {
      const registryRt = await ctx.requireAccount('Renaming across devices');
      const trimmed = name.trim();
      if (!trimmed) throw new Error('A name cannot be empty');
      const avatar = (await ownProfile())?.avatar;
      return writeProfile(registryRt, { name: trimmed, ...(avatar ? { avatar } : {}) });
    },
    async setAvatar(image, options = {}) {
      const registryRt = await ctx.requireAccount('Changing the picture across devices');
      const name = (await ownName()) ?? options.name?.trim();
      if (!name) throw new Error('Give the account a name first');
      if (image && !image.mime.startsWith('image/')) throw new Error('A picture is an image');
      const avatar = image ? { ...(await registryRt.addFile(image.bytes)), mime: image.mime } : null;
      return writeProfile(registryRt, { name, ...(avatar ? { avatar } : {}) });
    },
    async picture() {
      const avatar = (await ownProfile())?.avatar;
      if (!avatar || !accountSpaceId) return null;
      return { bytes: await (await ctx.runtime(accountSpaceId)).readFile(avatar), mime: avatar.mime };
    },
    revoke: async (key, options) =>
      (await ctx.requireAccount('Revoking in the account registry')).revoke(key, options),
  });

  // ─── Contacts ──────────────────────────────────────────────────────
  //
  // One `std.contact` per person in the contacts space, keyed by their DID.
  // Asking someone is a knock left as a `std.contact-request` in a space you
  // share: the signed invite to a new space for two, sealed to their contact
  // key, so it opens only for them, and only as from the account that left it.

  // The key `onePer: ['did']` derives, so the record for someone is the same one on every device.
  const contactRecordKey = async (did: string) =>
    (await contactsRuntime()).onePerKey(contactSchema.name, { did }, { onePer: contactSchema.rules.onePer });

  async function contactsRuntime(): Promise<SpaceRuntime> {
    if (!contactsSpaceId)
      throw new Error(
        'This app was not given your contacts. Connect to your account home again, and allow contacts.',
      );
    return ctx.runtime(contactsSpaceId);
  }

  /** What this account wrote in its contacts space, in a collection that `check` takes; none without one */
  async function ownContactRecords<T>(
    collection: string,
    check: (record: NodeRecord<T>) => boolean,
  ): Promise<NodeRecord<T>[]> {
    if (!contactsSpaceId) return [];
    return ctx.ownRecords<T>(await contactsRuntime(), { collection }, check);
  }

  /** Making and joining spaces for two needs a note good for every space — whole-account access. */
  function requireEverywhere(what: string): void {
    // As a knock needs: `/account/write` for the whole account (spec 01 §8, 07).
    if (ctx.narrowNote) {
      throw new Error(
        `${what} makes or joins a space, which needs access to your whole account. Connect to your account home again, and ask for it.`,
      );
    }
  }

  async function contactRecords(): Promise<ReadonlyArray<NodeRecord<Contact>>> {
    const listed = await ownContactRecords<Contact>(
      contactSchema.name,
      (record) => typeof record.body?.did === 'string' && typeof record.body.name === 'string',
    );
    // One record per person, under the key their DID gives.
    const found: NodeRecord<Contact>[] = [];
    for (const record of listed)
      if (record.key === (await contactRecordKey(record.body!.did))) found.push(record);
    return found;
  }

  /** Whoever the account blocked */
  const blockedDids = async () =>
    new Set((await contactRecords()).flatMap(({ body }) => (body!.blocked === true ? [body!.did] : [])));

  function requireContactKeys(): void {
    if (!contactKeys)
      throw new Error(
        "This app can't read contact requests. Connect to your account home again, and allow contacts.",
      );
  }

  function contactView(record: NodeRecord<Contact>): ContactView {
    const body = record.body!;
    return Object.freeze({
      did: body.did,
      name: body.name,
      space: typeof body.space === 'string' ? body.space : null,
      ...(typeof body.note === 'string' ? { note: body.note } : {}),
      blocked: body.blocked === true,
      ...(typeof body.username === 'string' ? { username: body.username } : {}),
      updatedAt: record.updatedAt,
    });
  }

  async function writeContact(body: Contact): Promise<ContactView> {
    const open = await contactsRuntime();
    await ensureDefined(open, contactSchema);
    // One per person: writing again is the next version of their record.
    return contactView(await open.put<Contact>(contactSchema.name, body));
  }

  /** Whether an account holds a place in a space */
  async function joined(spaceId: string, did: string): Promise<boolean> {
    return (await (await ctx.runtime(spaceId)).access()).members.some((member) => member.did === did);
  }

  /**
   * The space an invite from `did` is for, its id and name, checked as joining
   * would check it: signed by `did`, for the space whose constitution it
   * carries. Null for anything less.
   */
  async function invitedTo(
    invite: string,
    did: string,
  ): Promise<{ readonly id: string; readonly name: string } | null> {
    try {
      const { space, signed, invite: secret, invitedBy } = parseSpaceInvite(invite);
      if (invitedBy !== did || (await checkSpace(space)) !== null) return null;
      if ((await checkInvitation(signed, provider, secret)) !== null) return null;
      return { id: space.id, name: space.name };
    } catch {
      return null;
    }
  }

  /** An invite of yours a contact used: closed, so nobody joins with it again, and deleted */
  async function settleInvite(record: NodeRecord<SpaceInviteRecord>, did: string): Promise<void> {
    const { space, invite } = record.body!;
    if (!(await registry.get(space)) || !(await joined(space, did))) return;
    await ctx.spaces.closeInvite(space, invite).catch(() => {});
    const pair = record.space;
    await (await ctx.runtime(pair)).remove(record.key);
  }

  /** Leaves a space for two, unless another contact still names it */
  async function leavePairSpace(spaceId: string | null, did: string): Promise<void> {
    if (!spaceId || !(await registry.get(spaceId))) return;
    if ((await contactRecords()).some((record) => record.body!.did !== did && record.body!.space === spaceId))
      return;
    await ctx.spaces.leave(spaceId);
  }

  /**
   * A knock left in a space as a contact request, opened — or null when it
   * isn't one sealed to this account's contact key, by the account that wrote it.
   */
  async function openMail(record: NodeRecord<unknown> | null): Promise<OpenedKnock | null> {
    if (
      !config.contactKey ||
      !contactKeys ||
      !record?.verified ||
      record.collection !== contactRequestSchema.name
    )
      return null;
    const body = record.body;
    if (!isRecord(body) || body.to !== contactKeys.publicKey || typeof body.sealed !== 'string') return null;
    const opened = await openKnock([config.contactKey], body.sealed, provider);
    if (!opened || opened.from !== record.root || opened.from === config.signer.did) return null;
    return opened;
  }

  /**
   * A space for two and a knock that invites someone to it, sealed to `to`:
   * their inbox key or their contact key. The space waits for a carrier to
   * hold it before the knock is made, so they can join with every device of
   * this account away (`spaces.carried`).
   */
  async function makePair(
    to: string,
    names: { readonly mine: string; readonly theirs: string },
    note: string | undefined,
  ): Promise<{
    readonly space: string;
    readonly invite: string;
    readonly sealed: string;
    readonly carried: boolean;
  }> {
    const pair = await ctx.spaces.create({
      name: `${clip(names.mine, 64)} & ${clip(names.theirs, 64)}`,
      visibility: 'private',
      ...team,
    });
    try {
      const invite = await ctx.spaces.invite(pair.id, { role: 'editor' });
      const { signed, invite: secret } = parseSpaceInvite(invite);
      if (!secret) throw new Error('The invite to the space for two opens no role');
      const carried = await ctx.spaces.carried(pair.id);
      const sealed = await sealKnock(
        to,
        { invite: signed, secret: base64UrlDecode(secret), name: names.mine, ...(note ? { note } : {}) },
        ctx.looseSigner(),
        provider,
      );
      return { space: pair.id, invite, sealed, carried };
    } catch (error) {
      await ctx.spaces.leave(pair.id).catch(() => {});
      throw error;
    }
  }

  const contacts: NodeContacts = Object.freeze<NodeContacts>({
    async space() {
      return contactsSpaceId;
    },

    async list() {
      return (await contactRecords())
        .map(contactView)
        .sort((a, b) => a.name.localeCompare(b.name) || a.did.localeCompare(b.did));
    },

    async get(did) {
      const record = (await contactRecords()).find((found) => found.body!.did === did);
      return record ? contactView(record) : null;
    },

    async put(contact: {
      readonly did: string;
      readonly name: string;
      readonly space?: string | null;
      readonly note?: string;
    }) {
      if (!contact.did.startsWith('did:')) throw new Error('A contact needs their account DID');
      const name = contact.name.trim().slice(0, 200);
      if (!name) throw new Error('A contact needs a name');
      return writeContact({
        did: contact.did,
        name,
        ...(contact.space ? { space: contact.space } : {}),
        ...(contact.note ? { note: contact.note.slice(0, 2000) } : {}),
      });
    },

    async remove(did) {
      const found = await contacts.get(did);
      if (!found) return;
      await leavePairSpace(found.space, did);
      const key = await contactRecordKey(did);
      if (key) await (await contactsRuntime()).remove(key);
    },

    async block(did) {
      const found = await contacts.get(did);
      await leavePairSpace(found?.space ?? null, did);
      await writeContact({
        did,
        name: found?.name ?? did,
        blocked: true,
        ...(found?.note ? { note: found.note } : {}),
      });
    },

    async ask(spaceId, did, options = {}) {
      requireEverywhere('Adding a contact');
      if (did === config.signer.did) throw new Error('That is you');
      if (!contactsSpaceId) await contactsRuntime();
      const shared = await ctx.runtime(spaceId);
      const profiles = await shared.profiles();
      const theirs = profiles.find((profile) => profile.did === did);
      if (!theirs?.contactKey) {
        throw new Error(
          "They can't be asked here yet: their profile in this space has no contact key. It appears once they open the space in an up-to-date app.",
        );
      }
      const mine =
        (await ownName()) ?? profiles.find((profile) => profile.did === config.signer.did)?.name ?? 'Me';
      const note = options.note?.trim().slice(0, 2000);
      const made = await makePair(theirs.contactKey, { mine, theirs: theirs.name }, note);
      await ensureDefined(shared, contactRequestSchema);
      await writeContact({ did, name: theirs.name, space: made.space });
      const request = await shared.put<ContactRequestRecord>(contactRequestSchema.name, {
        to: theirs.contactKey,
        sealed: made.sealed,
      });
      return { space: made.space, request: request.key, carried: made.carried };
    },

    async requests(spaceId) {
      requireContactKeys();
      const shared = await ctx.runtime(spaceId);
      const blocked = await blockedDids();
      const names = new Map((await shared.profiles()).map((profile) => [profile.did, profile.name]));
      const found: ContactRequest[] = [];
      for (const record of await shared.list<unknown>({ collection: contactRequestSchema.name })) {
        const opened = await openMail(record);
        if (!opened || blocked.has(opened.from)) continue;
        // Already accepted, here or on another device.
        if (await registry.get(opened.pairSpace)) continue;
        found.push({
          space: spaceId,
          key: record.key,
          from: opened.from,
          name: names.get(opened.from) ?? null,
          ...(opened.note ? { note: opened.note } : {}),
          pairSpace: opened.pairSpace,
          createdAt: record.createdAt,
        });
      }
      return found;
    },

    async accept(spaceId, requestKey) {
      requireEverywhere('Accepting a contact request');
      requireContactKeys();
      const shared = await ctx.runtime(spaceId);
      const opened = await openMail(await shared.get<unknown>(requestKey));
      if (!opened) throw new Error('That contact request is gone, or is not for you.');
      await ctx.spaces.join(opened.invite);
      const name =
        (await shared.profiles()).find((profile) => profile.did === opened.from)?.name ??
        (await contacts.get(opened.from))?.name ??
        opened.name;
      return writeContact({ did: opened.from, name, space: opened.pairSpace });
    },

    async others(did) {
      const found = await contacts.get(did);
      if (!found?.space || !(await registry.get(found.space))) return [];
      const open = await ctx.runtime(found.space);
      const [{ members }, profiles, status] = await Promise.all([
        open.access(),
        open.profiles(),
        open.status(),
      ]);
      const seen = new Set([
        ...members.map((member) => member.did),
        ...profiles.map((profile) => profile.did),
        ...Object.values(status.accounts),
      ]);
      return [...seen].filter((account) => account !== config.signer.did && account !== did).sort();
    },

    async invite(did, spaceId, options = {}) {
      requireEverywhere('Inviting someone');
      const contact = await contacts.get(did);
      if (contact?.blocked) throw new Error(`You blocked ${contact.name}`);
      // Only someone whose account you have seen join your space for two: never whoever a name leads to.
      if (!contact?.space || !(await registry.get(contact.space)) || !(await joined(contact.space, did)))
        throw new Error(`${contact?.name ?? 'They'} haven't joined your space for two yet`);
      if (!(await registry.get(spaceId))) throw new Error("You don't hold that space");
      const invite = await ctx.spaces.invite(spaceId, options.role ? { role: options.role } : {});
      const pair = await ctx.runtime(contact.space);
      await ensureDefined(pair, spaceInviteSchema);
      // One per space: inviting again replaces the invite left before.
      await pair.put<SpaceInviteRecord>(spaceInviteSchema.name, { space: spaceId, invite });
    },

    async invites() {
      const held = new Set((await ctx.spaces.list()).map((summary) => summary.id));
      const found: SpaceInviteView[] = [];
      for (const { body } of await contactRecords()) {
        const { did, space: pairSpace, blocked } = body!;
        if (blocked || !pairSpace || !held.has(pairSpace)) continue;
        const pair = await ctx.runtime(pairSpace);
        for (const record of await pair.list<SpaceInviteRecord>({ collection: spaceInviteSchema.name })) {
          if (!record.verified || typeof record.body?.invite !== 'string') continue;
          if (record.root === config.signer.did) {
            await settleInvite(record, did).catch(() => {});
            continue;
          }
          // Only the contact leaves invites here, and the invite itself says which space.
          const space = record.root === did ? await invitedTo(record.body.invite, did) : null;
          if (!space || space.id !== record.body.space || held.has(space.id)) continue;
          found.push(
            Object.freeze({
              from: did,
              space: space.id,
              name: space.name,
              invite: record.body.invite,
              pairSpace,
              key: record.key,
              createdAt: record.createdAt,
            }),
          );
        }
      }
      return found.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },

    async join(pairSpace, key) {
      const contact = (await contactRecords()).find(({ body }) => body!.space === pairSpace)?.body;
      const record = await (await ctx.runtime(pairSpace)).get<SpaceInviteRecord>(key);
      if (!contact || contact.blocked || record?.root !== contact.did || !record.verified)
        throw new Error('That invite is gone: they may have taken it back');
      // Its maker closes and deletes it once they see you there; until then it is hidden, as you hold the space.
      return ctx.spaces.join(record.body!.invite);
    },
  });

  // ─── The inbox ─────────────────────────────────────────────────────
  //
  // Its settings are a `std.inbox` in the contacts space; its keys derive from
  // the contact key and its `gen`, so every device with the contact key opens
  // the same inbox. A knock you left is a `std.knock` until someone else joins
  // the space for two: only the inbox key's holder could open the invite, so
  // that is them. See `packages/core/src/inbox/inbox.ts`.

  /** Knocks seen in this node's inbox, by id: opened (null when they didn't check out), and until when to keep them */
  const knockCache = new Map<string, { readonly opened: OpenedKnock | null; readonly until: number }>();
  /** Knocks that didn't check out, by id, and until when they are not opened again: one dated a little ahead may pass later */
  const failed = new Map<string, number>();

  /** The inbox is the account's own, in its contacts space: only a key acting as the account opens one, as every peer checks */
  const inboxAllowed = () => contactsSpaceId !== null && !ctx.narrowNote;

  function requireContactKey(what: string): Uint8Array {
    // The inbox is the account's: a key whose note doesn't grant `/account/write` never opens one or knocks.
    if (!inboxAllowed())
      throw new Error(`This key's note doesn't let it use your inbox. ${what} is the person's to do.`);
    if (!config.contactKey)
      throw new Error(
        `${what} needs your contact key. Connect to your account home again, and allow contacts.`,
      );
    return config.contactKey;
  }

  /** An inbox's keys, from the contact key and its gen */
  async function inboxKeys(gen: number) {
    const contactKey = requireContactKey('Your inbox');
    const key = await deriveInboxKeyBytes(contactKey, gen);
    const sign = await deriveInboxSignKeyBytes(contactKey, gen);
    const signPublic = contactPublicKey(sign);
    return { key, sign, publicKey: contactPublicKey(key), signPublic, topic: await inboxTopic(signPublic) };
  }

  /** The account's inbox: the newest `std.inbox` of the highest gen */
  async function inboxRecord(): Promise<NodeRecord<Inbox> | null> {
    const records = await ownContactRecords<Inbox>(
      inboxSchema.name,
      (record) =>
        Number.isSafeInteger(record.body?.gen) && record.body!.gen >= 0 && Array.isArray(record.body!.places),
    );
    return (
      records.sort((a, b) => b.body!.gen - a.body!.gen || b.updatedAt.localeCompare(a.updatedAt))[0] ?? null
    );
  }

  async function inboxView(record: NodeRecord<Inbox>): Promise<InboxView> {
    const body = record.body!;
    const keys = await inboxKeys(body.gen);
    return Object.freeze({
      gen: body.gen,
      ...(body.name ? { name: body.name } : {}),
      key: keys.publicKey,
      sign: keys.signPublic,
      places: Object.freeze([...body.places]),
      code: await encodeInbox(
        keys.sign,
        {
          key: keys.publicKey,
          sign: keys.signPublic,
          gen: body.gen,
          places: body.places,
          ...(body.name ? { name: body.name } : {}),
        },
        provider,
      ),
      ...(body.username ? { username: body.username } : {}),
      ...(body.usernameUntil ? { usernameUntil: body.usernameUntil } : {}),
      updatedAt: record.updatedAt,
    });
  }

  /** Writes the inbox's settings, checked the way a knocker will read its code */
  async function writeInbox(body: Inbox, current: NodeRecord<Inbox> | null): Promise<InboxView> {
    const keys = await inboxKeys(body.gen);
    const { gen, places, name } = body;
    await encodeInbox(
      keys.sign,
      { gen, places, ...(name ? { name } : {}), key: keys.publicKey, sign: keys.signPublic },
      provider,
    );
    const open = await contactsRuntime();
    await ensureDefined(open, inboxSchema);
    return inboxView(
      current ? await open.update<Inbox>(current.key, body) : await open.put<Inbox>(inboxSchema.name, body),
    );
  }

  /** Clears knocks from every mailbox an inbox names that can purge, as its owner; how many did */
  async function purgeInbox(body: Inbox, ids: ReadonlyArray<string> | null): Promise<number> {
    const keys = await inboxKeys(body.gen);
    const done = await Promise.allSettled(
      body.places
        .filter((place) => relayKind(place)?.can.purge)
        .map((place) =>
          mailbox.purge(place, keys.topic, keys.signPublic, ids, (nonce) =>
            signPurge(keys.sign, keys.topic, nonce, ids),
          ),
        ),
    );
    return done.filter((result) => result.status === 'fulfilled').length;
  }

  /** Forgets every knock seen: what the mailboxes held is gone */
  function forgetKnocks(): void {
    knockCache.clear();
    failed.clear();
  }

  // ─── The username ──────────────────────────────────────────────────
  //
  // A name at a domain that leads to the inbox's code (spec 07 §9), claimed on
  // the domain's name service (`packages/core/docs/usernames.md`). It is kept
  // in `std.inbox`, so every device points it at the code when the code
  // changes, and renews it before its year is up.

  /** Renew a name this long before it lapses */
  const RENEW_BEFORE_MS = 30 * DAY_MS;
  /** When this node last looked whether the name needs renewing */
  let renewChecked = 0;

  /** Points the inbox's username at its code now, and keeps when it lapses */
  /**
   * The inbox's settings, with its username pointed at the code they make
   * first: a name service that is down leaves everything as it was, never the
   * name leading to an inbox nobody reads.
   */
  async function named(body: Inbox): Promise<Inbox> {
    if (!body.username) return body;
    const keys = await inboxKeys(body.gen);
    const { gen, places, name } = body;
    const code = await encodeInbox(
      keys.sign,
      { gen, places, ...(name ? { name } : {}), key: keys.publicKey, sign: keys.signPublic },
      provider,
    );
    const until = await claimUsername(body.username, requireContactKey('Your username'), code);
    return { ...body, usernameUntil: until };
  }

  /** Claims the name again when its year is nearly up; at most once an hour */
  async function renewName(): Promise<void> {
    if (Date.now() - renewChecked < 3600_000) return;
    renewChecked = Date.now();
    const current = await inboxRecord();
    const { username, usernameUntil = 0 } = current?.body ?? {};
    if (current && username && usernameUntil - Date.now() < RENEW_BEFORE_MS)
      await writeInbox(await named(current.body!), current);
  }

  const sentRecords = () =>
    ownContactRecords<Knock>(
      knockSchema.name,
      (record) => typeof record.body?.space === 'string' && typeof record.body.invite === 'string',
    );

  /**
   * Knocks of yours: one someone joined becomes a contact, and its invite is
   * closed; one nobody joined within the knock's life is let go, space and all.
   */
  async function settleSent(): Promise<void> {
    for (const record of await sentRecords()) {
      const { space, name, invite, username } = record.body!;
      if (!(await registry.get(space))) {
        await (await contactsRuntime()).remove(record.key);
        continue;
      }
      const open = await ctx.runtime(space);
      // Only the holder of the inbox key could open the invite: whoever joined first is them.
      const joiner = (await open.access()).members.find((member) => member.did !== config.signer.did)?.did;
      if (joiner) {
        // Whoever else the invite reached, nobody more joins with it.
        await ctx.spaces.closeInvite(space, invite).catch(() => {});
        const given = (await open.profiles()).find((profile) => profile.did === joiner)?.name;
        await writeContact({ did: joiner, name: given ?? name, space, ...(username ? { username } : {}) });
        await (await contactsRuntime()).remove(record.key);
      } else if (Date.now() - Date.parse(record.createdAt) > KNOCK_TTL_SECONDS * 1000 + DAY_MS) {
        await ctx.spaces.leave(space).catch(() => {});
        await (await contactsRuntime()).remove(record.key);
      }
    }
  }

  /** What the mailboxes of this node's inbox hold now, opened and cached */
  async function readKnocks(): Promise<ReadonlyArray<{ readonly id: string; readonly opened: OpenedKnock }>> {
    const now = Date.now();
    for (const [id, cached] of knockCache) if (cached.until <= now) knockCache.delete(id);
    const record = await inboxRecord();
    if (!record) return [];
    const { gen, places } = record.body!;
    const keys = await inboxKeys(gen);
    // Every mailbox in full: an inbox holds 64 knocks at most, and one cleared on another device goes here too.
    const held = await knocksAt(places, keys.topic);
    const found: { id: string; opened: OpenedKnock }[] = [];
    for (const [id, blob] of held) {
      const opened = knockCache.get(id)?.opened ?? (await openOnce(id, blob, keys.key, now));
      if (opened) found.push({ id, opened });
    }
    return found;
  }

  /** What the mailboxes hold under a topic, by knock id */
  async function knocksAt(places: ReadonlyArray<string>, topic: string): Promise<Map<string, string>> {
    const held = new Map<string, string>();
    const fetched = await Promise.allSettled(places.map((place) => mailbox.fetch(place, topic)));
    for (const result of fetched) {
      if (result.status !== 'fulfilled') continue;
      // A relay's id is only its word: a knock is filed under the hash of what it is.
      for (const item of result.value) held.set(await knockId(item.blob), item.blob);
    }
    return held;
  }

  /** Opens a knock; one that failed waits a while before it is tried again */
  async function openOnce(
    id: string,
    blob: string,
    key: Uint8Array,
    now: number,
  ): Promise<OpenedKnock | null> {
    if ((failed.get(id) ?? 0) > now) return null;
    const opened = await openKnock([key], blob, provider);
    if (opened) knockCache.set(id, { opened, until: opened.at + KNOCK_TTL_SECONDS * 1000 });
    else failed.set(id, now + 15 * 60_000);
    return opened;
  }

  const inbox: NodeInbox = Object.freeze<NodeInbox>({
    async get() {
      if (!config.contactKey || !inboxAllowed()) return null;
      const record = await inboxRecord();
      return record ? inboxView(record) : null;
    },

    async open(options = {}) {
      requireContactKey('Opening your inbox');
      if (!contactsSpaceId) await contactsRuntime();
      const current = await inboxRecord();
      const places = [...(options.places ?? current?.body?.places ?? usableRelays(config.network))].slice(
        0,
        MAX_INBOX_PLACES,
      );
      if (places.length === 0)
        throw new Error('An inbox needs a mailbox to hold its knocks, and this node has none.');
      const name = clip((options.name ?? current?.body?.name ?? (await ownName()) ?? '').trim(), 64);
      const { username, usernameUntil } = current?.body ?? {};
      const next: Inbox = {
        gen: current?.body?.gen ?? 0,
        places,
        ...(name ? { name } : {}),
        ...(username ? { username, ...(usernameUntil ? { usernameUntil } : {}) } : {}),
      };
      // A code that says something new: the name leads to it before anything is written.
      const said = (body: Inbox | null | undefined) => JSON.stringify([body?.places, body?.name ?? null]);
      return writeInbox(current && said(current.body) !== said(next) ? await named(next) : next, current);
    },

    async rotate() {
      requireContactKey('Replacing your inbox');
      const current = await inboxRecord();
      if (!current) return inbox.open();
      const next = await named({ ...current.body!, gen: current.body!.gen + 1 });
      // What waits in the old one goes with it.
      await purgeInbox(current.body!, null).catch(() => 0);
      forgetKnocks();
      return writeInbox(next, current);
    },

    async claim(username) {
      requireEverywhere('Claiming a username');
      const key = requireContactKey('Claiming a username');
      const parsed = parseUsername(username);
      if (!parsed) throw new Error('That is not a username, like leif@minca.social');
      const shown = formatUsername(parsed);
      const view = (await inbox.get()) ?? (await inbox.open());
      const until = await claimUsername(shown, key, view.code);
      const current = await inboxRecord();
      if (!current) throw new Error('Your inbox is not open');
      const previous = current.body!.username;
      const written = await writeInbox({ ...current.body!, username: shown, usernameUntil: until }, current);
      // One name at a time: the one before leads nowhere now.
      if (previous && previous !== shown) await claimUsername(previous, key, null).catch(() => 0);
      return written;
    },

    async release() {
      requireEverywhere('Giving up a username');
      const key = requireContactKey('Giving up a username');
      const current = await inboxRecord();
      const username = current?.body?.username;
      if (!current || !username) throw new Error('You have no username');
      await claimUsername(username, key, null);
      const { gen, places, name } = current.body;
      return writeInbox({ gen, places, ...(name ? { name } : {}) }, current);
    },

    async clear() {
      requireContactKey('Clearing your inbox');
      const current = await inboxRecord();
      if (!current) throw new Error('Your inbox is not open');
      if ((await purgeInbox(current.body!, null)) === 0)
        throw new Error("None of your inbox's mailboxes could be reached and cleared.");
      forgetKnocks();
    },

    async knock(target, options = {}) {
      requireContactKey('Knocking');
      requireEverywhere('Knocking');
      const username = parseUsername(target);
      const code = username ? (await resolveUsername(target, provider)).code : target;
      const theirs = await readInboxCode(code, provider);
      if ((await inbox.get())?.key === theirs.key) throw new Error('That is your own inbox');
      if (!contactsSpaceId) await contactsRuntime();
      const mine = (await ownName()) ?? 'Someone';
      const name = theirs.name ?? 'Contact';
      const made = await makePair(theirs.key, { mine, theirs: name }, options.note);
      const topic = await inboxTopic(theirs.sign);
      const left = await Promise.allSettled(
        theirs.places.map((place) => mailbox.drop(place, topic, made.sealed, KNOCK_TTL_SECONDS)),
      );
      if (!left.some((result) => result.status === 'fulfilled')) {
        await ctx.spaces.leave(made.space).catch(() => {});
        const reasons = left
          .map((result) => (result.status === 'rejected' ? errorText(result.reason) : ''))
          .filter(Boolean);
        throw new Error(`None of their inbox's mailboxes took the knock. ${reasons.join('; ')}`);
      }
      const open = await contactsRuntime();
      await ensureDefined(open, knockSchema);
      await open.put<Knock>(knockSchema.name, {
        space: made.space,
        name,
        invite: made.invite,
        ...(username ? { username: formatUsername(username) } : {}),
      });
      return { space: made.space, carried: made.carried };
    },

    async knocks() {
      requireContactKey('Reading knocks');
      await settleSent().catch(() => {});
      await renewName().catch(() => {});
      const blocked = await blockedDids();
      const found: KnockView[] = [];
      for (const { id, opened } of await readKnocks()) {
        if (opened.from === config.signer.did || blocked.has(opened.from)) continue;
        // Already accepted, here or on another device.
        if (await registry.get(opened.pairSpace)) continue;
        found.push(
          Object.freeze({
            id,
            from: opened.from,
            name: opened.name,
            ...(opened.note ? { note: opened.note } : {}),
            pairSpace: opened.pairSpace,
            at: new Date(opened.at).toISOString(),
          }),
        );
      }
      return found.sort((a, b) => b.at.localeCompare(a.at));
    },

    async sent() {
      await settleSent().catch(() => {});
      return (await sentRecords()).map((record) =>
        Object.freeze({
          space: record.body!.space,
          name: record.body!.name,
          ...(record.body!.username ? { username: record.body!.username } : {}),
          at: record.createdAt,
        }),
      );
    },

    async accept(id) {
      requireContactKey('Accepting a knock');
      requireEverywhere('Accepting a knock');
      if (!knockCache.get(id)?.opened) await readKnocks();
      const knocked = knockCache.get(id)?.opened;
      if (!knocked) throw new Error('That knock is gone: it expired, or your inbox was cleared or replaced.');
      await ctx.spaces.join(knocked.invite);
      const known = await contacts.get(knocked.from);
      const contact = await writeContact({
        did: knocked.from,
        name: known?.name ?? knocked.name,
        space: knocked.pairSpace,
      });
      // Done with: nobody needs it in the mailboxes any more.
      const current = await inboxRecord();
      if (current) await purgeInbox(current.body!, [id]).catch(() => 0);
      knockCache.delete(id);
      return contact;
    },

    async dismiss(id) {
      requireContactKey('Dismissing a knock');
      const current = await inboxRecord();
      if (current) await purgeInbox(current.body!, [id]);
      knockCache.delete(id);
    },
  });

  return Object.freeze({ account, contacts, inbox, publishProfile, publishProfileToOpenSpaces });
}
