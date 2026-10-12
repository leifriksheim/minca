/**
 * Grants as the plan has them (spec/drafts/constitution-grants-contracts.md
 * §2): UCAN-shaped delegations to roles, with UCAN policies, role
 * definitions, assignments, nestings, unassignments and removals. Only the
 * constitution (a founder, here) and `/role/define` issue grants, and only
 * to roles: an account holds power only through its roles, which
 * unassigning or removal take away. A delegation to an account or key
 * counts for nothing, and only members (founders, or accounts holding a
 * role) may invoke. Only the authority logic, not envelopes or signatures.
 * This is the code a peer would run, written in TypeScript: the policy
 * language only ever sees one invocation's arguments, which the host fills
 * in for each command (`byCreator`, `self`, `roles`, `mine` and the rest;
 * `argsFor` fills in the ones about a target).
 *
 * Time is a stand-in. An entry may carry `at`, a place in one linear
 * history, and `view`, the last place it had seen (by default, everything
 * before it). It is judged by what it had seen (its own view, as 03 §4.3
 * judges access events). An entry at a place after another that its view
 * doesn't reach is concurrent with it. An entry without `at` is founding
 * state, before everything. Strikes are not replayed here; `strikes` says
 * which concurrent action a reduction strikes.
 */
import { allows, type Json, type Policy } from './ucan-policy.js';

/** A place in the history, and what was seen there */
interface Placed {
  readonly at?: number;
  /** The last place it had seen; by default everything before `at` */
  readonly view?: number;
}

/**
 * `iss` lets the role `aud` (`role:<name>`) invoke `cmd` and below, where
 * `pol` holds. Any other `aud` counts for nothing. With `def`, it is part
 * of that role definition, and counts only while the definition is current.
 */
export interface Delegation extends Placed {
  readonly iss: string;
  readonly aud: string;
  readonly cmd: string;
  readonly pol: Policy;
  readonly def?: string;
}

/**
 * A `/role/define` of `role` by `by`, which its delegations and nestings
 * name by `id`. It supersedes the definitions it `saw`; definitions of one
 * role that none of the others saw are rivals.
 */
export interface Definition extends Placed {
  readonly id: string;
  readonly by: string;
  readonly role: string;
  readonly saw?: ReadonlyArray<string>;
}

/**
 * `by` puts the account `to` in the role `role`: an invocation of
 * `/role/assign`, with the arguments `{ role, self, roles }`. It grants
 * nothing itself: the role's grants are the delegations to it. An
 * assignment to a role (`to` starting `role:`) is refused: that is
 * nesting, which grants.
 */
export interface Assignment extends Placed {
  readonly by: string;
  readonly to: string;
  readonly role: string;
}

/**
 * `by` puts the role `role` inside the role `holds`: members of `role` hold
 * what `holds` holds. Part of `/role/define` for `role`, and a grant, so
 * it is attenuated like one: through it, a member of `role` may do only
 * what `by` could do itself, as of the nesting.
 */
export interface Nesting extends Placed {
  readonly by: string;
  readonly role: string;
  readonly holds: string;
  readonly def?: string;
}

/**
 * `by` takes `role` from the account `from`: an invocation of
 * `/role/unassign`, with `{ role, self, roles }`. Leaving a role on one's
 * own (`by === from`) is built in and needs no grant.
 */
export interface Unassignment extends Placed {
  readonly by: string;
  readonly from: string;
  readonly role: string;
  readonly at: number;
}

/** `by` removes `who` from the space: `/member/remove`, with `{ self, roles }`. Leaving is built in. */
export interface Removal extends Placed {
  readonly by: string;
  readonly who: string;
  readonly at: number;
}

export interface Authority {
  /** The constitution's `top`: they hold every command */
  readonly founders: ReadonlyArray<string>;
  readonly delegations: ReadonlyArray<Delegation>;
  readonly assignments: ReadonlyArray<Assignment>;
  readonly definitions?: ReadonlyArray<Definition>;
  readonly nestings?: ReadonlyArray<Nesting>;
  readonly unassignments?: ReadonlyArray<Unassignment>;
  readonly removals?: ReadonlyArray<Removal>;
}

