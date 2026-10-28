import { useCallback, useEffect, useState } from 'react';
import type { InvitePreview } from '@minca/core';
import { useNode } from './context.js';

/**
 * Invite links carry the invite in the URL fragment (`#invite=…`), which
 * browsers never send to a server, including the one hosting the page. For a
 * private space the invite holds the space key, so it must never go anywhere
 * else.
 */
const IN_LINK = /[#&]invite=([^&]+)/;

/**
 * A link that opens this page with an invite in it.
 *
 * ```ts
 * inviteLink(await node.spaces.invite(space.id, { short: true }))   // https://app.example/#invite=…
 * ```
 */
export function inviteLink(invite: string, page?: string): string {
  const { origin, pathname } = globalThis.location;
  return `${page ?? origin + pathname}#invite=${invite}`;
}

/** The invite in a link someone pasted, or the text itself when it is a bare invite */
export function inviteFromLink(value: string): string {
  const trimmed = value.trim();
  return IN_LINK.exec(trimmed)?.[1] ?? trimmed;
}

/**
 * The invite this page was opened with, if any, and what it is for: the
 * space's name, the role it gives, who sent it. `dismiss` takes it out of the
 * address bar, once joined or declined, so a reload doesn't offer it again.
 * `problem` says why an invite could not be read.
 */
export function useInviteLink(): {
  invite: string | null;
  preview: InvitePreview | null;
  problem: string | null;
  dismiss: () => void;
} {
  const node = useNode();
  const [invite, setInvite] = useState(() => IN_LINK.exec(globalThis.location?.hash ?? '')?.[1] ?? null);
  // A short link is fetched from its mailboxes, so what it is for arrives a moment later.
  // What arrives is kept with the invite it is for: a newer invite shows nothing until its own does.
  const [found, setFound] = useState<{
    readonly invite: string;
    readonly preview: InvitePreview | null;
    readonly problem: string | null;
  } | null>(null);
  useEffect(() => {
    if (!invite) return;
    let current = true;
    node.spaces.preview(invite).then(
      (preview) => current && setFound({ invite, preview, problem: null }),
      (error: unknown) =>
        current &&
        setFound({
          invite,
          preview: null,
          problem: error instanceof Error ? error.message : 'This invite could not be read',
        }),
    );
    return () => {
      current = false;
    };
  }, [node, invite]);
  const read =
    found && found.invite === invite
      ? { preview: found.preview, problem: found.problem }
      : { preview: null, problem: null };
  const dismiss = useCallback(() => {
    setInvite(null);
    const { pathname, search } = globalThis.location;
    globalThis.history.replaceState(null, '', pathname + search);
  }, []);
  return { invite, ...read, dismiss };
}
