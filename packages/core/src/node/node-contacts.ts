/**
 * @module node-contacts
 * The account's contacts, and the spaces for two they talk in.
 *
 * One `std.contact` per person in the contacts space, keyed by their DID, so
 * there is one per person on every device. Asking someone is a knock left
 * as a `std.contact-request` in a space you share: the signed invite to a new space for
 * two, sealed to their contact key, so it opens only for them, and only as
 * coming from the account that left it.
 */
import { parseSpaceInvite } from '../space/space-manager.js';
import { team } from '../space/presets.js';
import { clip, openKnock, sealKnock, type OpenedKnock } from '../inbox/inbox.js';
import {
  contact as contactSchema,
  contactRequest as contactRequestSchema,
  type Contact,
  type ContactRequestRecord,
} from '../schemas/contacts.js';
import { base64UrlDecode } from '../utils/encoding.js';
import { isRecord } from '../utils/guards.js';
import type { SpaceRuntime } from './space-runtime.js';
import type { ContactRequest, ContactView, NodeContacts, NodeRecord, NodeSpaces } from './types.js';
import { ensureDefined, type NodeContext } from './node-context.js';

interface ContactsNeeds {
  readonly spaces: NodeSpaces;
  /** The account's name, as its registry holds it */
  readonly ownName: () => Promise<string | null>;
}

export function createNodeContacts(ctx: NodeContext, needs: ContactsNeeds) {
  const { config, provider, registry, contactsSpaceId, contactKeys } = ctx;
  const { spaces } = needs;

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
      updatedAt: record.updatedAt,
    });
  }

  async function writeContact(body: Contact): Promise<ContactView> {
    const open = await contactsRuntime();
    await ensureDefined(open, contactSchema);
    // One per person: writing again is the next version of their record.
    return contactView(await open.put<Contact>(contactSchema.name, body));
  }

  /** Leaves a space for two, unless another contact still names it */
  async function leavePairSpace(spaceId: string | null, did: string): Promise<void> {
    if (!spaceId || !(await registry.get(spaceId))) return;
    if ((await contactRecords()).some((record) => record.body!.did !== did && record.body!.space === spaceId))
      return;
    await spaces.leave(spaceId);
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
    const pair = await spaces.create({
      name: `${clip(names.mine, 64)} & ${clip(names.theirs, 64)}`,
      visibility: 'private',
      ...team,
    });
    try {
      const invite = await spaces.invite(pair.id, { role: 'editor' });
      const { signed, invite: secret } = parseSpaceInvite(invite);
      if (!secret) throw new Error('The invite to the space for two opens no role');
      const carried = await spaces.carried(pair.id);
      const sealed = await sealKnock(
        to,
        { invite: signed, secret: base64UrlDecode(secret), name: names.mine, ...(note ? { note } : {}) },
        ctx.looseSigner(),
        provider,
      );
      return { space: pair.id, invite, sealed, carried };
    } catch (error) {
      await spaces.leave(pair.id).catch(() => {});
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
        (await needs.ownName()) ??
        profiles.find((profile) => profile.did === config.signer.did)?.name ??
        'Me';
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
      await spaces.join(opened.invite);
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
  });

  return Object.freeze({
    contacts,
    contactsRuntime,
    ownContactRecords,
    writeContact,
    blockedDids,
    makePair,
    requireEverywhere,
  });
}
