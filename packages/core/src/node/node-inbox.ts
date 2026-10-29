/**
 * @module node-inbox
 * The account's inbox, and the knocks it leaves in others'.
 *
 * The inbox's settings are a `std.inbox` in the contacts space; its keys
 * are derived from the contact key and its `gen`, so every device with the
 * contact key opens the same inbox. Knocks wait in the mailboxes it names.
 *
 * A knock you left is a `std.knock` until someone other than you joins
 * the space for two: only the holder of the inbox key could open the
 * invite, so whoever joins is them. Then it becomes a contact, and the
 * invite is closed. See `packages/core/src/inbox/inbox.ts`.
 */
import { usableRelays } from './space-runtime.js';
import { contactPublicKey, deriveInboxKeyBytes, deriveInboxSignKeyBytes } from '../identity/contact-key.js';
import { inbox as inboxSchema, knock as knockSchema, type Inbox, type Knock } from '../schemas/contacts.js';
import {
  clip,
  encodeInbox,
  inboxTopic,
  KNOCK_TTL_SECONDS,
  knockId,
  MAX_INBOX_PLACES,
  openKnock,
  readInbox as readInboxCode,
  signPurge,
  type OpenedKnock,
} from '../inbox/inbox.js';
import { relayKind } from '../network/relays.js';
import type { InboxView, KnockView, NodeInbox, NodeRecord, NodeSpaces } from './types.js';
import type { createNodeContacts } from './node-contacts.js';
import { ensureDefined, errorText, type NodeContext } from './node-context.js';

interface InboxNeeds {
  readonly spaces: NodeSpaces;
  readonly contacts: ReturnType<typeof createNodeContacts>;
  /** The account's name, as its registry holds it */
  readonly ownName: () => Promise<string | null>;
}

const DAY_MS = 24 * 3600 * 1000;

