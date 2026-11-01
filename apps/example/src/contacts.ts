/** Contacts (`node.contacts`) and the inbox (`node.inbox`), for the screens that show them. */
import { useEffect } from 'react';
import {
  ROLE_ASSIGN,
  type ContactRequest,
  type ContactView,
  type KnockView,
  type NodeEvent,
  type P2PNode,
  type SentKnockView,
  type SpaceInviteView,
  type SpaceSummary,
} from '@minca/core';
import { useAsync, useLive, useNode, useWatched } from '@minca/react';
import { addChat } from './components/apps/entries';

/** What a new space for two means when no carrier holds it yet (`spaces.carried`) */
export const NOT_CARRIED =
  'Sent. Nothing of yours keeps your space for two online yet, so they can join only while this device is.';

/**
 * A request to become someone's contact, with Chat already in the space for
 * two it makes: they open it into a conversation, and you can write first.
 */
export async function withChat<Made extends { readonly space: string }>(
  node: P2PNode,
  asking: Promise<Made>,
): Promise<Made> {
  const made = await asking;
  await addChat(node, made.space).catch(() => {});
  return made;
}

/** A link that knocks on an inbox: this app's people, with the code after `#inbox=` */
export function inboxLink(code: string): string {
  return `${globalThis.location.origin}/people#inbox=${code}`;
}

/** A link that opens this app's people with the username looked up, ready to add */
export const usernameLink = (username: string) =>
  `${globalThis.location.origin}/people#user=${encodeURIComponent(username)}`;

