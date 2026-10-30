import { useState } from 'react';
import type { InboxView } from '@minca/core';
import { useNode } from '@minca/react';
import { Shape } from '@minca/app-shared/shapes';
import { message, useCopy } from '@minca/app-shared/action';
import { shapeColours } from '@minca/ui/tokens';
import { palette, styles } from '../styles';
import { usernameIdeas } from '@minca/core/inbox';
import { shortUsername, useFreeUsername } from '@minca/app-shared/usernames';
import { UsernamePicker } from '@minca/app-shared/UsernamePicker';
import { AddButton, LinkButton, QuietButton } from './Buttons';
import { confirmThen } from '../confirm';
import { usernameLink } from '../contacts';

const { ink, surface, radius } = palette;

/** Shares a username the way a phone shares anything; elsewhere its link is copied */
export async function shareUsername(username: string, copy: (text: string) => void): Promise<void> {
  const url = usernameLink(username);
  if (globalThis.navigator.share)
    await globalThis.navigator.share({ title: 'Add me on Minca', text: username, url }).catch(() => {});
  else copy(url);
}

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
            name={inbox?.name}
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
  // At this app's domain, the name alone is what people type to find you.
  const shown = shortUsername(username);
  return (
    <>
      <h2 style={big}>{shown}</h2>
      <p style={hint}>
        Anyone with it can ask to be your contact, and you choose who gets in.
        {until ? ` Renewed for you, so it stays yours.` : ''}
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 10 }}>
        <AddButton onClick={() => name.copy(shown)} style={{ height: 36 }}>
          {name.copied ? 'Copied' : 'Copy username'}
        </AddButton>
        <QuietButton
          onClick={() => void shareUsername(username, link.copy)}
          style={{ height: 36, background: surface.card }}
        >
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

/** Picking a name, with a free one already offered from yours */
function Pick({
  current,
  name,
  onCancel,
  onClaimed,
}: {
  current: string | null;
  name: string | undefined;
  onCancel?: () => void;
  onClaimed: () => void;
}) {
  const suggestion = useFreeUsername(current ? [] : usernameIdeas(name ?? ''));
  return (
    <>
      <h2 style={{ ...big, fontSize: 'clamp(22px, 6vw, 26px)', maxWidth: 'calc(100% - 90px)' }}>
        {current ? 'Pick a new name' : 'Pick a name people can find you by'}
      </h2>
      <UsernamePicker current={current} suggestion={suggestion} onClaimed={onClaimed}>
        {onCancel && (
          <LinkButton type="button" onClick={onCancel}>
            Cancel
          </LinkButton>
        )}
      </UsernamePicker>
    </>
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

/** The name as a heading: a piece breaks inside only when it is wider than the card */
const big = { fontSize: 'clamp(24px, 7vw, 32px)', lineHeight: 1.1, overflowWrap: 'anywhere' } as const;

const hint = { fontSize: 13, lineHeight: 1.5, color: ink.muted, maxWidth: 460 } as const;
