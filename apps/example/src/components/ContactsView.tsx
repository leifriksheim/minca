import { useCallback, useEffect, useState } from 'react';
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
import { useAccount, useNode } from '@minca/react';
import {
  clearInboxFromUrl,
  inboxLink,
  NOT_CARRIED,
  readInboxFromUrl,
  takeBack,
  useContacts,
  useStanding,
} from '../contacts';
import { useWatched } from '../use-watched';
import { nameOf, peopleFrom } from '../derive/people';
import { ago } from '@minca/ui/time';
import { Avatar } from '@minca/app-shared/Avatar';
import { Modal } from '@minca/app-shared/Modal';
import { styles, palette } from '../styles';
import { message, useAction, useCopy } from '@minca/app-shared/action';
import { Loader } from '@minca/app-shared/Loader';
import { ask } from '@minca/app-shared/Ask';

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

/** People: your contacts (each a private space for two), who is asking to be one, and your inbox. */
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

  // Where a request of yours may be waiting, to take back with it.
  const writable = shared.filter((space) => space.writable).map((space) => space.id);
  const spaceName = (id: string) => spaces.find((space) => space.id === id)?.name ?? 'a space';
  const listed = (contacts ?? []).filter((contact) => !contact.blocked);
  const blocked = (contacts ?? []).filter((contact) => contact.blocked);
  const asking = requests.length + knocks.length;
  const knock = async (code: string, note: string) => {
    setNotice(null);
    const made = await node.inbox.knock(code, note ? { note } : {});
    if (!made.carried) setNotice(NOT_CARRIED);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {error && (
        <div style={{ ...styles.errorBox, marginTop: 0 }}>
          <p style={styles.error}>{error}</p>
        </div>
      )}

      {notice && <p style={styles.todoMeta}>{notice}</p>}

      <KnockFromLink onKnock={(code, note) => act(() => knock(code, note))} />

      {asking > 0 && (
        <section
          style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 16 }}
          aria-label="Asking to be your contact"
        >
          <h2 style={styles.sectionTitle}>Asking to be your contact</h2>
          <ul style={styles.todoList}>
            {requests.map((request) => (
              <li key={`${request.space}/${request.key}`} style={{ ...styles.row, alignItems: 'flex-start' }}>
                <Avatar did={request.from} size={32} />
                <div style={styles.todoContent}>
                  <p style={styles.todoText}>{request.name ?? nameOf(request.from, nobody)}</p>
                  <p style={styles.todoMeta}>
                    Asked in {spaceName(request.space)} · {ago(request.createdAt)}
                  </p>
                  {request.note && (
                    <p style={{ ...styles.todoMeta, color: palette.ink.body }}>“{request.note}”</p>
                  )}
                </div>
                <button
                  onClick={() => void act(() => node.contacts.accept(request.space, request.key))}
                  data-variant="primary"
                  style={{ ...styles.addButton, height: 32 }}
                >
                  Accept
                </button>
                <button
                  onClick={() => void act(() => node.contacts.block(request.from))}
                  data-variant="ghost"
                  style={styles.linkButton}
                  title="Hide their knocks, in every space"
                >
                  Block
                </button>
              </li>
            ))}
            {knocks.map((knock) => (
              <li key={knock.id} style={{ ...styles.row, alignItems: 'flex-start' }}>
                <Avatar did={knock.from} size={32} />
                <div style={styles.todoContent}>
                  <p style={styles.todoText}>
                    {knock.name}{' '}
                    <span style={{ color: palette.ink.faint, fontWeight: 400 }}>
                      · {knock.from.slice(-6)}
                    </span>
                  </p>
                  <p style={styles.todoMeta}>
                    Knocked on your inbox · {ago(knock.at)} · the name is theirs to choose; the code after it
                    is who they are
                  </p>
                  {knock.note && (
                    <p style={{ ...styles.todoMeta, color: palette.ink.body }}>“{knock.note}”</p>
                  )}
                </div>
                <button
                  onClick={() => void act(() => node.inbox.accept(knock.id))}
                  data-variant="primary"
                  style={{ ...styles.addButton, height: 32 }}
                >
                  Accept
                </button>
                <button
                  onClick={() => void act(() => node.inbox.dismiss(knock.id))}
                  data-variant="ghost"
                  style={styles.linkButton}
                  title="Let this knock go; they can knock again"
                >
                  Dismiss
                </button>
                <button
                  onClick={() => void act(() => node.contacts.block(knock.from))}
                  data-variant="ghost"
                  style={styles.linkButton}
                  title="Hide their knocks and requests from now on"
                >
                  Block
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section style={{ display: 'flex', flexDirection: 'column', gap: 4 }} aria-label="Contacts">
        <h2 style={styles.sectionTitle}>Contacts{listed.length > 0 ? ` (${listed.length})` : ''}</h2>
        {contacts === undefined ? (
          <p style={styles.todoMeta}>
            <Loader label="Loading" showLabel />
          </p>
        ) : listed.length === 0 ? (
          <div style={styles.emptyState}>
            No contacts yet. Add someone from a space you share — their name under People — or give them your
            inbox link below.
          </div>
        ) : (
          <ul style={styles.todoList}>
            {listed.map((contact) => (
              <ContactRow key={contact.did} contact={contact} shared={writable} onOpen={onOpen} act={act} />
            ))}
          </ul>
        )}
        {sent.length > 0 && (
          <ul style={{ ...styles.todoList, marginTop: 4 }} aria-label="Knocks you left">
            {sent.map((knock) => (
              <li key={knock.space} style={{ ...styles.row, color: palette.ink.muted, fontSize: 13 }}>
                <span style={{ width: 32, textAlign: 'center' }} aria-hidden>
                  …
                </span>
                <span style={{ flex: 1 }}>
                  Waiting for{' '}
                  <strong style={{ color: palette.ink.strong, fontWeight: 500 }}>{knock.name}</strong> to join
                  · knocked {ago(knock.at)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Inbox inbox={inbox} act={act} onKnock={knock} />

      {blocked.length > 0 && (
        <details style={{ marginTop: 16 }}>
          <summary style={{ ...styles.todoMeta, cursor: 'pointer' }}>Blocked ({blocked.length})</summary>
          <ul style={{ ...styles.todoList, marginTop: 8 }}>
            {blocked.map((contact) => (
              <li key={contact.did} style={styles.row}>
                <Avatar did={contact.did} size={24} />
                <span style={{ flex: 1, fontSize: 14 }}>
                  {contact.name === contact.did ? nameOf(contact.did, nobody) : contact.name}
                </span>
                <button
                  onClick={() => void act(() => node.contacts.remove(contact.did))}
                  data-variant="ghost"
                  style={styles.linkButton}
                  title="They can ask or knock again"
                >
                  Unblock
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/**
 * One contact: open your space for two, rename, remove or block. Warns when
 * someone other than the two of you is in that space — the invite was passed
 * on — so the person can decide whether it is still just the two of them.
 */
function ContactRow({
  contact,
  shared,
  onOpen,
  act,
}: {
  contact: ContactView;
  shared: ReadonlyArray<string>;
  onOpen: (spaceId: string) => void;
  act: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const node = useNode();
  const account = useAccount();
  const [others, setOthers] = useState<ReadonlyArray<string>>([]);
  const [renaming, setRenaming] = useState<string | null>(null);
  const standing = useStanding(contact);

  useEffect(() => {
    let stopped = false;
    void node.contacts
      .others(contact.did)
      .then((found) => !stopped && setOthers(found))
      .catch(() => {});
    return () => {
      stopped = true;
    };
  }, [node, contact.did, contact.space]);

  const rename = () => {
    const name = renaming?.trim();
    setRenaming(null);
    if (name && name !== contact.name)
      void act(() =>
        node.contacts.put({
          did: contact.did,
          name,
          space: contact.space,
          ...(contact.note ? { note: contact.note } : {}),
        }),
      );
  };

  return (
    <li style={{ ...styles.row, alignItems: 'flex-start' }} title={contact.did}>
      <Avatar did={contact.did} size={32} />
      <div style={styles.todoContent}>
        {renaming === null ? (
          <p style={styles.todoText}>{contact.name}</p>
        ) : (
          <input
            value={renaming}
            onChange={(event) => setRenaming(event.target.value)}
            onBlur={rename}
            onKeyDown={(event) => {
              if (event.key === 'Enter') rename();
              if (event.key === 'Escape') setRenaming(null);
            }}
            autoFocus
            maxLength={200}
            aria-label={`What you call ${contact.name}`}
            style={{ ...styles.input, height: 28, minHeight: 28, width: 200, padding: '0 8px', fontSize: 14 }}
          />
        )}
        <p style={styles.todoMeta}>
          {standing === 'waiting'
            ? 'Asked, waiting for them to accept'
            : standing === 'gone'
              ? 'You left your space for two: remove them to ask again'
              : contact.space
                ? 'Private space for the two of you'
                : 'No space for two yet'}{' '}
          · {contact.did.slice(-6)}
        </p>
        {others.length > 0 && (
          <p style={{ ...styles.todoMeta, color: palette.accent.danger }}>
            {others.length === 1 ? 'Someone else is' : `${others.length} others are`} in your space with{' '}
            {contact.name} ({others.map((did) => did.slice(-6)).join(', ')}): the invite was passed on.
          </p>
        )}
      </div>
      {contact.space && standing !== 'gone' && (
        <button onClick={() => onOpen(contact.space!)} data-variant="quiet" style={styles.smallButton}>
          Open
        </button>
      )}
      <button
        onClick={() => setRenaming(contact.name)}
        data-variant="ghost"
        style={styles.linkButton}
        title="Only you see what you call them"
      >
        Rename
      </button>
      <button
        onClick={() =>
          void ask(
            standing === 'waiting'
              ? 'Your request is taken back and you leave the space for two.'
              : 'You leave the space for two; they keep their copy.',
            { title: `Remove ${contact.name}?`, yes: 'Remove', danger: true },
          ).then(async (sure) => {
            if (sure)
              await act(() => takeBack(node, standing === 'waiting' ? shared : [], account.did, contact.did));
          })
        }
        data-variant="ghost"
        style={styles.linkButton}
      >
        Remove
      </button>
      <button
        onClick={() =>
          void ask('You leave the space for two, and their requests and knocks are hidden from now on.', {
            title: `Block ${contact.name}?`,
            yes: 'Block',
            danger: true,
          }).then(async (sure) => {
            if (sure) await act(() => node.contacts.block(contact.did));
          })
        }
        data-variant="ghost"
        style={{ ...styles.linkButton, color: palette.accent.danger }}
      >
        Block
      </button>
    </li>
  );
}

/**
 * Your inbox: one link anyone can use to ask to become your contact, without
 * sharing a space with you first. Replace it and the old link leads nowhere,
 * and nothing ties the new one to it.
 */
function Inbox({
  inbox,
  act,
  onKnock,
}: {
  inbox: InboxView | null;
  act: (action: () => Promise<unknown>) => Promise<void>;
  onKnock: (code: string, note: string) => Promise<void>;
}) {
  const node = useNode();
  const [knocking, setKnocking] = useState(false);
  const { copied, copy } = useCopy();

  return (
    <section style={{ ...styles.panelSection, marginTop: 24 }} aria-label="Your inbox">
      <h2 style={styles.sectionTitle}>Your inbox</h2>
      <p style={{ ...styles.todoMeta, marginTop: 0 }}>
        Your inbox link lets someone you share no space with ask to become your contact. It says nothing about
        who you are; replace it and the old link leads nowhere, while your contacts stay.
      </p>
      {inbox && (
        <ul style={styles.todoList}>
          <li style={styles.row}>
            <div style={styles.todoContent}>
              <p style={styles.todoText}>
                {inbox.name ? `Shows “${inbox.name}” to whoever knocks` : 'Shows no name'}
              </p>
              <p style={styles.todoMeta}>Since {ago(inbox.updatedAt)}</p>
            </div>
            <button
              onClick={() => copy(inboxLink(inbox.code))}
              data-variant="quiet"
              style={styles.smallButton}
            >
              {copied ? 'Copied' : 'Copy link'}
            </button>
            <button
              onClick={() => void act(() => node.inbox.clear())}
              data-variant="ghost"
              style={styles.linkButton}
              title="Clear every knock waiting, for an inbox someone is flooding"
            >
              Clear knocks
            </button>
            <button
              onClick={() =>
                void ask('The link you shared stops working everywhere. You get a new one.', {
                  title: 'Replace your inbox?',
                  yes: 'Replace it',
                  danger: true,
                }).then(async (sure) => {
                  if (sure) await act(() => node.inbox.rotate());
                })
              }
              data-variant="ghost"
              style={{ ...styles.linkButton, color: palette.accent.danger }}
            >
              Replace
            </button>
          </li>
        </ul>
      )}
      <div style={styles.linkRow}>
        {!inbox && (
          <button
            onClick={() => void act(() => node.inbox.open())}
            data-variant="quiet"
            style={styles.smallButton}
          >
            Open your inbox
          </button>
        )}
        <button onClick={() => setKnocking(true)} data-variant="ghost" style={styles.linkButton}>
          Knock on someone's inbox
        </button>
      </div>
      {knocking && (
        <KnockDialog
          onClose={() => setKnocking(false)}
          onKnock={(code, note) => {
            setKnocking(false);
            void act(() => onKnock(code, note));
          }}
        />
      )}
    </section>
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
  const [read, setRead] = useState<{ code: string; name: string | null; problem: string | null } | null>(
    null,
  );
  // An inbox code is signed: checked as it is typed.
  useEffect(() => {
    let stopped = false;
    const text = code.trim();
    if (!text) return;
    readInbox(text, provider).then(
      (inbox) => !stopped && setRead({ code: text, name: inbox.name ?? null, problem: null }),
      (caught: unknown) => !stopped && setRead({ code: text, name: null, problem: message(caught) }),
    );
    return () => {
      stopped = true;
    };
  }, [code]);
  const current = read?.code === code.trim() ? read : null;
  const name = current?.name ?? null;
  const problem = current?.problem ?? null;
  return (
    <Modal title={name ? `Knock on ${name}'s inbox` : "Knock on someone's inbox"} onClose={onClose}>
      <form
        style={styles.form}
        onSubmit={(event) => {
          event.preventDefault();
          if (code.trim() && !problem) onKnock(code.trim(), note.trim());
        }}
      >
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
          A note, so they know who is knocking
        </label>
        <textarea
          id="knock-note"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          maxLength={500}
          rows={3}
          style={styles.textarea}
        />
        <p style={styles.todoMeta}>
          This makes a private space for the two of you and leaves its invite in their inbox. They see your
          account and the name you go by. The name an inbox shows is the owner's to choose, so be sure the
          link came from them.
        </p>
        <button
          type="submit"
          disabled={!code.trim() || !current || !!problem}
          data-variant="primary"
          style={{ ...styles.addButton, marginTop: 12 }}
        >
          Knock
        </button>
      </form>
    </Modal>
  );
}

/** Offered when the page was opened from an inbox link: knock, or not now. */
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