/** The present: after every entry */
const NOW = Number.POSITIVE_INFINITY;
const NEVER = Number.NEGATIVE_INFINITY;
/** Whether an entry came before `at` (founding state comes before everything) */
const before = (e: Placed, at: number) => (e.at ?? NEVER) < at;
/** Where an entry is judged: as of its view, or its place; founding state against everything */
const judgedAt = (e: Placed) => (e.view !== undefined ? e.view + 0.5 : (e.at ?? NOW));
/** Whether `e` had seen `x` (founding state saw nothing) */
const saw = (e: Placed, x: Placed) => e.at !== undefined && (x.at ?? NEVER) < judgedAt(e);

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
  // An account's power is its roles as of the action's view; with none, it is no member.
  const roles = rolesIn(auth, who, at, inner);
  return roles.some((r) => holderMay(auth, `role:${r}`, cmd, args, at, inner));
}

/**
 * The current definitions of `role` as of `at`: those no other one saw.
 * More than one are rivals, and the role holds only what every one holds.
 */
function heads(auth: Authority, role: string, at: number, visiting: ReadonlySet<string>): Definition[] {
  // A definition its author couldn't write is no rival: else anyone could empty a role.
  const defs = (auth.definitions ?? []).filter(
    (d) =>
      d.role === role &&
      before(d, at) &&
      (auth.founders.includes(d.by) ||
        mayIn(
          auth,
          d.by,
          '/role/define',
          defineArgs(auth, d.by, role, undefined, judgedAt(d), visiting),
          judgedAt(d),
          visiting,
        )),
  );
  return defs.filter((d) => !defs.some((o) => o.id !== d.id && (o.saw ?? []).includes(d.id)));
}

/** What a role holds: delegations to it, judged in their own view, and through its nestings */
function holderMay(
  auth: Authority,
  principal: string,
  cmd: string,
  args: Json,
  at: number,
  visiting: ReadonlySet<string>,
): boolean {
  const role = roleName(principal);
  const current = heads(auth, role, at, visiting);
  const delegates = (d: Delegation) =>
    before(d, at) &&
    d.aud === principal &&
    covers(d.cmd, cmd) &&
    allows(d.pol, args) &&
    issued(auth, d, cmd, args, visiting);
  const nests = (n: Nesting) =>
    before(n, at) &&
    n.role === role &&
    n.holds !== role &&
    mayIn(
      auth,
      n.by,
      '/role/define',
      defineArgs(auth, n.by, role, n.holds, judgedAt(n), visiting),
      judgedAt(n),
      visiting,
    ) &&
    mayIn(auth, n.by, cmd, args, judgedAt(n), visiting) &&
    holderMay(auth, `role:${n.holds}`, cmd, args, at, visiting);
  // Outside any definition: additive, each judged on its own.
  if (auth.delegations.some((d) => d.def === undefined && delegates(d))) return true;
  if ((auth.nestings ?? []).some((n) => n.def === undefined && nests(n))) return true;
  if (current.length === 0) return false;
  // Inside definitions: what every current one holds, compared by `{cmd, pol}` (or `holds`), each validly issued.
  const inDef = (id: string, by: string) => (e: { def?: string; iss?: string; by?: string }) =>
    e.def === id && (e.iss ?? e.by) === by;
  const first = current[0];
  if (!first) return false;
  const shape = (d: Delegation) => JSON.stringify({ cmd: d.cmd, pol: d.pol });
  const viaDelegation = auth.delegations
    .filter(inDef(first.id, first.by))
    .some((d0) =>
      current.every((h) =>
        auth.delegations.some((d) => inDef(h.id, h.by)(d) && shape(d) === shape(d0) && delegates(d)),
      ),
    );
  if (viaDelegation) return true;
  return (auth.nestings ?? [])
    .filter(inDef(first.id, first.by))
    .some((n0) =>
      current.every((h) =>
        (auth.nestings ?? []).some((n) => inDef(h.id, h.by)(n) && n.holds === n0.holds && nests(n)),
      ),
    );
}

