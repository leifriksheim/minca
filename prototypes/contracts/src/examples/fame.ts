/**
 * 4. Hall of fame. A comment enters it when 5 different members react 🙂.
 */
import type { Check } from '../../../../packages/core/src/records/checks.js';

// -- (A) CEL contract, on a claim that cites the reactions ----------------------

export const claimContract: Check[] = [
  {
    that: "versions(body.reactions).filter(r, r.collection == 'app.reaction' && !r.deleted && r.link('on') == link('on') && r.body.emoji == '🙂').map(r, r.author).distinct().size() >= 5",
    else: "A comment enters the hall of fame with 5 different people's 🙂",
  },
];

// -- (C) Datalog -----------------------------------------------------------------

/** Over whatever the reader holds: no claim needed */
export const datalog = `
// The current version of a record: none of its key has a higher seq, or the same seq and a lower id.
superseded($a) <- key($a, $k), key($b, $k), seq($a, $x), seq($b, $y), $y > $x;
superseded($a) <- key($a, $k), key($b, $k), seq($a, $x), seq($b, $x), $b < $a;

member($m) <- initial($m), !removed($m);
removed($m) <- record($r, "std.member", _), field($r, "op", "remove"), field($r, "did", $m);

smile($c, $m) <- record($r, "app.reaction", $m), !superseded($r), !deleted($r), link($r, "on", $c), field($r, "emoji", "🙂"), member($m);
famous($c) <- record($c, "app.comment", _), $n = count $m { smile($c, $m) }, $n >= 5;
`;

/** Over a claim and the versions it cites, as the CEL contract reads them */
export const claimDatalog = `
famous($f, $c) <- record($f, "app.fame", _), link($f, "on", $c),
  $n = count $m { item($f, "reactions", _, $r), record($r, "app.reaction", $m), !deleted($r), link($r, "on", $c), field($r, "emoji", "🙂") },
  $n >= 5;
`;
