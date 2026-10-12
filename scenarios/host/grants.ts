/**
 * Grants as the plan has them (spec/drafts/constitution-grants-contracts.md
 * §2): UCAN-shaped delegations to people or roles, with UCAN policies, role
 * assignments, nestings and unassignments. Only the authority logic, not
 * envelopes or signatures. This is the code a peer would run, written in
 * TypeScript: the policy language only ever sees one invocation's
 * arguments, which the host fills in for each command (`byCreator`, `self`,
 * `roles` and the rest; `argsFor` fills in the ones about a target).
 *
 * Time is a stand-in. An entry may carry `at`, a place in one linear
 * history, and is then judged by what came before it (its own view, as 03
 * §4.3 judges access events). An entry without `at` is founding state,
 * before everything. A real peer has a causal history instead, where a
 * concurrent removal strikes what it races; this host has no concurrency.
 */
import { allows, type Json, type Policy } from './ucan-policy.js';

/** `iss` lets `aud` (a DID, or `role:<name>`) invoke `cmd` and below, where `pol` holds */
export interface Delegation {
  readonly iss: string;
  readonly aud: string;
  readonly cmd: string;
  readonly pol: Policy;
  readonly at?: number;
}

/**
 * `by` puts the account `to` in the role `role`: an invocation of
 * `/role/assign`, with the arguments `{ role, self, roles }`. It grants
 * nothing itself: the role's grants are the delegations to it. An
 * assignment to a role (`to` starting `role:`) is refused: that is
 * nesting, which grants.
 */
export interface Assignment {
  readonly by: string;
  readonly to: string;
  readonly role: string;
  readonly at?: number;
}

/**
 * `by` puts the role `role` inside the role `holds`: members of `role` hold
 * what `holds` holds. Part of `/role/define` for `role`, and a grant, so
 * it is attenuated like one: through it, a member of `role` may do only
 * what `by` could do itself, as of the nesting.
 */
export interface Nesting {
  readonly by: string;
  readonly role: string;
  readonly holds: string;
  readonly at?: number;
}

/**
 * `by` takes `role` from the account `from`: an invocation of
 * `/role/unassign`, with `{ role, self, roles }`. Leaving a role on one's
 * own (`by === from`) is built in and needs no grant.
 */
export interface Unassignment {
  readonly by: string;
  readonly from: string;
  readonly role: string;
  readonly at: number;
}

export interface Authority {
  /** The constitution's `top`: they hold every command */
  readonly founders: ReadonlyArray<string>;
  readonly delegations: ReadonlyArray<Delegation>;
  readonly assignments: ReadonlyArray<Assignment>;
  readonly nestings?: ReadonlyArray<Nesting>;
  readonly unassignments?: ReadonlyArray<Unassignment>;
}

/** The present: after every entry */
const NOW = Number.POSITIVE_INFINITY;
/** Whether an entry came before `at` (founding state comes before everything) */
const before = (e: { readonly at?: number }, at: number) => (e.at ?? Number.NEGATIVE_INFINITY) < at;

/** `/record` covers `/record/write`; `/` covers everything */
const covers = (granted: string, cmd: string) =>
  granted === '/' || cmd === granted || cmd.startsWith(`${granted}/`);

const isRole = (p: string) => p.startsWith('role:');
const roleName = (p: string) => p.slice('role:'.length);

/**
 * Whether `who` may invoke `cmd` with `args`, as of `at`. A delegation
 * counts when its issuer could itself invoke it with these arguments as of
 * the delegation (attenuation, judged in its own view), all the way to a
 * founder; a delegation to a role also needs its issuer to hold
 * `/role/define` for that role, unless it is a founder's.
 */
export function may(auth: Authority, who: string, cmd: string, args: Json, at = NOW): boolean {
  return mayIn(auth, who, cmd, args, at, new Set());
}

function mayIn(
  auth: Authority,
  who: string,
  cmd: string,
  args: Json,
  at: number,
  visiting: ReadonlySet<string>,
): boolean {
  if (auth.founders.includes(who)) return true;
  const key = `${who} ${cmd} ${JSON.stringify(args)} ${at}`;
  if (visiting.has(key)) return false;
  const inner = new Set(visiting).add(key);
  const principals = [who, ...rolesIn(auth, who, at, inner).map((r) => `role:${r}`)];
  return principals.some((p) => holderMay(auth, p, cmd, args, at, inner));
}

/** What a principal (an account or a role) holds directly, or a role through its nestings */
function holderMay(
  auth: Authority,
  principal: string,
  cmd: string,
  args: Json,
  at: number,
  visiting: ReadonlySet<string>,
): boolean {
  const direct = auth.delegations.some(
    (d) =>
      before(d, at) &&
      d.aud === principal &&
      covers(d.cmd, cmd) &&
      allows(d.pol, args) &&
      issued(auth, d, cmd, args, visiting),
  );
  if (direct || !isRole(principal)) return direct;
  const role = roleName(principal);
  return (auth.nestings ?? []).some(
    (n) =>
      before(n, at) &&
      n.role === role &&
      n.holds !== role &&
      mayIn(auth, n.by, '/role/define', { role }, n.at ?? NOW, visiting) &&
      mayIn(auth, n.by, cmd, args, n.at ?? NOW, visiting) &&
      holderMay(auth, `role:${n.holds}`, cmd, args, at, visiting),
  );
}

/** A delegation stands when its issuer held what it delegates, as of the delegation */
function issued(auth: Authority, d: Delegation, cmd: string, args: Json, visiting: ReadonlySet<string>) {
  if (auth.founders.includes(d.iss)) return true;
  const as = d.at ?? NOW;
  if (isRole(d.aud) && !mayIn(auth, d.iss, '/role/define', { role: roleName(d.aud) }, as, visiting))
    return false;
  return mayIn(auth, d.iss, cmd, args, as, visiting);
}

/** The roles the account `who` holds as of `at`, by name (not through nestings) */
function rolesIn(auth: Authority, who: string, at: number, outer: ReadonlySet<string>): string[] {
  const key = `roles ${who} ${at}`;
  if (isRole(who) || outer.has(key)) return [];
  const visiting = new Set(outer).add(key);
  const out = new Set<string>();
  for (const a of auth.assignments) {
    if (a.to !== who || out.has(a.role) || !before(a, at)) continue;
    const as = a.at ?? NOW;
    const struck = (auth.unassignments ?? []).some(
      (u) =>
        u.from === who &&
        u.role === a.role &&
        before(a, u.at) &&
        u.at < at &&
        (u.by === u.from ||
          mayIn(
            auth,
            u.by,
            '/role/unassign',
            targetArgs(auth, u.by, who, u.role, u.at, visiting),
            u.at,
            visiting,
          )),
    );
    if (struck) continue;
    const args = targetArgs(auth, a.by, who, a.role, as, visiting);
    if (!mayIn(auth, a.by, '/role/assign', args, as, visiting)) continue;
    out.add(a.role);
  }
  return [...out].sort();
}

/** The arguments of a command about a target, as the host fills them in: `{ role?, self, roles }` */
export function argsFor(auth: Authority, invoker: string, target: string, role?: string, at = NOW): Json {
  return targetArgs(auth, invoker, target, role, at, new Set());
}

function targetArgs(
  auth: Authority,
  invoker: string,
  target: string,
  role: string | undefined,
  at: number,
  visiting: ReadonlySet<string>,
): Json {
  // The target's roles as of the view, so a policy can protect, say, admins.
  const roles = auth.founders.includes(target) ? [] : rolesIn(auth, target, at, visiting);
  const self = invoker === target;
  return role === undefined ? { self, roles } : { role, self, roles };
}
