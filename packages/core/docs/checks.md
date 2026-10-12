# Checks

A collection's `rules.check` says what a version must _be_: conditions over
its body, the version before it, and other versions it **cites** as evidence.
"A proposal passes with yes votes from ten members", "a move must be legal
from the board before", "a transfer spends no more than the balances it
cites" are checks. How to write them, with patterns, is in
[collections.md](collections.md#checks); this page is the exact language and
how the library judges it.

> Not protocol. A peer that has never heard of checks syncs, stores and judges
> every version the same: it keeps a definition's `check` as a list it does
> not read ([spec 02 §7.6](https://github.com/leifriksheim/weave/blob/main/spec/02-records.md)),
> and stores a version that fails its checks like any other that stands. The
> library reads checks, and counts only versions that pass. Two
> implementations that judge checks must still do it exactly as below, or
> their readers will count different records.

```json
"rules": {
  "onePer": ["link:about"],
  "check": [
    {
      "that": "versions(body.votes).filter(v, v.collection == \"std.vote\" && v.link(\"about\") == link(\"about\") && v.body.choice == 0.0).map(v, v.author).distinct().size() >= 10",
      "else": "A proposal passes with yes votes from at least ten members"
    }
  ]
}
```

Nothing searches. A condition cannot look for records, because no node
holds them all. The writer does the work: it finds the votes, adds up the
balances, picks the move, and cites the versions that prove it by id. Every
reader confirms it from exactly what was cited.

## How a version is read

- **Kept and synced everywhere.** A version that fails its checks still
  stands, for every peer: it is stored, synced and passed on like any other.
  Checks never make a peer refuse, or wait for, a version.
- **Counted only when it passes.** `get`, `list` and queries show a
  record's newest version that stands and passes its checks. A version that
  fails, or that waits for versions it cites, is skipped, and the one before
  it shows instead; with none, the record is absent.
- **`node.records.checks(space, key)`** says how the record's newest version
  that stands fares: `{ version, passes, reason?, pending? }`. `passes` is
  `true`, `false` with the failing check's `else` as `reason`, or `null` when
  the collection has no checks or the version waits (`pending: true`).
- **The writer refuses its own failing version.** The node judges a version's
  checks before signing it, and throws with the check's `else` when it fails,
  or when a version it cites hasn't arrived. Another implementation, or a
  writer that signs anyway, can still send one: every peer keeps it, and no
  reader counts it.
- **Pending while cited versions are missing.** A version citing one this
  node doesn't hold is pending: not counted, and judged again when more
  arrives (up to 256 records at a time; beyond that, when the space's index
  is next rebuilt). Only a passing verdict, or a failing one, is cached.
- **Unreadable.** A node that can't open the version's body, the version
  before it (when that is kept whole), or a version it cites, because it
  doesn't hold the key, can't tell, and counts it on the rest.
- **What can be cited.** A cited version must stand as of the citing
  version's `seen`, and pass its own checks as of its own
  ([below](#citing-a-version)).
- **A chain counts only while every step does.** A version that follows one
  failing its checks fails too, so a forged step can't be laundered by the
  next. A step under checks that wasn't kept whole (`retain`, which is signed)
  can't be judged, so what follows it doesn't count either; a step not held
  yet leaves what follows pending; a delete in between hides nothing, since
  the chain is judged by the step before it, and a delete after a failing
  step fails too, so it can neither hide the record nor make its key
  unwritable. A condition meant only for creating a record should say so with
  `prev == null || prev.deleted`, since a record can be made again after a
  delete. Writing a key again continues from the
  newest version that counts, or starts it afresh when none does: a version
  that fails, or waits for ever on what it cites, can't make others build on
  it, or hold a `onePer` key against the real record.
- **Every read path.** `get`, `list`, `linked`, queries and their counts, rules
  and notifications count only versions that pass; `history` lists every
  version and gives a failing one its reason.
- **A check this node can't parse** (a newer function, say) fails every
  version under it, so an older library hides that collection rather than
  count what it can't judge.

Checks read the version before, and versions cited by id, so they need those
kept whole. The node sets `retain` on every version of a collection under
`check` that is not a delete. Peers don't require it: a version without it
stands, and its body is forgotten once superseded. A check then reads it as
`prev` without its body, and no check can cite it.

## Format

`check` is a list of 1 to **16** checks. A check is an object with exactly two
members:

- `that`: a **condition**, a CEL expression (below) of 1 to **4,000**
  characters;
- `else`: a string of 1 to 200 characters, not only white space: why a version
  that fails the check doesn't count.

## The language

A condition is an expression in **CEL**, the Common Expression Language,
as its specification defines it (github.com/google/cel-spec, at commit
`40a3c9007a9305d1f2638d5f538a4e011732cace`), restricted to the subset below.
Where this page and CEL's specification differ, this page decides.

**Values.** `null`, `bool`, `int` (64 bits), `uint` (64 bits), `double`,
`string`, `list` and `map`. JSON is read as CEL reads it: a number is a
`double`, an object a `map` with `string` keys, an array a `list`; a lone
surrogate in a string reads as U+FFFD, and JSON nested more than **64** deep
reads as an error. So `body.n + 1` is an error and `body.n + 1.0` is not,
while `body.n == 1` and `body.n < 1` compare across kinds (an `int` is
converted to a `double` to compare with one).

**Syntax.** All of CEL's, quoted field names (``body.`content-type` ``) and
reserved words after a `.` included, except: bytes literals (`b"…"`),
messages (`T{…}`), names with a leading `.`, optionals (`.?`, `?.`, `[?`),
and a double literal too large to be finite. A condition with a lone
surrogate in it is malformed.

**Parts.** A condition is a tree of parts: a literal, a name, a field
selection (`has()` included), an index, a call (an operator, a function or a
method; `math.greatest` is one), a list, a map, a conditional, a macro, and
a chain of `&&`, or of `||`, which is one part however long. A minus written
right before a number literal is part of the literal; parentheses are not
parts. The tree is at most **64** deep.

### Names

A condition reads these, and the variables of the macros that enclose it:

| Name         | Value                                                                                        |
| ------------ | -------------------------------------------------------------------------------------------- |
| `body`       | The version's body (opened, in a private space)                                              |
| `links`      | Its links, as a list of maps `{ "rel", "to" }` (spec 02 §5)                                  |
| `key`        | Its `key`                                                                                    |
| `seq`        | Its `seq`, an `int`                                                                          |
| `collection` | Its `collection`                                                                             |
| `author`     | Its writer's **root** DID (the account, not the session key)                                 |
| `creator`    | The root DID of the record's first version (spec 02 §4.6); on a create, the same as `author` |
| `createdAt`  | Its `createdAt`: what the writer's clock said, which nothing checks                          |
| `prev`       | The version its `prev` names, as a [cited version](#cited-versions), or `null` on a `seq 0`  |

### Functions

Only these:

| Function                                                                                                             | From       | Value                                                                                                                                                                              |
| -------------------------------------------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `==` `!=` `<` `<=` `>` `>=` `in` `+` `-` `*` `/` `%` `!` `&&` `\|\|` `? :`                                           | CEL        | As CEL defines them                                                                                                                                                                |
| `has(e.f)`, `e.all(x, p)`, `e.exists(x, p)`, `e.exists_one(x, p)`, `e.map(x, t)`, `e.map(x, p, t)`, `e.filter(x, p)` | CEL macros | As CEL defines them                                                                                                                                                                |
| `size`, `contains`, `startsWith`, `endsWith`, `int`, `uint`, `double`, `string`, `bool`, `dyn`                       | CEL        | As CEL defines them                                                                                                                                                                |
| `l.distinct()`                                                                                                       | CEL lists  | The list without the elements equal to an earlier one, as `==` says but with numbers compared by exact value: `[9007199254740993, 9007199254740992.0]` stays two                   |
| `math.greatest(…)`, `math.least(…)`                                                                                  | CEL math   | Of one list, or of one or more numbers: the greatest or least, the first of equals. An error on `NaN` or anything but a number                                                     |
| `sum(l)`                                                                                                             | Weave      | The elements added in order: all `int`s, all `uint`s or all `double`s, else an error; `0` for `[]`                                                                                 |
| `hash(x)`                                                                                                            | Weave      | The content id (spec 02 §2) of the canonical JSON of `x`; of a body, its `bodyHash`. An error for a non-finite `double`, an integer past ±2⁵³, or a map key that is not a `string` |
| `link(rel)`, `v.link(rel)`                                                                                           | Weave      | The `to` of the first link with that `rel` in this version's links, or in `v`'s `links`; `null` when there is none. `rel` is a literal link role (spec 02 §5.1)                    |
| `versions(ids)`                                                                                                      | Weave      | The cited version for each id in a list of strings, in order ([below](#citing-a-version))                                                                                          |
| `can(p)`, `can(p, did)`                                                                                              | Weave      | Whether the account (default: `author`) holds `<collection>/<p>` as of this version's `seen` (spec 03). `p` is a literal permission the definition declares (spec 02 §7.1)         |
| `member(did)`                                                                                                        | Weave      | Whether the account holds any role as of this version's `seen`                                                                                                                     |

`can` and `member` give an error for a value that is not a string starting
`did:`.

### What CEL leaves open

Every implementation must do these the same way:

1. **Order.** Everything is evaluated left to right. `&&` and `||` evaluate
   their right side only when the left does not decide; an error on one side
   gives way to a side that decides, as CEL says. `all` and `exists` stop at
   the first element that decides; `map`, `filter` and `exists_one` stop at
   the first error. A call evaluates its arguments in order and stops at the
   first error.
2. **Maps in macros** go through their keys in this order: `false`, `true`,
   numbers rising, then strings by UTF-16 code units, as canonical JSON
   (spec 02 §1) orders them.
3. **`string` of a `double`** is the shortest decimal that reads back as the
   same double, written `d.ddde±XX` (at least two exponent digits) when its
   exponent is below −4 or 6 and up, and as a plain decimal otherwise:
   `string(123.456)` is `"123.456"`, `string(1e6)` is `"1e+06"`. The special
   values are `"+Inf"`, `"-Inf"`, `"NaN"` and `"-0"`.
4. **Text to numbers.** `int(s)` takes an optional sign and decimal
   digits; `uint(s)` decimal digits only; `double(s)` an optional sign and a
   decimal number with an optional exponent, or `inf`, `infinity` or `nan`
   in any case. Anything else, or a value out of range, is an error. So is
   the least `int` `% -1`.
5. **Errors** carry no text that matters: only whether a condition gave
   `true`.

### Conformance

On CEL's conformance suite files `basic`, `comparisons`, `conversions`,
`fields`, `fp_math`, `integer_math`, `lists`, `logic`, `macros`, `macros2`,
`parse`, `plumbing` and `string`, an implementation must give the result each
test expects, or refuse the expression for something this page leaves out,
or refuse one the test expects to fail. Tests that need a container, type
checking alone, macros turned off, or a value the subset lacks (bytes, types,
messages, timestamps) don't apply.

## Cited versions

A **cited version** is a map:

```json
{
  "id": "b…",
  "key": "…",
  "collection": "std.vote",
  "seq": 0,
  "author": "did:key:…",
  "createdAt": "…",
  "deleted": false,
  "body": { "choice": 0 },
  "links": [{ "rel": "about", "to": "…" }]
}
```

`seq` is an `int`. `author` is the version's root DID. `body` and `links` are
its content, as for the version judged; `body` is `null` on a delete. For
`prev` only: when the version before does **not** carry `retain`, its `body`
is `null` and its `links` are its envelope's `links` (none, in a private
space), whether or not a node happens to hold its body. What `retain` says is
signed, so every node reads the same thing.

## Citing a version

`versions` looks each id up in this space, in order, and the first that does
not resolve decides:

1. Not held: the citing version is **pending**.
2. Held, not a delete, and without `retain`: the check fails. Only a version
   kept whole reads the same on every node, however late it joins.
3. Its collection differs from its record's first version (spec 02 §4.6):
   the check fails.
4. It does not stand **as of the citing version's `seen`** (spec 02 §9.4,
   with spec 03 §5.1 judged `within` that `seen`): the check fails; or the
   citing version is pending, if judging it waits.
5. It fails its own checks, judged as of its own `seen`: the
   check fails; or the citing version is pending, if those are pending.
6. Sealed with a key the node does not hold: the node can't judge
   ([below](#outcomes)).

A version's id covers its content, so a version cannot cite itself and
citations never form a cycle.

"As of the citing version's `seen`" means that only access changes the citing
version had seen (named in its `seen`, or seen by those) can take a cited
version away: a removal of its author, or a revoke of its key. A change that
came later, or apart, does not. So a check that passed when it was written
passes for every reader, at any time, whatever the access history grows
into. A cited version withdrawn by a later change is still held for this:
peers store withdrawn versions (spec 02 §9.5).

Example: Carol cites Bob's vote in a proof. Alice, who had not seen the vote,
then removes Bob, and her removal keeps nothing (spec 03 §6.3). Bob's vote
stops counting as a record; Carol's proof, which had not seen the removal,
still passes, for every reader. A proof written after seeing the removal
cannot count Bob's vote.

> Why: a proof that a later change could undo is not a proof: two readers
> that judged it before and after the change would disagree, and a result
> would go back on itself. The cost: a writer chooses its `seen`, and can
> leave a removal out of it to count a removed member's earlier versions, and
> nothing tells those from versions the removed member backdated after its
> removal ([#170](https://github.com/leifriksheim/weave/issues/170)). It must
> itself hold a role as of what it claims to have seen.

## Outcomes

A node judges a version's checks in order, and the first that is not `true`
decides. A check whose condition gives anything but `true` (an error
included) fails the version, with its `else` as the reason. A version that
cites one not held is pending, and is judged again when more arrives.

Limits, counted across all of one version's checks:

- **Steps.** Every part evaluated counts one, and so does every element a
  macro goes through. Past **100,000** the check fails.
- **Work.** A call to `==`, `!=`, `in`, `<`, `<=`, `>`, `>=`, `+`, `size`,
  `contains`, `startsWith`, `endsWith`, `int`, `uint`, `double`, `string`,
  `bool`, `distinct`, `sum`, `math.greatest`, `math.least`, `hash`, `link` or
  `versions` counts the **size** of each of its operands (its receiver
  included), and so do an index (its key), a map literal (each key) and a
  macro over a map (the map, whose keys it puts in order): 1 for `null`, a
  bool or a number; 1 and its code points for a string; 1 and its elements'
  sizes for a list; 1 and its keys' and values' sizes for a map. Past
  **4,000,000** the check fails. So what a check builds, and every pass over
  it, is paid for. An implementation must do each counted call in time near
  linear in what it counts (`contains` too). Reading the judged and cited
  versions into values is linear in what the node already holds, and is not
  counted.
- **Citations.** At most **256** distinct versions; citing one more fails the
  check. Citing the same id again does not count again. A cited version that
  fails rule 2, 3, 4 or 5 above fails the check, whatever `&&` or `||` around
  it would decide.

A node that can't read the version's body, the version before it (when that
carries `retain`), or a version it cites, because it is sealed with a key the
node does not hold, can't judge, and counts the version on the rest.

| Limit                              | Value                                 |
| ---------------------------------- | ------------------------------------- |
| Checks per collection              | ≤ 16; ≤ 2,000 parts in all, ≤ 64 deep |
| Condition                          | 1–4,000 characters                    |
| Judging one version's checks       | ≤ 100,000 steps, ≤ 4,000,000 work     |
| Versions one version's checks cite | ≤ 256 distinct                        |

## Checking a definition

Peers keep whatever list a definition's `check` holds. The node that defines
the collection refuses a `check` unless it is a list of 1 to 16 checks as
above, and:

- every condition parses as CEL within the subset's syntax;
- every name is one in the table above, or a macro's variable where the
  macro binds it;
- every call is to a function in the table, with a number of arguments it
  takes;
- `link` takes a literal link role, and `can` a literal permission the
  definition declares in `permissions`;
- no condition is more than **64** parts deep, and a collection's checks
  have at most **2,000** parts in all.

A definition that arrives with a `check` the library can't read (written by
another implementation, or by hand) still stands. Its checks fail every
version they judge, since none can give `true`.

> Why: a check is a verifier, not a program that runs the space. It always
> ends, and reads only what is fixed once written: its own version, the one
> before if kept whole, versions named by id and kept whole, and the roles as
> of its `seen`. No clock and no search, so every reader, whenever it judges,
> reaches the same verdict. Each step is bounded, but a record's versions are
> not, and versions can cite versions: that is where the power is. What a
> check cannot see is completeness ("nobody objected") and time ("before
> Friday"). Both become citable once someone signs them: a record that closes
> a vote and lists what it counts, or a witness's record that it saw
> something by a time.

## Planned: asking for what a version cites

Issue: [#138](https://github.com/leifriksheim/weave/issues/138). A version
pending on a version it cites doesn't ask for it: a node that holds the whole
space gets it in the next round anyway, but a node holding only some
collections (spec 05, What a node holds) may never fetch a cited version from
a collection it doesn't use, and the citing version then stays pending there
for good. The plan: a pending verdict names the ids it waits for, and the
node asks for those whatever their collection.

_Source: `packages/core/src/records/cel.ts` (`parseCel`, `checkCel`, `evaluateCel`, `MAX_CEL_DEPTH`, `MAX_CEL_STEPS`), `packages/core/src/records/checks.ts` (`checkChecks`, `runChecks`, `MAX_CHECKS`, `MAX_CONDITION_LENGTH`, `MAX_CITED`, `MAX_CHECK_NODES`, `CHECK_NAMES`), `packages/core/src/node/space-runtime.ts` (`checksOf`, `checksFor`, `checkStanding`, `checkedVersion`, `cited`, `counts`, `currentOf`, `write`, `define`). Tests: `packages/core/tests/checks.test.ts` (all; "a claim with too little evidence, signed anyway, reaches every peer and counts for no reader", "keeping versions under a check whole is the writer’s part…", "a proof stays a proof…"), `packages/core/tests/cel-conformance.test.ts` (CEL's conformance suite)._
