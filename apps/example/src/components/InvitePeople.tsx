import { useState } from 'react';
import type { ContactView, SpaceSummary } from '@minca/core';
import { useAsync, useNode } from '@minca/react';
import { Modal } from '@minca/app-shared/Modal';
import { message } from '@minca/app-shared/action';
import { Shape } from '@minca/app-shared/shapes';
import { markFor } from '@minca/ui/shapes';
import { palette, styles } from '../styles';
import { invitableRoles, useContacts } from '../contacts';
import { useUsernameLookup } from '../usernames';
import { AddButton } from './Buttons';
import { AddDialog, Handle, PersonRow } from './PeopleParts';

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
 * Adding people to a space the way a group chat does: tick contacts, choose
 * what they join as, and send; each finds the invite in your space for two.
 * Someone found by username who isn't a contact yet is asked to be one first:
 * nobody gets into a space before you have seen who they are.
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
  const contacts = useContacts();
  const roles = useAsync(() => invitableRoles(node, space.id), [node, space.id]);
  const offered = roles.status === 'done' ? roles.value : [];
  // Undefined until chosen: the first role offered; '' for viewing only.
  const [role, setRole] = useState<string>();
  const chosenRole = role === undefined ? (offered[0] ?? null) : role || null;
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
    const options = chosenRole ? { role: chosenRole } : {};
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
    if (invited === 0 && waiting.length > 0) {
      setError(`${waiting.join(', ')} haven't accepted your contact request yet, so they can't be invited.`);
      return;
    }
    setDone(
      `Invited ${invited === 1 ? 'one person' : `${invited} people`}. They find it with their invites.` +
        (waiting.length > 0 ? ` ${waiting.join(', ')} haven't accepted your contact request yet.` : ''),
    );
  };

  if (done)
    return (
      <Modal title={`Add people to ${space.name}`} onClose={onClose}>
        <p style={{ fontSize: 15, color: ink.strong, lineHeight: 1.5 }}>{done}</p>
        <AddButton onClick={onClose} style={{ marginTop: 16, height: 40 }}>
          Done
        </AddButton>
      </Modal>
    );

  if (asking)
    return (
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
    );

  return (
    <Modal title={`Add people to ${space.name}`} onClose={onClose} width={520}>
      <input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search contacts, or type a username"
        aria-label="Search contacts, or type a username"
        autoFocus
        style={{ ...styles.input, height: 42, marginBottom: 10 }}
      />
      <ul style={{ padding: 0, margin: 0, maxHeight: 320, overflowY: 'auto' }}>
        {found && (
          <PersonRow
            face={found.username}
            name={found.found.inbox.name ?? <Handle username={found.username} />}
            detail={<>{found.username} · not a contact yet</>}
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
        {contacts !== undefined && shown.length === 0 && !found && (
          <li style={{ listStyle: 'none', padding: '18px 4px', fontSize: 14, color: ink.muted }}>
            {q
              ? lookup.status === 'looking'
                ? 'Looking…'
                : 'No contact by that name, and nobody with that username.'
              : candidates.length === 0
                ? 'Everyone in your contacts is here already. Type a username to add someone new.'
                : ''}
          </li>
        )}
      </ul>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, color: ink.body }}>
          Joins as
          <select
            value={chosenRole ?? ''}
            onChange={(event) => setRole(event.target.value)}
            style={{ ...styles.input, width: 'auto', height: 34, fontSize: 13 }}
          >
            {offered.map((name) => (
              <option key={name} value={name}>
                {titled(name)}
              </option>
            ))}
            <option value="">Viewer</option>
          </select>
        </label>
        <span style={{ flex: 1 }} />
        <AddButton onClick={() => void send()} disabled={picked.size === 0 || sending} style={{ height: 40 }}>
          {sending ? 'Inviting…' : picked.size === 0 ? 'Invite' : `Invite ${picked.size}`}
        </AddButton>
      </div>
      {error && <p style={{ ...styles.bad, marginTop: 10 }}>{error}</p>}
    </Modal>
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
