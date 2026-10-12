/**
 * @module space/grants
 * What a role may do in a space: its grants (spec 03 §2).
 *
 * A grant is a delegation to a role, in Weave's JSON profile of UCAN 1.0
 * (spec 01 §7): a command path, and a policy over the command's arguments.
 * Only the constitution (the space's genesis) and a role's definition issue
 * grants, and only to roles. An account holds power only through the roles
 * assigned to it, so nothing it was handed outlives its roles.
 *
 * The constitution's grants for a role are written `{ cmd, pol }`: the space
 * itself issues them. A definition's are whole delegation payloads, issued by
 * the definition's author to `role:<name>` about `space:<id>`, and signed by
 * the version that carries them.
 */
import { commandCovers, isCommand } from '../identity/ucan.js';
import { isJson, policyOutcome, policyProblem, policyReads } from '../identity/policy.js';
import { canonicalize } from '../schema/version.js';
import { isRecord } from '../utils/guards.js';
import type { SpaceGrant, SpaceRole } from '../types.js';

// ─── Commands (spec 03 §2.2) ──────────────────────────────────────────

/** Reading a collection: `{ collection }` */
export const RECORD_READ = '/record/read';
/** Writing a version: `{ collection, byCreator, body }` */
export const RECORD_WRITE = '/record/write';
/** Deleting a record: `{ collection, byCreator }` */
export const RECORD_DELETE = '/record/delete';
/** Defining or changing a collection: `{ collection }` */
export const COLLECTION_DEFINE = '/collection/define';
/** Removing an account from the space: `{ self, roles }` */
export const MEMBER_REMOVE = '/member/remove';
/** Writing a role's definition, its grants and nestings: `{ role }` */
export const ROLE_DEFINE = '/role/define';
/** Assigning a role to an account, or opening an invite to it: `{ role, self, roles }` */
export const ROLE_ASSIGN = '/role/assign';
/** Taking a role from an account: `{ role, self, roles }` */
export const ROLE_UNASSIGN = '/role/unassign';
/** Changing a private space's key: no arguments */
export const KEY_CHANGE = '/key/change';
/** Naming the relays the space meets on: no arguments */
export const SPACE_RELAYS = '/space/relays';
/** Naming the nodes that keep the space whole: no arguments */
export const SPACE_KEEPERS = '/space/keepers';

/** A grant's command and policy: all two grants are compared by */
type Grant = SpaceGrant;

/** A role the space is founded with: the constitution's grants for it are its first definition */
export type FoundingRole = SpaceRole;

/** A role's definition, as its record says it, its grants checked */
export interface DefinedRole {
  readonly name: string;
  readonly title?: string;
  readonly grants: ReadonlyArray<Grant>;
  readonly nests: ReadonlyArray<string>;
}

const ROLE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,39}$/;
/** How many roles a space may be founded with */
const MAX_FOUNDING_ROLES = 64;
/** How many grants one role may hold in one definition */
const MAX_GRANTS = 64;
/** How many roles one role may nest */
const MAX_NESTS = 16;

const NONCE = /^[A-Za-z0-9_-]{1,64}$/;

/** The audience a grant to a role names */
const roleAudience = (name: string) => `role:${name}`;
/** The subject a grant in a space names */
const spaceSubject = (spaceId: string) => `space:${spaceId}`;

/** Why a constitution grant is malformed, or null: exactly `cmd` and `pol` */
function grantProblem(grant: unknown): string | null {
  if (!isRecord(grant)) return 'A grant is an object';
  for (const field of Object.keys(grant))
    if (field !== 'cmd' && field !== 'pol') return `A founding grant has only cmd and pol, not ${field}`;
  if (!isCommand(grant.cmd)) return 'A grant names a command path';
  return policyProblem(grant.pol);
}

/** Why a role's title or nestings are malformed, or null */
function partsProblem(name: string, title: unknown, nests: unknown): string | null {
  if (title !== undefined && (typeof title !== 'string' || title.length > 80))
    return 'A role title is text of at most 80 characters';
  if (nests === undefined) return null;
  if (!Array.isArray(nests) || nests.length > MAX_NESTS) return `A role nests at most ${MAX_NESTS} roles`;
  const list: unknown[] = nests;
  if (!list.every((n) => typeof n === 'string' && ROLE_NAME_PATTERN.test(n) && n !== name))
    return 'A role nests other roles, by name';
  return new Set(list).size === list.length ? null : 'A role nests another role once';
}

