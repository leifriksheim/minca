/** 5. Mutual credit, in Datalog. Parked; see the scenarios README. */

export const datalog = `
pay($p, $a, $to, $amt, $bal) <- record($p, "app.pay", $a), field($p, "to", $to), field($p, "amount", $amt), field($p, "balance", $bal);

// A double spend: two payments after the same one, or two first payments of a line.
forked($p) <- pay($p, _, _, _, _), prev($p, $q), prev($o, $q), $o != $p;
forked($p) <- pay($p, _, _, _, _), key($p, $k), seq($p, 0), key($o, $k), seq($o, 0), $o != $p;

// Earlier payments on the same line, and what they claimed.
earlier($q, $p) <- prev($p, $q);
earlier($q, $p) <- earlier($q, $m), prev($p, $m);
claimed_before($p, $r) <- earlier($q, $p), item($q, "received", _, $r);
twice($p) <- item($p, "received", $i, $r), item($p, "received", $j, $r), $i != $j;

claims($p, $s) <- pay($p, _, _, _, _), $s = sum $amt per $r { item($p, "received", _, $r), field($r, "amount", $amt) };

// Every payment it claims counts, is to the payer, and is new: walk the list.
claims_ok($p, 0) <- pay($p, _, _, _, _);
claims_ok($p, $j) <- claims_ok($p, $i), item($p, "received", $i, $r), counts($r), pay($r, _, $a, _, _), pay($p, $a, _, _, _), !claimed_before($p, $r), $j = $i + 1;

balance_before($p, 0) <- pay($p, _, _, _, _), seq($p, 0);
balance_before($p, $b) <- prev($p, $q), counts($q), pay($q, _, _, _, $b);

counts($p) <- pay($p, $a, $to, $amt, $bal), $to != $a, $amt >= 0, !forked($p), !twice($p),
  balance_before($p, $b), claims_ok($p, $n), size($p, "received", $n), claims($p, $s),
  $bal == $b - $amt + $s, $bal >= -100;

// An account's balance: its newest payment that counts.
followed($p) <- prev($q, $p), counts($q);
balance($a, $b) <- counts($p), pay($p, $a, _, _, $b), !followed($p);

// A payment whose previous one isn't here yet.
held($q) <- record($q, _, _);
waiting($p) <- prev($p, $q), !held($q);
`;
