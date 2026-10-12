/**
 * Grants as the plan has them (spec/drafts/constitution-grants-contracts.md
 * §2): UCAN 1.0 delegations to people or roles, with UCAN policies, and
 * role assignments. Only the authority logic, not UCAN's envelopes or
 * signatures. This is the code a peer would run, written in TypeScript:
 * the policy language only ever sees one invocation's arguments.
 */
import { allows, type Json, type Policy } from './ucan-policy.js';

/** `iss` lets `aud` (a DID, or `role:<name>`) invoke `cmd` and below, where `pol` holds */
export interface Delegation {
  readonly iss: string;
  readonly aud: string;
  readonly cmd: string;
  readonly pol: Policy;
}

/** `by` gives `to` (a DID, or `role:<name>`) the role `role`: an invocation of `/role/assign` */
export interface Assignment {
  readonly by: string;
  readonly to: string;
  readonly role: string;
}

export interface Authority {
  /** The constitution's `top`: they hold every command */
  readonly founders: ReadonlyArray<string>;
  readonly delegations: ReadonlyArray<Delegation>;
  readonly assignments: ReadonlyArray<Assignment>;
}

/** `/record` covers `/record/write`; `/` covers everything */
const covers = (granted: string, cmd: string) =>
  granted === '/' || cmd === granted || cmd.startsWith(`${granted}/`);

/**
 * Whether `who` may invoke `cmd` with `args`. A delegation counts when its
 * issuer could itself invoke it with these arguments (attenuation), all the
 * way to a founder. Roles are principals too: a member holds what each of
 * their roles holds, and a role what the roles it was given hold.
 */
export function may(
  auth: Authority,
  who: string,
  cmd: string,
  args: Json,
  visiting = new Set<string>(),
): boolean {
  if (auth.founders.includes(who)) return true;
  const key = `${who} ${cmd} ${JSON.stringify(args)}`;
  if (visiting.has(key)) return false;
  const inner = new Set(visiting).add(key);
  const principals = [who, ...rolesOf(auth, who, inner)];
  return auth.delegations.some(
    (d) =>
      principals.includes(d.aud) &&
      covers(d.cmd, cmd) &&
      allows(d.pol, args) &&
      may(auth, d.iss, cmd, args, inner),
  );
}

/** The roles `who` holds, as `role:<name>`, directly or through roles it holds */
function rolesOf(auth: Authority, who: string, visiting = new Set<string>()): string[] {
  const out = new Set<string>();
  const queue = [who];
  while (queue.length > 0) {
    const p = queue.shift() ?? '';
    for (const a of auth.assignments) {
      const role = `role:${a.role}`;
      if (a.to !== p || out.has(role)) continue;
      if (!may(auth, a.by, '/role/assign', { role: a.role, to: a.to }, visiting)) continue;
      out.add(role);
      queue.push(role);
    }
  }
  return [...out].sort();
}
