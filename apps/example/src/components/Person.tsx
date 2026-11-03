import { createContext, useContext, useState, type ReactNode } from 'react';
import type { ContactView, SpaceSummary } from '@minca/core';
import { useNode } from '@minca/react';
import { isBot, nameOf, type People } from '../derive/people';
import { NOT_CARRIED, takeBack, useContacts, useStanding, withChat } from '../contacts';
import { PersonFace } from './PersonFace';
import { Modal } from '@minca/app-shared/Modal';
import { useAction, useCopy } from '@minca/app-shared/action';
import { Loader } from '@minca/app-shared/Loader';
import { ask } from '@minca/app-shared/Ask';

/** What a name in a space needs to open its card: the space, who is in it, and where a space for two opens */
interface PersonScope {
  readonly space: SpaceSummary;
  readonly people: People;
  readonly roles: ReadonlyMap<string, string>;
  readonly me: string;
  readonly openSpace?: (id: string) => void;
}

const Scope = createContext<PersonScope | null>(null);

/** Set once by the space on screen, so every name inside it can be clicked without being handed the space */
export function PersonScopeProvider({ children, ...scope }: PersonScope & { children: ReactNode }) {
  return <Scope.Provider value={scope}>{children}</Scope.Provider>;
}

/** The space on screen: null outside one */
export const useSpaceHere = (): SpaceSummary | null => useContext(Scope)?.space ?? null;

/** Who is in the space on screen, and which of them is you: null outside a space */
export function usePeopleHere(): { readonly people: People; readonly me: string } | null {
  const scope = useContext(Scope);
  return scope ? { people: scope.people, me: scope.me } : null;
}

/**
 * Someone's name, which opens their card. Outside a space there is no card
 * to open, so it is only the name.
 */
export function Person({
  did,
  label,
}: {
  did: string | null | undefined;
  /** Shown instead of their name, like the "@Name" of a mention */
  label?: string;
}) {
  const scope = useContext(Scope);
  const [open, setOpen] = useState(false);
  const people = scope?.people ?? new Map();
  // A bot says so in its profile; shown with its name wherever it appears.
  const name = label ?? (isBot(did, people) ? `${nameOf(did, people)} · bot` : nameOf(did, people));
  if (!scope || !did) return <span>{name}</span>;
  return (
    <>
      <button
        type="button"
        onClick={(event) => {
          // Names sit inside rows that open records; this click is for the person.
          event.stopPropagation();
          setOpen(true);
        }}
        title={did}
        data-intent="inline"
      >
        {name}
      </button>
      {open && <PersonCard did={did} scope={scope} onClose={() => setOpen(false)} />}
    </>
  );
}

/** Someone's card in the space on screen, opened from somewhere other than their name: a click in an app's screen */
export function PersonCardHere({ did, onClose }: { did: string; onClose: () => void }) {
  const scope = useContext(Scope);
  return scope ? <PersonCard did={did} scope={scope} onClose={onClose} /> : null;
}

/**
 * Who someone is here, and whether they can be a contact. Says why not when
 * they can't, since the + that used to be the only way in gave no reason.
 */
function PersonCard({ did, scope, onClose }: { did: string; scope: PersonScope; onClose: () => void }) {
  const { space, people, roles, me } = scope;
  const contacts = useContacts();
  const { copied, copy } = useCopy();
  // Asking puts them on the list at once, which would swap the confirmation for "In your contacts".
  const [asked, setAsked] = useState<{ readonly carried: boolean } | null>(null);
  const name = nameOf(did, people);
  const profile = people.get(did);
  const contact = contacts?.find((c) => c.did === did);
  const role = roles.get(did);

  return (
    <Modal title={name} onClose={onClose}>
      <div className="row">
        <PersonFace did={did} size={48} />
        <div className="stack truncate" data-gap="tight">
          <small>
            {did === me ? 'You' : profile ? `In ${space.name}` : `No profile in ${space.name}`}
            {role && ` · ${role.toLowerCase()}`}
          </small>
          <span className="row" data-gap="tight">
            <small className="truncate" title={did}>
              {did}
            </small>
            <button type="button" data-intent="inline" onClick={() => copy(did)}>
              {copied ? 'Copied' : 'Copy'}
            </button>
          </span>
        </div>
      </div>
      {did === me ? null : asked ? (
        <>
          <p>
            Asked. {name} is on your contacts now, and will see your request here in {space.name}. Once they
            accept, the two of you share a private space.
          </p>
          {!asked.carried && <p>{NOT_CARRIED}</p>}
          <button data-intent="primary" onClick={onClose}>
            Done
          </button>
        </>
      ) : contacts === undefined ? (
        <small>
          <Loader label="Loading your contacts" showLabel />
        </small>
      ) : contact?.blocked ? (
        <p>You blocked {name}. Unblock them from Contacts to hear from them again.</p>
      ) : contact ? (
        <Standing contact={contact} name={name} scope={scope} onClose={onClose} />
      ) : !profile?.contactKey ? (
        <p>
          {name} can't be added as a contact yet: the app they use here wasn't given their contacts, so there
          is no key to seal a request to.
        </p>
      ) : !space.writable ? (
        <p>
          You can only read {space.name}, so you can't leave a request for {name} here.
        </p>
      ) : (
        <AskContact space={space} did={did} name={name} onAsked={setAsked} />
      )}
    </Modal>
  );
}

