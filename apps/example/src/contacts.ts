/** Contacts (`node.contacts`) and the inbox (`node.inbox`), for the screens that show them. */
import { useEffect, useState } from 'react';
import type { ContactView, P2PNode } from '@minca/core';
import { useLive, useNode } from '@minca/core/react';

/** What a new space for two means when no carrier holds it yet (`spaces.carried`) */
export const NOT_CARRIED =
  'Sent. Nothing of yours keeps your space for two online yet, so they can join only while this device is.';

/** A link that knocks on an inbox: this app's contacts, with the code after `#inbox=` */
export function inboxLink(code: string): string {
  return `${globalThis.location.origin}/contacts#inbox=${code}`;
}

/** The inbox code in this page's URL, if someone opened an inbox link */
export function readInboxFromUrl(): string | null {
  return /[#&]inbox=([A-Za-z0-9_-]+)/.exec(globalThis.location.hash)?.[1] ?? null;
}

/** Drops the inbox code from the address bar once it has been dealt with */
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
  const [contacts, setContacts] = useState<ReadonlyArray<ContactView>>();

  useEffect(() => {
    let stopped = false;
    let space: string | null = null;
    const load = () =>
      void node.contacts
        .list()
        .then((list) => !stopped && setContacts(list))
        .catch(() => !stopped && setContacts([]));
    void node.contacts.space().then((id) => {
      space = id;
      load();
    });
    const unsubscribe = node.subscribe((event) => {
      if (event.type === 'records' && event.space === space) load();
    });
    return () => {
      stopped = true;
      unsubscribe();
    };
  }, [node]);

  return contacts;
}

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
