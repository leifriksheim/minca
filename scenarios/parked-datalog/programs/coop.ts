/** 2. Co-op, in Datalog. Parked; see the scenarios README. */

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
