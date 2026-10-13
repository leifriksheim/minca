# 09 — Contracts

A **contract** says what a version of a collection must _be_ to count:
conditions over its body, the version before it, and other versions it
**cites** as evidence. "A proposal passes with yes votes from ten members",
"a move must be legal from the board before", "a payment leaves a balance of
at least −100" are contracts. A **line** is a built-in rule a contract can't
express: one account's sequence of versions in a collection, where two
versions after the same one cancel each other (§7).

This part says how a reader judges them, so that two implementations count
the same records. **Readers judge; peers store regardless.** A peer keeps and
syncs every version that fails its contract, as any other that stands
(02 §7.6); only what a reader counts changes. A peer that has never heard of
contracts still syncs, stores and judges standing the same way, but its
readers would count records that other readers don't.

Out of scope here: whether a version stands at all (02 §9, 03 §5), which a
reader decides first; and how the library exposes verdicts and refuses to
sign a failing version of its own ([contracts](../packages/core/docs/contracts.md)).

**Terms.** The _judged_ version is the one whose contract is being run. A
_cited_ version is one it names by id through `versions(...)`. A version
_counts_ for a reader when it stands and its contract passes.

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

Nothing searches. A condition cannot look for records, because no node holds
them all. The writer does the work: it finds the votes, adds up the balances,
picks the move, and cites the versions that prove it by id. Every reader
confirms it from exactly what was cited.

> Rationale: a contract is a verifier, not a program that runs the space. It
> always ends, and reads only what is fixed once written: its own version,
> the one before if kept whole, versions named by id and kept whole, and the
> roles as of its `seen`. No clock and no search, so every reader, whenever it
> judges, reaches the same verdict. What a contract cannot see is
> completeness ("nobody objected") and time ("before Friday"). Both become
> citable once someone signs them: a record that closes a vote and lists
> what it counts, or a witness's record that it saw something by a time.

---

## 1. Where a contract lives

A collection's contract is its definition's `rules.check` (02 §7.6), a list
of conditions (§3), and its line declaration is the definition's `line`
member (§7.1). Which definition applies is the one in force as of the judged
version's `seen` (02 §6.3), as for every rule.

The field keeps the name `check`: peers check that `rules` has no members
but `onePer`, `fixed`, `check` and `final` (02 §7.5), so a new name would make
every older peer treat the definition as invalid. `line` is a top-level
member, which peers ignore (02 §6.1).

_Source: `packages/core/src/records/rules.ts` (`checkRules`), `packages/core/src/schema/collection-def.ts` (`StoredCollection`), `packages/core/src/node/space-runtime.ts` (`rulesAt`, `checksOf`)._

## 2. Verdicts

A reader judges a standing version's contract to one of four verdicts:

| Verdict      | When                                                                                         | Counted |
| ------------ | -------------------------------------------------------------------------------------------- | ------- |
| **passes**   | Every condition gives `true` and the line rule (§7) holds; or the collection has no contract | yes     |
| **fails**    | A condition gives anything but `true`, a limit (§4.3) is passed, or the line rule is broken  | no      |
| **pending**  | A version it cites, or the version before it, is not held yet                                | no      |
| **unjudged** | The reader can’t judge it (below)                                                            | no      |

- A reader **MUST** count only versions that stand and pass, and treat a
  record as having its newest such version (02 §4.3). A version that fails
  or is pending is skipped, and the one before shows instead; with none, the
  record is absent.
- A pending version is judged again when more arrives. Only passes and
  fails are final.
- A version is **unjudged** when the reader can't open its body, the
  version before it (when that is kept whole) or a version it cites,
  because it is sealed with a key the reader does not hold; when its
  collection declares a line with a key the reader doesn't know (§7.1); or
  when the version before it, or one it cites, is unjudged (§6.2). The reader
  **MUST NOT** count it, and **MUST NOT** fail it; it says why, and judges it
  again when it gets the key. Counting it on the rest would let a version
  that cites something sealed pass on what the reader never read.

A contract the reader can't parse (a newer function, say) fails every
version under it, so an older reader hides that collection rather than count
what it can't judge.

> Rationale: two readers that judged one collection by different rules would
> disagree without either knowing. An unknown line key leaves the
> collection uncounted and says so, as a peer stays out of a space with a
> resolver it doesn't know (03 §1).

