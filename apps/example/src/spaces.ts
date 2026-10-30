// Invite links carry the space, and a private one's key, in the URL fragment, which never reaches a server.
import type { P2PNode } from '@minca/core';
import { inviteLink } from '@minca/react';
import { readKept, writeKept } from './kept';

/**
 * A link that lets someone else open this space — joining with `role`, or with
 * none, only to read it. It opens the app's front page, not the space you are
 * in, which they don't have yet.
 */
export async function createInviteLink(node: P2PNode, spaceId: string, role: string | null): Promise<string> {
  const before = new Set((await node.spaces.access(spaceId)).invites.map((invite) => invite.key));
  const invite = await node.spaces.invite(
    spaceId,
    role ? { role, short: true } : { write: false, short: true },
  );
  const link = inviteLink(invite, `${globalThis.location.origin}/`);
  // The space keeps only the invite's key, never its link, so this device remembers the link to hand
  // it out again. Its key is the one invite that wasn't there before. A view-only link writes no
  // invite at all, so a new key then is someone else's, made meanwhile: it is never kept for this link.
  if (!role) return link;
  const [made, ...more] = (await node.spaces.access(spaceId)).invites.filter((one) => !before.has(one.key));
  if (made && more.length === 0) writeKept(linksOf(spaceId), { ...madeLinks(spaceId), [made.key]: link });
  return link;
}

const linksOf = (spaceId: string) => `minca:invite-links:${spaceId}`;

/** The invite links this device made in a space, by their invite's key */
export function madeLinks(spaceId: string): Readonly<Record<string, string>> {
  const kept = readKept(linksOf(spaceId));
  if (typeof kept !== 'object' || kept === null) return {};
  return Object.fromEntries(
    Object.entries(kept).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}
