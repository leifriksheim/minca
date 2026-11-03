import { useState, type ReactNode } from 'react';
import type { SpaceSummary } from '@minca/core';
import { useAction, useCopy } from '@minca/app-shared/action';
import { Modal } from '@minca/app-shared/Modal';
import { useAccess, useNode } from '@minca/react';
import type { ShapeKind } from '@minca/ui/shapes';
import { createInviteLink, madeLinks } from '../spaces';
import { confirmThen } from '../confirm';
import { ContactPicker, JoinsAs, useJoinsAs } from './InvitePeople';
import { Loader } from '@minca/app-shared/Loader';
import { Options, type Option } from './Options';

/**
 * `/spaces/<id>/invite`: bringing people in. Your contacts get the invite in your space for two,
 * as the role picked beside them; anyone else gets a link, made for one role, which works until it
 * is closed.
 */
export function InviteView({ space }: { space: SpaceSummary }) {
  const access = useAccess(space.id);
  const { offered, role, setRole } = useJoinsAs(space);
  const [making, setMaking] = useState(false);
  if (!access)
    return (
      <p className="empty">
        <Loader label="Loading who's here" showLabel />
      </p>
    );
  const members = new Set(access.members.map((member) => member.did));
  const titleOf = (name: string) => access.roles.find((r) => r.name === name)?.title ?? titled(name);

  return (
    <div className="stack" data-gap="loose">
      <Section title="Your contacts" action={<JoinsAs offered={offered} role={role} onChange={setRole} />}>
        <ContactPicker space={space} members={members} role={role} />
      </Section>

      <Section
        title="Invite links"
        action={
          <button data-intent="primary" onClick={() => setMaking(true)}>
            Create link
          </button>
        }
      >
        <small>For anyone who isn't a contact yet. Anyone with the link can join, until you close it.</small>
        <OpenLinks
          space={space}
          open={access.invites.filter((invite) => invite.open)}
          offered={offered}
          titleOf={titleOf}
        />
      </Section>

      {making && (
        <MakeLink space={space} offered={offered} titleOf={titleOf} onClose={() => setMaking(false)} />
      )}
    </div>
  );
}

/** The usual roles, from least say to most: what each lets someone do, in a few words, and its shape */
const USUAL: ReadonlyArray<{ name: string; shape: ShapeKind; about: string }> = [
  { name: 'member', shape: 'dots', about: 'Adds things, and changes only their own.' },
  { name: 'editor', shape: 'flower', about: 'Changes anything, and invites more editors.' },
  { name: 'moderator', shape: 'shield', about: 'Changes or removes anything, to keep things tidy.' },
  { name: 'steward', shape: 'group', about: 'Runs it with the other stewards.' },
  { name: 'admin', shape: 'star', about: 'Runs the group with you: roles, people and settings.' },
];
/** Where a role goes in the list: the usual ones in their order, then the space's own */
const rank = (name: string) => {
  const at = USUAL.findIndex((usual) => usual.name === name);
  return at === -1 ? USUAL.length : at;
};

/** A role's name as people read it: `member` → Member */
const titled = (role: string) => role.charAt(0).toUpperCase() + role.slice(1).replace(/-/g, ' ');

/** What a link made to view only is picked by: no role has this name, since a role's name has no space in it */
const VIEW = 'view only';