_Source: `packages/core/src/node/space-runtime.ts` (`checksOf`, `counts`, `contractsFor`). Tests: `packages/core/tests/contracts.test.ts` ("a claim with too little evidence, signed anyway, reaches every peer and counts for no reader"), `packages/core/tests/contracts-pending.test.ts`, `packages/core/tests/contracts-line.test.ts` ("a line declared with a key it doesn't know leaves the collection unjudged…", "a version sealed with a key the reader lacks is unjudged…")._

## 3. Format

`check` is a list of 1 to **16** conditions. Each is an object with exactly
two members:

- `that`: a CEL expression (§5) of 1 to **4,000** characters;
- `else`: a string of 1 to 200 characters, not only white space: why a version
  that fails it doesn't count.

The conditions of one collection have at most **2,000** parts (§5.1) in
all, and none is more than **64** parts deep. A `check` that breaks any of
this, or names something outside the subset (§5), can't be read (§2).

```json
{ "that": "body.amount >= 0.0 && body.to != author", "else": "Pay someone else, an amount of at least 0" }
```

_Source: `packages/core/src/records/contracts.ts` (`checkContracts`, `MAX_CHECKS`, `MAX_CONDITION_LENGTH`, `MAX_CHECK_NODES`). Tests: `packages/core/tests/contracts.test.ts` ("contracts: a definition")._

## 4. Judging a version

### 4.1 The chain

A version counts only while every step before it does: one that follows a
version failing its contract fails too, so a forged step can't be laundered
by the next.

1. A reader judges the version before (`prev`) first. Outside a line, a
   delete in between hides nothing: the chain is judged by the step before
   it. In a line, a version after a delete **fails**: a delete ends a line
   (§7.5).
2. If the version before is not held, the judged version is **pending**.
3. If the version before is under a contract or a line, is not a delete and
   does not carry `retain`, the judged version **fails**: what it reads can't
   be the same on every node.
4. If the version before fails, the judged version fails; if it is pending
   or unjudged, so is the judged version.
5. A delete has no content to judge, but it is a step like any other: one
   after a failing step fails, so it can neither hide the record nor make
   its key unwritable. In a line it is also judged by the line rule (§7.2,
   §7.3), so a delete can be a twin.
6. Otherwise the line rule (§7) and then the conditions, in order; the first
   that is not `true` decides.

A condition meant only for creating a record says so with
`prev == null || prev.deleted`, since a record can be made again after a
delete.

### 4.2 Kept whole

A contract reads the version before and versions cited by id, so a writer
**MUST** set `retain` on every version of a collection under a contract or a
line that is not a delete. Peers don't require it: a version without it
stands, and its body is forgotten once superseded (02 §4.5). A contract then
reads it as `prev` without its body (§6.1), no contract can cite it, and
what follows it fails (§4.1).

### 4.3 Limits

Counted across all of one version's conditions:

- **Steps.** Every part evaluated counts one, and so does every element a
  macro goes through. Past **100,000** the version fails.
- **Work.** A call to `==`, `!=`, `in`, `<`, `<=`, `>`, `>=`, `+`, `size`,
  `contains`, `startsWith`, `endsWith`, `int`, `uint`, `double`, `string`,
  `bool`, `distinct`, `sum`, `math.greatest`, `math.least`, `hash`, `link` or
  `versions` counts the **size** of each of its operands (its receiver
  included), and so do an index (its key), a map literal (each key) and a
  macro over a map (the map, whose keys it puts in order): 1 for `null`, a
  bool or a number; 1 and its code points for a string; 1 and its elements'
  sizes for a list; 1 and its keys' and values' sizes for a map. Past
  **4,000,000** the version fails. So what a contract builds, and every pass
  over it, is paid for. An implementation must do each counted call in time
  near linear in what it counts (`contains` too). Reading the judged and
  cited versions into values is linear in what the node already holds, and
  is not counted.
- **Citations.** At most **256** distinct versions; citing one more fails.
  Citing the same id again does not count again.

| Limit                                  | Value                                 |
| -------------------------------------- | ------------------------------------- |
| Conditions per collection              | ≤ 16; ≤ 2,000 parts in all, ≤ 64 deep |
| Condition                              | 1–4,000 characters                    |
| Judging one version's conditions       | ≤ 100,000 steps, ≤ 4,000,000 work     |
| Versions one version's conditions cite | ≤ 256 distinct                        |

