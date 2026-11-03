import { useState, type ReactNode } from 'react';
import { PersonFace } from './PersonFace';
import type { SpaceInviteView } from '@minca/core';
import { useNode } from '@minca/react';
import { Avatar } from '@minca/app-shared/Avatar';
import { Modal } from '@minca/app-shared/Modal';
import { message } from '@minca/app-shared/action';
import { Shape } from '@minca/app-shared/shapes';
import { shapeFor } from '@minca/ui/shapes';
import { ago } from '@minca/ui/time';
import { NOT_CARRIED, useSpaceInvites, withChat } from '../contacts';
import { shortUsername } from '@minca/app-shared/usernames';
import { Icon } from './Icon';
import { usePopover } from './usePopover';
import styles from './PeopleParts.module.css';

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
  online,
  onOpen,
}: {
  /** Their account, for their avatar; or a username, for someone not met yet */
  face: string;
  name: ReactNode;
  detail?: ReactNode;
  children?: ReactNode;
  /** Online now: a dot on their face, as Members shows it */
  online?: boolean;
  /** A tap anywhere on their face or name: opens your chat with them, or ticks them in a picker */
  onOpen?: () => void;
}) {
  const who = (
    <>
      <span className={styles.face}>
        <PersonFace did={face} size={40} round />
        {online && <span title="Online now" className={styles.online} />}
      </span>
      <span className="stack truncate" data-gap="tight">
        <strong className="truncate">{name}</strong>
        {detail && <small className="truncate">{detail}</small>}
      </span>
    </>
  );
  return (
    // In a list, the list draws the lines between rows.
    <li className="row">
      {onOpen ? (
        <button data-intent="open" onClick={onOpen} className="row truncate">
          {who}
        </button>
      ) : (
        who
      )}
      {children && <div className="row">{children}</div>}
    </li>
  );
}

/** A username as it reads in a list: just the name when it is at this app's domain */
export function Handle({ username }: { username: string }) {
  return <span title={username}>@{shortUsername(username)}</span>;
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
    <div ref={root} className={styles.anchor}>
      <button
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
        data-intent="quiet"
        data-icon
      >
        <Icon name="menu" size={14} />
      </button>
      {open && (
        <menu role="menu">
          {items.map((item) => (
            <li key={item.label}>
              <button
                role="menuitem"
                data-intent={item.danger ? 'danger' : undefined}
                onClick={() => {
                  close();
                  item.onClick();
                }}
              >
                {item.label}
              </button>
            </li>
          ))}
        </menu>
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
      const made = await withChat(node, node.inbox.knock(username, note.trim() ? { note: note.trim() } : {}));
      onSent(made.carried ? `Sent. ${who} shows up in your contacts once they accept.` : NOT_CARRIED);
    } catch (reason) {
      setError(message(reason));
      setSending(false);
    }
  };
  return (
    <Modal title={`Add ${who}`} onClose={onClose}>
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <div className="row">
          <Avatar did={username} size={48} round />
          <span className="stack" data-gap="tight">
            <strong>{who}</strong>
            <small>@{shortUsername(username)}</small>
          </span>
        </div>
        <label>
          <span>
            Say who you are <small>(optional)</small>
          </span>
          <textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            maxLength={500}
            rows={3}
            placeholder="Hi! We met at…"
            autoFocus
          />
        </label>
        <small>
          {who} sees your name and note, and chooses whether to accept. If they do, you get a private space
          for the two of you.
        </small>
        {error && <p role="alert">{error}</p>}
        <button data-intent="primary" type="submit" disabled={sending}>
          {sending ? 'Sending…' : 'Send request'}
        </button>
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
  const invites = useSpaceInvites(tick);
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
    <section aria-label="Invites to spaces" data-gap="tight">
      <h2>Invited to</h2>
      <ul role="list">
        {invites.map((invite) => (
          <li key={`${invite.pairSpace}/${invite.space}`} className="row">
            <Shape kind={shapeFor(invite.space).kind} colour={shapeFor(invite.space).colour} size={40} />
            <span className="stack truncate" data-gap="tight">
              <strong className="truncate">{invite.name}</strong>
              <small className="truncate">
                {names.get(invite.from) ?? 'A contact'} invited you · {ago(invite.createdAt)}
              </small>
            </span>
            <button data-intent="primary" onClick={() => void join(invite)} disabled={joining !== null}>
              {joining === invite.space ? 'Joining…' : 'Join'}
            </button>
          </li>
        ))}
      </ul>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

/** A quiet line that says what just happened, and goes when dismissed */
export function Notice({ text, onDismiss }: { text: string; onDismiss: () => void }) {
  return (
    <aside role="status" data-tone="good" className="row" data-spread>
      <span>{text}</span>
      <button data-intent="quiet" onClick={onDismiss}>
        OK
      </button>
    </aside>
  );
}
