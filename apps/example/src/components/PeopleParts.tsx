import { useState, type ReactNode } from 'react';
import type { SpaceInviteView } from '@minca/core';
import { useNode, useWatched } from '@minca/react';
import { Avatar } from '@minca/app-shared/Avatar';
import { Modal } from '@minca/app-shared/Modal';
import { message } from '@minca/app-shared/action';
import { Shape } from '@minca/app-shared/shapes';
import { shapeFor } from '@minca/ui/shapes';
import { ago } from '@minca/ui/time';
import { palette, styles } from '../styles';
import { NOT_CARRIED } from '../contacts';
import { shortUsername } from '../usernames';
import { AddButton, LinkButton } from './Buttons';
import { Icon } from './Icon';
import { usePopover } from './usePopover';

const { ink, surface, radius } = palette;

/**
 * One person in a list: their face, their name, a quieter line under it, and
 * what can be done on the right. The same row for contacts, people found by
 * username and people asking in, so they read as one list.
 */
export function PersonRow({
  face,
  name,
  detail,
  children,
  tone,
}: {
  /** Their account, for their avatar; or a username, for someone not met yet */
  face: string;
  name: ReactNode;
  detail?: ReactNode;
  children?: ReactNode;
  /** A card of its own, for someone asking or found, rather than a row in the list */
  tone?: 'card';
}) {
  return (
    <li
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: tone === 'card' ? '12px 14px' : '10px 4px',
        ...(tone === 'card'
          ? { border: `1px solid ${surface.rule}`, borderRadius: radius.lg, background: surface.card }
          : { borderBottom: `1px solid ${surface.line}` }),
        listStyle: 'none',
      }}
    >
      <Avatar did={face} size={40} round />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: ink.strong, ...ellipsis }}>{name}</div>
        {detail && <div style={{ fontSize: 13, color: ink.muted, marginTop: 1, ...ellipsis }}>{detail}</div>}
      </div>
      {children && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>{children}</div>
      )}
    </li>
  );
}

const ellipsis = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as const;

/** A username as it reads in a list: just the name when it is at this app's domain */
export function Handle({ username }: { username: string }) {
  return (
    <span title={username} style={{ fontFamily: 'inherit' }}>
      @{shortUsername(username)}
    </span>
  );
}