_Source: `packages/core/src/records/cel.ts` (`evaluateCel`, `MAX_CEL_DEPTH`, `MAX_CEL_STEPS`, `MAX_CEL_WORK`), `packages/core/src/records/contracts.ts` (`runContracts`, `MAX_CITED`), `packages/core/src/node/space-runtime.ts` (`checksOf`, `checkStanding`, `write`). Tests: `packages/core/tests/contracts.test.ts` ("keeping versions under a check whole is the writer’s part…", "a record whose versions are checked against the one before is a state machine"), `packages/core/tests/contracts-delete-launder.test.ts`, `packages/core/tests/contracts-delete-lockout.test.ts`, `packages/core/tests/contracts-stub-launder.test.ts`, `packages/core/tests/contracts-squat.test.ts`._

## 5. The language

A condition is an expression in **CEL**, the Common Expression Language, as
its specification defines it (github.com/google/cel-spec, at commit
`40a3c9007a9305d1f2638d5f538a4e011732cace`), restricted to a **strict
subset**: every expression a reader accepts means exactly what it means in
standard CEL, with the names and functions below added. Where this part and
CEL's specification differ, this part decides.

**Values.** `null`, `bool`, `int` (64 bits), `uint` (64 bits), `double`,
`string`, `list` and `map`. JSON is read as CEL reads it: a number is a
`double`, an object a `map` with `string` keys, an array a `list`; a lone
surrogate in a string reads as U+FFFD, and JSON nested more than **64** deep
reads as an error. So `body.n + 1` is an error and `body.n + 1.0` is not,
while `body.n == 1` and `body.n < 1` compare across kinds (an `int` is
converted to a `double` to compare with one).

**Left out**, each refused when a definition is written and failing any
version it judges:

| Left out                                                       | Why                                                                                      |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Bytes (`b"…"`) and the `bytes` type                            | Bodies are JSON, which has no bytes                                                      |
| Messages (`T{…}`), protobuf types and names with a leading `.` | No schema of messages exists to build them from                                          |
| `type()` and type values                                       | Types would be a second way to say what `has()` and comparisons say                      |
| Timestamps and durations                                       | No clock: a contract that read the time would judge differently tomorrow                 |
| `matches()` (regular expressions)                              | RE2 engines differ in small ways, and two readers would disagree                         |
| Optionals (`.?`, `?.`, `[?`)                                   | Not in CEL's core; `has()` says the same                                                 |
| A double literal too large to be finite                        | It has no JSON value                                                                     |
| Any other function or name                                     | A reader can only agree on what it implements; a newer one is a new version of this part |

A condition with a lone surrogate in it is malformed.

### 5.1 Parts

A condition is a tree of parts: a literal, a name, a field selection
(`has()` included), an index, a call (an operator, a function or a method;
`math.greatest` is one), a list, a map, a conditional, a macro, and a chain
of `&&`, or of `||`, which is one part however long. A minus written right
before a number literal is part of the literal; parentheses are not parts.
Syntax is all of CEL's, quoted field names (``body.`content-type` ``) and
reserved words after a `.` included, except what §5 leaves out.

### 5.2 Names

A condition reads these, and the variables of the macros that enclose it:

