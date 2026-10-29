import { useEffect, useState } from 'react';
import { createP256Provider } from '@minca/core';
import { formatUsername, parseUsername, resolveUsername, type ResolvedUsername } from '@minca/core/inbox';
import { useNode } from '@minca/react';

/** Where this app's people claim their usernames: `leif@minca.social` */
export const NAMES_DOMAIN = import.meta.env.VITE_NAMES_DOMAIN || 'minca.social';

const provider = createP256Provider();

/** A username from what someone typed: `anna` is anna at this app's domain, `@anna@x.org` is as written */
function usernameFrom(text: string): string | null {
  const typed = text.trim().replace(/^@/, '').toLowerCase();
  if (!typed) return null;
  const parsed = parseUsername(typed.includes('@') ? typed : `${typed}@${NAMES_DOMAIN}`);
  return parsed ? formatUsername(parsed) : null;
}

/** Just the name, when the username is at this app's domain; the whole of it otherwise */
export const shortUsername = (username: string): string =>
  username.endsWith(`@${NAMES_DOMAIN}`) ? username.slice(0, -NAMES_DOMAIN.length - 1) : username;

/** What looking a username up found, as it is typed */
export type Lookup =
  | { readonly status: 'empty' }
  | { readonly status: 'invalid' }
  | { readonly status: 'looking'; readonly username: string }
  | { readonly status: 'found'; readonly username: string; readonly found: ResolvedUsername }
  | { readonly status: 'nobody'; readonly username: string };

/** Looks up whoever `text` names, a moment after typing stops */
export function useUsernameLookup(text: string, delayMs = 300): Lookup {
  const username = usernameFrom(text);
  const [lookup, setLookup] = useState<Lookup>({ status: 'empty' });
  useEffect(() => {
    if (!text.trim()) return setLookup({ status: 'empty' });
    if (!username) return setLookup({ status: 'invalid' });
    setLookup({ status: 'looking', username });
    let current = true;
    const timer = setTimeout(() => {
      resolveUsername(username, provider).then(
        (found) => current && setLookup({ status: 'found', username, found }),
        () => current && setLookup({ status: 'nobody', username }),
      );
    }, delayMs);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [text, username, delayMs]);
  return lookup;
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