export function createNodeInbox(ctx: NodeContext, needs: InboxNeeds): NodeInbox {
  const { config, provider, registry, mailbox } = ctx;
  const { spaces, contacts: part } = needs;
  const { contactsRuntime, writeContact, requireEverywhere } = part;

  /** Knocks seen in this node's inbox, by id: opened (null when they didn't check out), and until when to keep them */
  const knockCache = new Map<string, { readonly opened: OpenedKnock | null; readonly until: number }>();
  /** Knocks that didn't check out, by id, and until when they are not opened again: one dated a little ahead may pass later */
  const failed = new Map<string, number>();

  /** The inbox is the account's own, in its contacts space: only a key acting as the account opens one, as every peer checks */
  const inboxAllowed = () => ctx.contactsSpaceId !== null && !ctx.narrowNote;

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
    const records = await part.ownContactRecords<Inbox>(
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
      updatedAt: record.updatedAt,
    });
  }

  /** Writes the inbox's settings, checked the way a knocker will read its code */
  async function writeInbox(body: Inbox, current: NodeRecord<Inbox> | null): Promise<InboxView> {
    const keys = await inboxKeys(body.gen);
    await encodeInbox(keys.sign, { ...body, key: keys.publicKey, sign: keys.signPublic }, provider);
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

  const sentRecords = () =>
    part.ownContactRecords<Knock>(
      knockSchema.name,
      (record) => typeof record.body?.space === 'string' && typeof record.body.invite === 'string',
    );

  /**
   * Knocks of yours: one someone joined becomes a contact, and its invite is
   * closed; one nobody joined within the knock's life is let go, space and all.
   */
  async function settleSent(): Promise<void> {
    for (const record of await sentRecords()) {
      const { space, name, invite } = record.body!;
      if (!(await registry.get(space))) {
        await (await contactsRuntime()).remove(record.key);
        continue;
      }
      const open = await ctx.runtime(space);
      // Only the holder of the inbox key could open the invite: whoever joined first is them.
      const joiner = (await open.access()).members.find((member) => member.did !== config.signer.did)?.did;
      if (joiner) {
        // Whoever else the invite reached, nobody more joins with it.
        await spaces.closeInvite(space, invite).catch(() => {});
        const given = (await open.profiles()).find((profile) => profile.did === joiner)?.name;
        await writeContact({ did: joiner, name: given ?? name, space });
        await (await contactsRuntime()).remove(record.key);
      } else if (Date.now() - Date.parse(record.createdAt) > KNOCK_TTL_SECONDS * 1000 + DAY_MS) {
        await spaces.leave(space).catch(() => {});
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
      if (!ctx.contactsSpaceId) await contactsRuntime();
      const current = await inboxRecord();
      const places = [...(options.places ?? current?.body?.places ?? usableRelays(config.network))].slice(
        0,
        MAX_INBOX_PLACES,
      );
      if (places.length === 0)
        throw new Error('An inbox needs a mailbox to hold its knocks, and this node has none.');
      const name = clip((options.name ?? current?.body?.name ?? (await needs.ownName()) ?? '').trim(), 64);
      return writeInbox({ gen: current?.body?.gen ?? 0, places, ...(name ? { name } : {}) }, current);
    },

    async rotate() {
      requireContactKey('Replacing your inbox');
      const current = await inboxRecord();
      if (!current) return inbox.open();
      // What waits in the old one goes with it.
      await purgeInbox(current.body!, null).catch(() => 0);
      forgetKnocks();
      return writeInbox({ ...current.body!, gen: current.body!.gen + 1 }, current);
    },

    async clear() {
      requireContactKey('Clearing your inbox');
      const current = await inboxRecord();
      if (!current) throw new Error('Your inbox is not open');
      if ((await purgeInbox(current.body!, null)) === 0)
        throw new Error("None of your inbox's mailboxes could be reached and cleared.");
      forgetKnocks();
    },

    async knock(code, options = {}) {
      requireContactKey('Knocking');
      requireEverywhere('Knocking');
      const theirs = await readInboxCode(code, provider);
      if ((await inbox.get())?.key === theirs.key) throw new Error('That is your own inbox');
      if (!ctx.contactsSpaceId) await contactsRuntime();
      const mine = (await needs.ownName()) ?? 'Someone';
      const name = theirs.name ?? 'Contact';
      const made = await part.makePair(theirs.key, { mine, theirs: name }, options.note);
      const topic = await inboxTopic(theirs.sign);
      const left = await Promise.allSettled(
        theirs.places.map((place) => mailbox.drop(place, topic, made.sealed, KNOCK_TTL_SECONDS)),
      );
      if (!left.some((result) => result.status === 'fulfilled')) {
        await spaces.leave(made.space).catch(() => {});
        const reasons = left
          .map((result) => (result.status === 'rejected' ? errorText(result.reason) : ''))
          .filter(Boolean);
        throw new Error(`None of their inbox's mailboxes took the knock. ${reasons.join('; ')}`);
      }
      const open = await contactsRuntime();
      await ensureDefined(open, knockSchema);
      await open.put<Knock>(knockSchema.name, { space: made.space, name, invite: made.invite });
      return { space: made.space, carried: made.carried };
    },

    async knocks() {
      requireContactKey('Reading knocks');
      await settleSent().catch(() => {});
      const blocked = await part.blockedDids();
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
        Object.freeze({ space: record.body!.space, name: record.body!.name, at: record.createdAt }),
      );
    },

    async accept(id) {
      requireContactKey('Accepting a knock');
      requireEverywhere('Accepting a knock');
      if (!knockCache.get(id)?.opened) await readKnocks();
      const knocked = knockCache.get(id)?.opened;
      if (!knocked) throw new Error('That knock is gone: it expired, or your inbox was cleared or replaced.');
      await spaces.join(knocked.invite);
      const known = await part.contacts.get(knocked.from);
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

  return inbox;
}