/** A delegation stands when its issuer held what it delegates, as of the delegation */
function issued(auth: Authority, d: Delegation, cmd: string, args: Json, visiting: ReadonlySet<string>) {
  if (!isRole(d.aud)) return false;
  if (auth.founders.includes(d.iss)) return true;
  const as = judgedAt(d);
  const role = roleName(d.aud);
  if (
    !mayIn(auth, d.iss, '/role/define', defineArgs(auth, d.iss, role, undefined, as, visiting), as, visiting)
  )
    return false;
  return mayIn(auth, d.iss, cmd, args, as, visiting);
}

/** `/role/define`'s arguments: `{ role, holds?, mine }`, where `mine` is whether the definer holds `role` */
function defineArgs(
  auth: Authority,
  by: string,
  role: string,
  holds: string | undefined,
  at: number,
  visiting: ReadonlySet<string>,
): Json {
  const mine = holdsRole(auth, by, role, at, visiting);
  return holds === undefined ? { role, mine } : { role, holds, mine };
}

/** Whether `who` holds `role` as of `at`, directly or through nesting */
function holdsRole(auth: Authority, who: string, role: string, at: number, visiting: ReadonlySet<string>) {
  const held = new Set(rolesIn(auth, who, at, visiting));
  for (let grew = true; grew;) {
    grew = false;
    for (const n of auth.nestings ?? [])
      if (before(n, at) && held.has(n.role) && !held.has(n.holds)) {
        held.add(n.holds);
        grew = true;
      }
  }
  return held.has(role);
}

/** `/role/define`'s arguments, as the host fills them in */
export function defineArgsFor(auth: Authority, by: string, role: string, holds?: string, at = NOW): Json {
  return defineArgs(auth, by, role, holds, at, new Set());
}

/** The roles the account `who` holds as of `at`, by name (not through nestings) */
function rolesIn(auth: Authority, who: string, at: number, outer: ReadonlySet<string>): string[] {
  const key = `roles ${who} ${at}`;
  if (isRole(who) || outer.has(key)) return [];
  const visiting = new Set(outer).add(key);
  // A removal ends every assignment that hadn't seen it; after a re-add, only those that saw it count.
  const removals = (auth.removals ?? []).filter(
    (r) =>
      r.who === who &&
      before(r, at) &&
      !auth.founders.includes(who) &&
      (r.by === who ||
        mayIn(
          auth,
          r.by,
          '/member/remove',
          targetArgs(auth, r.by, who, undefined, judgedAt(r), visiting),
          judgedAt(r),
          visiting,
        )),
  );
  const out = new Set<string>();
  for (const a of auth.assignments) {
    if (a.to !== who || out.has(a.role) || !before(a, at)) continue;
    if (removals.some((r) => !saw(a, r))) continue;
    const struck = (auth.unassignments ?? []).some(
      (u) =>
        u.from === who &&
        u.role === a.role &&
        before(u, at) &&
        !saw(a, u) &&
        (u.by === u.from ||
          mayIn(
            auth,
            u.by,
            '/role/unassign',
            targetArgs(auth, u.by, who, u.role, judgedAt(u), visiting),
            judgedAt(u),
            visiting,
          )),
    );
    if (struck) continue;
    const as = judgedAt(a);
    if (!mayIn(auth, a.by, '/role/assign', targetArgs(auth, a.by, who, a.role, as, visiting), as, visiting))
      continue;
    out.add(a.role);
  }
  return [...out].sort();
}

/**
 * Whether a reduction strikes an action concurrent with it. Removal strikes
 * every one. Unassigning a role, or leaving it, strikes only an action that
 * its own view allowed and would refuse without that role.
 */
export function strikes(
  auth: Authority,
  reduction: { readonly who: string; readonly role?: string },
  action: { readonly who: string; readonly cmd: string; readonly args: Json; readonly at: number },
): boolean {
  if (action.who !== reduction.who) return false;
  if (!may(auth, action.who, action.cmd, action.args, action.at)) return false;
  if (reduction.role === undefined) return true;
  const without: Authority = {
    ...auth,
    assignments: auth.assignments.filter((a) => !(a.to === reduction.who && a.role === reduction.role)),
  };
  return !may(without, action.who, action.cmd, action.args, action.at);
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
