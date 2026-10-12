import { useState, type CSSProperties } from 'react';
import { useAction } from '@weave/app-shared/action';
import { MEMBER_REMOVE, ROLE_ASSIGN, ROLE_DEFINE, ROLE_UNASSIGN } from '@weaveprotocol/core';
import type { SpaceGrant as Grant, NodeCollection, SpaceSummary } from '@weaveprotocol/core';
import { useAccess, useAccount, useLive, useNode, useProfiles } from '@weaveprotocol/core/react';
import {
  abilitiesOf,
  choicesIn,
  GRANT_CHOICES,
  grantLines,
  grantsOf,
  type RoleView,
} from '../derive/abilities';
import { nameOf, peopleFrom, type People } from '../derive/people';
import { Avatar } from '@weave/app-shared/Avatar';
import { RingButton } from './calls/Calls';
import { createInviteLink } from '../spaces';
import { styles, palette, variants } from '../styles';
import { Person } from './Person';

/** Your own name, renamed in place on the account, so every space you are in gets it */
function MyName({ name }: { name: string }) {
  const node = useNode();
  const [draft, setDraft] = useState<string | null>(null);
  const save = async () => {
    const trimmed = draft?.trim();
    setDraft(null);
    if (trimmed && trimmed !== name) await node.account.setName(trimmed).catch(() => {});
  };
  if (draft === null) {
    return (
      <button
        onClick={() => setDraft(name)}
        data-variant="ghost"
        title="Rename — everyone in your spaces sees this name"
        style={{ ...styles.linkButton, fontSize: 14, color: palette.ink.strong }}
      >
        {name}
      </button>
    );
  }
  return (
    <input
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => void save()}
      onKeyDown={(event) => {
        if (event.key === 'Enter') void save();
        if (event.key === 'Escape') setDraft(null);
      }}
      autoFocus
      maxLength={64}
      aria-label="Your name"
      style={{ ...styles.input, height: 26, minHeight: 26, width: 160, padding: '0 6px', fontSize: 14 }}
    />
  );
}

/** Who holds what in the space, as the node reports it */
type SpaceAccess = NonNullable<ReturnType<typeof useAccess>>;

/**
 * What this account may change here, asked of the node, which judges the
 * space's grants as every peer does: which roles it may define, give to
 * whom and take from whom, whom it may remove, and which roles an invite may
 * give.
 */
interface Powers {
  readonly define: ReadonlySet<string>;
  readonly defineNew: boolean;
  readonly invite: ReadonlyArray<string>;
  readonly assign: ReadonlyMap<string, ReadonlySet<string>>;
  readonly unassign: ReadonlyMap<string, ReadonlySet<string>>;
  readonly remove: ReadonlySet<string>;
}

const NO_POWERS: Powers = {
  define: new Set(),
  defineNew: false,
  invite: [],
  assign: new Map(),
  unassign: new Map(),
  remove: new Set(),
};

function usePowers(spaceId: string, me: string): Powers {
  return (
    useLive(
      spaceId,
      async (node): Promise<Powers> => {
        const access = await node.spaces.access(spaceId);
        const may = (cmd: string, args: Record<string, unknown>) => node.spaces.may(spaceId, cmd, args);
        const names = access.roles.map((r) => r.name);
        const define = new Set<string>();
        for (const name of names) if (await may(ROLE_DEFINE, { role: name })) define.add(name);
        const invite: string[] = [];
        for (const name of names)
          if (await may(ROLE_ASSIGN, { role: name, self: false, roles: [] })) invite.push(name);
        const assign = new Map<string, Set<string>>();
        const unassign = new Map<string, Set<string>>();
        const remove = new Set<string>();
        for (const member of access.members) {
          const self = member.did === me;
          const args = { self, roles: member.roles };
          // Anyone may leave, a founder too; no one else removes a founder.
          if (self || (!member.founder && (await may(MEMBER_REMOVE, args)))) remove.add(member.did);
          const gives = new Set<string>();
          const takes = new Set<string>();
          for (const name of names) {
            if (!member.roles.includes(name) && (await may(ROLE_ASSIGN, { ...args, role: name })))
              gives.add(name);
            if (member.roles.includes(name) && (self || (await may(ROLE_UNASSIGN, { ...args, role: name }))))
              takes.add(name);
          }
          assign.set(member.did, gives);
          unassign.set(member.did, takes);
        }
        return {
          define,
          defineNew: await may(ROLE_DEFINE, { role: 'new-role' }),
          invite: invite.sort((a, b) => Number(b === 'member') - Number(a === 'member')),
          assign,
          unassign,
          remove,
        };
      },
      [me],
    ) ?? NO_POWERS
  );
}

