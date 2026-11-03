import { useCallback, useState } from 'react';
import { useRouterState } from '@tanstack/react-router';
import type { ContactView, InboxView, SentKnockView, SpaceSummary } from '@minca/core';
import { readInbox } from '@minca/core/inbox';
import { createP256Provider } from '@minca/core';
import { useAccount, useAsync, useNode, useSpaceStatus } from '@minca/react';
import {
  clearInboxFromUrl,
  inboxLink,
  NOT_CARRIED,
  readInboxFromUrl,
  readUserFromUrl,
  takeBack,
  useAsking,
  useContacts,
  useStanding,
  useHeldSpaces,
  withChat,
} from '../contacts';
import { nameOf, peopleFrom } from '../derive/people';
import { ago } from '@minca/ui/time';
import { Avatar } from '@minca/app-shared/Avatar';
import { Modal } from '@minca/app-shared/Modal';
import { message, useAction, useCopy } from '@minca/app-shared/action';
import { Loader } from '@minca/app-shared/Loader';
import { confirmThen } from '../confirm';
import { Icon } from './Icon';
import { AddDialog, Handle, Notice, PersonRow, RowMenu, SpaceInvites } from './PeopleParts';
import { SpaceCount } from './SpaceList';
import { RingButton } from './calls/Calls';
import { onlineAccounts } from '../derive/network';
import { InviteToSpace } from './InvitePeople';
import { shortUsername, useUsernameLookup } from '@minca/app-shared/usernames';

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

  const shared = spaces.filter((space) => !space.joining);
  const { requests, inbox, knocks, sent } = useAsking(spaces, tick);

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
    <div className="stack" data-gap="loose">
      {error && <aside data-tone="danger">{error}</aside>}
      {notice && <Notice text={notice} onDismiss={() => setNotice(null)} />}

      <KnockFromLink
        onKnock={(code, note) =>
          act(async () => {
            const made = await withChat(node, node.inbox.knock(code, note ? { note } : {}));
            setNotice(made.carried ? 'Sent. They show up here once they accept.' : NOT_CARRIED);
          })
        }
      />

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
        <section className="stack" aria-label="Wants to connect">
          <h2>Wants to connect</h2>
          <ul role="list">
            {knocks.map((knock) => (
              <PersonRow
                key={knock.id}
                face={knock.from}
                name={knock.name}
                detail={knock.note ? `“${knock.note}”` : `Asked ${ago(knock.at)}`}
              >
                <button data-intent="primary" onClick={() => void act(() => node.inbox.accept(knock.id))}>
                  Accept
                </button>
                <button data-intent="ghost" onClick={() => void act(() => node.inbox.dismiss(knock.id))}>
                  Not now
                </button>
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
                  face={request.from}
                  name={name}
                  detail={
                    request.note
                      ? `“${request.note}”`
                      : `From ${spaceName(request.space)} · ${ago(request.createdAt)}`
                  }
                >
                  <button
                    data-intent="primary"
                    onClick={() => void act(() => node.contacts.accept(request.space, request.key))}
                  >
                    Accept
                  </button>
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
        <section className="stack" aria-label="Contacts">
          <h2>
            {q ? 'In your contacts' : 'Contacts'}
            {!q && listed.length > 0 && <small> {listed.length}</small>}
          </h2>
          {contacts === undefined ? (
            <small>
              <Loader label="Loading" showLabel />
            </small>
          ) : listed.length === 0 && sent.length === 0 ? (
            <EmptyContacts hasName={!!inbox?.username} />
          ) : (
            <ul role="list">
              {matching.map((contact) => (
                <ContactRow
                  key={contact.did}
                  contact={contact}
                  space={spaces.find((one) => one.id === contact.space)}
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
                    onOpen={() => onOpen(knock.space)}
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

      <details>
        <summary>Other ways to connect</summary>
        <Inbox inbox={inbox} act={act} onKnocked={setNotice} />
      </details>

      {blocked.length > 0 && (
        <details>
          <summary>
            <small>Blocked ({blocked.length})</small>
          </summary>
          <ul role="list">
            {blocked.map((contact) => (
              <PersonRow
                key={contact.did}
                face={contact.did}
                name={contact.name === contact.did ? nameOf(contact.did, nobody) : contact.name}
              >
                <button
                  data-intent="ghost"
                  onClick={() => void act(() => node.contacts.remove(contact.did))}
                  title="They can ask or knock again"
                >
                  Unblock
                </button>
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
  // Arrived from "New contact": straight into finding them.
  const finding = useRouterState({ select: (state) => state.location.state.find === true });
  const [adding, setAdding] = useState<{ username: string; name?: string } | null>(null);
  const known = lookup.status === 'found' ? contacts.find((c) => c.username === lookup.username) : undefined;
  const waiting = lookup.status === 'found' && sent.some((knock) => knock.username === lookup.username);
  const yours = lookup.status === 'found' && inbox?.username === lookup.username;

  return (
    <section aria-label="Find people" className="stack">
      <div className="row">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Find people by name or username"
          aria-label="Find people by name or username"
          // A search, so a phone doesn't take it for a sign-in and fill in your own username.
          type="search"
          name="find-people"
          enterKeyHint="search"
          autoFocus={finding}
          autoCapitalize="none"
          autoComplete="off"
          spellCheck={false}
        />
        {query && (
          <button data-intent="ghost" data-icon onClick={() => setQuery('')} aria-label="Clear">
            ×
          </button>
        )}
      </div>

      {lookup.status === 'found' && (
        <ul role="list">
          <PersonRow
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
              <button data-intent="ghost" onClick={() => onOpen(known.space!)}>
                Open
              </button>
            ) : !yours && !waiting ? (
              <button
                data-intent="primary"
                onClick={() =>
                  setAdding({
                    username: lookup.username,
                    ...(lookup.found.inbox.name ? { name: lookup.found.inbox.name } : {}),
                  })
                }
              >
                Add
              </button>
            ) : null}
          </PersonRow>
        </ul>
      )}
      {lookup.status === 'looking' && matches === 0 && (
        <small>Looking for @{shortUsername(lookup.username)}…</small>
      )}
      {lookup.status === 'invalid' && matches === 0 && <small>No contact called that.</small>}
      {lookup.status === 'nobody' && matches === 0 && (
        <small>
          Nobody is called <strong>@{shortUsername(lookup.username)}</strong> yet.
        </small>
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
    <div className="empty">
      <strong>No contacts yet</strong>
      <p>
        {hasName
          ? 'Search for someone’s username above, or share yours from New.'
          : 'Search for someone’s username above. To be found by yours, pick one in your account.'}
      </p>
    </div>
  );
}

/**
 * One contact: a tap opens your chat with them, and the rest (adding them to
 * a group, renaming, removing) is behind a menu. Warns when someone other than the two of you is in
 * that space — the invite was passed on — so you can decide whether it is
 * still just the two of you.
 */
function ContactRow({
  contact,
  space,
  shared,
  invitable,
  onOpen,
  onNotice,
  act,
}: {
  contact: ContactView;
  /** Your space for two with them, once it is on this device */
  space: SpaceSummary | undefined;
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
  // Whether they are in your space for two now; none yet, and nobody is.
  const status = useSpaceStatus(contact.space ?? '');
  const online = !!joined && !!status && onlineAccounts(status, account.did).has(contact.did);

  return (
    <>
      <PersonRow
        face={contact.did}
        name={contact.name}
        online={online}
        {...(joined ? { onOpen: () => onOpen(contact.space!) } : {})}
        detail={
          others.length > 0 ? (
            <span data-tone="danger">
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
        {/* What's new in your chat with them, as a group shows it, and calling them in it. */}
        {joined && space && <SpaceCount space={space} />}
        {/* Messaging them is a tap on the row too, which isn't plain to see: a button says so. */}
        {joined && (
          <button
            data-intent="ghost"
            data-icon
            onClick={() => onOpen(contact.space!)}
            aria-label={`Message ${contact.name}`}
            title={`Message ${contact.name}`}
          >
            <Icon name="chat" size={14} />
          </button>
        )}
        {joined && space && standing === 'joined' && (
          <RingButton space={space} did={contact.did} name={contact.name} />
        )}
        <RowMenu
          label={`More for ${contact.name}`}
          items={[
            ...(joined && standing === 'joined'
              ? [{ label: 'Add to group…', onClick: () => setInviting(true) }]
              : []),
            { label: 'Rename', onClick: () => setRenaming(true) },
            {
              label: 'Remove',
              onClick: () =>
                confirmThen(
                  standing === 'waiting'
                    ? 'Your request is taken back, and your chat with them goes.'
                    : 'Your chat with them goes from all your devices. They keep their copy.',
                  { title: `Remove ${contact.name} from your contacts?`, yes: 'Remove' },
                  () =>
                    act(() => takeBack(node, standing === 'waiting' ? shared : [], account.did, contact.did)),
                ),
            },
            {
              label: 'Block',
              danger: true,
              onClick: () =>
                confirmThen(
                  'Your chat with them goes, and their requests are hidden from now on.',
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
        className="stack"
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
          autoFocus
        />
        <small>Only you see what you call them.</small>
        <button data-intent="primary" type="submit">
          Save
        </button>
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
    <div className="stack">
      <small>
        Your username leads to your inbox. You can also hand out its link, which works without a username, or
        knock with a code someone gave you. Replace the inbox and old links lead nowhere; your contacts stay.
      </small>
      <div className="row">
        {inbox ? (
          <button data-intent="ghost" onClick={() => copy(inboxLink(inbox.code))}>
            {copied ? 'Copied' : 'Copy inbox link'}
          </button>
        ) : (
          <button data-intent="ghost" onClick={() => void act(() => node.inbox.open())}>
            Open your inbox
          </button>
        )}
        <button data-intent="ghost" onClick={() => setKnocking(true)}>
          Use a link or code
        </button>
        {inbox && (
          <>
            <button
              data-intent="ghost"
              onClick={() => void act(() => node.inbox.clear())}
              title="Clear every knock waiting, for an inbox someone is flooding"
            >
              Clear waiting requests
            </button>
            <button
              data-intent="danger"
              onClick={() =>
                confirmThen(
                  'Links you shared stop working everywhere. Your username moves to the new inbox.',
                  { title: 'Replace your inbox?', yes: 'Replace it' },
                  () => act(() => node.inbox.rotate()),
                )
              }
            >
              Replace inbox
            </button>
          </>
        )}
      </div>
      {knocking && (
        <KnockDialog
          onClose={() => setKnocking(false)}
          onKnock={(code, note) => {
            setKnocking(false);
            void act(async () => {
              const made = await withChat(node, node.inbox.knock(code, note ? { note } : {}));
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
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          if (code.trim() && !problem) onKnock(code.trim(), note.trim());
        }}
      >
        {initial && name && (
          <div className="row">
            <Avatar did={initial} size={48} round />
            <strong>{name}</strong>
          </div>
        )}
        {!initial && (
          <>
            <label>
              Their inbox link or code
              <input value={code} onChange={(event) => setCode(event.target.value)} />
            </label>
            {problem && <p role="alert">{problem}</p>}
          </>
        )}
        <label>
          <span>
            Say who you are <small>(optional)</small>
          </span>
          <textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={500} rows={3} />
        </label>
        <small>
          They see your name and note, and choose whether to accept. The name a link shows is the owner’s to
          choose, so be sure it came from them.
        </small>
        <button
          data-intent="primary"
          type="submit"
          disabled={!text || inbox.status !== 'done' || !inbox.value}
        >
          Send request
        </button>
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