| Name         | Value                                                                                                             |
| ------------ | ----------------------------------------------------------------------------------------------------------------- |
| `body`       | The version's body (opened, in a private space)                                                                   |
| `links`      | Its links, as a list of maps `{ "rel", "to" }` (02 §5)                                                            |
| `key`        | Its `key`                                                                                                         |
| `seq`        | Its `seq`, an `int`                                                                                               |
| `collection` | Its `collection`                                                                                                  |
| `author`     | Its writer's **root** DID (the account, not the session key)                                                      |
| `creator`    | The root DID of the version's first version, the one its chain names (02 §4.5); on a create, the same as `author` |
| `createdAt`  | Its `createdAt`: what the writer's clock said, which nothing checks                                               |
| `prev`       | The version its `prev` names, as a [cited version](#61-a-cited-version), or `null` on a `seq 0`                   |

### 5.3 Functions

Only these:

| Function                                                                                                             | From       | Value                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `==` `!=` `<` `<=` `>` `>=` `in` `+` `-` `*` `/` `%` `!` `&&` `\|\|` `? :`                                           | CEL        | As CEL defines them                                                                                                                                                           |
| `has(e.f)`, `e.all(x, p)`, `e.exists(x, p)`, `e.exists_one(x, p)`, `e.map(x, t)`, `e.map(x, p, t)`, `e.filter(x, p)` | CEL macros | As CEL defines them                                                                                                                                                           |
| `size`, `contains`, `startsWith`, `endsWith`, `int`, `uint`, `double`, `string`, `bool`, `dyn`                       | CEL        | As CEL defines them                                                                                                                                                           |
| `l.distinct()`                                                                                                       | CEL lists  | The list without the elements equal to an earlier one, as `==` says but with numbers compared by exact value: `[9007199254740993, 9007199254740992.0]` stays two              |
| `math.greatest(…)`, `math.least(…)`                                                                                  | CEL math   | Of one list, or of one or more numbers: the greatest or least, the first of equals. An error on `NaN` or anything but a number                                                |
| `sum(l)`                                                                                                             | Minca      | The elements added in order: all `int`s, all `uint`s or all `double`s, else an error; **`0.0` for `[]`**, since every number read from a body is a `double`                   |
| `hash(x)`                                                                                                            | Minca      | The content id (02 §2) of the canonical JSON of `x`; of a body, its `bodyHash`. An error for a non-finite `double`, an integer past ±2⁵³, or a map key that is not a `string` |
| `link(rel)`, `v.link(rel)`                                                                                           | Minca      | The `to` of the first link with that `rel` in this version's links, or in `v`'s `links`; `null` when there is none. `rel` is a literal link role (02 §5.1)                    |
| `versions(ids)`                                                                                                      | Minca      | The cited version for each id in a list of strings, in order (§6)                                                                                                             |
| `member(did)`                                                                                                        | Minca      | Whether the account is a member (a founder, or holds any role) as of this version's `seen`                                                                                    |

`member` gives an error for a value that is not a string starting `did:`.
There is no `can()`: who may write is the space's grants (03 §2), which every
peer judges before a contract runs.

### 5.4 What CEL leaves open

Every implementation **MUST** do these the same way:

1. **Order.** Everything is evaluated left to right. `&&` and `||` evaluate
   their right side only when the left does not decide; an error on one side
   gives way to a side that decides, as CEL says. `all` and `exists` stop at
   the first element that decides; `map`, `filter` and `exists_one` stop at
   the first error. A call evaluates its arguments in order and stops at the
   first error.
2. **Maps in macros** go through their keys in this order: `false`, `true`,
   numbers rising, then strings by UTF-16 code units, as canonical JSON
   (02 §1) orders them.
3. **`string` of a `double`** is the shortest decimal that reads back as the
   same double, written `d.ddde±XX` (at least two exponent digits) when its
   exponent is below −4 or 6 and up, and as a plain decimal otherwise:
   `string(123.456)` is `"123.456"`, `string(1e6)` is `"1e+06"`. The special
   values are `"+Inf"`, `"-Inf"`, `"NaN"` and `"-0"`.
4. **Text to numbers.** `int(s)` takes an optional sign and decimal digits;
   `uint(s)` decimal digits only; `double(s)` an optional sign and a decimal
   number with an optional exponent, or `inf`, `infinity` or `nan` in any
   case. Anything else, or a value out of range, is an error. So is the
   least `int` `% -1`.
5. **Errors** carry no text that matters: only whether a condition gave
   `true`.

### 5.5 Conformance

The language's tests are CEL's own conformance suite. On its files `basic`,
`comparisons`, `conversions`, `fields`, `fp_math`, `integer_math`, `lists`,
`logic`, `macros`, `macros2`, `parse`, `plumbing` and `string`, an
implementation **MUST** give the result each test expects, or refuse the
expression for something §5 leaves out, or refuse one the test expects to
fail. Tests that need a container, type checking alone, macros turned off,
or a value the subset lacks (bytes, types, messages, timestamps) don't
apply.

_Source: `packages/core/src/records/cel.ts` (`parseCel`, `checkCel`, `evaluateCel`, `fromJson`), `packages/core/src/records/contracts.ts` (`CHECK_NAMES`). Tests: `packages/core/tests/cel-conformance.test.ts` (CEL's conformance suite, `packages/core/tests/cel-conformance/`), `packages/core/tests/contracts.test.ts` ("refuses what no peer could judge the same way", "lists: all, exists, filter, map, distinct, sum, in, math")._

## 6. Citing evidence

### 6.1 A cited version

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
its content, as for the judged version; `body` is `null` on a delete. For
`prev` only: when the version before does **not** carry `retain`, its `body`
is `null` and its `links` are its envelope's `links` (none, in a private
space), whether or not a node happens to hold its body. What `retain` says is
signed, so every node reads the same thing.

A contract reads what a cited version links to with `v.link(rel)`, and the
judged version's own links with `link(rel)`: "a vote about this proposal" is
`v.link("about") == link("about")`.

### 6.2 `versions(ids)`

`versions` looks each id up in this space, in order, and the first that does
not resolve decides:

1. Not held: the judged version is **pending**.
2. Held, not a delete, and without `retain`: it fails. Only a version kept
   whole reads the same on every node, however late it joins.
3. Its collection differs from its record's first version (02 §4.6): it
   fails.
4. It does not stand **as of the judged version's `seen`** (02 §9.4, with
   03 §5.1 judged `within` that `seen`): it fails; or the judged version is
   pending, if judging it waits.
