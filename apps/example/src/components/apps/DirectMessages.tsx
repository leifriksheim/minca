import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { DirectMessage, SpaceSummary } from '@minca/core';
import { useLive, useNode } from '@minca/react';
import { useAction } from '@minca/app-shared/action';
import { Avatar } from '@minca/app-shared/Avatar';
import { Modal } from '@minca/app-shared/Modal';
import { ago } from '@minca/ui/time';
import { nameOf, type People } from '../../derive/people';
import { usePeopleHere } from '../Person';
import { PrimaryButton, QuietButton } from '../Buttons';
import { Icon } from '../Icon';
import { palette, stack, styles, ui } from '../../styles';

/**
 * Direct messages in a group (`std.direct`, `packages/core/docs/direct-messages.md`): text for one or
 * a few members, sealed so only they and whoever wrote it can read it. The app draws this itself rather
 * than in a screen, since a screen's code would be handed text sealed for its viewer alone.
 */
export function DirectMessages({
  space,
  shown,
  onShown,
}: {
  space: SpaceSummary;
  /** A message opened from elsewhere, to show in its conversation */
  shown?: string | undefined;
  onShown?: () => void;
}) {
  const here = usePeopleHere();
  const people = here?.people ?? NOBODY;
  const me = here?.me ?? '';
  // Sealed to member keys, which members publish only in a private space.
  const sealable = space.visibility === 'private';
  const reachable = useLive(space.id, async (n) => (sealable ? n.direct.reachable(space.id) : []), [
    sealable,
  ]);
  const messages = useLive(space.id, async (n) => (sealable ? n.direct.list(space.id) : []), [sealable]);
  const conversations = conversationsOf(messages ?? [], me);
  // Who the open conversation is with; null for the list itself.
  const [open, setOpen] = useState<ReadonlyArray<string> | null>(null);
  const [starting, setStarting] = useState(false);

  // A message opened from elsewhere opens its conversation, once it has arrived here, and is then
  // handed back so it isn't opened again.
  const [handled, setHandled] = useState<string>();
  if (shown && messages && shown !== handled) {
    setHandled(shown);
    const found = messages.find((m) => m.key === shown);
    if (found) setOpen(groupOf(found, me));
  }
  useEffect(() => {
    if (shown && shown === handled) onShown?.();
  }, [shown, handled, onShown]);

  if (!sealable)
    return (
      <p style={{ ...styles.emptyState, margin: 'auto', maxWidth: 360 }}>
        Direct messages are sealed to each member's key, and members share those only in a private group. This
        one is public.
      </p>
    );

  const current = open && (conversations.find((c) => same(c.with, open)) ?? { with: open, messages: [] });
  return (
    <div className="chat-shell" data-view={current ? 'room' : 'list'} style={{ flex: 1, minHeight: 0 }}>
      <nav className="chat-places" aria-label="Conversations">
        <div className="chat-places-heading" style={heading}>
          <span>Conversations</span>
          {space.writable && (reachable?.length ?? 0) > 0 && (
            <button
              onClick={() => setStarting(true)}
              aria-label="New message"
              title="New message"
              className="group-button"
              style={newButton}
            >
              <Icon name="plus" size={14} />
            </button>
          )}
        </div>
        {conversations.map((c) => {
          const last = c.messages.at(-1);
          return (
            <button
              key={c.with.join(',')}
              data-nav
              aria-current={current && same(current.with, c.with) ? 'page' : undefined}
              onClick={() => setOpen(c.with)}
              className="side-item"
              style={place}
            >
              <Faces dids={c.with} />
              <span style={{ ...stack(1), flex: 1, minWidth: 0 }}>
                <span style={{ ...ui.ellipsis, fontWeight: 600, color: palette.ink.strong }}>
                  {namesOf(c.with, people)}
                </span>
                {last && (
                  <span style={{ ...ui.ellipsis, fontSize: 12.5, color: palette.ink.muted }}>
                    {last.text ?? 'Sealed'} · {ago(last.createdAt)}
                  </span>
                )}
              </span>
            </button>
          );
        })}
        {conversations.length === 0 && (
          <p className="chat-places-note" style={note}>
            {(reachable?.length ?? 0) > 0
              ? 'Nothing yet. Start one with "+".'
              : 'Nobody else here can be written to yet: each member can once their app has been in the group.'}
          </p>
        )}
      </nav>

      <section
        className="chat-room"
        style={{ display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}
      >
        {current ? (
          <Room
            space={space}
            people={people}
            me={me}
            with={current.with}
            messages={current.messages}
            onBack={() => setOpen(null)}
          />
        ) : (
          <p style={{ ...styles.emptyState, margin: 'auto' }}>Pick a conversation, or start one.</p>
        )}
      </section>

      {starting && (
        <StartDialog
          reachable={reachable ?? []}
          people={people}
          onClose={() => setStarting(false)}
          onStart={(group) => {
            setStarting(false);
            setOpen(group);
          }}
        />
      )}
    </div>
  );
}

const NOBODY: People = new Map();

/** One conversation: everyone in it but you, and what was said, oldest first */
interface Conversation {
  readonly with: ReadonlyArray<string>;
  readonly messages: ReadonlyArray<DirectMessage>;
}

/** Everyone in a message but you, as one key: sorted, once each */
const groupOf = (m: DirectMessage, me: string): ReadonlyArray<string> =>
  [...new Set([m.from, ...m.to])].filter((did) => did !== me).sort();
const same = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) => a.join(',') === b.join(',');
const namesOf = (dids: ReadonlyArray<string>, people: People) =>
  dids.map((did) => nameOf(did, people)).join(', ');