/** The username in this page's URL, if someone opened a link to add them (`#user=`) */
export function readUserFromUrl(): string | null {
  const found = /[#&]user=([^&]+)/.exec(globalThis.location.hash)?.[1];
  return found ? decodeURIComponent(found) : null;
}

/**
 * The roles this account may invite someone into a space as, `member` first;
 * empty when it may only share the space to view.
 */
export async function invitableRoles(node: P2PNode, spaceId: string): Promise<ReadonlyArray<string>> {
  const access = await node.spaces.access(spaceId);
  const roles: string[] = [];
  for (const { name } of access.roles)
    if (await node.spaces.may(spaceId, ROLE_ASSIGN, { role: name, self: false, roles: [] })) roles.push(name);
  return roles.sort((a, b) => Number(b === 'member') - Number(a === 'member'));
}

/** The inbox code in this page's URL, if someone opened an inbox link */
export function readInboxFromUrl(): string | null {
  return /[#&]inbox=([A-Za-z0-9_-]+)/.exec(globalThis.location.hash)?.[1] ?? null;
}

/** Drops the inbox code or username from the address bar once it has been dealt with */
export function clearInboxFromUrl(): void {
  globalThis.history.replaceState(null, '', globalThis.location.pathname + globalThis.location.search);
}

/**
 * The contact list, kept current: loaded again whenever the contacts space
 * changes, here or on another device. Undefined until the first load; empty
 * for an app not given the contacts.
 */
export function useContacts(): ReadonlyArray<ContactView> | undefined {
  const node = useNode();
  const space = useAsync(() => node.contacts.space(), [node]);
  const spaceId = space.status === 'done' ? space.value : undefined;
  return useWatched((node) => node.contacts.list().catch(() => []), [spaceId], {
    when: (event) => event.type === 'records' && event.space === spaceId,
  });
}

/** Who a space for two is with: a contact, or someone you asked who hasn't answered yet */
export interface PairWith {
  readonly name: string;
  /** Their account, or for someone not met yet, the username you asked them by */
  readonly face: string;
}

/**
 * Your spaces for two, by space, and who each is with: they are People, not
 * Groups. Kept current as the contact list changes, here or on another device.
 */
export function usePairSpaces(): ReadonlyMap<string, PairWith> {
  const node = useNode();
  const space = useAsync(() => node.contacts.space(), [node]);
  const spaceId = space.status === 'done' ? space.value : undefined;
  const found = useWatched(
    async (node) => {
      const [contacts, sent] = await Promise.all([
        node.contacts.list().catch(() => []),
        node.inbox.sent().catch(() => []),
      ]);
      const pairs = new Map<string, PairWith>();
      for (const knock of sent)
        pairs.set(knock.space, { name: knock.name, face: knock.username ?? knock.space });
      for (const contact of contacts)
        if (contact.space) pairs.set(contact.space, { name: contact.name, face: contact.did });
      return pairs;
    },
    [spaceId],
    { when: (event) => event.type === 'records' && event.space === spaceId },
  );
  return found ?? NO_PAIRS;
}

const NO_PAIRS: ReadonlyMap<string, PairWith> = new Map();

/** Where a contact stands with your space for two (`gone`: you left it); undefined while loading */
export type Standing = 'joined' | 'waiting' | 'gone' | 'none';

export function useStanding(contact: ContactView | undefined): Standing | undefined {
  return useLive(
    contact?.space ?? '',
    async (node): Promise<Standing | undefined> => {
      if (!contact) return undefined;
      if (!contact.space) return 'none';
      if (!(await node.spaces.list()).some((space) => space.id === contact.space)) return 'gone';
      const { members } = await node.spaces.access(contact.space);
      return members.some((member) => member.did === contact.did) ? 'joined' : 'waiting';
    },
    [contact?.did, contact?.space],
  );
}

/**
 * Takes back a request to become someone's contact: deletes the knocks you
 * left for them in the given spaces, sealed to the contact key on their
 * profile there, so they can't accept into a space you are no longer in,
 * then removes them, which leaves the space for two.
 */
export async function takeBack(
  node: P2PNode,
  spaceIds: ReadonlyArray<string>,
  me: string,
  did: string,
): Promise<void> {
  for (const spaceId of spaceIds) {
    const theirs = (await node.spaces.profiles(spaceId).catch(() => [])).find(
      (p) => p.did === did,
    )?.contactKey;
    if (!theirs) continue;
    const asked = await node.records
      .list<{ to?: string }>(spaceId, { collection: 'std.contact-request' })
      .catch(() => []);
    for (const record of asked) {
      if (record.root === me && record.body?.to === theirs)
        await node.records.delete(spaceId, record.key).catch(() => {});
    }
  }
  await node.contacts.remove(did);
}

/** Keeps these spaces syncing while the screen shows, so what contacts leave there arrives */
export function useHeldSpaces(ids: ReadonlyArray<string>): void {
  const node = useNode();
  const key = [...ids].sort().join(',');
  useEffect(() => {
    if (!key) return;
    const held = key.split(',').map((id) => node.spaces.hold(id).catch(() => null));
    return () => {
      for (const hold of held) void hold.then((release) => release?.());
    };
  }, [node, key]);
}

/** How often to look in the inbox's mailboxes: knocks wait on relays, which tell nobody */
const KNOCK_POLL_MS = 30_000;

async function readMailbox(node: P2PNode) {
  const [inbox, knocks, sent] = await Promise.all([
    node.inbox.get().catch(() => null),
    node.inbox.knocks().catch((): KnockView[] => []),
    node.inbox.sent().catch((): SentKnockView[] => []),
  ]);
  return { inbox, knocks, sent };
}

/**
 * Who wants to be your contact, kept current: requests left in the spaces you share, knocks on your
 * inbox, and your own knocks still waiting. Reading knocks also turns knocks of yours someone joined
 * into contacts. `tick` loads it all again.
 */
export function useAsking(spaces: ReadonlyArray<SpaceSummary>, tick = 0) {
  // Requests are records in the spaces you share, so a change in any of them may bring one.
  const shared = spaces.filter((space) => !space.joining).map((space) => space.id);
  const key = shared.join(',');
  const watch = {
    when: (event: NodeEvent) =>
      (event.type === 'records' && shared.includes(event.space)) || event.type === 'spaces',
    settle: 400,
  };
  const requests =
    useWatched(
      async (node) =>
        (
          await Promise.all(shared.map((id) => node.contacts.requests(id).catch((): ContactRequest[] => [])))
        ).flat(),
      [key, tick],
      watch,
    ) ?? [];
  const mailbox = useWatched(readMailbox, [key, tick], { ...watch, every: KNOCK_POLL_MS });
  return {
    requests,
    inbox: mailbox?.inbox ?? null,
    knocks: mailbox?.knocks ?? [],
    sent: mailbox?.sent ?? [],
  };
}

/** Invites to groups your contacts left for you in your spaces for two, kept current; `tick` loads them again */
export function useSpaceInvites(tick = 0): ReadonlyArray<SpaceInviteView> {
  return (
    useWatched((node) => node.contacts.invites().catch((): SpaceInviteView[] => []), [tick], {
      when: (event) => event.type === 'records' || event.type === 'spaces',
      settle: 400,
      every: 30_000,
    }) ?? []
  );
}
