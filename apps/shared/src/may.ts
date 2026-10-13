/**
 * What this account may do in a space, by the space's grants (spec 03 §2):
 * asked of the node, which judges them as every peer does, and asked again
 * whenever the space changes.
 */
import { useLive } from '@minca/core/react';
import type { SpaceGrant as Grant } from '@minca/core';

/** Whether this account may invoke `cmd` with `args` in a space now; false until known */
export function useMay(spaceId: string, cmd: string, args: Readonly<Record<string, unknown>> = {}): boolean {
  const key = JSON.stringify(args);
  return useLive(spaceId, (node) => node.spaces.may(spaceId, cmd, args), [cmd, key]) ?? false;
}

const COMMANDS: Readonly<Record<string, string>> = {
  '/': 'do anything',
  '/record': 'read, write and delete records',
  '/record/read': 'read records',
  '/record/write': 'write records',
  '/record/delete': 'delete records',
  '/collection/define': 'add and change collections',
  '/member/remove': 'remove people',
  '/role/define': 'define roles',
  '/role/assign': 'give roles and make invites',
  '/role/unassign': 'take roles away',
  '/key/change': "change the space's key",
  '/space/relays': 'choose where the space meets',
  '/space/keepers': 'choose who keeps the space',
  '/space/succeed': 'name a space that succeeds this one',
  '/std.automation/instruct': 'instruct bots',
};

/** One statement of a policy, in a few words; its JSON when it is not one of the usual shapes */
function statement(s: ReadonlyArray<unknown>): string {
  const [op, a, b] = s;
  if (op === '==' && a === '.byCreator' && b === true) return 'only their own';
  if (op === '==' && a === '.self' && b === false) return 'not to themselves';
  if (op === '==' && a === '.self' && b === true) return 'only themselves';
  if (op === '==' && a === '.collection') return `in ${String(b)}`;
  if (op === '!=' && a === '.collection') return `except in ${String(b)}`;
  if (op === '==' && a === '.role') return `the role ${String(b)}`;
  if (op === '!=' && a === '.role') return `any role but ${String(b)}`;
  if (op === 'not' && Array.isArray(a) && a[0] === 'any' && a[1] === '.roles' && Array.isArray(a[2]))
    return `not to ${String(a[2][2])}s`;
  return JSON.stringify(s);
}

/** A grant in plain words: "delete records, in app.chess, only their own" */
export function describeGrant(grant: Grant): string {
  const what = COMMANDS[grant.cmd] ?? grant.cmd;
  const conditions = grant.pol.map(statement);
  return conditions.length ? `${what}: ${conditions.join(', ')}` : what;
}

/**
 * The roles this account may give someone new, by name, `member` first:
 * what an invite or a bot can be given. With `held`, only roles whose every
 * grant this account holds itself: a bot acts on what its members ask, so
 * it must not hold more than they do. Empty until known.
 */
export function useAssignable(
  spaceId: string,
  options: { readonly held?: boolean } = {},
): ReadonlyArray<{ readonly name: string; readonly title?: string }> {
  const held = !!options.held;
  return (
    useLive(
      spaceId,
      async (node) => {
        const { roles } = await node.spaces.access(spaceId);
        const out: Array<{ name: string; title?: string }> = [];
        for (const role of roles) {
          if (!(await node.spaces.may(spaceId, '/role/assign', { role: role.name, self: false, roles: [] })))
            continue;
          if (held && !(await node.spaces.holdsRole(spaceId, role.name))) continue;
          out.push({ name: role.name, ...(role.title !== undefined ? { title: role.title } : {}) });
        }
        return out.sort((a, b) => Number(b.name === 'member') - Number(a.name === 'member'));
      },
      [held],
    ) ?? []
  );
}

/**
 * Whether this account may add or change a collection's definition: the
 * one named, or with none named, collections in general. A collection this
 * account defined it may change anyway, which this doesn't ask.
 */
export const useMayDefine = (spaceId: string, collection = '') =>
  useMay(spaceId, '/collection/define', { collection });
