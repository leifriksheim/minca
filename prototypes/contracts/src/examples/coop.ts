/**
 * 2. Co-op. No fixed top. Members add members; removing a member needs
 * ballots from more than half of the members, counted as of the proposal.
 */
import type { Check } from '../../../../packages/core/src/records/checks.js';
import type { Delegation } from '../grants.js';

// -- (A) UCAN grants, CEL contracts -------------------------------------------

/** `top: "none"`: no founder, so the constitution itself is the root of every grant */
export const CONSTITUTION = 'space:coop';

/** Members add members */
export const grants: Delegation[] = [
  { iss: CONSTITUTION, aud: 'role:member', cmd: '/role/assign', pol: [['==', '.role', 'member']] },
];

/**
 * The proposal lists the members as of itself, and the check confirms the
 * list is complete: `memberCount` is a name the subset doesn't have today,
 * the number of members as of the version's `seen`.
 */
export const proposalContract: Check[] = [
  {
    that: 'body.members.size() == memberCount && body.members.all(m, member(m)) && body.members.distinct().size() == body.members.size() && body.member in body.members',
    else: 'A proposal lists every member as of itself',
  },
];

/** On `std.member`: an add needs nothing more; a removal cites its proposal and the ballots */
export const memberContract: Check[] = [
  {
    that: "body.op == 'add' || versions([body.proposal]).all(p, p.collection == 'coop.proposal' && p.body.member == body.did)",
    else: 'A removal cites a proposal to remove that member',
  },
  {
    that: "body.op == 'add' || versions([body.proposal]).all(p, versions(body.ballots).filter(b, b.collection == 'coop.ballot' && b.link('on') == p.key && b.body.yes == true && b.author in p.body.members).map(b, b.author).distinct().size() * 2 > p.body.members.size())",
    else: 'More than half of the members as of the proposal said yes',
  },
];

// -- (C) Datalog ---------------------------------------------------------------

/** With `member_at(Version, Member)` given by the host's replay of the access history */
export const datalog = `
yes($p, $m) <- record($b, "coop.ballot", $m), link($b, "on", $p), field($b, "yes", true), member_at($p, $m);
passes($p) <- record($p, "coop.proposal", _), $y = count $m { yes($p, $m) }, $n = count $m { member_at($p, $m) }, $y * 2 > $n;
removed($who) <- record($r, "std.member", _), field($r, "op", "remove"), field($r, "proposal", $p), passes($p), field($p, "member", $who);
`;

/** The same, with membership as of each version derived in Datalog too: refused */
export const datalogWhole = `
before($a, $b) <- seen($b, $a);
before($a, $c) <- before($a, $b), seen($c, $b);
added($a, $m) <- record($a, "std.member", $by), field($a, "op", "add"), field($a, "did", $m), member_at($a, $by);
member_at($v, $m) <- record($v, _, _), founding($m), !removed_before($v, $m);
member_at($v, $m) <- added($a, $m), before($a, $v), !removed_before($v, $m);
removed_before($v, $m) <- record($r, "std.member", _), field($r, "op", "remove"), before($r, $v), field($r, "proposal", $p), passes($p), field($p, "member", $m);
yes($p, $m) <- record($b, "coop.ballot", $m), link($b, "on", $p), field($b, "yes", true), member_at($p, $m);
passes($p) <- record($p, "coop.proposal", _), $y = count $m { yes($p, $m) }, $n = count $m { member_at($p, $m) }, $y * 2 > $n;
`;
