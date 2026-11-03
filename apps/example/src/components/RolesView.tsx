import { useState } from 'react';
import { useAction } from '@minca/app-shared/action';
import { MEMBER_REMOVE, ROLE_ASSIGN, ROLE_DEFINE, ROLE_UNASSIGN } from '@minca/core';
import type { SpaceGrant as Grant, SpaceSummary } from '@minca/core';
import { useAccess, useAccount, useLive, useNode, useProfiles, useSpaceStatus } from '@minca/react';
import {
  abilitiesOf,
  choicesIn,
  GRANT_CHOICES,
  grantLines,
  grantsOf,
  type RoleView,
} from '../derive/abilities';
import { nameOf, peopleFrom, type People } from '../derive/people';
import { onlineAccounts } from '../derive/network';
import { PersonFace } from './PersonFace';
import { RingButton } from './calls/Calls';
import { RowMenu } from './PeopleParts';
import { Person } from './Person';
import { Loader } from '@minca/app-shared/Loader';
import { confirmThen } from '../confirm';

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

/** Who may do what in a space: its people and the roles assigned them, or what each role grants */
export function RolesView({
  space,
  show,
  onInvite,
}: {
  space: SpaceSummary;
  /** Which page this is: the members, or the roles they hold */
  show: 'members' | 'roles';
  onInvite: () => void;
}) {
  const access = useAccess(space.id);
  const account = useAccount();
  const people = peopleFrom(useProfiles(space.id));
  const powers = usePowers(space.id, account.did);
  const status = useSpaceStatus(space.id);
  const online = status ? onlineAccounts(status, account.did) : new Set([account.did]);
  if (!access)
    return (
      <small>
        <Loader label="Loading who's who" showLabel />
      </small>
    );
  // Everyone sees the roles; only whoever may make or change one gets the buttons that do.
  if (show === 'roles') return <Roles space={space} access={access} powers={powers} />;
  return (
    <div className="stack" data-gap="loose">
      <Members
        space={space}
        access={access}
        me={account.did}
        people={people}
        powers={powers}
        online={online}
        onInvite={onInvite}
      />
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
    <section aria-label="What you can do">
      <h2>What you can do</h2>
      <p>{summary}</p>
      {lines.length > 0 && (
        <ul role="list">
          {lines.map((line) => (
            <li key={line}>
              <span data-tone="good">✓</span> {capital(line)}
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
    <section aria-label="Roles">
      <header>
        <h2>Roles</h2>
        <button
          onClick={() => setEditing({ kind: 'new' })}
          disabled={!powers.defineNew || editing?.kind === 'new'}
          title={powers.defineNew ? undefined : 'Defining roles takes a grant of /role/define'}
        >
          New role
        </button>
      </header>
      <p>A role is what it grants. Whoever defines a role can give it only what they may do themselves.</p>

      {editing?.kind === 'new' && (
        <RoleEditor space={space} existing={null} roles={roles} onDone={() => setEditing(null)} />
      )}

      <ul role="list">
        {roles.map((role) => {
          const may = powers.define.has(role.name);
          const count = holders(role.name);
          const open = editing?.kind === 'edit' && editing.name === role.name;
          const { grants, rivals } = grantsOf(role);
          return (
            <li key={role.name}>
              <div className="row" data-spread>
                <div className="stack" data-gap="tight">
                  <div className="row">
                    <strong>{titleOf(role)}</strong>
                    {access.mine.includes(role.name) && (
                      <span className="tag" data-hue="1">
                        yours
                      </span>
                    )}
                    <small>
                      <code>{role.name}</code> · {count} {count === 1 ? 'person' : 'people'}
                    </small>
                  </div>
                  <div className="row" data-gap="tight">
                    {grants.length === 0 ? (
                      <small>Grants nothing</small>
                    ) : (
                      grantLines(grants).map((line) => (
                        <span key={line} className="tag">
                          {line}
                        </span>
                      ))
                    )}
                  </div>
                  {rivals && (
                    <small>
                      Defined twice apart: it grants only what both definitions share, until someone defines
                      it again.
                    </small>
                  )}
                </div>
                <button
                  onClick={() => setEditing(open ? null : { kind: 'edit', name: role.name })}
                  disabled={!may}
                  title={may ? undefined : 'Defining this role takes a grant of /role/define for it'}
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
    <aside className="stack" data-gap="loose">
      {!existing && <strong>New role</strong>}
      <label>
        Title
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Reviewer"
          maxLength={80}
          autoFocus={!existing}
        />
        <small>
          {existing ? 'Its key stays ' : 'Its key will be '}
          <code>{name || '…'}</code>
        </small>
      </label>

      <fieldset>
        <legend>What it grants</legend>
        {GRANT_CHOICES.map((c) => (
          <label key={c.key}>
            <input
              type="checkbox"
              checked={chosen.has(c.key)}
              onChange={(e) => toggle(c.key, e.target.checked)}
            />
            {c.label}
          </label>
        ))}
        {start.other.length > 0 && (
          <label>
            <input type="checkbox" checked={keepOther} onChange={(e) => setKeepOther(e.target.checked)} />
            <small>Keep its other grants: {grantLines(start.other).join('; ')}</small>
          </label>
        )}
      </fieldset>
      <small>
        A grant counts only as far as you may do it yourself. Narrowing a role keeps what its holders already
        wrote.
      </small>

      {problem && <small>{problem}</small>}
      {error && <p role="alert">{plainError(error)}</p>}
      <div className="row">
        <button data-intent="primary" onClick={() => void save()} disabled={!!problem || saving}>
          {saving ? 'Saving…' : existing ? 'Save role' : 'Create role'}
        </button>
        <button data-intent="quiet" onClick={onDone}>
          Cancel
        </button>
      </div>
    </aside>
  );
}

// ─── Members ──────────────────────────────────────────────────────────

function Members({
  space,
  access,
  me,
  people,
  powers,
  online,
  onInvite,
}: {
  space: SpaceSummary;
  access: SpaceAccess;
  me: string;
  people: People;
  powers: Powers;
  /** Who is online here now, by account */
  online: ReadonlySet<string>;
  onInvite: () => void;
}) {
  const node = useNode();
  const { run, error } = useAction();
  const roleTitle = (name: string) => titleOf(access.roles.find((r) => r.name === name) ?? { name });
  const members = new Set(access.members.map((m) => m.did));
  // People who said who they are here but hold no role: they follow along.
  const followers = [...people.keys()].filter((did) => !members.has(did));

  // Asks first, then does it, if the person said yes.
  const confirmed = (title: string, question: string, yes: string, then: () => Promise<unknown>) =>
    confirmThen(question, { title, yes }, () => run(then));

  /** What can be done with someone, behind their row's menu */
  const actions = (member: { did: string; founder: boolean; roles: ReadonlyArray<string> }) => {
    const { did } = member;
    const self = did === me;
    const name = nameOf(did, people);
    const takes = powers.unassign.get(did) ?? new Set<string>();
    return [
      ...[...(powers.assign.get(did) ?? [])].map((role) => ({
        label: self ? `Take the ${roleTitle(role)} role` : `Give the ${roleTitle(role)} role`,
        onClick: () => void run(() => node.spaces.assign(space.id, did, role)),
      })),
      ...member.roles
        .filter((role) => takes.has(role))
        .map((role) => ({
          label: self ? `Give up ${roleTitle(role)}` : `Take ${roleTitle(role)} away`,
          onClick: () =>
            confirmed(
              self ? `Give up your ${roleTitle(role)} role?` : `Take ${roleTitle(role)} from ${name}?`,
              self
                ? 'You can only have it back if someone gives it to you.'
                : 'What they already wrote stays.',
              self ? 'Give it up' : 'Take it',
              () => node.spaces.unassign(space.id, did, role),
            ),
        })),
      ...(self && member.founder && member.roles.length > 0
        ? [
            {
              label: 'Step down as founder',
              onClick: () =>
                confirmed(
                  'Step down as a founder?',
                  'You stay, with the roles you hold, and can be removed like anyone else.',
                  'Step down',
                  () => node.spaces.stepDown(space.id),
                ),
            },
          ]
        : []),
      ...(members.has(did) && powers.remove.has(did)
        ? [
            {
              label: self ? 'Leave the space' : 'Remove from the space',
              danger: true,
              onClick: () =>
                confirmed(
                  self ? 'Leave this space?' : `Remove ${name} from the space?`,
                  self
                    ? 'You give up every role you hold here.'
                    : 'They lose every role here. What they already wrote stays.',
                  self ? 'Leave' : 'Remove',
                  () => node.spaces.removeMember(space.id, did),
                ),
            },
          ]
        : []),
    ];
  };

  const row = (member: { did: string; founder: boolean; roles: ReadonlyArray<string> }) => {
    const { did } = member;
    const self = did === me;
    const name = nameOf(did, people);
    const menu = actions(member);
    const labels = [...(member.founder ? ['Founder'] : []), ...member.roles.map(roleTitle)];
    return (
      <li key={did} className="row">
        <PersonFace did={did} size={40} />
        <div className="stack truncate" data-gap="tight">
          <strong>
            <Person did={did} />
            {self && <small> · you</small>}
            {/* Online now, as chat apps mark it */}
            {online.has(did) && (
              <small data-tone="good" title="Online now">
                {' '}
                ●
              </small>
            )}
          </strong>
          <span className="row" data-gap="tight">
            {labels.length > 0 ? (
              labels.map((label) => (
                <span key={label} className="tag">
                  {label}
                </span>
              ))
            ) : (
              <small>No role</small>
            )}
          </span>
        </div>
        {!self && members.has(did) && <RingButton space={space} did={did} name={name} />}
        {menu.length > 0 && <RowMenu label={`More for ${name}`} items={menu} />}
      </li>
    );
  };

  return (
    <section aria-label="Members">
      <header>
        <h2>Members · {access.members.length}</h2>
        <button data-intent="primary" onClick={onInvite}>
          Invite people
        </button>
      </header>
      {error && <p role="alert">{plainError(error)}</p>}
      <ul role="list">{access.members.map(row)}</ul>

      {followers.length > 0 && (
        <>
          <h3>Following, with no role</h3>
          <ul role="list">{followers.map((did) => row({ did, founder: false, roles: [] }))}</ul>
        </>
      )}

      {access.headless && (
        <p>
          No one can change roles here any more. Members keep what their roles allow; to change more, move to
          a successor space.
        </p>
      )}
      {access.successors.length > 0 && (
        <>
          {/* In no order: which to follow is each member's choice. */}
          <h3>Named as successors</h3>
          <ul role="list">
            {access.successors.map((next) => (
              <li key={next.space}>
                …{next.space.slice(-8)}
                <small> · named by {next.by.map((did) => nameOf(did, people)).join(', ')}</small>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
