/**
 * Access events for the replay's tests: plain objects, no crypto. Each
 * builder takes its author's account, what it saw, and the change.
 */
import type { AccessEvent, Cutoff } from '../../src/space/roles.js';
import type { SpaceGrant as Grant } from '../../src/types.js';

let counter = 0;
/** A fresh id with a readable label; ids sort in the order they were made */
const nextId = (label: string) => `${label}-${String(counter++).padStart(4, '0')}`;

export interface Extra {
  readonly id?: string;
  readonly cutoff?: Readonly<Record<string, Readonly<Record<string, number>>>>;
  /** The key that signed it; by default the account itself */
  readonly author?: string;
  readonly line?: number;
}

const cutoffOf = (extra: Extra): Cutoff =>
  new Map(Object.entries(extra.cutoff ?? {}).map(([key, lines]) => [key, new Map(Object.entries(lines))]));

const base = (label: string, root: string, seen: ReadonlyArray<string>, extra: Extra) => ({
  id: extra.id ?? nextId(label),
  root,
  author: extra.author ?? root,
  seen,
  cutoff: cutoffOf(extra),
  ...(extra.line !== undefined ? { line: extra.line } : {}),
});

/** `root` defines `name` to hold `grants`, nesting `nests` */
export function define(
  root: string,
  name: string,
  grants: ReadonlyArray<Grant>,
  seen: ReadonlyArray<string>,
  options: Extra & { readonly nests?: ReadonlyArray<string> } = {},
): AccessEvent {
  return {
    ...base('def', root, seen, options),
    key: `role:${name}`,
    kind: 'role',
    name,
    grants,
    nests: options.nests ?? [],
  };
}

/** `root` assigns `role` to `did` */
export function assign(
  root: string,
  did: string,
  role: string,
  seen: ReadonlyArray<string>,
  extra: Extra & { readonly viaInvite?: string } = {},
): AccessEvent {
  return {
    ...base('as', root, seen, extra),
    key: `assign:${did}|${role}`,
    kind: 'assign',
    did,
    role,
    assigned: true,
    ...(extra.viaInvite !== undefined ? { viaInvite: extra.viaInvite } : {}),
  };
}

/** `root` takes `role` from `did`: its own, to leave it */
export function unassign(
  root: string,
  did: string,
  role: string,
  seen: ReadonlyArray<string>,
  extra: Extra = {},
): AccessEvent {
  return {
    ...base('un', root, seen, extra),
    key: `assign:${did}|${role}`,
    kind: 'assign',
    did,
    role,
    assigned: false,
  };
}

/** `root` removes `did` from the space: itself, to leave */
export function remove(
  root: string,
  did: string,
  seen: ReadonlyArray<string>,
  extra: Extra = {},
): AccessEvent {
  return { ...base('rm', root, seen, extra), key: `remove:${did}`, kind: 'remove', did };
}

/** `root` opens (or closes) an invite with key `inviteKey` for `role` */
export function invite(
  root: string,
  inviteKey: string,
  role: string,
  seen: ReadonlyArray<string>,
  open = true,
  extra: Extra = {},
): AccessEvent {
  return {
    ...base('inv', root, seen, extra),
    key: `invite:${inviteKey}`,
    kind: 'invite',
    inviteKey,
    role,
    open,
  };
}

/** `root` revokes its own key `target` */
export function revoke(
  root: string,
  target: string,
  seen: ReadonlyArray<string>,
  extra: Extra = {},
): AccessEvent {
  return { ...base('rv', root, seen, extra), key: `revoke:${target}|${root}`, kind: 'revoke', target };
}

/** `root` defines (or deletes) the collection `name` */
export function collection(
  root: string,
  name: string,
  seen: ReadonlyArray<string>,
  deleted = false,
  extra: Extra = {},
): AccessEvent {
  return { ...base('col', root, seen, extra), key: `collection:${name}`, kind: 'definition', name, deleted };
}

/** Writing in a collection, as a record's arguments say it */
export const writes = (collection: string, byCreator = true) => ({ collection, byCreator });

/** `root`, a founder, steps down: itself, keeping its roles */
export function stepDown(
  root: string,
  did: string,
  seen: ReadonlyArray<string>,
  extra: Extra = {},
): AccessEvent {
  return { ...base('sd', root, seen, extra), key: `stepdown:${did}`, kind: 'stepdown', did };
}

/** `root` names `space` as a successor */
export function succeed(
  root: string,
  space: string,
  seen: ReadonlyArray<string>,
  extra: Extra = {},
): AccessEvent {
  return { ...base('sc', root, seen, extra), key: `succeed:${space}`, kind: 'succeed', space };
}