/** Who may do what in a space: its people and the roles assigned them, and what each role grants */
export function RolesView({
  space,
  collections: _collections,
}: {
  space: SpaceSummary;
  collections: ReadonlyArray<NodeCollection>;
}) {
  const access = useAccess(space.id);
  const account = useAccount();
  const people = peopleFrom(useProfiles(space.id));
  const powers = usePowers(space.id, account.did);
  if (!access) return <p style={{ fontSize: 13, color: palette.ink.faint }}>Loading who's who…</p>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 36 }}>
      <Members space={space} access={access} me={account.did} people={people} powers={powers} />
      <Roles space={space} access={access} powers={powers} />
      <WhatYouCanDo access={access} />
    </div>
  );
}

/** Node errors are written about "its author" — this is about you */
function plainError(text: string): string {
  return text
    .replace(/^Its author/, 'You')
    .replace(/\btheir own\b/g, 'your own')
    .replace(/\bthey do not hold\b/g, "you don't hold");
}

const titleOf = (role: { readonly name: string; readonly title?: string }) => role.title ?? role.name;

// ─── What you can do ──────────────────────────────────────────────────

function WhatYouCanDo({ access }: { access: SpaceAccess }) {
  const { summary, lines } = abilitiesOf(access);
  return (
    <section style={section} aria-label="What you can do">
      <h2 style={{ ...styles.appTitle, fontSize: 20 }}>What you can do</h2>
      <p style={{ fontSize: 14, color: palette.ink.body }}>{summary}</p>
      {lines.length > 0 && (
        <ul style={list}>
          {lines.map((line) => (
            <li key={line} style={item}>
              <span style={{ color: palette.accent.good }}>✓</span>{' '}
              <span style={{ color: palette.ink.strong }}>{capital(line)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

// ─── Roles ────────────────────────────────────────────────────────────

/** Where a role being edited sits: one being made, or the name of one being changed */
type Editing = { readonly kind: 'new' } | { readonly kind: 'edit'; readonly name: string } | null;

function Roles({ space, access, powers }: { space: SpaceSummary; access: SpaceAccess; powers: Powers }) {
  const [editing, setEditing] = useState<Editing>(null);
  const roles = [...access.roles].sort((a, b) => a.name.localeCompare(b.name));
  const holders = (name: string) => access.members.filter((m) => m.roles.includes(name)).length;

  return (
    <section style={section} aria-label="Roles">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <h2 style={{ ...styles.appTitle, fontSize: 20 }}>Roles</h2>
        <button
          onClick={() => setEditing({ kind: 'new' })}
          disabled={!powers.defineNew || editing?.kind === 'new'}
          title={powers.defineNew ? undefined : 'Defining roles takes a grant of /role/define'}
          data-variant="quiet"
          style={styles.smallButton}
        >
          New role
        </button>
      </div>
      <p style={{ fontSize: 13, color: palette.ink.muted, lineHeight: 1.5 }}>
        A role is what it grants. Whoever defines a role can give it only what they may do themselves.
      </p>

      {editing?.kind === 'new' && (
        <RoleEditor space={space} existing={null} roles={roles} onDone={() => setEditing(null)} />
      )}

      <ul style={{ ...list, gap: 8 }}>
        {roles.map((role) => {
          const may = powers.define.has(role.name);
          const count = holders(role.name);
          const open = editing?.kind === 'edit' && editing.name === role.name;
          const { grants, rivals } = grantsOf(role);
          return (
            <li key={role.name} style={card}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                    <strong style={{ color: palette.ink.strong, fontSize: 15 }}>{titleOf(role)}</strong>
                    {access.mine.includes(role.name) && <span style={styles.badge}>yours</span>}
                    <span style={{ fontSize: 12, color: palette.ink.faint }}>
                      <code>{role.name}</code> · {count} {count === 1 ? 'person' : 'people'}
                    </span>
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {grants.length === 0 ? (
                      <span style={{ fontSize: 12, color: palette.ink.faint }}>Grants nothing</span>
                    ) : (
                      grantLines(grants).map((line) => (
                        <span key={line} style={chip}>
                          {line}
                        </span>
                      ))
                    )}
                  </div>
                  {rivals && (
                    <span style={{ fontSize: 12, color: palette.ink.faint }}>
                      Defined twice apart: it grants only what both definitions share, until someone defines
                      it again.
                    </span>
                  )}
                </div>
                <button
                  onClick={() => setEditing(open ? null : { kind: 'edit', name: role.name })}
                  disabled={!may}
                  title={may ? undefined : 'Defining this role takes a grant of /role/define for it'}
                  data-variant="quiet"
                  style={styles.smallButton}
                >
                  {open ? 'Close' : 'Edit'}
                </button>
              </div>
              {open && (
                <RoleEditor space={space} existing={role} roles={roles} onDone={() => setEditing(null)} />
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** "Content writer" → "content-writer": a role's key, from its title */
const slug = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+|-+$/g, '')
    .slice(0, 40);

/** Making a role, or changing one: its title, and what it grants */
function RoleEditor({
  space,
  existing,
  roles,
  onDone,
}: {
  space: SpaceSummary;
  existing: RoleView | null;
  roles: ReadonlyArray<RoleView>;
  onDone: () => void;
}) {
  const node = useNode();
  const held = existing ? grantsOf(existing) : { grants: [], rivals: false };
  const start = choicesIn(held.grants);
  const nests = existing?.definitions[0]?.nests ?? [];
  const [title, setTitle] = useState(existing?.title ?? existing?.name ?? '');
  const [chosen, setChosen] = useState<ReadonlySet<string>>(start.chosen);
  const [keepOther, setKeepOther] = useState(true);
  const { run, busy: saving, error } = useAction();

  const name = existing?.name ?? slug(title);
  const problem = !title.trim()
    ? 'Give it a title'
    : !name
      ? 'The title needs at least one letter or number'
      : !existing && roles.some((r) => r.name === name)
        ? `There's already a role called “${name}”`
        : null;

  const toggle = (key: string, on: boolean) => {
    const next = new Set(chosen);
    if (on) next.add(key);
    else next.delete(key);
    setChosen(next);
  };

  const save = () =>
    run(async () => {
      const grants: Grant[] = [
        ...GRANT_CHOICES.filter((c) => chosen.has(c.key)).flatMap((c) => c.grants),
        ...(keepOther ? start.other : []),
      ];
      await node.spaces.defineRole(space.id, {
        name,
        ...(title.trim() ? { title: title.trim() } : {}),
        grants,
        ...(nests.length ? { nests } : {}),
      });
      onDone();
    });

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        marginTop: existing ? 14 : 0,
        padding: 16,
        borderRadius: palette.radius.md,
        background: palette.surface.sunken,
        border: `1px solid ${palette.surface.line}`,
      }}
    >
      {!existing && <strong style={{ color: palette.ink.strong }}>New role</strong>}
      <label>
        <p style={styles.fieldLabel}>Title</p>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Reviewer"
          maxLength={80}
          style={styles.input}
          autoFocus={!existing}
        />
        <p style={{ fontSize: 12, color: palette.ink.faint, marginTop: 4 }}>
          {existing ? 'Its key stays ' : 'Its key will be '}
          <code>{name || '…'}</code>
        </p>
      </label>

      <fieldset
        style={{ border: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 6 }}
      >
        <legend style={{ ...styles.fieldLabel, padding: 0 }}>What it grants</legend>
        {GRANT_CHOICES.map((c) => (
          <label key={c.key} style={{ ...styles.checkboxRow, alignItems: 'flex-start' }}>
            <input
              type="checkbox"
              checked={chosen.has(c.key)}
              onChange={(e) => toggle(c.key, e.target.checked)}
              style={styles.checkbox}
            />
            <span style={{ color: palette.ink.strong, fontSize: 13 }}>{c.label}</span>
          </label>
        ))}
        {start.other.length > 0 && (
          <label style={{ ...styles.checkboxRow, alignItems: 'flex-start' }}>
            <input
              type="checkbox"
              checked={keepOther}
              onChange={(e) => setKeepOther(e.target.checked)}
              style={styles.checkbox}
            />
            <span style={{ color: palette.ink.muted, fontSize: 12 }}>
              Keep its other grants: {grantLines(start.other).join('; ')}
            </span>
          </label>
        )}
      </fieldset>
      <p style={{ fontSize: 12, color: palette.ink.faint }}>
        A grant counts only as far as you may do it yourself. Narrowing a role keeps what its holders already
        wrote.
      </p>

      {problem && <p style={{ fontSize: 13, color: palette.ink.muted }}>{problem}</p>}
      {error && <p style={styles.error}>{plainError(error)}</p>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          onClick={() => void save()}
          disabled={!!problem || saving}
          data-variant="primary"
          style={{ ...styles.addButton, height: 34 }}
        >
          {saving ? 'Saving…' : existing ? 'Save role' : 'Create role'}
        </button>
        <button
          onClick={onDone}
          data-variant="quiet"
          style={{ ...variants.quiet, width: 'auto', height: 34 }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ─── Members ──────────────────────────────────────────────────────────

function Members({
  space,
  access,
  me,
  people,
  powers,
}: {
  space: SpaceSummary;
  access: SpaceAccess;
  me: string;
  people: People;
  powers: Powers;
}) {
  const node = useNode();
  const { run, error } = useAction();
  const [inviteOpen, setInviteOpen] = useState(false);
  const roleNamed = (name: string) => access.roles.find((r) => r.name === name) ?? null;
  const members = new Set(access.members.map((m) => m.did));
  // People who said who they are here but hold no role: they follow along.
  const followers = [...people.keys()].filter((did) => !members.has(did));

  const confirmed = (ask: string) => globalThis.confirm(ask);
  const closeInvite = async (key: string) => {
    if (
      !confirmed(
        'Close this invite link? Nobody new can join with it. People who already joined keep their role.',
      )
    )
      return;
    await run(() => node.spaces.closeInvite(space.id, key));
  };

  const row = (member: { did: string; founder: boolean; roles: ReadonlyArray<string> }) => {
    const { did } = member;
    const self = did === me;
    const name = nameOf(did, people);
    const gives = [...(powers.assign.get(did) ?? [])];
    const takes = powers.unassign.get(did) ?? new Set<string>();
    const removes = powers.remove.has(did);
    return (
      <li key={did} style={{ ...styles.row, padding: '8px 4px', flexWrap: 'wrap' }}>
        <Avatar did={did} size={28} />
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <span style={{ color: palette.ink.strong, fontSize: 14 }}>
            {self ? <MyName name={people.get(did)?.name ?? name} /> : <Person did={did} />}{' '}
            {self && <span style={{ color: palette.ink.faint, fontWeight: 400 }}>· you</span>}
          </span>
          <span style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 2 }}>
            {member.founder && <span style={chip}>Founder</span>}
            {member.roles.map((role) => {
              const r = roleNamed(role);
              return (
                <span key={role} style={chip}>
                  {r ? titleOf(r) : role}
                  {takes.has(role) && (
                    <button
                      onClick={() =>
                        confirmed(
                          self
                            ? `Give up your ${r ? titleOf(r) : role} role?`
                            : `Take ${r ? titleOf(r) : role} from ${name}? What they already wrote stays.`,
                        ) && void run(() => node.spaces.unassign(space.id, did, role))
                      }
                      aria-label={`Take ${role} from ${name}`}
                      style={{ ...styles.linkButton, padding: '0 0 0 6px', fontSize: 12 }}
                    >
                      ×
                    </button>
                  )}
                </span>
              );
            })}
          </span>
        </div>
        {!self && members.has(did) && <RingButton space={space} did={did} name={name} />}
        {gives.length > 0 && (
          <select
            aria-label={`Give ${name} a role`}
            value=""
            onChange={(e) =>
              e.target.value && void run(() => node.spaces.assign(space.id, did, e.target.value))
            }
            style={{ ...styles.input, width: 'auto', height: 32, fontSize: 13 }}
          >
            <option value="">Give a role…</option>
            {gives.map((role) => {
              const r = roleNamed(role);
              return (
                <option key={role} value={role}>
                  {r ? titleOf(r) : role}
                </option>
              );
            })}
          </select>
        )}
        {self && member.founder && member.roles.length > 0 && (
          <button
            onClick={() =>
              confirmed(
                'Step down as a founder? You stay, with the roles you hold, and can be removed like anyone else.',
              ) && void run(() => node.spaces.stepDown(space.id))
            }
            data-variant="quiet"
            style={styles.smallButton}
          >
            Step down
          </button>
        )}
        {members.has(did) && removes && (
          <button
            onClick={() =>
              confirmed(
                self
                  ? 'Leave this space? You give up every role you hold here.'
                  : `Remove ${name} from the space? They lose every role here. What they already wrote stays.`,
              ) && void run(() => node.spaces.removeMember(space.id, did))
            }
            data-variant="danger"
            style={{ ...styles.smallButton, color: palette.accent.danger }}
          >
            {self ? 'Leave' : 'Remove'}
          </button>
        )}
      </li>
    );
  };

  const invites = access.invites.filter((i) => i.open);
  return (
    <section style={section} aria-label="Members">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <h2 style={{ ...styles.appTitle, fontSize: 20 }}>People ({access.members.length})</h2>
        <button
          onClick={() => setInviteOpen(!inviteOpen)}
          data-variant={inviteOpen ? 'quiet' : 'primary'}
          style={styles.smallButton}
        >
          {inviteOpen ? 'Close' : 'Invite people'}
        </button>
      </div>
      {inviteOpen && <Invite space={space} access={access} offered={powers.invite} />}
      {error && <p style={styles.error}>{plainError(error)}</p>}
      <ul style={{ ...list, gap: 0 }}>{access.members.map(row)}</ul>
      {access.headless && (
        <p style={{ ...styles.fieldLabel, fontWeight: 400 }}>
          No one can change roles here any more. Members keep what their roles allow; to change more, move to
          a successor space.
        </p>
      )}
      {access.successors.length > 0 && (
        <div>
          {/* In no order: which to follow is each member's choice. */}
          <p style={styles.fieldLabel}>Named as successors</p>
          <ul style={{ ...list, gap: 0 }}>
            {access.successors.map((next) => (
              <li key={next.space} style={{ ...styles.row, padding: '8px 4px', fontSize: 13 }}>
                <span style={{ flex: 1, color: palette.ink.body }}>
                  …{next.space.slice(-8)}
                  <span style={{ color: palette.ink.faint }}>
                    {' '}
                    · named by {next.by.map((did) => nameOf(did, people)).join(', ')}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {followers.length > 0 && (
        <div>
          <p style={styles.fieldLabel}>Following, with no role</p>
          <ul style={{ ...list, gap: 0 }}>
            {followers.map((did) => row({ did, founder: false, roles: [] }))}
          </ul>
        </div>
      )}

      {invites.length > 0 && (
        <div>
          <p style={styles.fieldLabel}>Open invite links</p>
          <ul style={{ ...list, gap: 0 }}>
            {invites.map((invite) => {
              const role = roleNamed(invite.role);
              const why = powers.invite.includes(invite.role)
                ? null
                : 'Closing it takes a grant of /role/assign for its role';
              return (
                <li key={invite.key} style={{ ...styles.row, padding: '8px 4px' }}>
                  <span style={{ flex: 1, fontSize: 13, color: palette.ink.body }}>
                    Joins as <strong>{role ? titleOf(role) : invite.role}</strong>
                    <span style={{ color: palette.ink.faint }}> · …{invite.key.slice(-6)}</span>
                  </span>
                  <button
                    onClick={() => void closeInvite(invite.key)}
                    disabled={!!why}
                    title={why ?? undefined}
                    data-variant="quiet"
                    style={styles.smallButton}
                  >
                    Close link
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}

/** What an invite gives, as the link-maker picks it: a role, or only a view */
const VIEW_ONLY = '';

/** Making an invite link, joining as a role you may give, `member` first */
function Invite({
  space,
  access,
  offered,
}: {
  space: SpaceSummary;
  access: SpaceAccess;
  offered: ReadonlyArray<string>;
}) {
  const node = useNode();
  const [choice, setChoice] = useState(offered[0] ?? VIEW_ONLY);
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const { run, error } = useAction();
  const role = access.roles.find((r) => r.name === choice && offered.includes(r.name)) ?? null;
  const grants = role ? grantLines(grantsOf(role).grants) : [];
  const gives = role
    ? grants.length === 0
      ? 'They can see everything, and the role grants nothing yet.'
      : `They can ${grants.slice(0, 3).join('; ')}${grants.length > 3 ? `, and ${grants.length - 3} more` : ''}.`
    : 'They can see everything, but change nothing.';

  const make = () =>
    run(async () => {
      const next = await createInviteLink(node, space.id, role?.name ?? null);
      setLink(next);
      setCopied(
        (await globalThis.navigator.clipboard?.writeText(next).then(
          () => true,
          () => false,
        )) ?? false,
      );
    });

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        padding: 16,
        borderRadius: palette.radius.md,
        background: palette.surface.sunken,
        border: `1px solid ${palette.surface.line}`,
      }}
    >
      <label style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 14, color: palette.ink.strong }}>People with the link join as</span>
        <select
          value={choice}
          onChange={(e) => {
            setChoice(e.target.value);
            setLink(null); // a link made for the other choice would say the wrong thing
          }}
          style={{ ...styles.input, width: 'auto', height: 32, fontSize: 13 }}
        >
          {offered.map((name) => {
            const r = access.roles.find((known) => known.name === name);
            return (
              <option key={name} value={name}>
                {r ? titleOf(r) : name}
              </option>
            );
          })}
          <option value={VIEW_ONLY}>Viewer — can't change anything</option>
        </select>
      </label>
      <p style={{ fontSize: 13, lineHeight: 1.5, color: palette.ink.muted }}>
        {gives}
        {space.visibility === 'private' &&
          ' The space is encrypted, and the link carries its key, so send it only to the people it is for.'}
        {role && ' You can close it later.'}
      </p>
      {offered.length === 0 && (
        <p style={{ fontSize: 12, color: palette.ink.faint }}>
          Inviting with a role takes a grant of /role/assign, so you can only share it to view.
        </p>
      )}
      {error && <p style={styles.error}>{plainError(error)}</p>}
      <button
        onClick={() => void make()}
        data-variant="primary"
        style={{ ...styles.addButton, height: 34, alignSelf: 'flex-start' }}
      >
        {link ? 'Make another link' : 'Create link'}
      </button>
      {link && (
        <div>
          <p style={{ fontSize: 12, color: palette.ink.muted }}>
            {copied
              ? 'Copied. Send it to them however you like.'
              : 'Copy this and send it to them however you like.'}
          </p>
          <code style={styles.token}>{link}</code>
        </div>
      )}
    </div>
  );
}

const section: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 12 };
const list: CSSProperties = { listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 4 };
const item: CSSProperties = { fontSize: 13, lineHeight: 1.6 };
const card: CSSProperties = {
  padding: 14,
  border: `1px solid ${palette.surface.line}`,
  borderRadius: palette.radius.md,
  background: palette.surface.card,
};
const chip: CSSProperties = { ...styles.badge, color: palette.ink.body, background: palette.surface.sunken };
