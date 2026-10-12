/**
 * 1. Chess club. Members play; a Referee may delete moves in `app.chess`;
 * admins assign Referee.
 */
import type { Check } from '../../../../packages/core/src/records/checks.js';
import type { Delegation } from '../grants.js';

export const ALICE = 'did:key:alice'; // founder
export const ERIN = 'did:key:erin'; // admin
export const BOB = 'did:key:bob';
export const CAROL = 'did:key:carol';
export const DAVE = 'did:key:dave'; // referee

// -- (A) UCAN grants, CEL contract ---------------------------------------------

export const grants: Delegation[] = [
  { iss: ALICE, aud: 'role:member', cmd: '/record/write', pol: [['==', '.collection', 'app.chess']] },
  { iss: ALICE, aud: 'role:referee', cmd: '/record/delete', pol: [['==', '.collection', 'app.chess']] },
  { iss: ALICE, aud: 'role:admin', cmd: '/role/assign', pol: [['==', '.role', 'referee']] },
];

/** On each move: the player whose turn it is made it */
export const moveContract: Check[] = [
  {
    that: "versions([body.game]).all(g, g.collection == 'app.chess.game' && author == (int(body.ply) % 2 == 0 ? g.body.white : g.body.black))",
    else: 'Players move in turn',
  },
];

// -- (C) Datalog, grants and contract ---------------------------------------------

export const datalog = `
grant("member", "/record/write", "app.chess");
grant("referee", "/record/delete", "app.chess");
grant("admin", "/role/assign", "referee");

// An assignment counts when whoever made it may assign that role.
assigned($by, $who, $role) <- record($a, "std.role", $by), field($a, "to", $who), field($a, "role", $role);
holds($who, $role) <- assigned($by, $who, $role), founder($by);
holds($who, $role) <- assigned($by, $who, $role), holds($by, $r), grant($r, "/role/assign", $role);

// request(Who, Command, Collection, Creator): may it be done?
allowed($w, $c, $k, $by) <- request($w, $c, $k, $by), founder($w);
allowed($w, $c, $k, $by) <- request($w, $c, $k, $by), holds($w, $r), grant($r, $c, $k);
allowed($w, "/record/delete", $k, $w) <- request($w, "/record/delete", $k, $w), holds($w, "member");

// The player whose turn it is made the move.
legal($m) <- record($m, "app.chess", $p), field($m, "game", $g), field($m, "ply", $n), field($g, "white", $p), $n % 2 == 0;
legal($m) <- record($m, "app.chess", $p), field($m, "game", $g), field($m, "ply", $n), field($g, "black", $p), $n % 2 == 1;
`;