/** Messages as conversations, the one written in most recently first */
function conversationsOf(messages: ReadonlyArray<DirectMessage>, me: string): ReadonlyArray<Conversation> {
  const byGroup = new Map<string, { with: ReadonlyArray<string>; messages: DirectMessage[] }>();
  for (const m of messages) {
    const group = groupOf(m, me);
    const found = byGroup.get(group.join(',')) ?? { with: group, messages: [] };
    found.messages.push(m);
    byGroup.set(group.join(','), found);
  }
  // Writers date their own messages: one from the future must not hold its conversation at the top.
  const now = new Date().toISOString();
  const last = (c: Conversation) => {
    const when = c.messages.at(-1)?.createdAt ?? '';
    return when > now ? now : when;
  };
  return [...byGroup.values()].sort((a, b) => last(b).localeCompare(last(a)));
}

/** The faces of whoever a conversation is with: one, or the first two overlapping */
function Faces({ dids }: { dids: ReadonlyArray<string> }) {
  const [first, second] = dids;
  if (!first) return null;
  if (!second) return <Avatar did={first} size={28} round />;
  return (
    <span style={{ position: 'relative', width: 28, height: 28, flexShrink: 0 }}>
      <span style={{ position: 'absolute', left: 0, top: 0 }}>
        <Avatar did={first} size={20} round />
      </span>
      <span style={{ position: 'absolute', right: 0, bottom: 0 }}>
        <Avatar did={second} size={20} round />
      </span>
    </span>
  );
}

/** A conversation open: what was said, and a field to say more */
function Room({
  space,
  people,
  me,
  with: others,
  messages,
  onBack,
}: {
  space: SpaceSummary;
  people: People;
  me: string;
  with: ReadonlyArray<string>;
  messages: ReadonlyArray<DirectMessage>;
  onBack: () => void;
}) {
  const node = useNode();
  const [draft, setDraft] = useState('');
  const { run, busy, error } = useAction();
  const scroller = useRef<HTMLDivElement>(null);
  const names = namesOf(others, people);

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, others]);

  const send = (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    void run(() => node.direct.send(space.id, others, text)).then((sent) => sent || setDraft(text));
  };

  return (
    <>
      <header className="chat-room-title" style={roomTitle}>
        {/* A phone shows the list or a conversation, not both: the way back to the list. */}
        <button
          onClick={onBack}
          aria-label="All conversations"
          className="phone-only group-button"
          style={backButton}
        >
          <span style={{ display: 'inline-flex', transform: 'rotate(180deg)' }}>
            <Icon name="chevron" size={14} />
          </span>
        </button>
        <Faces dids={others} />
        <span style={{ ...stack(1), minWidth: 0 }}>
          <strong style={{ ...ui.ellipsis, fontSize: 15, color: palette.ink.strong }}>{names}</strong>
          <span style={{ fontSize: 12.5, color: palette.ink.muted }}>
            <Icon name="lock" size={11} /> Sealed for the people in this conversation
          </span>
        </span>
      </header>

      <div
        ref={scroller}
        style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '12px 16px', ...stack(10) }}
      >
        {messages.length === 0 && (
          <p style={{ ...styles.quiet, margin: 'auto', maxWidth: 320, textAlign: 'center' }}>
            Sealed for {names} and you. Others in {space.name} see that you wrote, not what.
          </p>
        )}
        {messages.map((m) => (
          <div key={m.key} className="chat-line" tabIndex={0} style={line}>
            <Avatar did={m.from} size={28} round />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <strong style={{ fontSize: 14, color: palette.ink.strong }}>
                  {m.from === me ? 'You' : nameOf(m.from, people)}
                </strong>
                <span style={{ fontSize: 12, color: palette.ink.faint }}>
                  {ago(m.createdAt)}
                  {m.recordsOnly ? ' · via agent' : ''}
                </span>
              </div>
              <p
                style={{
                  margin: 0,
                  fontSize: 14.5,
                  lineHeight: 1.45,
                  whiteSpace: 'pre-wrap',
                  overflowWrap: 'anywhere',
                  color: m.text === null ? palette.ink.faint : palette.ink.body,
                  fontStyle: m.text === null ? 'italic' : undefined,
                }}
              >
                {m.text ?? "This device can't open this message."}
              </p>
            </div>
            {m.from === me && space.writable && (
              <QuietButton
                data-row-action
                onClick={() => void run(() => node.records.delete(space.id, m.key))}
                aria-label="Take back this message"
                style={{ height: 28, padding: '0 10px', fontSize: 12.5 }}
              >
                Delete
              </QuietButton>
            )}
          </div>
        ))}
      </div>

      {error && <p style={{ ...styles.error, padding: '0 16px' }}>{error}</p>}
      {space.writable && (
        <form onSubmit={send} style={composer}>
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={`Message ${names}`}
            aria-label="Write a direct message"
            maxLength={10000}
            style={{ ...styles.input, flex: 1, margin: 0 }}
          />
          <PrimaryButton
            type="submit"
            disabled={busy || !draft.trim()}
            style={{ width: 'auto', padding: '0 16px' }}
          >
            Send
          </PrimaryButton>
        </form>
      )}
    </>
  );
}

