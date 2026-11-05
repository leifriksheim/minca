import { useEffect, useRef, useState, type FormEvent } from 'react';
import { PersonFace } from '../PersonFace';
import type { DirectMessage, SpaceSummary } from '@minca/core';
import { useLive, useNode } from '@minca/react';
import { useAction } from '@minca/app-shared/action';
import { Modal } from '@minca/app-shared/Modal';
import { Shape } from '@minca/app-shared/shapes';
import { ago } from '@minca/ui/time';
import { nameOf, type People } from '../../derive/people';
import { usePeopleHere } from '../Person';
import { Icon } from '@minca/app-shared/Icon';
import styles from './DirectMessages.module.css';
import made from './MadeApps.module.css';

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
      <div className="empty">
        <p>
          Direct messages are sealed to each member's key, and members share those only in a private group.
          This one is public.
        </p>
      </div>
    );

  const current = open && (conversations.find((c) => same(c.with, open)) ?? { with: open, messages: [] });
  // One open is the whole screen, one level in; the app's bar names it and Back comes out to the list.
  if (current)
    return (
      <section className={made.app}>
        <Room space={space} people={people} me={me} with={current.with} messages={current.messages} />
      </section>
    );
  const mayStart = space.writable && (reachable?.length ?? 0) > 0;
  return (
    <div className={`stack ${styles.list}`}>
      <header>
        <h2>Conversations</h2>
        {mayStart && (
          <button type="button" data-intent="primary" onClick={() => setStarting(true)}>
            <Icon name="plus" size={14} /> New message
          </button>
        )}
      </header>
      {conversations.length > 0 ? (
        <ol role="list" aria-label="Conversations">
          {conversations.map((c) => {
            const last = c.messages.at(-1);
            return (
              <li key={c.with.join(',')}>
                <button type="button" data-intent="open" className="row" onClick={() => setOpen(c.with)}>
                  <Faces dids={c.with} />
                  <span className="stack truncate" data-gap="tight">
                    <strong className="truncate">{namesOf(c.with, people)}</strong>
                    {last && (
                      <small className="truncate">
                        {last.text ?? 'Sealed'} · {ago(last.createdAt)}
                      </small>
                    )}
                  </span>
                  <Icon name="chevron" size={14} />
                </button>
              </li>
            );
          })}
        </ol>
      ) : (
        <div className="empty">
          <Shape kind="lock" colour="coral" size={48} />
          <strong>No conversations yet</strong>
          <p>
            {mayStart
              ? 'Only the people you write to can read what you send.'
              : 'Nobody else here can be written to yet: each member can once their app has been in the group.'}
          </p>
        </div>
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
  if (!second) return <PersonFace did={first} size={36} round />;
  return (
    <span className={styles.faces}>
      <PersonFace did={first} size={26} round />
      <PersonFace did={second} size={26} round />
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
      {/* Faces and names, not a title with actions: a row, not the layout's header */}
      <div className={`row ${styles.title}`}>
        <Faces dids={others} />
        <span className="stack truncate" data-gap="tight">
          <strong className="truncate">{names}</strong>
          <small className="row" data-gap="tight">
            <Icon name="lock" size={11} /> Sealed for the people in this conversation
          </small>
        </span>
      </div>

      <div ref={scroller} className={`stack ${styles.messages}`}>
        {messages.length === 0 && (
          <div className="empty">
            <p>
              Sealed for {names} and you. Others in {space.name} see that you wrote, not what.
            </p>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.key} tabIndex={0} className={`row ${styles.line}`}>
            <PersonFace did={m.from} size={28} round />
            <div>
              <div className="row">
                <strong>{m.from === me ? 'You' : nameOf(m.from, people)}</strong>
                <small>
                  {ago(m.createdAt)}
                  {m.recordsOnly ? ' · via agent' : ''}
                </small>
              </div>
              <p>{m.text ?? "This device can't open this message."}</p>
            </div>
            {m.from === me && space.writable && (
              <div data-actions>
                <button
                  type="button"
                  data-intent="ghost"
                  onClick={() => void run(() => node.records.delete(space.id, m.key))}
                  aria-label="Take back this message"
                >
                  Delete
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      {error && <p role="alert">{error}</p>}
      {space.writable && (
        <form onSubmit={send} className={styles.composer}>
          <div className="composer">
            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={`Message ${names}`}
              aria-label="Write a direct message"
              maxLength={10000}
            />
            <button
              type="submit"
              data-intent="primary"
              data-icon
              aria-label="Send"
              disabled={busy || !draft.trim()}
            >
              ↑
            </button>
          </div>
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
        className="stack"
        data-gap="loose"
      >
        {reachable.length > 6 && (
          <input
            value={find}
            onChange={(event) => setFind(event.target.value)}
            placeholder="Find someone"
            aria-label="Find someone"
          />
        )}
        <div role="group" aria-label="People" className={`stack ${styles.people}`}>
          {found.map((p) => (
            <label key={p.did}>
              <input
                type="checkbox"
                checked={picked.includes(p.did)}
                onChange={() => toggle(p.did)}
                // 16 at most, as std.direct allows
                disabled={!picked.includes(p.did) && picked.length >= 16}
              />
              <PersonFace did={p.did} size={24} round />
              <strong className="truncate">{p.name}</strong>
            </label>
          ))}
          {found.length === 0 && <small>Nobody by that name.</small>}
        </div>
        <small>Sealed for the people you pick. Others in the group see that you wrote, not what.</small>
        <button type="submit" data-intent="primary" disabled={picked.length === 0}>
          Write to {picked.length === 0 ? '…' : namesOf(picked, people)}
        </button>
      </form>
    </Modal>
  );
}