/** Why a founding role is malformed, or null */
export function checkFoundingRole(role: unknown): string | null {
  if (!isRecord(role)) return 'A role must be an object';
  for (const field of Object.keys(role))
    if (!['name', 'title', 'grants', 'nests'].includes(field)) return `A role has no field ${field}`;
  if (typeof role.name !== 'string' || !ROLE_NAME_PATTERN.test(role.name))
    return 'A role name is 1–40 characters of a–z, 0–9 and . _ -';
  const parts = partsProblem(role.name, role.title, role.nests);
  if (parts) return parts;
  if (!Array.isArray(role.grants) || role.grants.length > MAX_GRANTS)
    return `A role holds a list of at most ${MAX_GRANTS} grants`;
  for (const grant of role.grants) {
    const problem = grantProblem(grant);
    if (problem) return problem;
  }
  return null;
}

/** Why a space's founding roles are malformed, or null: at most 64, names unique */
export function checkFoundingRoles(roles: unknown): string | null {
  if (!Array.isArray(roles) || roles.length > MAX_FOUNDING_ROLES)
    return `A space starts with at most ${MAX_FOUNDING_ROLES} roles`;
  for (const role of roles) {
    const problem = checkFoundingRole(role);
    if (problem) return problem;
  }
  const names = roles.map((role: { readonly name: string }) => role.name);
  return new Set(names).size === names.length ? null : 'Two founding roles share a name';
}

/**
 * The definition a `sys.role` body holds, or null when it isn't one: its
 * name, an optional title, its grants as delegation payloads from `root` to
 * the role about this space, and the roles it nests. A payload has exactly
 * UCAN 1.0's fields less `exp` and `nbf`: time ends no grant.
 */
export function readDefinition(
  body: unknown,
  context: { readonly root: string; readonly spaceId: string },
): DefinedRole | null {
  if (!isRecord(body)) return null;
  for (const field of Object.keys(body))
    if (!['name', 'title', 'grants', 'nests'].includes(field)) return null;
  const { name, title, nests } = body;
  if (typeof name !== 'string' || !ROLE_NAME_PATTERN.test(name)) return null;
  if (partsProblem(name, title, nests ?? []) !== null) return null;
  if (!Array.isArray(body.grants) || body.grants.length > MAX_GRANTS) return null;
  const grants: Grant[] = [];
  for (const payload of body.grants) {
    if (!isRecord(payload)) return null;
    for (const field of Object.keys(payload))
      if (!['iss', 'aud', 'sub', 'cmd', 'pol', 'nonce', 'meta'].includes(field)) return null;
    if (payload.iss !== context.root) return null;
    if (payload.aud !== roleAudience(name)) return null;
    if (payload.sub !== spaceSubject(context.spaceId)) return null;
    if (!isCommand(payload.cmd) || policyProblem(payload.pol) !== null || !Array.isArray(payload.pol))
      return null;
    if (typeof payload.nonce !== 'string' || !NONCE.test(payload.nonce)) return null;
    if ('meta' in payload && !(isRecord(payload.meta) && isJson(payload.meta))) return null;
    const pol: Grant['pol'] = payload.pol;
    grants.push(Object.freeze({ cmd: payload.cmd, pol }));
  }
  return Object.freeze({
    name,
    ...(typeof title === 'string' ? { title } : {}),
    grants: Object.freeze(grants),
    nests: Object.freeze(Array.isArray(nests) ? nests.filter((n) => typeof n === 'string') : []),
  });
}

/** The body of a definition `root` writes for a role: each grant as a delegation payload */
export function definitionBody(
  role: FoundingRole,
  context: { readonly root: string; readonly spaceId: string },
  nonce: () => string,
): Record<string, unknown> {
  return {
    name: role.name,
    ...(role.title !== undefined ? { title: role.title } : {}),
    grants: role.grants.map((grant) => ({
      iss: context.root,
      aud: roleAudience(role.name),
      sub: spaceSubject(context.spaceId),
      cmd: grant.cmd,
      pol: grant.pol,
      nonce: nonce(),
    })),
    nests: [...(role.nests ?? [])],
  };
}

/** What two grants are compared by, in rival definitions: the canonical JSON of `{ cmd, pol }` */
export const grantShape = (grant: Grant): string => canonicalize({ cmd: grant.cmd, pol: grant.pol });

/**
 * Whether a grant lets its holder invoke `cmd` with `args`: its command
 * covers it and its policy holds. With `opaque`, the invocation's body could
 * not be read here: a policy that reads `.body` and finds no data is left to
 * those who can read it, and counts as holding.
 */
export function grantFits(grant: Grant, cmd: string, args: unknown, opaque = false): boolean {
  if (!commandCovers(grant.cmd, cmd)) return false;
  const outcome = policyOutcome(grant.pol, args);
  return outcome === true || (opaque && outcome === null && policyReads(grant.pol, 'body'));
}