/** The lesser things to do with a row, behind one button */
export function RowMenu({
  label,
  items,
}: {
  label: string;
  items: ReadonlyArray<{ label: string; onClick: () => void; danger?: boolean }>;
}) {
  const { open, setOpen, close, root } = usePopover();
  return (
    <div ref={root} style={{ position: 'relative' }}>
      <button
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
        data-variant="quiet"
        style={{ ...styles.smallButton, width: 34, padding: 0, display: 'grid', placeItems: 'center' }}
      >
        <Icon name="menu" size={14} />
      </button>
      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute',
            right: 0,
            top: 40,
            zIndex: 20,
            width: 200,
            padding: 6,
            ...styles.float,
            animation: 'minca-fade .1s ease',
          }}
        >
          {items.map((item) => (
            <button
              key={item.label}
              role="menuitem"
              data-menu-item
              onClick={() => {
                close();
                item.onClick();
              }}
              style={{
                width: '100%',
                height: 36,
                padding: '0 10px',
                border: 'none',
                borderRadius: radius.md,
                background: 'none',
                textAlign: 'left',
                fontSize: 14,
                color: item.danger ? palette.accent.danger : ink.body,
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Asking someone found by their username to be your contact: a note if you
 * like, then a space for the two of you and a knock on their inbox.
 */
export function AddDialog({
  username,
  name,
  onClose,
  onSent,
}: {
  username: string;
  /** The name their inbox gives, which they chose themselves */
  name?: string;
  onClose: () => void;
  /** After the knock is left: `notice` says something worth knowing about it */
  onSent: (notice: string) => void;
}) {
  const node = useNode();
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const who = name ?? `@${shortUsername(username)}`;
  const send = async () => {
    setSending(true);
    setError(null);
    try {
      const made = await node.inbox.knock(username, note.trim() ? { note: note.trim() } : {});
      onSent(made.carried ? `Sent. ${who} shows up in your contacts once they accept.` : NOT_CARRIED);
    } catch (reason) {
      setError(message(reason));
      setSending(false);
    }
  };
  return (
    <Modal title={`Add ${who}`} onClose={onClose}>
      <form
        style={styles.form}
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
          <Avatar did={username} size={48} round />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 16, color: ink.strong }}>{who}</div>
            <div style={{ fontSize: 13, color: ink.muted }}>{username}</div>
          </div>
        </div>
        <label style={styles.fieldLabel} htmlFor="add-note">
          Say who you are <span style={{ color: ink.faint, fontWeight: 400 }}>(optional)</span>
        </label>
        <textarea
          id="add-note"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          maxLength={500}
          rows={3}
          placeholder="Hi! We met at…"
          style={styles.textarea}
          autoFocus
        />
        <p style={{ fontSize: 13, lineHeight: 1.5, color: ink.muted, marginTop: 8 }}>
          {who} sees your name and note, and chooses whether to accept. If they do, you get a private space
          for the two of you.
        </p>
        {error && <p style={styles.bad}>{error}</p>}
        <AddButton type="submit" disabled={sending} style={{ marginTop: 12, height: 40 }}>
          {sending ? 'Sending…' : 'Send request'}
        </AddButton>
      </form>
    </Modal>
  );
}

/**
 * Invites to spaces your contacts left for you, in your spaces for two with
 * them: a card each, joined with one press. Shown on the spaces page and with
 * your contacts.
 */
export function SpaceInvites({
  names,
  onJoined,
}: {
  /** What you call each contact, by account */
  names: ReadonlyMap<string, string>;
  onJoined: (spaceId: string) => void;
}) {
  const node = useNode();
  const [tick, setTick] = useState(0);
  const [joining, setJoining] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const invites =
    useWatched((node) => node.contacts.invites().catch((): SpaceInviteView[] => []), [tick], {
      when: (event) => event.type === 'records' || event.type === 'spaces',
      settle: 400,
      every: 30_000,
    }) ?? [];
  if (invites.length === 0) return null;
  const join = async (invite: SpaceInviteView) => {
    setJoining(invite.space);
    setError(null);
    try {
      const joined = await node.contacts.join(invite.pairSpace, invite.key);
      onJoined(joined.id);
    } catch (reason) {
      setError(message(reason));
    } finally {
      setJoining(null);
      setTick((n) => n + 1);
    }
  };
  return (
    <section aria-label="Invites to spaces" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <h2 style={styles.sectionTitle}>Invited to</h2>
      <ul style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 0 }}>
        {invites.map((invite) => (
          <li
            key={`${invite.pairSpace}/${invite.space}`}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '12px 14px',
              border: `1px solid ${surface.rule}`,
              borderRadius: radius.lg,
              background: surface.card,
              listStyle: 'none',
            }}
          >
            <Shape kind={shapeFor(invite.space).kind} colour={shapeFor(invite.space).colour} size={40} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 15, fontWeight: 600, color: ink.strong, ...ellipsis }}>
                {invite.name}
              </div>
              <div style={{ fontSize: 13, color: ink.muted, ...ellipsis }}>
                {names.get(invite.from) ?? 'A contact'} invited you · {ago(invite.createdAt)}
              </div>
            </div>
            <AddButton onClick={() => void join(invite)} disabled={joining !== null} style={{ height: 34 }}>
              {joining === invite.space ? 'Joining…' : 'Join'}
            </AddButton>
          </li>
        ))}
      </ul>
      {error && <p style={styles.bad}>{error}</p>}
    </section>
  );
}

/** A quiet line that says what just happened, and goes when dismissed */
export function Notice({ text, onDismiss }: { text: string; onDismiss: () => void }) {
  return (
    <div
      role="status"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '10px 14px',
        borderRadius: radius.lg,
        background: palette.accent.goodSoft,
        color: palette.accent.good,
        fontSize: 14,
      }}
    >
      <span style={{ flex: 1 }}>{text}</span>
      <LinkButton onClick={onDismiss} style={{ color: palette.accent.good }}>
        OK
      </LinkButton>
    </div>
  );
}