5. It fails its own contract, judged as of its own `seen`: it fails; or the
   judged version is pending, if that is pending.
6. Sealed with a key the reader does not hold, or in a collection whose
   line declaration the reader doesn't know: the judged version is
   unjudged (§2).

A cited version that fails rule 2, 3, 4 or 5 fails the judged version,
whatever `&&` or `||` around it would decide. A version's id covers its
content, so a version cannot cite itself and citations never form a cycle.

"As of the judged version's `seen`" means that only access changes it had
seen (named in its `seen`, or seen by those) can take a cited version away: a
removal of its author, or a revoke of its key. A change that came later, or
apart, does not. So a contract that passed when it was written passes for
every reader, at any time, whatever the access history grows into. A cited
version withdrawn by a later change is still held for this: peers store
withdrawn versions (02 §9.5).

**A contract judges the versions cited, not whether they are current.** A
claim may cite a version that has since been edited or deleted, and a
withdrawal doesn't undo a claim that passed. Records have no causal past a
peer can check (a version's `seen` names only access changes, and is
whatever its writer says), so "cited versions must be current as of the
claim" would be a promise no reader could keep. A community that wants
withdrawals to count writes its claim later, or counts with a query.

Example: Carol cites Bob's vote in a proof. Alice, who had not seen the vote,
then removes Bob, and her removal keeps nothing (03 §6.3). Bob's vote stops
counting as a record; Carol's proof, which had not seen the removal, still
passes, for every reader. A proof written after seeing the removal cannot
count Bob's vote.

