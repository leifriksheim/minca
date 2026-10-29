import { useCallback, useState } from 'react';
import type {
  ContactRequest,
  ContactView,
  InboxView,
  NodeEvent,
  P2PNode,
  KnockView,
  SentKnockView,
  SpaceSummary,
} from '@minca/core';
import { readInbox } from '@minca/core/inbox';
import { createP256Provider } from '@minca/core';
import { useAccount, useAsync, useNode, useWatched } from '@minca/react';
import {
  clearInboxFromUrl,
  inboxLink,
  NOT_CARRIED,
  readInboxFromUrl,
  readUserFromUrl,
  takeBack,
  useContacts,
  useStanding,
  useHeldSpaces,
} from '../contacts';
import { nameOf, peopleFrom } from '../derive/people';
import { ago } from '@minca/ui/time';
import { Avatar } from '@minca/app-shared/Avatar';
import { Modal } from '@minca/app-shared/Modal';
import { styles, palette } from '../styles';
import { message, useAction, useCopy } from '@minca/app-shared/action';
import { Loading } from './Loading';
import { AddButton, LinkButton, QuietButton } from './Buttons';
import { confirmThen } from '../confirm';
import { Icon } from './Icon';
import { UsernameCard } from './UsernameCard';
import { AddDialog, Handle, Notice, PersonRow, RowMenu, SpaceInvites } from './PeopleParts';
import { InviteToSpace } from './InvitePeople';
import { shortUsername, useUsernameLookup } from '@minca/app-shared/usernames';

const { ink, surface, accent } = palette;

/** How often to look in the inbox's mailboxes: knocks wait on relays, which tell nobody */
const KNOCK_POLL_MS = 30_000;

async function readMailbox(node: P2PNode) {
  const [inbox, knocks, sent] = await Promise.all([
    node.inbox.get().catch(() => null),
    node.inbox.knocks().catch((): KnockView[] => []),
    node.inbox.sent().catch((): SentKnockView[] => []),
  ]);
  return { inbox, knocks, sent };
}

/** Checks inbox codes as they are typed */
const provider = createP256Provider();

/** Nobody's profile: names here come from the contact list, or the tail of an identity */
const nobody = peopleFrom([]);

/**
 * People, the way a messaging app has them: your username to hand out, one
 * search box that finds contacts and anyone by username, who wants to
 * connect, invites contacts left you, and your contacts, each a private space
 * for two you can open or invite into another space.
 */
