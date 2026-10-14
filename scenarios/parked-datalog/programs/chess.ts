/** 1. Chess club, in Datalog: grants, roles and the contract. Parked; see the scenarios README. */

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