/** Choosing who a new conversation is with: anyone here who can be written to */
function StartDialog({
  reachable,
  people,
  onClose,
  onStart,
}: {
  reachable: ReadonlyArray<string>;
  people: People;
  onClose: () => void;
  onStart: (group: ReadonlyArray<string>) => void;
}) {
  const [picked, setPicked] = useState<ReadonlyArray<string>>([]);
  const [find, setFind] = useState('');
  const found = reachable
    .map((did) => ({ did, name: nameOf(did, people) }))
    .filter((p) => p.name.toLowerCase().includes(find.trim().toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name));
  const toggle = (did: string) =>
    setPicked((was) => (was.includes(did) ? was.filter((d) => d !== did) : [...was, did]));
  return (
    <Modal title="New message" onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (picked.length) onStart([...picked].sort());
        }}
        style={stack(12)}
      >
        {reachable.length > 6 && (
          <input
            value={find}
            onChange={(event) => setFind(event.target.value)}
            placeholder="Find someone"
            aria-label="Find someone"
            style={styles.input}
          />
        )}
        <div role="group" aria-label="People" style={{ ...stack(2), maxHeight: 320, overflowY: 'auto' }}>
          {found.map((p) => (
            <label key={p.did} data-nav className="side-item" style={{ cursor: 'pointer', height: 40 }}>
              <input
                type="checkbox"
                checked={picked.includes(p.did)}
                onChange={() => toggle(p.did)}
                // 16 at most, as std.direct allows
                disabled={!picked.includes(p.did) && picked.length >= 16}
                style={styles.checkbox}
              />
              <Avatar did={p.did} size={24} round />
              <span style={{ ...ui.ellipsis, color: palette.ink.strong }}>{p.name}</span>
            </label>
          ))}
          {found.length === 0 && <p style={styles.quiet}>Nobody by that name.</p>}
        </div>
        <p style={styles.quiet}>
          Sealed for the people you pick. Others in the group see that you wrote, not what.
        </p>
        <PrimaryButton type="submit" disabled={picked.length === 0}>
          Write to {picked.length === 0 ? '…' : namesOf(picked, people)}
        </PrimaryButton>
      </form>
    </Modal>
  );
}

const heading = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '10px 4px 6px 10px',
  fontSize: 12.5,
  fontWeight: 500,
  color: palette.ink.muted,
} as const;
const newButton = {
  display: 'grid',
  placeItems: 'center',
  width: 28,
  height: 28,
  padding: 0,
  border: 'none',
  borderRadius: palette.radius.md,
  background: 'none',
  color: palette.ink.body,
} as const;
const place = { width: '100%', height: 52, gap: 10, borderRadius: palette.radius.md } as const;
const note = { padding: '6px 10px', fontSize: 12.5, lineHeight: 1.45, color: palette.ink.muted } as const;
const roomTitle = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '10px 16px',
  borderBottom: `1px solid ${palette.surface.line}`,
} as const;
const backButton = {
  placeItems: 'center',
  width: 32,
  height: 32,
  padding: 0,
  border: 'none',
  borderRadius: palette.radius.md,
  background: 'none',
  color: palette.ink.strong,
} as const;
const line = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 10,
  padding: '4px 6px',
  borderRadius: palette.radius.md,
} as const;
const composer = {
  display: 'flex',
  gap: 8,
  padding: '10px 16px calc(10px + env(safe-area-inset-bottom))',
  borderTop: `1px solid ${palette.surface.line}`,
} as const;
