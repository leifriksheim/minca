/**
 * Constitution templates: who sits at the top, the roles a space can be
 * founded with and their grants, and the roles its creator starts with —
 * plain data, and nothing more.
 *
 * The protocol takes no position on what roles a space should have: it reads
 * whatever a constitution names, and never looks at a template's name. These
 * are for app developers who want a sensible start. Spread one into
 * `spaces.create`, change it, or write your own. Under `top: founders` the
 * creator is a founder and holds every command, whatever the roles say;
 * under `top: none` it holds only the roles the template gives it.
 *
 * Each template says explicitly whether members may change each other's
 * records (`byCreator` in a policy), and gives `/role/define` for a role to
 * another role than itself, or to the founders alone: rival definitions of a
 * role that defines itself can leave it unable to settle them (spec 03 §2.6).
 */
import type { SpaceGrant, SpaceRole } from '../types.js';
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
  SPACE_SUCCEED,
} from './grants.js';

export interface RolePreset {
  /** `founders`: the creator founds the space. `none`: no one is above the roles */
  readonly top: 'founders' | 'none';
  readonly roles: ReadonlyArray<SpaceRole>;
  /** The roles the constitution assigns the creator: under `top: none`, all the power it starts with */
  readonly creatorRoles?: ReadonlyArray<string>;
}

/** Naming a successor space */
const SUCCEED: SpaceGrant = Object.freeze({ cmd: SPACE_SUCCEED, pol: [] });

/** Every record command, in every collection */
const RECORDS: SpaceGrant = Object.freeze({ cmd: '/record', pol: [] });

/** Writing and deleting one's own records, in every collection but `except` */
function ownRecords(except: ReadonlyArray<string> = []): ReadonlyArray<SpaceGrant> {
  const mine = [['==', '.byCreator', true]] as const;
  const elsewhere = except.length
    ? [['not', ['or', except.map((collection) => ['==', '.collection', collection])]]]
    : [];
  return [
    { cmd: RECORD_WRITE, pol: [...mine, ...elsewhere] },
    { cmd: RECORD_DELETE, pol: [...mine, ...elsewhere] },
  ];
}

/** Whose roles don't name any of these */
const notHolding = (roles: ReadonlyArray<string>) =>
  roles.map((role) => ['not', ['any', '.roles', ['==', '.', role]]] as const);

/**
 * Whose rules a bot in the space runs (`std.automation`'s `by`): a library command
 * no peer checks, held as a grant like any other (docs/automations.md)
 */
const INSTRUCT_BOTS: SpaceGrant = Object.freeze({ cmd: '/std.automation/instruct', pol: [] });

/** The space's own settings: its key, its relays, its keepers */
const SETTINGS: ReadonlyArray<SpaceGrant> = [
  { cmd: KEY_CHANGE, pol: [] },
  { cmd: SPACE_RELAYS, pol: [] },
  { cmd: SPACE_KEEPERS, pol: [] },
];

/**
 * Collections of the standard library only those who keep order in a
 * community start: announcements, badges and awards, pins, labels, channels
 * and the space's hosts.
 */
export const STAFF_COLLECTIONS: ReadonlyArray<string> = Object.freeze([
  'std.announcement',
  'std.badge',
  'std.award',
  'std.pin',
  'std.label',
  'std.channel',
  'std.host',
]);

/** Just the founder. Invites are view-only: there is no role to give. */
export const solo: RolePreset = Object.freeze({ top: 'founders', roles: Object.freeze([]) });

/**
 * A small group working together: editors change any record, invite more
 * editors and add collections. The founder alone defines and removes.
 */
export const team: RolePreset = Object.freeze({
  top: 'founders',
  roles: Object.freeze([
    {
      name: 'editor',
      title: 'Editor',
      grants: [
        RECORDS,
        { cmd: COLLECTION_DEFINE, pol: [] },
        { cmd: ROLE_ASSIGN, pol: [['==', '.role', 'editor']] },
      ],
    },
  ]),
});

/**
 * A community: admins run it, moderators keep order in every app, members
 * take part and change only what they made. The founders define admin;
 * admins define the other roles, and may name a successor space. An admin who has seen another's promotion
 * can't remove or demote them; one who names a view from before it, or acts
 * concurrently, can: `.roles` binds only a remover whose view holds the role
 * (spec 03 §2.3).
 */
export const community: RolePreset = Object.freeze({
  top: 'founders',
  roles: Object.freeze([
    {
      name: 'admin',
      title: 'Admin',
      grants: [
        RECORDS,
        { cmd: COLLECTION_DEFINE, pol: [] },
        { cmd: ROLE_DEFINE, pol: [['!=', '.role', 'admin']] },
        { cmd: ROLE_ASSIGN, pol: [] },
        { cmd: ROLE_UNASSIGN, pol: notHolding(['admin']) },
        { cmd: MEMBER_REMOVE, pol: notHolding(['admin']) },
        INSTRUCT_BOTS,
        SUCCEED,
        ...SETTINGS,
      ],
    },
    {
      name: 'moderator',
      title: 'Moderator',
      grants: [RECORDS, { cmd: ROLE_ASSIGN, pol: [['==', '.role', 'member']] }, INSTRUCT_BOTS],
    },
    { name: 'member', title: 'Member', grants: ownRecords(STAFF_COLLECTIONS) },
  ]),
});

/** Who a steward manages: members and other stewards */
const MEMBERS_OR_STEWARDS = [
  [
    'or',
    [
      ['==', '.role', 'member'],
      ['==', '.role', 'steward'],
    ],
  ],
] as const;

/**
 * A co-op: no founders, so no one is above the roles. Stewards run it and
 * may remove anyone, other stewards and the creator included; members take
 * part, change only what they made, and may name a successor space. The
 * creator starts as a steward. Nobody may define `steward`: its grants are
 * the constitution's, and changing them takes a successor. Two stewards who
 * remove each other apart both stand removed (spec 03 §4.3).
 */
export const coop: RolePreset = Object.freeze({
  top: 'none',
  creatorRoles: Object.freeze(['steward']),
  roles: Object.freeze([
    {
      name: 'steward',
      title: 'Steward',
      grants: [
        RECORDS,
        { cmd: COLLECTION_DEFINE, pol: [] },
        { cmd: ROLE_DEFINE, pol: [['==', '.role', 'member']] },
        { cmd: ROLE_ASSIGN, pol: MEMBERS_OR_STEWARDS },
        { cmd: ROLE_UNASSIGN, pol: MEMBERS_OR_STEWARDS },
        { cmd: MEMBER_REMOVE, pol: [] },
        INSTRUCT_BOTS,
        SUCCEED,
        ...SETTINGS,
      ],
    },
    { name: 'member', title: 'Member', grants: [...ownRecords(STAFF_COLLECTIONS), SUCCEED] },
  ]),
});

export const rolePresets = Object.freeze({ solo, team, community, coop });
