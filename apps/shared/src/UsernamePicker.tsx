import { useState, type FormEvent, type ReactNode } from 'react';
import { useNode } from '@minca/react';
import { message } from './action';
import {
  NAMES_DOMAIN,
  OWN_DOMAIN_HELP,
  shortUsername,
  useAvailability,
  type Availability,
} from './usernames';

/**
 * Picking a username: checked as it is typed, claimed with a few seconds of
 * work. The account home asks for one at sign-up, and an app's contacts screen
 * for one later; both are this.
 */
export function UsernamePicker({
  current = null,
  suggestion = null,
  onClaimed,
  children,
}: {
  /** The username the account has now, if any */
  current?: string | null;
  /** A free name to start with, until something is typed */
  suggestion?: string | null;
  onClaimed: (username: string) => void;
  /** The lesser actions beside Claim: Cancel, Skip */
  children?: ReactNode;
}) {
  const node = useNode();
  // Null until something is typed: the name it has, or the free one offered.
  const [typed, setTyped] = useState<string | null>(null);
  const text = typed ?? (current ? shortUsername(current) : (suggestion ?? ''));
  const [claiming, setClaiming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A bare name is at this build's domain; one with its own domain is checked there.
  const typedName = text.trim().toLowerCase();
  const availability = useAvailability(typedName);
  const wanted = availability.status === 'free' ? availability.username : null;

  const claim = async (event: FormEvent) => {
    event.preventDefault();
    if (!wanted || claiming) return;
    setClaiming(true);
    setError(null);
    try {
      await node.inbox.claim(wanted);
      onClaimed(wanted);
    } catch (reason) {
      // The service's own words, without who refused what: the screen says that already.
      setError(message(reason).replace(/^.* refused \S+: /, ''));
    } finally {
      setClaiming(false);
    }
  };

  const status = usernameStatus(availability, typedName, current);

  return (
    <form onSubmit={(event) => void claim(event)} className="stack">
      <div className="row">
        <input
          value={text}
          onChange={(event) => setTyped(event.target.value)}
          placeholder="yourname"
          aria-label="Username"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={320}
          disabled={claiming}
          autoFocus
        />
        <button type="submit" data-intent="primary" disabled={!wanted || claiming}>
          {claiming ? 'Claiming…' : 'Claim it'}
        </button>
        {children}
      </div>
      <small aria-live="polite" data-tone={claiming ? undefined : status.tone}>
        {claiming ? 'Doing a few seconds of work, so bots can’t grab every name…' : status.text}
      </small>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}

/** What the line under a username field says about `typed`, and in what tone */
export function usernameStatus(
  availability: Availability,
  typed: string,
  current: string | null = null,
): { text: ReactNode; tone?: 'good' | 'danger' } {
  const own = typed.includes('@');
  const domain = own ? typed.slice(typed.indexOf('@') + 1) : NAMES_DOMAIN;
  const mine = availability.status === 'taken' && availability.username === current;
  return availability.status === 'invalid'
    ? {
        text: typed.endsWith('@')
          ? 'Your domain, like you@yourname.com'
          : 'Letters, numbers, dots, dashes and underscores; start and end with a letter or number',
      }
    : availability.status === 'checking'
      ? { text: 'Checking…' }
      : availability.status === 'free'
        ? { text: `${shortUsername(availability.username)} is free`, tone: 'good' }
        : availability.status === 'taken'
          ? {
              text: mine ? 'That one is already yours' : 'Someone has that one. Try another?',
              ...(mine ? {} : { tone: 'danger' as const }),
            }
          : availability.status === 'unknown'
            ? own
              ? {
                  text: (
                    <>
                      {domain} doesn’t give out Minca usernames yet.{' '}
                      <a href={OWN_DOMAIN_HELP} target="_blank" rel="noopener noreferrer">
                        Set it up
                      </a>
                    </>
                  ),
                }
              : { text: `Couldn’t reach ${NAMES_DOMAIN} just now. Try again in a moment.` }
            : { text: 'Like a phone number, but one you choose.' };
}