/** Making one link: who it is for, then the link to copy */
function MakeLink({
  space,
  offered,
  titleOf,
  onClose,
}: {
  space: SpaceSummary;
  offered: ReadonlyArray<string>;
  titleOf: (role: string) => string;
  onClose: () => void;
}) {
  const node = useNode();
  // The least say first: someone you invite by link can always be given more.
  const [picked, setPicked] = useState(() => [...offered].sort((x, y) => rank(x) - rank(y))[0] ?? VIEW);
  const [link, setLink] = useState<string | null>(null);
  const { run, busy, error } = useAction();
  const { copied, copy } = useCopy();
  const options: ReadonlyArray<Option<string>> = [
    ...[...offered]
      .sort((x, y) => rank(x) - rank(y))
      .map((name) => {
        const usual = USUAL.find((one) => one.name === name);
        return {
          value: name,
          shape: usual?.shape ?? 'daisy',
          title: titleOf(name),
          detail: usual?.about ?? 'Can do what this space’s role grants.',
        };
      }),
    { value: VIEW, shape: 'half', title: 'Viewer', detail: 'Sees everything, changes nothing.' },
  ];
  const make = () =>
    run(async () => {
      const made = await createInviteLink(node, space.id, picked === VIEW ? null : picked);
      setLink(made);
      copy(made);
    });

  if (link)
    return (
      <Modal title="Your invite link" onClose={onClose}>
        <>
          <p>
            {copied ? 'Copied. ' : ''}Send it to the people it is for. They join as{' '}
            <strong>{picked === VIEW ? 'Viewer' : titleOf(picked)}</strong>.
            {space.visibility === 'private' && ' It carries the space’s key, so keep it to them.'}
          </p>
          <pre>{link}</pre>
          <div className="row">
            <button data-intent="ghost" onClick={() => copy(link)}>
              {copied ? 'Copied' : 'Copy link'}
            </button>
            <button data-intent="primary" onClick={onClose}>
              Done
            </button>
          </div>
        </>
      </Modal>
    );

  return (
    <Modal title="Who is this link for?" onClose={onClose}>
      <Options label="They join as" options={options} picked={picked} onPick={setPicked} />
      {error && <p role="alert">{error}</p>}
      <button data-intent="primary" onClick={() => void make()} disabled={busy}>
        {busy ? 'Making a link…' : 'Create link'}
      </button>
    </Modal>
  );
}

/** The links still open, to copy again or close */
function OpenLinks({
  space,
  open,
  offered,
  titleOf,
}: {
  space: SpaceSummary;
  open: ReadonlyArray<{ readonly key: string; readonly role: string }>;
  offered: ReadonlyArray<string>;
  titleOf: (role: string) => string;
}) {
  const node = useNode();
  const { run, error } = useAction();
  // Only this device has a link to copy again: the space keeps an invite's key, never its link.
  const links = madeLinks(space.id);
  const close = (key: string) =>
    confirmThen(
      'Nobody new can join with it. People who already joined keep their role.',
      { title: 'Close this invite link?', yes: 'Close it' },
      () => run(() => node.spaces.closeInvite(space.id, key)),
    );
  if (open.length === 0) return null;
  return (
    <>
      <ul role="list">
        {open.map((invite) => {
          const link = links[invite.key];
          const mayClose = offered.includes(invite.role);
          return (
            <li key={invite.key} className="row" data-spread>
              <span className="stack" data-gap="tight">
                <span>
                  Joins as <strong>{titleOf(invite.role)}</strong>
                </span>
                <small>
                  {link ? 'Made on this device' : 'Made elsewhere: close it, or make a new one to share'}
                </small>
              </span>
              {link && <CopyButton text={link} />}
              <button
                data-intent="ghost"
                onClick={() => close(invite.key)}
                disabled={!mayClose}
                title={mayClose ? undefined : 'Closing it takes a grant of /role/assign for its role'}
              >
                Close
              </button>
            </li>
          );
        })}
      </ul>
      {error && <p role="alert">{error}</p>}
    </>
  );
}

/** Copies a link, and says so for a moment */
function CopyButton({ text }: { text: string }) {
  const { copied, copy } = useCopy();
  return (
    <button data-intent="ghost" onClick={() => copy(text)}>
      {copied ? 'Copied' : 'Copy link'}
    </button>
  );
}

/** A section's title, with what is done in it on the right */
function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={title}>
      <header>
        <h2>{title}</h2>
        {action}
      </header>
      {children}
    </section>
  );
}
