import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { DirectMessage, SpaceSummary } from '@minca/core';
import { useLive, useNode } from '@minca/react';
import { useAction } from '@minca/app-shared/action';
import { Avatar } from '@minca/app-shared/Avatar';
import { Modal } from '@minca/app-shared/Modal';
import { ago } from '@minca/ui/time';
import { nameOf, type People } from '../../derive/people';
import { usePeopleHere } from '../Person';
import { LinkButton, PrimaryButton, QuietButton } from '../Buttons';
import { cardText, cardTitle, rowButton, sectionHeading } from './AppsView';
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
  view,
  onGo,
}: {
  space: SpaceSummary;
  /** A message opened from elsewhere, to show in its conversation */
  shown?: string | undefined;
  onShown?: () => void;
  /** The conversation open, as the app's views name it: who it is with, sorted, joined by commas */
  view: string | null;
  /** Opening one, one level in: the app's bar names it, and its Back comes back out */
  onGo?: ((view: string | null, title: string | null) => void) | undefined;
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
  // Who the open conversation is with, from the address; null for the list itself.
  const open = view ? view.split(',') : null;
  const setOpen = (group: ReadonlyArray<string>) => onGo?.(group.join(','), namesOf(group, people));
  const [starting, setStarting] = useState(false);

  // A message opened from elsewhere opens its conversation, once it has arrived here, and is then
  // handed back so it isn't opened again.
  const handled = useRef<string>(undefined);
  useEffect(() => {
    if (!shown || !messages || handled.current === shown) return;
    handled.current = shown;
    const found = messages.find((m) => m.key === shown);
    if (found) setOpen(groupOf(found, me));
    onShown?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setOpen is new each draw; what it reads is listed
  }, [shown, messages, me, onShown]);

  if (!sealable)
    return (
      <p style={{ ...styles.emptyState, margin: 'auto', maxWidth: 360 }}>
        Direct messages are sealed to each member's key, and members share those only in a private group. This
        one is public.
      </p>
    );

  const current = open && (conversations.find((c) => same(c.with, open)) ?? { with: open, messages: [] });
  // One open is the whole screen, one level in; the app's bar names it and Back comes out to the list.
  if (current)
    return (
      <section style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0 }}>
        <Room space={space} people={people} me={me} with={current.with} messages={current.messages} />
      </section>
    );
  const mayStart = space.writable && (reachable?.length ?? 0) > 0;
  return (
    <div style={listPage}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <h2 style={sectionHeading}>Conversations</h2>
        {mayStart && (
          <LinkButton onClick={() => setStarting(true)} style={{ paddingRight: 0 }}>
            New message
          </LinkButton>
        )}
      </div>
      {conversations.length > 0 ? (
        <ol aria-label="Conversations" className="rows" style={ui.list}>
          {conversations.map((c) => {
            const last = c.messages.at(-1);
            return (
              <li key={c.with.join(',')} data-tile style={{ listStyle: 'none' }}>
                <button onClick={() => setOpen(c.with)} style={rowButton}>
                  <Faces dids={c.with} />
                  <span style={{ ...stack(2), flex: 1, minWidth: 0 }}>
                    <strong style={{ ...cardTitle, ...ui.ellipsis }}>{namesOf(c.with, people)}</strong>
                    {last && (
                      <span style={{ ...cardText, ...ui.ellipsis }}>
                        {last.text ?? 'Sealed'} · {ago(last.createdAt)}
                      </span>
                    )}
                  </span>
                  <span style={{ display: 'inline-flex', color: palette.ink.faint }}>
                    <Icon name="chevron" size={14} />
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      ) : (
        <p style={styles.emptyState}>
          {mayStart
            ? 'Nothing yet. Only the people you write to can read what you send.'
            : 'Nobody else here can be written to yet: each member can once their app has been in the group.'}
        </p>
      )}
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
  if (!second) return <Avatar did={first} size={36} round />;
  return (
    <span style={{ position: 'relative', width: 36, height: 36, flexShrink: 0 }}>
      <span style={{ position: 'absolute', left: 0, top: 0 }}>
        <Avatar did={first} size={26} round />
      </span>
      <span style={{ position: 'absolute', right: 0, bottom: 0 }}>
        <Avatar did={second} size={26} round />
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
}: {
  space: SpaceSummary;
  people: People;
  me: string;
  with: ReadonlyArray<string>;
  messages: ReadonlyArray<DirectMessage>;
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
      <header style={roomTitle}>
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

/** The list, as the space's own lists are: centred, with room around it */
const listPage = {
  ...stack(12),
  width: '100%',
  maxWidth: 640,
  margin: '0 auto',
  padding: '20px 16px 48px',
  overflowY: 'auto',
} as const;
const roomTitle = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '10px 16px',
  borderBottom: `1px solid ${palette.surface.line}`,
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
