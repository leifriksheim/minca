# Draft: CEL or Datalog for contracts and grants

Status: evidence for a decision, October 2026. Not normative. It tests step
1 of [the plan](constitution-grants-contracts.md) ("Examples first") with
two languages instead of one: the five examples, written in both, run by a
small evaluator for each, with tests.

- **(A)** CEL contracts (Weave's existing subset, `packages/core/src/records/cel.ts`)
  with grants as UCAN 1.0 delegations and UCAN policies.
- **(B)** Datalog for contracts only.
- **(C)** Datalog for grants and contracts both.

**Recommendation: (A)**, with four additions the examples showed it needs
(§9). Datalog wrote the grants better, and wrote about the same contracts,
but the parts that are hard are hard in both, and Datalog's strength,
deriving over everything a node holds, is what Weave's contracts must not
do. The reasons are in §8.

## 1. What was built

Everything is in `prototypes/contracts/`, a private workspace that is
typechecked, linted and tested with the rest (`npm test`, `npm run check`).

| File                 | What                                                                                                                                                                                             | Lines (code) |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------ |
| `src/datalog.ts`     | Datalog: parser, safety, stratification, semi-naive evaluation, negation, `count`/`sum`, arithmetic, a fact limit                                                                                | 715 (596)    |
| `src/ucan-policy.ts` | UCAN 1.0 policies: every operator, the common selectors                                                                                                                                          | 128 (104)    |
| `src/grants.ts`      | Delegation chains to a founder, roles, roles holding roles                                                                                                                                       | 78 (54)      |
| `src/cel-host.ts`    | What a peer does around `runChecks` (`packages/core/src/records/checks.ts`): chains, pending, standing as of `seen`, a membership replay, and two optional host rules (`forkKills`, extra names) | 170 (132)    |
| `src/space.ts`       | Versions, and the mapping from versions to Datalog facts                                                                                                                                         | 100 (69)     |
| `src/examples/*.ts`  | The five examples, in both languages, as quoted below                                                                                                                                            | 275          |
| `tests/*.test.ts`    | 66 tests: the evaluator alone (15), and each example in both languages, with order-shuffling for every Datalog example                                                                           | 883          |

The CEL side reuses the real evaluator; it imports `runChecks` from
`packages/core/src` by relative path, since the package doesn't export it.

### Facts from records

Both sides read the same versions. For Datalog each version becomes:

```
record(Id, Collection, Author)   key(Id, Key)   seq(Id, Seq)
prev(Id, Before)   seen(Id, Other)   deleted(Id)   link(Id, Rel, To)
field(Id, "a.b", Value)               for each string, safe integer or boolean in the body
item(Id, "list", Index, Value)        for each such value in a list
size(Id, "list", N)                   for each list
```

Nulls and numbers that aren't safe integers have no fact. Access facts
(`founder`, `initial`, `member_at`, `request`) are added where an example
needs them.

### The Datalog, against Biscuit's

Syntax follows [Biscuit's Datalog](https://doc.biscuitsec.org/reference/datalog):
`$x` variables, `head <- body;`, `//` comments, strings, integers, booleans,
`== != < <= > >= + - * / %`. Where it differs:

| Biscuit                        | Here                                                  | Why                                                    |
| ------------------------------ | ----------------------------------------------------- | ------------------------------------------------------ |
| No negation                    | `!pred(...)`, stratified                              | Every example needs "not withdrawn", "not forked"      |
| No aggregates                  | `$n = count $m { ... }`, `$s = sum $a per $r { ... }` | Quorum, the hall of fame and balances count            |
| Expressions only test          | `$x = expr` binds a new variable                      | Balances and list positions compute                    |
| No `_`                         | `_`, a fresh variable never read                      | Readability; a negated atom may leave it free          |
| Dates, bytes, sets, methods    | Strings, safe integers, booleans only                 | Nothing needed them; no floats keeps equality exact    |
| `check if`, `allow if`, scopes | None: a caller queries derived predicates             | Contracts derive results; the host decides what counts |

An aggregate's body is its own scope: variables also used outside it are
its group, the rest are local. `count` counts distinct values of the listed
variables; `sum $a per $r` adds `$a` over distinct `($r, $a)`. A group with
no solutions gives 0. An expression that errs (division by zero, a result
past 2^53, comparing a string with a number) gives no fact for that binding.

## 2. The examples, side by side

Each (A) block is the UCAN delegations and CEL checks as written; each (C)
block is the whole Datalog program. Both are quoted from
`prototypes/contracts/src/examples/`.

### 2.1 Chess club

Members play; a Referee may delete moves in `app.chess`; admins assign
Referee. A small contract checks that players move in turn.

**(A)**

```js
// grants
{ iss: ALICE, aud: 'role:member',  cmd: '/record/write',  pol: [['==', '.collection', 'app.chess']] }
{ iss: ALICE, aud: 'role:referee', cmd: '/record/delete', pol: [['==', '.collection', 'app.chess']] }
{ iss: ALICE, aud: 'role:admin',   cmd: '/role/assign',   pol: [['==', '.role', 'referee']] }
```

```
// contract on app.chess
versions([body.game]).all(g, g.collection == 'app.chess.game' && author == (int(body.ply) % 2 == 0 ? g.body.white : g.body.black))
```

**(C)**

```
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
```

Both work. (A) is shorter, because how roles chain is fixed code
(`src/grants.ts`), not part of each space. (C) also says "a member may
delete their own move", which a UCAN policy can't: it compares a selector
with a literal, never with the invoker. In CEL, `int(body.ply) % 2` needs
the `int()` because JSON numbers are doubles and `%` takes ints.

### 2.2 Co-op

No fixed top. Members add members; removing one needs ballots from more
than half of the members as of the proposal.

**(A)**

```js
// grants: the constitution is the root, since there is no founder
{ iss: 'space:coop', aud: 'role:member', cmd: '/role/assign', pol: [['==', '.role', 'member']] }
```

```
// contract on coop.proposal: it lists every member as of itself
body.members.size() == memberCount && body.members.all(m, member(m)) && body.members.distinct().size() == body.members.size() && body.member in body.members

// contracts on std.member: a removal cites its proposal and the ballots
body.op == 'add' || versions([body.proposal]).all(p, p.collection == 'coop.proposal' && p.body.member == body.did)
body.op == 'add' || versions([body.proposal]).all(p, versions(body.ballots).filter(b, b.collection == 'coop.ballot' && b.link('on') == p.key && b.body.yes == true && b.author in p.body.members).map(b, b.author).distinct().size() * 2 > p.body.members.size())
```

**(C)**, with `member_at(Version, Member)` given by the host's replay:

```
yes($p, $m) <- record($b, "coop.ballot", $m), link($b, "on", $p), field($b, "yes", true), member_at($p, $m);
passes($p) <- record($p, "coop.proposal", _), $y = count $m { yes($p, $m) }, $n = count $m { member_at($p, $m) }, $y * 2 > $n;
removed($who) <- record($r, "std.member", _), field($r, "op", "remove"), field($r, "proposal", $p), passes($p), field($p, "member", $who);
```

and, deriving `member_at` in Datalog too, **refused**:

```
before($a, $b) <- seen($b, $a);
before($a, $c) <- before($a, $b), seen($c, $b);
added($a, $m) <- record($a, "std.member", $by), field($a, "op", "add"), field($a, "did", $m), member_at($a, $by);
member_at($v, $m) <- record($v, _, _), founding($m), !removed_before($v, $m);
member_at($v, $m) <- added($a, $m), before($a, $v), !removed_before($v, $m);
removed_before($v, $m) <- record($r, "std.member", _), field($r, "op", "remove"), before($r, $v), field($r, "proposal", $p), passes($p), field($p, "member", $m);
yes($p, $m) <- ...;  passes($p) <- ...;   // as above
```

Awkward in **both**. CEL has no way to count the members as of anything:
a proposal can list them and `member()` confirms each, but nothing confirms
the list is complete, so a proposer could leave members out and lower the
bar. The fix is a new name, `memberCount` (members as of the version's
`seen`), which the prototype passes in; the subset doesn't have it today.
CEL also has no `let`, so `versions([...]).all(p, ...)` stands in for one.

Datalog can't derive membership as of a version at all. Whether a removal
counts depends on the members as of its proposal, which depends on earlier
removals: a predicate counting itself, which stratified Datalog refuses
(test "membership as of a version, derived in Datalog too, is refused").
It is only well founded because of causal order, which the stratifier can't
see. So the replay stays host code in every option, and Datalog gets
`member_at` as given facts, exactly as CEL gets `member()`. Strong removal
(plan §4) has the same shape: whether a removal counts depends on the
remover's standing as of it.

### 2.3 Company team

`hr` writes `app.hr`, `eng` writes `app.eng`, and `web`, inside `eng`,
writes `app.web`. The company's admins manage them all but can't read
`app.hr`.

**(A)**

```js
{ iss: CEO, aud: 'role:hr',  cmd: '/record', pol: [['==', '.collection', 'app.hr']] }
{ iss: CEO, aud: 'role:eng', cmd: '/record', pol: [['==', '.collection', 'app.eng']] }
{ iss: CEO, aud: 'role:web', cmd: '/record', pol: [['==', '.collection', 'app.web']] }
{ iss: CEO, aud: 'role:admin', cmd: '/role/assign', pol: [['or', [['==', '.role', 'hr'], ['==', '.role', 'eng'], ['==', '.role', 'web']]]] }
{ iss: CEO, aud: 'role:admin', cmd: '/record/read', pol: [['not', ['==', '.collection', 'app.hr']]] }
// and the assignment { by: ANN, to: 'role:web', role: 'eng' }: the web team holds eng
```

**(C)**

```
parent("company", "hr"); parent("company", "eng"); parent("eng", "web");
writes("hr", "app.hr"); writes("eng", "app.eng"); writes("web", "app.web");
private("app.hr");

// A team's admins manage every team below it.
below($t, $s) <- parent($t, $s);
below($t, $s) <- below($t, $m), parent($m, $s);

// in_team(Who, Team, As): As is "member" or "admin". Not by oneself.
joined($by, $who, $t, $as) <- record($j, "std.role", $by), field($j, "to", $who), field($j, "team", $t), field($j, "as", $as);
in_team($who, $t, $as) <- joined($by, $who, $t, $as), founder($by);
in_team($who, $t, $as) <- joined($by, $who, $t, $as), in_team($by, $top, "admin"), below($top, $t), $by != $who;

// A sub-team's members work in the team above it too.
works_in($who, $t) <- in_team($who, $t, "member");
works_in($who, $t) <- works_in($who, $s), parent($t, $s);

allowed($w, $c, $k) <- request($w, $c, $k), founder($w);
allowed($w, $c, $k) <- request($w, $c, $k), works_in($w, $t), writes($t, $k);
allowed($w, "/record/read", $k) <- request($w, "/record/read", $k), in_team($w, $top, "admin"), below($top, $t), writes($t, $k), !private($k);
```

Datalog is better here. The team tree is data, and `below` follows it to
any depth; in (A) every new sub-team means editing the admin's policy (or a
naming convention with `like`). And (A) has a hole: the admin may assign
`hr`, so she assigns it to herself and reads `app.hr` (test "a hole: the
admin assigns herself hr"). A policy can't say "not to yourself", for the
same reason as the creator rule above. (C) says it with `$by != $who`.

A limit neither closes: an admin who can add people to `hr` can add a
second account of her own (test "a limit no language closes"). "Manages hr
but can't read it" only holds if someone else manages hr's membership.
The plan also has a tension here: an admin assigning `hr` grants
`/record` on `app.hr`, which she doesn't hold, so `/role/assign` bypasses
UCAN's "only grant what you hold". That needs saying in plan §2 either way.

### 2.4 Hall of fame

A comment enters it when 5 different members react 🙂.

**(A)**: someone writes a claim citing the reactions.

```
versions(body.reactions).filter(r, r.collection == 'app.reaction' && !r.deleted && r.link('on') == link('on') && r.body.emoji == '🙂').map(r, r.author).distinct().size() >= 5
```

**(C)**, over whatever the reader holds, with no claim:

```
// The current version of a record: none of its key has a higher seq, or the same seq and a lower id.
superseded($a) <- key($a, $k), key($b, $k), seq($a, $x), seq($b, $y), $y > $x;
superseded($a) <- key($a, $k), key($b, $k), seq($a, $x), seq($b, $x), $b < $a;

member($m) <- initial($m), !removed($m);
removed($m) <- record($r, "std.member", _), field($r, "op", "remove"), field($r, "did", $m);

smile($c, $m) <- record($r, "app.reaction", $m), !superseded($r), !deleted($r), link($r, "on", $c), field($r, "emoji", "🙂"), member($m);
famous($c) <- record($c, "app.comment", _), $n = count $m { smile($c, $m) }, $n >= 5;
```

or over a claim and what it cites, which reads as the CEL does:

```
famous($f, $c) <- record($f, "app.fame", _), link($f, "on", $c),
  $n = count $m { item($f, "reactions", _, $r), record($r, "app.reaction", $m), !deleted($r), link($r, "on", $c), field($r, "emoji", "🙂") },
  $n >= 5;
```

The membership rules here are simplified (anyone may remove, no re-adds).
The hard cases, all tested:

| Case                                                     | CEL claim          | Datalog, all held | Datalog, the claim's past       |
| -------------------------------------------------------- | ------------------ | ----------------- | ------------------------------- |
| Five 🙂                                                  | passes             | famous            | famous                          |
| A reaction withdrawn after the claim                     | still passes       | **not** famous    | famous                          |
| Withdrawn before the claim, which had seen the delete    | **passes (a gap)** | not famous        | not famous                      |
| Its author removed after the claim                       | still passes       | **not** famous    | famous                          |
| Removed, and a claim that had seen it cites the reaction | fails              | not famous        | not famous                      |
| A device holding 3 of the 5 reactions                    | **pending**        | **not** famous    | pending (by the host; untested) |

The gap in the third row: a cited version must stand as of the claim's
`seen`, but nothing says it must be _current_ then, so a claim may cite the
version before a delete it had seen. `!r.deleted` only catches citing the
delete itself. CEL needs a rule for that (§9); "Datalog over the claim's
past" catches it, at the cost of holding the whole past.

### 2.5 Mutual credit

Payments with a limit of −100. An account's payments are one record's
versions (the line), so each names the previous one (`prev`) and carries the
balance; a payment claims payments made to it (`received`), each once.

**(A)**: six checks, and a host rule (`forkKills`): two versions after the
same one both fail, and so does everything after either.

```
body.amount >= 0.0 && body.to != author
body.received.distinct().size() == body.received.size() && body.received.all(r, !(r in (prev == null ? [] : prev.body.claimed)))
body.claimed == (prev == null ? [] : prev.body.claimed) + body.received
versions(body.received).all(r, r.collection == 'app.pay' && r.body.to == author)
body.balance == (prev == null ? 0.0 : prev.body.balance) - body.amount + sum(versions(body.received).map(r, r.body.amount) + [0.0])
body.balance >= -100.0
```

**(C)**

```
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
```

Awkward in **both**, in different places:

- **CEL** sees one step back (`prev`) and can't walk the line, so "claimed
  once" means carrying every claim so far in `body.claimed`: a list that
  grows with the account, re-read on every payment, until the work limit.
  `sum([])` is the int `0`, and an int plus a double is an error, so a
  payment that claims nothing fails unless the sum is padded with `[0.0]`
  (test "CEL's trap"). And a double spend is invisible to a check: the
  sibling is never cited, so "neither counts" is a host rule, not CEL.
- **Datalog** walks the line (`earlier`) and sees siblings (`forked`)
  naturally, and can say what waits (`waiting`) and what the balance is.
  But "every claimed payment counts" is a _for all_ inside the recursion,
  and both ways to say it (`!` or `count` over `counts`) are unstratifiable
  (test "are refused: a for-all over counts…"), so the program walks the
  list by index instead (`claims_ok`): correct, and the least readable rule
  in this document.

The same in both (test "until the second arrives, the first counts, and so
does what a payee built on it"): a payment counts until its twin arrives,
and then so does nothing built on it, including a payee's later payments
that claimed it. "Neither counts" is not monotone, so no language makes it
fixed; only a witness, or a payee waiting, does.

## 3. Line counts

| Example       | (A) grants    | (A) CEL checks, characters | (A) needs from the host beyond today's | (C) Datalog statements, lines, characters | (C) needs from the host        |
| ------------- | ------------- | -------------------------- | -------------------------------------- | ----------------------------------------- | ------------------------------ |
| Chess club    | 3 delegations | 1, 130                     | the `creator` rule (not a policy)      | 11, 11, 914 (grants, roles and contract)  | `request` facts                |
| Co-op         | 1 delegation  | 3, 527                     | `memberCount`                          | 3, 3, 374                                 | `member_at` facts (the replay) |
| Company team  | 5 delegations | none                       | can't refuse self-assignment           | 17, 13, 943                               | `request` facts                |
| Hall of fame  | none          | 1, 174                     | "cited must be current" (the gap)      | 6, 6, 515 (or 1, 3, 213 over a claim)     | none                           |
| Mutual credit | none          | 6, 471                     | the fork rule                          | 17, 19, 1,393                             | none                           |

Grants in (A) are shorter because chaining (who may grant, roles holding
roles) is fixed code shared by every space, 54 lines. In (C) every space
writes it again, about six rules; a fixed prelude would remove that.

## 4. Natural, awkward, or not at all

| Need                                               | CEL + UCAN policy                                     | Datalog                                     |
| -------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------- |
| A condition on one record's fields                 | Natural                                               | Natural, a little longer                    |
| Counting distinct authors of cited records         | Natural (`map`, `distinct`, `size`)                   | Natural (`count`)                           |
| A role chain, a team tree to any depth             | Fixed host code; per-space only by listing names      | Natural (recursion)                         |
| "Not to yourself", "only the creator"              | **Not at all** in a policy                            | Natural (`$by != $who`)                     |
| Membership as of a version                         | A host name (`member`, `memberCount`)                 | **Not at all** (unstratifiable); host facts |
| Walking a line, transitive history                 | **Not at all**: one step (`prev`), else carry state   | Natural                                     |
| Siblings: two versions after the same one          | **Not at all**: host rule                             | Natural                                     |
| "For all" inside recursion                         | Natural (`all`), but no recursion to be inside        | Awkward (walk by index)                     |
| Numbers                                            | Awkward: JSON is double; `%` needs `int()`; `sum([])` | Natural: integers only (no decimals at all) |
| Local names                                        | Awkward: no `let`; `.all(p, ...)` stands in           | Natural (variables)                         |
| Asking "which comments are famous", "what balance" | Not at all: CEL only verifies; the library queries    | Natural: the same program answers           |

## 5. Partial data and arrival order

**CEL** reads only the version, the one before it, and what it cites by id.
Anything missing makes it **pending**, never false; once everything cited is
held, every peer gets the same verdict, whatever else it holds or lacks. A
node holding only some collections still judges correctly, once it fetches
what is cited (#79).

**Datalog over everything held** is order-independent: every Datalog
example's tests shuffle the facts 30 times and get the same answer. But
independent of order is not independent of _what is held_: with 3 of 5
reactions a device says "not famous", and with C's ballot missing it says
"not removed". Those are definite answers, not "wait", and they flip as
data arrives, or never, on a node that doesn't hold every collection. Stale
"no"s are harmless for results that only grow (CALM: famous, passed), and
wrong for anything a reader acts on before it has everything.

**Datalog over a claim** (its cited versions, or its whole past) behaves as
CEL does, given the same host: missing evidence is pending, because the
host, not the program, notices what is missing.

## 6. Fixed by cited evidence, or by everything held

| Example       | CEL                                                         | Datalog over all held       | Datalog over the claim's past |
| ------------- | ----------------------------------------------------------- | --------------------------- | ----------------------------- |
| Chess club    | Fixed (cites the game)                                      | Grows with what is held     | n/a                           |
| Co-op         | Fixed (cites proposal and ballots)                          | Grows with ballots held     | Fixed (untested)              |
| Company team  | Grants as of `seen` (host)                                  | Grows with assignments held | Fixed (untested)              |
| Hall of fame  | Fixed: later withdrawals and removals don't undo it         | Goes back and forth         | Fixed                         |
| Mutual credit | **Not fixed**: a later twin undoes a payment and its payees | Not fixed, the same way     | Not fixed, the same way       |

Fixed-by-citation is the property contracts were designed around (docs
`checks.md`, "a proof that a later change could undo is not a proof"). CEL
keeps it by construction, except where a host rule (forks) deliberately
looks at more. Datalog keeps it only when the host restricts its input to
what a claim cites or saw, at which point the program doesn't search
anything and is a longer way to write the CEL.

## 7. The evaluators, and what a second implementation must match

| Side                | Size (code lines)                | Has                                                                                                                                     |
| ------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| CEL subset (built)  | `cel.ts` 1,271 + `checks.ts` 204 | An upstream spec and conformance suite; an exact cost model (steps and work, left to right); the definition checks; used in production  |
| UCAN policy (proto) | 104 + grants 54                  | An upstream spec; not checked here against any outside fixtures                                                                         |
| Datalog (proto)     | 596                              | Parser, safety, stratification, semi-naive, negation, `count`/`sum`, a fact limit. No cost model, no indexes, no incremental evaluation |

**A second CEL implementation** must match `checks.md`: the subset, the
cost model, the number and string formats, and the Weave functions. Most of
it is pinned down by CEL's own suite, which the reference already passes
(`packages/core/tests/cel-conformance.test.ts`).

**A second Datalog implementation** must match all of this, with no outside
suite to check against (Biscuit's has no negation or aggregates):

1. The grammar, and the facts every version becomes (§1): field paths,
   lists, which values have no fact.
2. Which programs are refused: the safety rules, how an aggregate's group
   is found, where `_` may go, and the stratification test. Two
   implementations that accept different programs disagree on every space
   using one.
3. Aggregate semantics: distinct tuples, `per`, 0 for an empty group.
4. Expression errors: no fact for that binding.
5. **Limits.** A fact limit is order-independent (facts only grow, so the
   final set passes it or not), but it doesn't bound time: the rule
   `p($a, $b, $c) <- q($a), q($b), q($c), $a + $b + $c == -1;` over 200 facts
   derives nothing and takes 2.7 s here; it grows with the cube. A step
   limit that two implementations agree on would have to fix the join order
   and strategy, which is what lets Datalog engines differ. CEL's limit is
   exact because its evaluation order is.
6. Whether the input is everything held, the cited versions, or the past;
   and the host rules around it (pending, standing, chains), the same as for
   CEL.

## 8. Recommendation: (A), and why

**(A) CEL contracts with UCAN-policy grants.** The deciding observations:

1. **Contracts verify cited evidence; Datalog's strength is search.** The
   design rests on "nothing searches": a writer cites, every reader
   confirms from exactly that, and the answer is fixed and the same on a
   partial replica. Datalog over everything held gives definite, changing,
   holding-dependent answers (§5, §6). Restricted to a claim's evidence it
   loses that, and the hall of fame becomes one rule against one
   expression.
2. **The hard parts are hard in both.** Membership as of a version is not
   stratifiable, so the resolver stays host code in (C) as in (A) (§2.2).
   "Neither counts" for a double spend is not monotone, so it undoes
   results in both (§2.5). Neither language removes the host machinery
   (chains, pending, standing as of `seen`), which is the larger part to
   specify.
3. **Exact agreement is cheaper in CEL.** It has an upstream spec, a
   conformance suite, and an exact cost model; Weave already has a tested
   implementation. Datalog with negation and aggregates is a new spec with
   no outside suite, and its time limit can't be made exact without fixing
   the evaluation strategy (§7.5).
4. **Datalog's real wins are in grants, and they are small built-ins.** It
   said "not to yourself", "the creator may delete", and "any team below"
   where UCAN policies can't. Those are three rules, which (A) can take as
   built-ins (§9) without replacing UCAN 1.0, which the account's own notes
   are moving to (#19). (C) would make two delegation formats, or none that
   other UCAN tools read.
5. **Where Datalog is best, it isn't protocol.** "Which comments are
   famous, what is Bob's balance" over what a node holds is a query, and
   Datalog answers it with the same program; a library query layer could
   use it later, in the docs rather than the spec.

(B) would cost a second language spec to write the same contracts, with
the same host, a weaker cost model and no conformance suite. It would be
worth reopening if contracts start needing recursion over cited evidence
(walking a cited chain), which none of the five did once the host judged
chains.

## 9. What the examples ask of (A)

Each came out awkward or wrong somewhere in CEL or UCAN; each is a small
addition, for the plan's later steps:

1. **`memberCount`**, members as of the version's `seen` (co-op), or a
   function giving the list. Without it no quorum check can be complete.
2. **A cited version must be current as of the citing version's `seen`**,
   or a cited-version field saying whether it was (hall of fame, the gap).
3. **A declared line rule**: a collection whose versions each name the one
   before, where two after the same one count for neither, judged by every
   reader (mutual credit). Today that is host code in the prototype.
4. **Invoker-aware grants**: the `creator` rule (plan open question 4) and
   "not to yourself" for `/role/assign`, as built-ins beside UCAN policy.
   And plan §2 must say how `/role/assign` relates to attenuation.

And two smaller CEL fixes worth making with the spec part: `sum([])` of
doubles (an int `0` today), and a `let` (CEL's `cel.bind`) so a cited
version can be named once.

_Source: `prototypes/contracts/src/datalog.ts` (`parse`, `evaluate`), `prototypes/contracts/src/ucan-policy.ts` (`allows`), `prototypes/contracts/src/grants.ts` (`may`), `prototypes/contracts/src/cel-host.ts` (`judge`), `prototypes/contracts/src/space.ts` (`factsOf`), `prototypes/contracts/src/examples/`. Tests: `prototypes/contracts/tests/` (all), with `packages/core/src/records/checks.ts` (`runChecks`) as the CEL evaluator._