> Why: a proof that a later change could undo is not a proof: two readers
> that judged it before and after the change would disagree, and a result
> would go back on itself. The cost: a writer chooses its `seen`, and can
> leave a removal out of it to count a removed member's earlier versions, and
> nothing tells those from versions the removed member backdated after its
> removal ([#184](https://github.com/leifriksheim/minca/issues/184)). It must
> itself hold a role as of what it claims to have seen.

_Source: `packages/core/src/records/contracts.ts` (`runContracts`, `CitedVersion`), `packages/core/src/node/space-runtime.ts` (`cited`, `checkedVersion`). Tests: `packages/core/tests/contracts.test.ts` ("a proof stays a proof…"), `packages/core/tests/contracts-pending-squat.test.ts`, `scenarios/tests/fame.test.ts` (all)._

## 7. Lines

A **line** is one account's sequence of versions in a collection: each names
the account's previous one as `prev`, so a payment can carry a running
balance that a contract checks against the one before. Limits on one
account's own spending need that account's own order, and a line gives it
without a global one.

### 7.1 The declaration

A collection is a line when its definition has a `line` member, an object:

```json
{ "name": "app.pay", "schema": { "type": "object" }, "rules": { "check": [ … ] }, "line": { "once": ["received"] } }
```

| Key    | Type     | Meaning                                                                        |
| ------ | -------- | ------------------------------------------------------------------------------ |
| `once` | string[] | Body fields whose citations may appear only once along a line (§7.4). Optional |

**Its keys are closed.** A reader that finds a key it doesn't know in a line
declaration doesn't judge that collection: its versions are **unjudged**
(§2). A `line` that is not an object, or whose `once` is not a list of
non-empty strings of at most 64 characters, can't be read, and every version
under it fails.

### 7.2 One line per account

Every version of a line collection **MUST** be at its author's line key,
`lineKey(root, collection)`, or it fails:

```
lineKey(root, collection) = owner(root) + "." + "line:" + base32(SHA-256(utf8(collection))[0..16])
```

with `owner` and the owned key form of 02 §4.1, and base32 lower case
without padding. Being an owned key, only that account's own versions stand
there (02 §4.1). Without it, anyone could write a first version at someone
else's line key, or a next version after their payment, and kill the line;
and an account could open a second line and claim each payment once in each.

### 7.3 Double spends

Two versions of a line naming the same previous version (or two first
versions, naming none) are a **double spend**: a reader **MUST** fail both,
whichever devices of the account wrote them, and so everything after
either (§4.1). Deletes are versions here like any other. A reader **MUST**
look for twins among every version it holds at the line key, in that
collection, signed by the same account, deletes and versions without
`retain` included, not only those a record's history keeps (02 §4.5).

A version counts until its twin arrives. A contract can't express this,
since a version never cites its twin, so a payee who claimed a payment that
is later double-spent loses that version too, and everything after it in
their own line. Waiting before building on a payment, or a witness, is the
only cure.

### 7.4 Claiming once

For each field `once` names, every element of that field's list (when it is
a list; anything else claims nothing) is a **citation**, compared as
canonical JSON (02 §1). A reader **MUST** fail a version when one of its
citations, under the same field, appears twice along its **counted chain**:
the version and every version its `prev` names back to the start. The reader already holds the whole chain (§4.1), so the body carries
nothing extra.

### 7.5 No corrections

**A delete ends a line for good.** In a line collection, no version after
a delete counts, so an account can't delete its line to start its balance
again; a delete that names the same previous version as a payment is that
payment's twin (§7.3).

There is no way back from a double spend. After one, any new version after
the last that counts is a twin of a failed one, so the line ends there for
good: the account's later payments in that collection never count. Two
devices of one honest account that pay in the same collection while apart
write twins, and kill the line the same way; apps must keep a line on one
device at a time, or sync before writing to it.

As for every rule, a version is judged by the definition in force as of
its `seen` (02 §6.3): one whose `seen` is from before the `line`
declaration escapes the line rule, the known gap of a rule narrowed after
the fact ([threat model](threat-model.md) §3.2).

> **Planned: corrections.** A way back for a payee, and a restart record for
> an honest account's forked devices. The starting point: a correction is
> allowed after the payee's last counted version only when a version it
> cites is one of a double-spent pair (a structural check, with no second
> run of the contract), and it restates the failed versions' outgoing
> payments in order, dropping only the failed citations, so it can't unpay
> anyone. A broad trigger ("would pass if what it cited stood") lets a
> correction revive a version that failed for its own reasons, and is ruled
> out ([the plan](drafts/constitution-grants-contracts.md) §3).

_Source: `packages/core/src/records/contracts.ts` (`checkLine`, `onceCitations`, `Line`), `packages/core/src/records/key.ts` (`lineKey`), `packages/core/src/node/space-runtime.ts` (`lineBreak`, `lineIndex`, `checksOf`, `recordsChanged`, `define`, `write`), `packages/core/src/storage/storage-provider.ts` (`keptVersions`). Tests: `packages/core/tests/contracts-line.test.ts` (all: "two devices of one account pay after the same payment…", "no corrections…", "a payment claimed again later along the line fails…", "a second line of one account claims nothing…", "a payment arriving before the one it follows waits…", "a line declared with a key it doesn't know…", "a reader that counted a payment stops counting it…", "a delete written as a twin of a payment is a double spend…", "a delete ends a line for good…"), `scenarios/tests/credit.test.ts` (all)._

## 8. Checking a definition

Peers keep whatever `check` list and `line` a definition holds (02 §7.6).
The node that defines a collection **SHOULD** refuse a definition unless:

- `check` is a list of 1 to 16 conditions as in §3, every condition parses
  within the subset (§5), every name is one in §5.2 or a macro's variable
  where the macro binds it, every call is to a function in §5.3 with a
  number of arguments it takes, and `link` takes a literal link role;
- `line`, when present, is an object whose only key is `once` (§7.1).

A definition that arrives with a `check` a reader can't read (written by
another implementation, or by hand) still stands; its contract fails every
version it judges (§2). One with a `line` key a reader doesn't know leaves
the collection unjudged (§7.1).

_Source: `packages/core/src/records/contracts.ts` (`checkContracts`, `checkLine`), `packages/core/src/node/space-runtime.ts` (`define`). Tests: `packages/core/tests/contracts.test.ts` ("contracts: a definition"), `packages/core/tests/contracts-line.test.ts` ("the library refuses to define a line with a key it does not know")._

## 9. Planned: asking for what a version cites

Issue: [#79](https://github.com/leifriksheim/minca/issues/79). A version
pending on a version it cites doesn't ask for it: a node that holds the whole
space gets it in the next round anyway, but a node holding only some
collections (05, What a node holds) may never fetch a cited version from a
collection it doesn't use, and the citing version then stays pending there
for good. The plan: a pending verdict names the ids it waits for, and the
node asks for those whatever their collection.
