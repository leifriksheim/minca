import { useState, type FormEvent, type ReactNode } from 'react';
import { useNode } from '@minca/react';
import { message } from './action';
import { palette, styles } from './styles';
import { NAMES_DOMAIN, shortUsername, useUsernameLookup } from './usernames';

const { ink, surface, accent } = palette;

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

  // Only a bare name here: usernames this build gives out are at its own domain.
  const bare = text.trim().toLowerCase();
  const lookup = useUsernameLookup(bare.includes('@') ? '' : bare);
  const wanted = lookup.status === 'nobody' ? lookup.username : null;
  const mine = lookup.status === 'found' && lookup.username === current;

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

  const status = bare.includes('@')
    ? { text: `Just the name: it will be yours at ${NAMES_DOMAIN}`, tone: ink.muted }
    : lookup.status === 'invalid'
      ? {
          text: 'Letters, numbers, dots, dashes and underscores; start and end with a letter or number',
          tone: ink.muted,
        }
      : lookup.status === 'looking'
        ? { text: 'Checking…', tone: ink.faint }
        : lookup.status === 'nobody'
          ? { text: `${lookup.username} is free`, tone: accent.good }
          : lookup.status === 'found'
            ? {
                text: mine ? 'That one is already yours' : 'Someone has that one. Try another?',
                tone: mine ? ink.muted : accent.danger,
              }
            : { text: 'Like a phone number, but one you choose.', tone: ink.muted };

  return (
    <form
      onSubmit={(event) => void claim(event)}
      style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
    >
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <label className="pill-field" style={field}>
          <span
            style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}
          >
            Username
          </span>
          <input
            value={text}
            onChange={(event) => setTyped(event.target.value)}
            placeholder="yourname"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={64}
            disabled={claiming}
            autoFocus
            style={fieldInput}
          />
          <span style={{ color: ink.muted, fontWeight: 500, paddingRight: 16, whiteSpace: 'nowrap' }}>
            @{NAMES_DOMAIN}
          </span>
        </label>
        <button
          type="submit"
          data-variant="primary"
          disabled={!wanted || claiming}
          style={{ ...styles.addButton, height: 44, padding: '0 20px' }}
        >
          {claiming ? 'Claiming…' : 'Claim it'}
        </button>
        {children}
      </div>
      <p aria-live="polite" style={{ ...hint, color: claiming ? ink.muted : status.tone }}>
        {claiming ? 'Doing a few seconds of work, so bots can’t grab every name…' : status.text}
      </p>
      {error && <p style={styles.error}>{error}</p>}
    </form>
  );
}

const hint = { fontSize: 13, lineHeight: 1.5, minHeight: 20, maxWidth: 460, margin: 0 } as const;

/** One pill: the name typed, and the domain it will be at */
const field = {
  ...styles.input,
  position: 'relative',
  display: 'flex',
  alignItems: 'center',
  flex: '1 1 260px',
  maxWidth: 420,
  height: 44,
  padding: 0,
  background: surface.card,
} as const;

const fieldInput = {
  flex: 1,
  minWidth: 0,
  height: '100%',
  border: 'none',
  outline: 'none',
  background: 'transparent',
  padding: '0 2px 0 18px',
  fontSize: 16,
  fontWeight: 500,
  color: ink.strong,
  boxShadow: 'none',
} as const;
