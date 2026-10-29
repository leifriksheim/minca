import { useEffect, useState } from 'react';
import { createP256Provider } from '@minca/core';
import { formatUsername, parseUsername, resolveUsername, type ResolvedUsername } from '@minca/core/inbox';

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

/**
 * Names to offer someone called `name`, best first: their first name, the
 * whole of it, then the first name with a number.
 */
export function usernameIdeas(name: string): string[] {
  const words = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const first = words[0]?.slice(0, 30);
  if (!first) return [];
  // The same number for the same name, so the ideas don't change between renders.
  const number = 10 + ([...name].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 90);
  return [...new Set([first, words.join('.').slice(0, 64), `${first}${number}`])];
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
        const taken = await resolveUsername(username, provider).then(
          () => true,
          () => false,
        );
        if (!current) return;
        if (!taken) return setFree(idea);
      }
    })();
    return () => {
      current = false;
    };
  }, [key]);
  return free;
}