export function ContactsView({
  spaces,
  onOpen,
}: {
  spaces: ReadonlyArray<SpaceSummary>;
  onOpen: (spaceId: string) => void;
}) {
  const node = useNode();
  const contacts = useContacts();
  const [notice, setNotice] = useState<string | null>(null);
  const { run, error } = useAction();
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  // A link to add someone (`#user=`) opens with them looked up.
  const [query, setQuery] = useState(() => {
    const user = readUserFromUrl();
    if (user) clearInboxFromUrl();
    return user ?? '';
  });

  /** Runs an action, shows what went wrong, and loads everything again */
  const act = useCallback(
    async (action: () => Promise<unknown>) => {
      await run(action);
      reload();
    },
    [run, reload],
  );

  // Requests are records in the spaces you share, so a change in any of them may bring one.
  const shared = spaces.filter((space) => !space.joining);
  const sharedIds = shared.map((space) => space.id).join(',');
  const watch = {
    when: (event: NodeEvent) =>
      (event.type === 'records' && sharedIds.split(',').includes(event.space)) || event.type === 'spaces',
    settle: 400,
  };
  const requests =
    useWatched(
      async (node) => {
        const found = await Promise.all(
          shared.map((space) => node.contacts.requests(space.id).catch((): ContactRequest[] => [])),
        );
        return found.flat();
      },
      [sharedIds, tick],
      watch,
    ) ?? [];
  // The inbox, and the knocks in it. Reading knocks also turns knocks of yours someone joined into contacts.
  const mailbox = useWatched(readMailbox, [sharedIds, tick], { ...watch, every: KNOCK_POLL_MS });
  const inbox = mailbox?.inbox ?? null;
  const knocks = mailbox?.knocks ?? [];
  const sent = mailbox?.sent ?? [];

  const listed = (contacts ?? []).filter((contact) => !contact.blocked);
  const blocked = (contacts ?? []).filter((contact) => contact.blocked);
  // Spaces for two stay in sync while this shows, so invites left in them arrive.
  const pairs = listed.flatMap((contact) => (contact.space ? [contact.space] : []));
  useHeldSpaces(pairs);
  const writable = shared.filter((space) => space.writable).map((space) => space.id);
  const spaceName = (id: string) => spaces.find((space) => space.id === id)?.name ?? 'a space';
  // Spaces to invite a contact into: yours to write in, and not a space for two.
  const pairSet = new Set(pairs);
  const invitable = shared.filter((space) => space.writable && !pairSet.has(space.id));
  const names = new Map(listed.map((contact) => [contact.did, contact.name]));

  const q = query.trim().toLowerCase().replace(/^@/, '');
  const matching = q
    ? listed.filter((c) => c.name.toLowerCase().includes(q) || c.username?.includes(q))
    : listed;
  const asking = requests.length + knocks.length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      {error && (
        <div style={{ ...styles.errorBox, marginTop: 0 }}>
          <p style={styles.error}>{error}</p>
        </div>
      )}
      {notice && <Notice text={notice} onDismiss={() => setNotice(null)} />}

      <KnockFromLink
        onKnock={(code, note) =>
          act(async () => {
            const made = await node.inbox.knock(code, note ? { note } : {});
            setNotice(made.carried ? 'Sent. They show up here once they accept.' : NOT_CARRIED);
          })
        }
      />

      <UsernameCard inbox={inbox} onChange={reload} />

      <FindPeople
        query={query}
        setQuery={setQuery}
        inbox={inbox}
        contacts={listed}
        sent={sent}
        matches={matching.length}
        onOpen={onOpen}
        onSent={(text) => {
          setNotice(text);
          setQuery('');
          reload();
        }}
      />

      {asking > 0 && (
        <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }} aria-label="Wants to connect">
          <h2 style={styles.sectionTitle}>Wants to connect</h2>
          <ul style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 0 }}>
            {knocks.map((knock) => (
              <PersonRow
                key={knock.id}
                tone="card"
                face={knock.from}
                name={knock.name}
                detail={knock.note ? `“${knock.note}”` : `Asked ${ago(knock.at)}`}
              >
                <AddButton onClick={() => void act(() => node.inbox.accept(knock.id))} style={{ height: 34 }}>
                  Accept
                </AddButton>
                <QuietButton
                  onClick={() => void act(() => node.inbox.dismiss(knock.id))}
                  style={{ height: 34 }}
                >
                  Not now
                </QuietButton>
                <RowMenu
                  label={`More for ${knock.name}`}
                  items={[
                    {
                      label: 'Block',
                      danger: true,
                      onClick: () => void act(() => node.contacts.block(knock.from)),
                    },
                  ]}
                />
              </PersonRow>
            ))}
            {requests.map((request) => {
              const name = request.name ?? nameOf(request.from, nobody);
              return (
                <PersonRow
                  key={`${request.space}/${request.key}`}
                  tone="card"
                  face={request.from}
                  name={name}
                  detail={
                    request.note
                      ? `“${request.note}”`
                      : `From ${spaceName(request.space)} · ${ago(request.createdAt)}`
                  }
                >
                  <AddButton
                    onClick={() => void act(() => node.contacts.accept(request.space, request.key))}
                    style={{ height: 34 }}
                  >
                    Accept
                  </AddButton>
                  <RowMenu
                    label={`More for ${name}`}
                    items={[
                      {
                        label: 'Block',
                        danger: true,
                        onClick: () => void act(() => node.contacts.block(request.from)),
                      },
                    ]}
                  />
                </PersonRow>
              );
            })}
          </ul>
        </section>
      )}

      <SpaceInvites names={names} onJoined={onOpen} />

      {/* Searching, only contacts that match: the search box says the rest. */}
      {!(q && matching.length === 0) && (
        <section style={{ display: 'flex', flexDirection: 'column', gap: 4 }} aria-label="Contacts">
          <h2 style={styles.sectionTitle}>
            {q ? 'In your contacts' : 'Contacts'}
            {!q && listed.length > 0 && (
              <span style={{ color: ink.faint, fontWeight: 500 }}> {listed.length}</span>
            )}
          </h2>
          {contacts === undefined ? (
            <Loading label="Loading" style={styles.todoMeta} />
          ) : listed.length === 0 && sent.length === 0 ? (
            <EmptyContacts hasName={!!inbox?.username} />
          ) : (
            <ul style={{ padding: 0, margin: 0 }}>
              {matching.map((contact) => (
                <ContactRow
                  key={contact.did}
                  contact={contact}
                  shared={writable}
                  invitable={invitable}
                  onOpen={onOpen}
                  onNotice={setNotice}
                  act={act}
                />
              ))}
              {!q &&
                sent.map((knock) => (
                  <PersonRow
                    key={knock.space}
                    face={knock.username ?? knock.space}
                    name={knock.name}
                    detail={
                      <>
                        {knock.username && (
                          <>
                            <Handle username={knock.username} /> ·{' '}
                          </>
                        )}
                        Waiting for them to accept · {ago(knock.at)}
                      </>
                    }
                  />
                ))}
            </ul>
          )}
        </section>
      )}

      <details style={{ borderTop: `1px solid ${surface.line}`, paddingTop: 16 }}>
        <summary style={{ fontSize: 14, fontWeight: 600, color: ink.body }}>Other ways to connect</summary>
        <Inbox inbox={inbox} act={act} onKnocked={setNotice} />
      </details>

      {blocked.length > 0 && (
        <details>
          <summary style={{ ...styles.todoMeta, cursor: 'pointer' }}>Blocked ({blocked.length})</summary>
          <ul style={{ padding: 0, marginTop: 8 }}>
            {blocked.map((contact) => (
              <PersonRow
                key={contact.did}
                face={contact.did}
                name={contact.name === contact.did ? nameOf(contact.did, nobody) : contact.name}
              >
                <LinkButton
                  onClick={() => void act(() => node.contacts.remove(contact.did))}
                  title="They can ask or knock again"
                >
                  Unblock
                </LinkButton>
              </PersonRow>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/**
 * One search box for people: it narrows your contacts as you type, and looks
 * the words up as a username, so anyone with one is a tap away.
 */
function FindPeople({
  query,
  setQuery,
  inbox,
  contacts,
  sent,
  matches,
  onOpen,
  onSent,
}: {
  query: string;
  setQuery: (text: string) => void;
  inbox: InboxView | null;
  contacts: ReadonlyArray<ContactView>;
  sent: ReadonlyArray<SentKnockView>;
  /** How many contacts the words match, shown below */
  matches: number;
  onOpen: (spaceId: string) => void;
  onSent: (notice: string) => void;
}) {
  const lookup = useUsernameLookup(query);
  const [adding, setAdding] = useState<{ username: string; name?: string } | null>(null);
  const known = lookup.status === 'found' ? contacts.find((c) => c.username === lookup.username) : undefined;
  const waiting = lookup.status === 'found' && sent.some((knock) => knock.username === lookup.username);
  const yours = lookup.status === 'found' && inbox?.username === lookup.username;

  return (
    <section aria-label="Find people" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <label
        className="pill-field"
        style={{
          ...styles.input,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          height: 48,
          padding: '0 16px',
          background: surface.card,
        }}
      >
        <Icon name="search" size={16} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Find people by name or username"
          aria-label="Find people by name or username"
          autoCapitalize="none"
          autoComplete="off"
          spellCheck={false}
          style={{
            flex: 1,
            minWidth: 0,
            height: '100%',
            border: 'none',
            background: 'transparent',
            fontSize: 15,
            color: ink.strong,
            outline: 'none',
          }}
        />
        {query && (
          <button
            onClick={() => setQuery('')}
            aria-label="Clear"
            style={{
              border: 'none',
              background: 'none',
              color: ink.faint,
              fontSize: 18,
              lineHeight: 1,
              padding: 4,
            }}
          >
            ×
          </button>
        )}
      </label>

      {lookup.status === 'found' && (
        <ul style={{ padding: 0, margin: 0 }}>
          <PersonRow
            tone="card"
            face={known?.did ?? lookup.username}
            name={known?.name ?? lookup.found.inbox.name ?? `@${shortUsername(lookup.username)}`}
            detail={
              <>
                @{shortUsername(lookup.username)}
                {yours ? ' · that’s you' : known ? ' · in your contacts' : waiting ? ' · request sent' : ''}
              </>
            }
          >
            {known?.space ? (
              <QuietButton onClick={() => onOpen(known.space!)} style={{ height: 34 }}>
                Open
              </QuietButton>
            ) : !yours && !waiting ? (
              <AddButton
                onClick={() =>
                  setAdding({
                    username: lookup.username,
                    ...(lookup.found.inbox.name ? { name: lookup.found.inbox.name } : {}),
                  })
                }
                style={{ height: 34 }}
              >
                Add
              </AddButton>
            ) : null}
          </PersonRow>
        </ul>
      )}
      {lookup.status === 'looking' && matches === 0 && (
        <p style={{ fontSize: 13, color: ink.faint, padding: '0 4px' }}>
          Looking for @{shortUsername(lookup.username)}…
        </p>
      )}
      {lookup.status === 'invalid' && matches === 0 && (
        <p style={{ fontSize: 13, color: ink.muted, padding: '0 4px' }}>No contact called that.</p>
      )}
      {lookup.status === 'nobody' && matches === 0 && (
        <p style={{ fontSize: 13, color: ink.muted, padding: '0 4px' }}>
          Nobody is called <strong style={{ color: ink.strong }}>@{shortUsername(lookup.username)}</strong>{' '}
          yet.
        </p>
      )}
      {adding && (
        <AddDialog
          username={adding.username}
          {...(adding.name ? { name: adding.name } : {})}
          onClose={() => setAdding(null)}
          onSent={(text) => {
            setAdding(null);
            onSent(text);
          }}
        />
      )}
    </section>
  );
}

function EmptyContacts({ hasName }: { hasName: boolean }) {
  return (
    <div
      style={{ ...styles.emptyState, display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'center' }}
    >
      <strong style={{ color: ink.strong, fontSize: 15 }}>No contacts yet</strong>
      <span>
        {hasName
          ? 'Search for someone’s username above, or send them yours.'
          : 'Pick a username above, then search for your friends’.'}
      </span>
    </div>
  );
}

/**
 * One contact: open your space for two, invite them into another space, and
 * the rest behind a menu. Warns when someone other than the two of you is in
 * that space — the invite was passed on — so you can decide whether it is
 * still just the two of you.
 */
function ContactRow({
  contact,
  shared,
  invitable,
  onOpen,
  onNotice,
  act,
}: {
  contact: ContactView;
  shared: ReadonlyArray<string>;
  invitable: ReadonlyArray<SpaceSummary>;
  onOpen: (spaceId: string) => void;
  onNotice: (text: string) => void;
  act: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const node = useNode();
  const account = useAccount();
  const othersFound = useAsync(() => node.contacts.others(contact.did), [node, contact.did, contact.space]);
  const others = othersFound.status === 'done' ? othersFound.value : [];
  const [renaming, setRenaming] = useState(false);
  const [inviting, setInviting] = useState(false);
  const standing = useStanding(contact);
  const joined = contact.space && standing !== 'gone';

  return (
    <>
      <PersonRow
        face={contact.did}
        name={contact.name}
        detail={
          others.length > 0 ? (
            <span style={{ color: accent.danger }}>
              {others.length === 1 ? 'Someone else is' : `${others.length} others are`} in your space for two
            </span>
          ) : standing === 'waiting' ? (
            'Waiting for them to accept'
          ) : standing === 'gone' ? (
            'You left your space for two'
          ) : contact.username ? (
            <Handle username={contact.username} />
          ) : (
            'Contact'
          )
        }
      >
        {joined && (
          <QuietButton onClick={() => onOpen(contact.space!)} style={{ height: 34 }}>
            Open
          </QuietButton>
        )}
        {joined && standing === 'joined' && (
          <QuietButton
            onClick={() => setInviting(true)}
            style={{ height: 34 }}
            title="Invite them into one of your spaces"
          >
            Invite to…
          </QuietButton>
        )}
        <RowMenu
          label={`More for ${contact.name}`}
          items={[
            { label: 'Rename', onClick: () => setRenaming(true) },
            {
              label: 'Remove',
              onClick: () =>
                confirmThen(
                  standing === 'waiting'
                    ? 'Your request is taken back and you leave the space for two.'
                    : 'You leave the space for two; they keep their copy.',
                  { title: `Remove ${contact.name}?`, yes: 'Remove' },
                  () =>
                    act(() => takeBack(node, standing === 'waiting' ? shared : [], account.did, contact.did)),
                ),
            },
            {
              label: 'Block',
              danger: true,
              onClick: () =>
                confirmThen(
                  'You leave the space for two, and their requests and knocks are hidden from now on.',
                  { title: `Block ${contact.name}?`, yes: 'Block' },
                  () => act(() => node.contacts.block(contact.did)),
                ),
            },
          ]}
        />
      </PersonRow>
      {renaming && (
        <Rename
          contact={contact}
          onClose={() => setRenaming(false)}
          onSave={(name) => {
            setRenaming(false);
            void act(() =>
              node.contacts.put({
                did: contact.did,
                name,
                space: contact.space,
                ...(contact.note ? { note: contact.note } : {}),
              }),
            );
          }}
        />
      )}
      {inviting && (
        <InviteToSpace
          contact={contact}
          spaces={invitable}
          onClose={() => setInviting(false)}
          onDone={(text) => {
            setInviting(false);
            onNotice(text);
          }}
        />
      )}
    </>
  );
}

function Rename({
  contact,
  onClose,
  onSave,
}: {
  contact: ContactView;
  onClose: () => void;
  onSave: (name: string) => void;
}) {
  const [name, setName] = useState(contact.name);
  return (
    <Modal title={`Rename ${contact.name}`} onClose={onClose}>
      <form
        style={styles.form}
        onSubmit={(event) => {
          event.preventDefault();
          const next = name.trim();
          if (next && next !== contact.name) onSave(next);
          else onClose();
        }}
      >
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={200}
          aria-label={`What you call ${contact.name}`}
          style={styles.input}
          autoFocus
        />
        <p style={{ fontSize: 13, color: ink.muted }}>Only you see what you call them.</p>
        <AddButton type="submit" style={{ marginTop: 8, height: 40 }}>
          Save
        </AddButton>
      </form>
    </Modal>
  );
}

/**
 * The inbox under the username: a link anyone can use to ask to become your
 * contact, a way to knock with a code someone gave you, and replacing or
 * clearing it when it is flooded.
 */
function Inbox({
  inbox,
  act,
  onKnocked,
}: {
  inbox: InboxView | null;
  act: (action: () => Promise<unknown>) => Promise<void>;
  onKnocked: (notice: string) => void;
}) {
  const node = useNode();
  const [knocking, setKnocking] = useState(false);
  const { copied, copy } = useCopy();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 14 }}>
      <p style={{ fontSize: 13, lineHeight: 1.5, color: ink.muted }}>
        Your username leads to your inbox. You can also hand out its link, which works without a username, or
        knock with a code someone gave you. Replace the inbox and old links lead nowhere; your contacts stay.
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {inbox ? (
          <QuietButton onClick={() => copy(inboxLink(inbox.code))}>
            {copied ? 'Copied' : 'Copy inbox link'}
          </QuietButton>
        ) : (
          <QuietButton onClick={() => void act(() => node.inbox.open())}>Open your inbox</QuietButton>
        )}
        <QuietButton onClick={() => setKnocking(true)}>Use a link or code</QuietButton>
        {inbox && (
          <>
            <LinkButton
              onClick={() => void act(() => node.inbox.clear())}
              title="Clear every knock waiting, for an inbox someone is flooding"
            >
              Clear waiting requests
            </LinkButton>
            <LinkButton
              onClick={() =>
                confirmThen(
                  'Links you shared stop working everywhere. Your username moves to the new inbox.',
                  { title: 'Replace your inbox?', yes: 'Replace it' },
                  () => act(() => node.inbox.rotate()),
                )
              }
              style={{ color: accent.danger }}
            >
              Replace inbox
            </LinkButton>
          </>
        )}
      </div>
      {knocking && (
        <KnockDialog
          onClose={() => setKnocking(false)}
          onKnock={(code, note) => {
            setKnocking(false);
            void act(async () => {
              const made = await node.inbox.knock(code, note ? { note } : {});
              onKnocked(made.carried ? 'Sent. They show up in your contacts once they accept.' : NOT_CARRIED);
            });
          }}
        />
      )}
    </div>
  );
}

function KnockDialog({
  initial = '',
  onClose,
  onKnock,
}: {
  initial?: string;
  onClose: () => void;
  onKnock: (code: string, note: string) => void;
}) {
  const [code, setCode] = useState(initial);
  const [note, setNote] = useState('');
  // An inbox code is signed: checked as it is typed.
  const text = code.trim();
  const inbox = useAsync(async () => (text ? readInbox(text, provider) : null), [text]);
  const name = inbox.status === 'done' ? (inbox.value?.name ?? null) : null;
  const problem = inbox.status === 'failed' ? message(inbox.error) : null;
  return (
    <Modal title={name ? `Add ${name}` : 'Add someone with a link'} onClose={onClose}>
      <form
        style={styles.form}
        onSubmit={(event) => {
          event.preventDefault();
          if (code.trim() && !problem) onKnock(code.trim(), note.trim());
        }}
      >
        {initial && name && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
            <Avatar did={initial} size={48} round />
            <div style={{ fontWeight: 600, fontSize: 16, color: ink.strong }}>{name}</div>
          </div>
        )}
        {!initial && (
          <>
            <label style={styles.fieldLabel} htmlFor="inbox-code">
              Their inbox link or code
            </label>
            <input
              id="inbox-code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              style={styles.input}
            />
            {problem && <p style={styles.bad}>{problem}</p>}
          </>
        )}
        <label style={{ ...styles.fieldLabel, marginTop: 8 }} htmlFor="knock-note">
          Say who you are <span style={{ color: ink.faint, fontWeight: 400 }}>(optional)</span>
        </label>
        <textarea
          id="knock-note"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          maxLength={500}
          rows={3}
          style={styles.textarea}
        />
        <p style={{ fontSize: 13, lineHeight: 1.5, color: ink.muted }}>
          They see your name and note, and choose whether to accept. The name a link shows is the owner’s to
          choose, so be sure it came from them.
        </p>
        <AddButton
          type="submit"
          disabled={!text || inbox.status !== 'done' || !inbox.value}
          style={{ marginTop: 12, height: 40 }}
        >
          Send request
        </AddButton>
      </form>
    </Modal>
  );
}

/** Offered when the page was opened from an inbox link: add them, or not now. */
function KnockFromLink({ onKnock }: { onKnock: (code: string, note: string) => Promise<void> }) {
  const [code, setCode] = useState(readInboxFromUrl);
  if (!code) return null;
  const done = () => {
    setCode(null);
    clearInboxFromUrl();
  };
  return (
    <KnockDialog
      initial={code}
      onClose={done}
      onKnock={(value, note) => {
        done();
        void onKnock(value, note);
      }}
    />
  );
}