/**
 * Someone already on your list: whether they have joined your space for two
 * yet, and what to do when they haven't, or when you left it.
 */
function Standing({
  contact,
  name,
  scope,
  onClose,
}: {
  contact: ContactView;
  name: string;
  scope: PersonScope;
  onClose: () => void;
}) {
  const node = useNode();
  const standing = useStanding(contact);
  const { run: act, busy, error } = useAction();
  const { space, me, openSpace } = scope;
  const called = contact.name !== name && contact.name !== contact.did ? ` as ${contact.name}` : '';

  if (standing === undefined)
    return (
      <small>
        <Loader label="Loading" showLabel />
      </small>
    );
  if (standing === 'gone') {
    return (
      <>
        <p>
          You left your space for two with {name}, so they are on your list{called} but you no longer share
          anything. Remove them to ask again.
        </p>
        {error && <p role="alert">{error}</p>}
        <button
          data-intent="primary"
          disabled={busy}
          onClick={() => void act(() => takeBack(node, [space.id], me, contact.did))}
        >
          {busy ? 'Removing…' : 'Remove, and ask again'}
        </button>
      </>
    );
  }
  if (standing === 'waiting') {
    return (
      <>
        <p>
          You asked {name}. Waiting for them to accept; they see your request in {space.name} and on their
          Contacts screen.
        </p>
        {error && <p role="alert">{error}</p>}
        <button
          data-intent="ghost"
          disabled={busy}
          onClick={() =>
            void ask('Your space for two is left and the request here is deleted.', {
              title: `Take back your request to ${name}?`,
              yes: 'Take back',
            }).then(async (sure) => {
              if (sure) await act(() => takeBack(node, [space.id], me, contact.did));
            })
          }
        >
          {busy ? 'Taking back…' : 'Take back'}
        </button>
      </>
    );
  }
  return (
    <>
      <p>In your contacts{called}.</p>
      {contact.space && openSpace && (
        <button
          data-intent="primary"
          onClick={() => {
            onClose();
            openSpace(contact.space!);
          }}
        >
          Open your space for two
        </button>
      )}
    </>
  );
}

/**
 * Asking someone here to become a contact: a private space for the two of you,
 * its invite posted in this space sealed so only they can open it. Everyone
 * here can see that you asked them, not what you wrote.
 */
function AskContact({
  space,
  did,
  name,
  onAsked,
}: {
  space: SpaceSummary;
  did: string;
  name: string;
  onAsked: (result: { readonly carried: boolean }) => void;
}) {
  const node = useNode();
  const [note, setNote] = useState('');
  const { run, busy: asking, error } = useAction();
  const ask = () =>
    run(async () => {
      onAsked(
        await withChat(node, node.contacts.ask(space.id, did, note.trim() ? { note: note.trim() } : {})),
      );
    });
  return (
    <form
      className="stack"
      onSubmit={(event) => {
        event.preventDefault();
        void ask();
      }}
    >
      <small>
        Adding {name} makes a private space for the two of you and leaves its invite here, sealed so only they
        can open it. Others in {space.name} see that you asked, not what you wrote.
      </small>
      <label>
        A note (optional)
        <textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={2000} rows={3} />
      </label>
      {error && <p role="alert">{error}</p>}
      <button data-intent="primary" type="submit" disabled={asking}>
        {asking ? 'Asking…' : 'Add as a contact'}
      </button>
    </form>
  );
}
