import { useState, type FormEvent } from 'react';
import type { InboxView } from '@minca/core';
import { useNode } from '@minca/react';
import { Shape } from '@minca/app-shared/shapes';
import { message, useCopy } from '@minca/app-shared/action';
import { shapeColours } from '@minca/ui/tokens';
import { palette, styles } from '../styles';
import { NAMES_DOMAIN, shortUsername, useUsernameLookup } from '../usernames';
import { AddButton, LinkButton, QuietButton } from './Buttons';
import { confirmThen } from '../confirm';

const { ink, surface, accent, radius } = palette;

/** A link that opens this app's contacts with the username looked up, ready to add */
const usernameLink = (username: string) =>
  `${globalThis.location.origin}/contacts#user=${encodeURIComponent(username)}`;

/**
 * Your username: pick one, see at once whether it is free, and claim it; then
 * copy or share it. A colour tile, since it is the one thing on the page to
 * set up once and then hand out.
 */
export function UsernameCard({ inbox, onChange }: { inbox: InboxView | null; onChange: () => void }) {
  const username = inbox?.username ?? null;
  const [changing, setChanging] = useState(false);
  return (
    <section aria-label="Your username" style={tile}>
      <Shape kind="flower" colour="peach" size={190} style={art} />
      <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={eyebrow}>Your username</span>
        {username && !changing ? (
          <Claimed
            username={username}
            until={inbox?.usernameUntil}
            onChange={() => setChanging(true)}
            onGone={onChange}
          />
        ) : (
          <Pick
            current={username}
            onCancel={username ? () => setChanging(false) : undefined}
            onClaimed={() => {
              setChanging(false);
              onChange();
            }}
          />
        )}
      </div>
    </section>
  );
}

function Claimed({
  username,
  until,
  onChange,
  onGone,
}: {
  username: string;
  until: number | undefined;
  onChange: () => void;
  onGone: () => void;
}) {
  const node = useNode();
  const name = useCopy();
  const link = useCopy();
  const [error, setError] = useState<string | null>(null);
  const domain = username.slice(username.indexOf('@'));
  const share = async () => {
    const url = usernameLink(username);
    // A phone shares it the way it shares anything; elsewhere the link is copied.
    if (globalThis.navigator.share)
      await globalThis.navigator.share({ title: `Add me on Minca`, text: username, url }).catch(() => {});
    else link.copy(url);
  };
  return (
    <>
      <h2 style={big}>
        {/* Two pieces, so a narrow screen breaks the line before the @ and never inside a word. */}
        <span style={{ display: 'inline-block' }}>{username.slice(0, username.indexOf('@'))}</span>
        <span style={{ display: 'inline-block', color: ink.muted, fontWeight: 600 }}>{domain}</span>
      </h2>
      <p style={hint}>
        Anyone with it can ask to be your contact, and you choose who gets in.
        {until ? ` Renewed for you, so it stays yours.` : ''}
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 10 }}>
        <AddButton onClick={() => name.copy(username)} style={{ height: 36 }}>
          {name.copied ? 'Copied' : 'Copy username'}
        </AddButton>
        <QuietButton onClick={() => void share()} style={{ height: 36, background: surface.card }}>
          {link.copied ? 'Link copied' : 'Share a link'}
        </QuietButton>
        <LinkButton onClick={onChange}>Change</LinkButton>
        <LinkButton
          onClick={() =>
            confirmThen(
              `${username} stops leading to you, and anyone may take it. Your contacts stay.`,
              { title: 'Give up your username?', yes: 'Give it up' },
              async () => {
                setError(null);
                await node.inbox.release().then(onGone, (reason: unknown) => setError(message(reason)));
              },
            )
          }
          style={{ color: ink.muted }}
        >
          Give it up
        </LinkButton>
      </div>
      {error && <p style={{ ...styles.bad, marginTop: 6 }}>{error}</p>}
    </>
  );
}

/** Picking a name: checked as it is typed, claimed with a few seconds of work */
function Pick({
  current,
  onCancel,
  onClaimed,
}: {
  current: string | null;
  onCancel?: () => void;
  onClaimed: () => void;
}) {
  const node = useNode();
  const [text, setText] = useState(current ? shortUsername(current) : '');
  const [claiming, setClaiming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Only a bare name here: usernames this app gives out are at its own domain.
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
      onClaimed();
    } catch (reason) {
      setError(message(reason));
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
      <h2 style={{ ...big, fontSize: 'clamp(22px, 6vw, 26px)' }}>
        {current ? 'Pick a new name' : 'Pick a name people can find you by'}
      </h2>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <label className="pill-field" style={field}>
          <span
            style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}
          >
            Username
          </span>
          <input
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="yourname"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={64}
            disabled={claiming}
            style={fieldInput}
          />
          <span style={{ color: ink.muted, fontWeight: 500, paddingRight: 16, whiteSpace: 'nowrap' }}>
            @{NAMES_DOMAIN}
          </span>
        </label>
        <AddButton type="submit" disabled={!wanted || claiming} style={{ height: 44, padding: '0 20px' }}>
          {claiming ? 'Claiming…' : 'Claim it'}
        </AddButton>
        {onCancel && (
          <LinkButton type="button" onClick={onCancel} disabled={claiming}>
            Cancel
          </LinkButton>
        )}
      </div>
      <p aria-live="polite" style={{ ...hint, color: claiming ? ink.muted : status.tone, minHeight: 20 }}>
        {claiming ? 'Doing a few seconds of work, so bots can’t grab every name…' : status.text}
      </p>
      {error && <p style={styles.bad}>{error}</p>}
    </form>
  );
}

const tile = {
  position: 'relative',
  overflow: 'hidden',
  padding: '22px 24px 24px',
  borderRadius: radius.xl,
  border: `1px solid ${surface.rule}`,
  background: `color-mix(in srgb, ${shapeColours.peach} var(--minca-tint-panel), ${surface.page})`,
} as const;

/** The tile's shape: big, half off the top right corner, behind the words */
const art = { position: 'absolute', top: -70, right: -60, transform: 'rotate(12deg)', opacity: 0.9 } as const;

const eyebrow = {
  fontSize: 12,
  fontWeight: 600,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  color: ink.muted,
} as const;

const big = {
  fontSize: 32,
  lineHeight: 1.1,
  overflowWrap: 'anywhere',
  maxWidth: 'calc(100% - 90px)',
} as const;

const hint = { fontSize: 13, lineHeight: 1.5, color: ink.muted, maxWidth: 460 } as const;

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
