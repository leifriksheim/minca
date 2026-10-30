import { useState, type ReactNode } from 'react';
import type { ContactView, SpaceSummary } from '@minca/core';
import { useAsync, useNode } from '@minca/react';
import { Modal } from '@minca/app-shared/Modal';
import { message, useCopy } from '@minca/app-shared/action';
import { createInviteLink } from '../spaces';
import { Shape } from '@minca/app-shared/shapes';
import { markFor } from '@minca/ui/shapes';
import { palette, styles, ui } from '../styles';
import { invitableRoles, useContacts } from '../contacts';
import { shortUsername, useUsernameLookup } from '@minca/app-shared/usernames';
import { AddButton } from './Buttons';
import { Icon } from './Icon';
import { AddDialog, Handle, PersonRow } from './PeopleParts';
import { usePopover } from './usePopover';

const { ink, surface, radius } = palette;

/** A role's name as people read it: `member` → Member */
const titled = (role: string) => role.charAt(0).toUpperCase() + role.slice(1).replace(/-/g, ' ');

/**
 * Inviting one contact into one of your spaces, from their row: pick the
 * space, and they find the invite waiting, as the first role you may give
 * there, or to view when you may give none.
 */
export function InviteToSpace({
  contact,
  spaces,
  onClose,
  onDone,
}: {
  contact: ContactView;
  /** The spaces to offer: yours to write in, not spaces for two */
  spaces: ReadonlyArray<SpaceSummary>;
  onClose: () => void;
  onDone: (notice: string) => void;
}) {
  const node = useNode();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const invite = async (space: SpaceSummary) => {
    setBusy(space.id);
    setError(null);
    try {
      const [role] = await invitableRoles(node, space.id);
      await node.contacts.invite(contact.did, space.id, role ? { role } : {});
      onDone(`${contact.name} is invited to ${space.name}${role ? ` as ${titled(role)}` : ', to view'}.`);
    } catch (reason) {
      setError(message(reason));
      setBusy(null);
    }
  };
  return (
    <Modal title={`Invite ${contact.name} to…`} onClose={onClose}>
      {spaces.length === 0 ? (
        <p style={{ fontSize: 14, color: ink.muted }}>You have no spaces to invite anyone to yet.</p>
      ) : (
        <ul style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 0, margin: 0 }}>
          {spaces.map((space) => {
            const mark = markFor(space.id);
            return (
              <li key={space.id} style={{ listStyle: 'none' }}>
                <button
                  onClick={() => void invite(space)}
                  disabled={busy !== null}
                  data-menu-item
                  style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '8px 10px',
                    border: `1px solid ${surface.line}`,
                    borderRadius: radius.md,
                    background: surface.card,
                    textAlign: 'left',
                  }}
                >
                  <span style={{ position: 'relative', display: 'grid', placeItems: 'center' }}>
                    <Shape kind={mark.kind} colour={mark.colour} size={34} />
                    <span style={letterOnShape}>{space.name.charAt(0).toUpperCase()}</span>
                  </span>
                  <span style={{ flex: 1, fontSize: 15, fontWeight: 600, color: ink.strong }}>
                    {space.name}
                  </span>
                  <span style={{ fontSize: 13, color: palette.accent.base, fontWeight: 600 }}>
                    {busy === space.id ? 'Inviting…' : 'Invite'}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {error && <p style={{ ...styles.bad, marginTop: 10 }}>{error}</p>}
      <p style={{ fontSize: 13, lineHeight: 1.5, color: ink.muted, marginTop: 12 }}>
        The invite waits in your private space with {contact.name}.
      </p>
    </Modal>
  );
}

const letterOnShape = {
  position: 'absolute',
  fontSize: 14,
  fontWeight: 700,
  color: surface.card,
  pointerEvents: 'none',
} as const;

/**
 * Adding people to a space the way a group chat does, as a dialog over the chat a new group opens in:
 * what they join as, your contacts to tick, and a link for anyone else.
 */
export function AddPeople({
  space,
  members,
  onClose,
}: {
  space: SpaceSummary;
  /** Who is in the space already, so they aren't offered */
  members: ReadonlySet<string>;
  onClose: () => void;
}) {
  const node = useNode();
  const { offered, role, setRole } = useJoinsAs(space);
  // The link's own, so changing it never changes what the contacts above join as.
  const { role: linkRole, setRole: setLinkRole } = useJoinsAs(space);
  const { copied, copy } = useCopy();
  const [making, setMaking] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // For anyone who isn't a contact yet: a link that joins as the role chosen. Shown as well as copied,
  // since a phone may not let a page copy once it has waited for something.
  const copyLink = async () => {
    setMaking(true);
    setError(null);
    try {
      const made = await createInviteLink(node, space.id, linkRole);
      setLink(made);
      copy(made);
    } catch (reason) {
      setError(message(reason));
    }
    setMaking(false);
  };

  return (
    <Modal title={`Add people to ${space.name}`} onClose={onClose} width={520}>
      <ContactPicker
        space={space}
        members={members}
        role={role}
        autoFocus
        beside={<JoinsAs offered={offered} role={role} onChange={setRole} />}
      />
      <div style={{ height: 1, background: palette.surface.line, margin: '16px 0 4px' }} />
      {/* Anyone who isn't a contact gets a link, made for one role, which it says. */}
      <div style={linkRow}>
        <span style={linkBadge} aria-hidden>
          <Icon name="link" size={16} />
        </span>
        <span style={{ display: 'flex', flexDirection: 'column', gap: 1, flex: 1, minWidth: 0 }}>
          <strong style={{ fontSize: 15, fontWeight: 600, color: ink.strong }}>Invite with a link</strong>
          <span style={{ fontSize: 13, color: ink.muted }}>
            {copied ? (
              'Copied. Send it to the people it is for.'
            ) : (
              <>
                Joins as <strong style={{ color: ink.body }}>{linkRole ? titled(linkRole) : 'Viewer'}</strong>{' '}
                ·{' '}
                <ChangeRole
                  offered={offered}
                  role={linkRole}
                  onChange={(next) => {
                    setLinkRole(next);
                    setLink(null); // a link made for the other role would say the wrong thing
                  }}
                />
              </>
            )}
          </span>
        </span>
        <button onClick={() => void copyLink()} disabled={making} data-variant="ghost" style={copyButton}>
          {making ? 'Making…' : copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {link && (
        <input
          readOnly
          value={link}
          onFocus={(event) => event.target.select()}
          aria-label="Invite link"
          style={{ ...styles.input, height: 38, fontSize: 13, marginTop: 8 }}
        />
      )}
      {error && <p style={{ ...styles.bad, marginTop: 10 }}>{error}</p>}
    </Modal>
  );
}

const linkRow = { display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0' } as const;
const copyButton = {
  flexShrink: 0,
  padding: '6px 4px',
  border: 'none',
  background: 'none',
  fontSize: 14,
  fontWeight: 600,
  color: palette.accent.base,
} as const;

/** A quiet "change" beside the role a link gives, which lists the roles to pick from */
function ChangeRole({
  offered,
  role,
  onChange,
}: {
  offered: ReadonlyArray<string>;
  role: string | null;
  onChange: (role: string | null) => void;
}) {
  const { open, setOpen, close, root } = usePopover();
  const choices: ReadonlyArray<string | null> = [...offered, null];
  return (
    <span ref={root} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen((was) => !was)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="quiet-link"
      >
        Change
      </button>
      {open && (
        <span role="menu" style={roleMenu}>
          {choices.map((choice) => (
            <button
              key={choice ?? ''}
              role="menuitemradio"
              aria-checked={choice === role}
              data-menu-item
              onClick={() => {
                close();
                onChange(choice);
              }}
              style={roleItem}
            >
              {choice ? titled(choice) : 'Viewer'}
              {choice === role && <Icon name="check" size={14} />}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

const roleMenu = {
  ...styles.float,
  position: 'absolute',
  left: 0,
  // Upward: the row is the last thing in its dialog.
  bottom: 'calc(100% + 6px)',
  zIndex: 30,
  width: 180,
  padding: 6,
  display: 'flex',
  flexDirection: 'column',
} as const;
const roleItem = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  height: 36,
  padding: '0 10px',
  border: 'none',
  borderRadius: radius.md,
  background: 'none',
  fontSize: 14,
  color: ink.body,
  textAlign: 'left',
} as const;
const linkBadge = {
  width: 40,
  height: 40,
  flexShrink: 0,
  display: 'grid',
  placeItems: 'center',
  borderRadius: radius.pill,
  background: surface.sunken,
  color: ink.strong,
} as const;

/** The roles you may give here, `member` first, and the one picked: the first, until another is; null to view only */
export function useJoinsAs(space: SpaceSummary) {
  const node = useNode();
  const roles = useAsync(() => invitableRoles(node, space.id), [node, space.id]);
  const offered = roles.status === 'done' ? roles.value : [];
  // Undefined until chosen; '' for viewing only.
  const [picked, setPicked] = useState<string>();
  const role = picked === undefined ? (offered[0] ?? null) : picked || null;
  return { offered, role, setRole: (next: string | null) => setPicked(next ?? '') };
}

/** What someone you invite joins as */
export function JoinsAs({
  offered,
  role,
  onChange,
}: {
  offered: ReadonlyArray<string>;
  role: string | null;
  onChange: (role: string | null) => void;
}) {
  return (
    <label
      style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, color: ink.muted, minWidth: 0 }}
    >
      Joins as
      <select
        value={role ?? ''}
        onChange={(event) => onChange(event.target.value || null)}
        style={{
          ...styles.input,
          width: 'auto',
          flex: 'none',
          height: 36,
          minHeight: 36,
          padding: '0 32px 0 14px',
          fontSize: 14,
        }}
      >
        {offered.map((name) => (
          <option key={name} value={name}>
            {titled(name)}
          </option>
        ))}
        <option value="">Viewer</option>
      </select>
    </label>
  );
}

/**
 * Your contacts who aren't in the space yet, to tick and invite as `role`; each finds the invite in
 * your space for two. Someone found by username who isn't a contact yet is asked to be one first:
 * nobody gets into a space before you have seen who they are.
 */
export function ContactPicker({
  space,
  members,
  role,
  autoFocus,
  beside,
}: {
  space: SpaceSummary;
  members: ReadonlySet<string>;
  role: string | null;
  autoFocus?: boolean;
  /** Beside the Invite button: what they join as, when it is chosen here */
  beside?: ReactNode;
}) {
  const node = useNode();
  const contacts = useContacts();
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [asking, setAsking] = useState<{ username: string; name?: string } | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const lookup = useUsernameLookup(query);

  const candidates = (contacts ?? []).filter((c) => !c.blocked && c.space && !members.has(c.did));
  const q = query.trim().toLowerCase().replace(/^@/, '');
  const shown = q
    ? candidates.filter((c) => c.name.toLowerCase().includes(q) || c.username?.includes(q))
    : candidates;
  // Someone found by username who isn't a contact: asked to be one, and invited once they are.
  const found =
    lookup.status === 'found' && !(contacts ?? []).some((c) => c.username === lookup.username)
      ? lookup
      : null;

  const toggle = (did: string) =>
    setPicked((was) => {
      const next = new Set(was);
      if (next.has(did)) next.delete(did);
      else next.add(did);
      return next;
    });

  const send = async () => {
    setSending(true);
    setError(null);
    setDone(null);
    const options = role ? { role } : {};
    const waiting: string[] = [];
    let invited = 0;
    for (const did of picked) {
      const contact = candidates.find((c) => c.did === did);
      if (!contact) continue;
      try {
        await node.contacts.invite(did, space.id, options);
        invited += 1;
      } catch {
        waiting.push(contact.name);
      }
    }
    setSending(false);
    setPicked(new Set());
    if (invited === 0 && waiting.length > 0) {
      setError(`${waiting.join(', ')} haven't accepted your contact request yet, so they can't be invited.`);
      return;
    }
    setDone(
      `Invited ${invited === 1 ? 'one person' : `${invited} people`}. They find it with their invites.` +
        (waiting.length > 0 ? ` ${waiting.join(', ')} haven't accepted your contact request yet.` : ''),
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search contacts, or type a username"
        aria-label="Search contacts, or type a username"
        autoFocus={autoFocus}
        style={{ ...styles.input, height: 42 }}
      />
      {(found || shown.length > 0) && (
        <ul className="rows" style={{ ...ui.list, maxHeight: 360, overflowY: 'auto' }}>
          {found && (
            <PersonRow
              face={found.username}
              name={found.found.inbox.name ?? <Handle username={found.username} />}
              detail={<>@{shortUsername(found.username)} · not a contact yet</>}
            >
              <AddButton
                onClick={() =>
                  setAsking({
                    username: found.username,
                    ...(found.found.inbox.name ? { name: found.found.inbox.name } : {}),
                  })
                }
                style={{ height: 32 }}
              >
                Add contact
              </AddButton>
            </PersonRow>
          )}
          {shown.map((contact) => (
            <PersonRow
              key={contact.did}
              face={contact.did}
              name={contact.name}
              detail={contact.username ? <Handle username={contact.username} /> : 'Contact'}
            >
              <Tick
                checked={picked.has(contact.did)}
                onChange={() => toggle(contact.did)}
                label={contact.name}
              />
            </PersonRow>
          ))}
        </ul>
      )}
      {contacts !== undefined && shown.length === 0 && !found && (
        <p style={{ fontSize: 14, lineHeight: 1.5, color: ink.muted }}>
          {q
            ? lookup.status === 'looking'
              ? 'Looking…'
              : 'No contact by that name, and nobody with that username.'
            : (contacts ?? []).some((c) => !c.blocked && c.space)
              ? 'Everyone in your contacts is here already. Type a username to add someone new.'
              : 'No contacts yet. Type a username to find someone, or send an invite link.'}
        </p>
      )}
      {done && <p style={{ fontSize: 14, lineHeight: 1.5, color: ink.strong }}>{done}</p>}
      {error && <p style={styles.bad}>{error}</p>}
      {(candidates.length > 0 || beside) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {beside}
          <span style={{ flex: 1 }} />
          {candidates.length > 0 && (
            <AddButton
              onClick={() => void send()}
              disabled={picked.size === 0 || sending}
              style={{ height: 40 }}
            >
              {sending ? 'Inviting…' : picked.size === 0 ? 'Invite' : `Invite ${picked.size}`}
            </AddButton>
          )}
        </div>
      )}
      {asking && (
        <AddDialog
          username={asking.username}
          {...(asking.name ? { name: asking.name } : {})}
          onClose={() => setAsking(null)}
          onSent={(text) => {
            setAsking(null);
            setQuery('');
            setDone(`${text} Invite them here once they have.`);
          }}
        />
      )}
    </div>
  );
}

function Tick({ checked, onChange, label }: { checked: boolean; onChange: () => void; label?: string }) {
  return (
    <input
      type="checkbox"
      checked={checked}
      onChange={onChange}
      aria-label={label ? `Invite ${label}` : 'Invite'}
      style={{ ...styles.checkbox, width: 20, height: 20 }}
    />
  );
}
