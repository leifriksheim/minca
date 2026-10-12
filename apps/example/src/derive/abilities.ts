// What a role may do in a space, in plain words, from its grants (spec 03 §2): a command, and a policy on its arguments.
import {
  COLLECTION_DEFINE,
  KEY_CHANGE,
  MEMBER_REMOVE,
  RECORD_DELETE,
  RECORD_WRITE,
  ROLE_ASSIGN,
  ROLE_DEFINE,
  ROLE_UNASSIGN,
  SPACE_KEEPERS,
  SPACE_RELAYS,
} from '@weaveprotocol/core';
import type { SpaceGrant as Grant, SpaceAccess } from '@weaveprotocol/core';
import { describeGrant } from '@weave/app-shared/may';

/** A role as the space has it now */
export type RoleView = SpaceAccess['roles'][number];

/** A few grants a role editor offers together, under one readable label */
export interface GrantChoice {
  readonly key: string;
  readonly label: string;
  readonly grants: ReadonlyArray<Grant>;
}

const own = [['==', '.byCreator', true]] as const;

/** What a role editor offers, each a box to tick */
export const GRANT_CHOICES: ReadonlyArray<GrantChoice> = [
  {
    key: 'own',
    label: 'Add records, and change or delete their own',
    grants: [
      { cmd: RECORD_WRITE, pol: own },
      { cmd: RECORD_DELETE, pol: own },
    ],
  },
  { key: 'records', label: 'Change and delete anyone’s records', grants: [{ cmd: '/record', pol: [] }] },
  { key: 'moderate', label: 'Delete anyone’s records', grants: [{ cmd: RECORD_DELETE, pol: [] }] },
  { key: 'define', label: 'Add and change collections', grants: [{ cmd: COLLECTION_DEFINE, pol: [] }] },
  {
    key: 'invite',
    label: 'Invite people as members',
    grants: [{ cmd: ROLE_ASSIGN, pol: [['==', '.role', 'member']] }],
  },
  {
    key: 'assign',
    label: 'Give any role to others',
    grants: [{ cmd: ROLE_ASSIGN, pol: [['==', '.self', false]] }],
  },
  {
    key: 'unassign',
    label: 'Take roles from others',
    grants: [{ cmd: ROLE_UNASSIGN, pol: [['==', '.self', false]] }],
  },
  { key: 'remove', label: 'Remove people', grants: [{ cmd: MEMBER_REMOVE, pol: [['==', '.self', false]] }] },
  { key: 'roles', label: 'Define roles', grants: [{ cmd: ROLE_DEFINE, pol: [] }] },
  {
    key: 'settings',
    label: 'Change the key, where it meets, and who keeps it',
    grants: [
      { cmd: KEY_CHANGE, pol: [] },
      { cmd: SPACE_RELAYS, pol: [] },
      { cmd: SPACE_KEEPERS, pol: [] },
    ],
  },
];

/** Two grants compared as rival definitions compare them: their command and policy */
const sameGrant = (a: Grant, b: Grant) => JSON.stringify([a.cmd, a.pol]) === JSON.stringify([b.cmd, b.pol]);

/**
 * What a role holds now: the grants every one of its current definitions
 * holds (rivals hold only what they share), and whether rivals stand.
 */
export function grantsOf(role: RoleView): {
  readonly grants: ReadonlyArray<Grant>;
  readonly rivals: boolean;
} {
  const [first, ...rest] = role.definitions;
  if (!first) return { grants: [], rivals: false };
  const grants = first.grants.filter((g) => rest.every((d) => d.grants.some((o) => sameGrant(o, g))));
  return { grants, rivals: rest.length > 0 };
}

/** Which choices a role's grants make up whole, and the grants left over */
export function choicesIn(grants: ReadonlyArray<Grant>): {
  readonly chosen: ReadonlySet<string>;
  readonly other: ReadonlyArray<Grant>;
} {
  const chosen = new Set(
    GRANT_CHOICES.filter((c) => c.grants.every((g) => grants.some((h) => sameGrant(g, h)))).map((c) => c.key),
  );
  const covered = GRANT_CHOICES.filter((c) => chosen.has(c.key)).flatMap((c) => c.grants);
  return { chosen, other: grants.filter((g) => !covered.some((c) => sameGrant(c, g))) };
}

/** A role's grants in plain words */
export const grantLines = (grants: ReadonlyArray<Grant>): ReadonlyArray<string> => grants.map(describeGrant);

/** What this account may do, in plain words, from the roles it holds */
export function abilitiesOf(access: SpaceAccess): {
  readonly summary: string;
  readonly lines: ReadonlyArray<string>;
} {
  if (access.founder)
    return {
      summary: 'You founded this space: you may do anything here, and nobody can remove you.',
      lines: [],
    };
  if (access.mine.length === 0)
    return { summary: "You're following this space: you can see it, but not change anything.", lines: [] };
  const held = access.roles.filter((r) => access.mine.includes(r.name));
  const titles = held.map((r) => r.title ?? r.name).join(', ');
  const lines = [...new Set(held.flatMap((r) => grantLines(grantsOf(r).grants)))];
  return { summary: `You hold ${titles}.`, lines };
}
