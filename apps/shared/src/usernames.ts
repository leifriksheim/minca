import { useEffect, useState } from 'react';
import { createP256Provider } from '@minca/core';
import {
  formatUsername,
  parseUsername,
  resolveUsername,
  usernameFree,
  type ResolvedUsername,
} from '@minca/core/inbox';

/** Where this build's people claim their usernames: `leif@minca.social` */
export const NAMES_DOMAIN = import.meta.env.VITE_NAMES_DOMAIN || 'minca.social';

const provider = createP256Provider();

/** A username from what someone typed: `anna` is anna at this build's domain, `@anna@x.org` is as written */
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

/** The first of `ideas` nobody has yet, once looked up; null while looking, or when all are taken */
export function useFreeUsername(ideas: ReadonlyArray<string>): string | null {
  const [free, setFree] = useState<string | null>(null);
  const key = ideas.join(',');
  useEffect(() => {
    let current = true;
    void (async () => {
      for (const idea of key.split(',')) {
        const username = usernameFrom(idea);
        if (!username) continue;
        // Only a name the service says nobody has: not one it couldn't answer for.
        const free = await usernameFree(username);
        if (!current) return;
        if (free) return setFree(idea);
      }
    })();
    return () => {
      current = false;
    };
  }, [key]);
  return free;
}

/** Where a username being picked stands, as it is typed */
export type Availability =
  | { readonly status: 'empty' | 'invalid' }
  | { readonly status: 'checking' | 'free' | 'taken' | 'unknown'; readonly username: string };

/**
 * Whether the username `text` names is free, a moment after typing stops:
 * `anna` at this build's domain, `anna@example.org` at that one. `unknown`
 * when its domain couldn't say, down or giving out no Minca usernames.
 */
export function useAvailability(text: string, delayMs = 300): Availability {
  const username = usernameFrom(text);
  const [found, setFound] = useState<{ username: string; free: boolean | null } | null>(null);
  useEffect(() => {
    if (!username) return;
    let current = true;
    const timer = setTimeout(() => {
      void usernameFree(username).then((free) => current && setFound({ username, free }));
    }, delayMs);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [username, delayMs]);
  if (!text.trim()) return { status: 'empty' };
  if (!username) return { status: 'invalid' };
  if (found?.username !== username) return { status: 'checking', username };
  return { status: found.free === null ? 'unknown' : found.free ? 'free' : 'taken', username };
}

/** How to give out Minca usernames at a domain of your own */
export const OWN_DOMAIN_HELP =
  'https://github.com/leifriksheim/minca/blob/main/packages/core/docs/usernames.md#running-one-for-your-domain';
