# Draft: SQL on SQLite for contracts and queries

Status: evidence for a decision, October 2026. Not normative. It asks
whether Minca's contracts ([spec 09](../09-contracts.md)), and the local
query language ([query format](../../packages/core/docs/query-format.md)),
should be **SQL on SQLite** instead of CEL, as
[the CEL against Datalog comparison](contracts-comparison.md) asked of
Datalog: the scenarios' contracts written in SQL, run on a locked-down
SQLite against the same cases, with probes of where peers could disagree.

- **(A)** Keep CEL.
- **(B)** SQL for contracts and queries.
- **(C)** SQL for local queries only, CEL for contracts.

**Recommendation: (C).** SQL wrote two things better than CEL (a quorum
against a members table, and a walk along a line), and the contracts are
clear to anyone who knows SQL. But a contract's verdict must be the same on
every peer, for good, and SQLite gives that only if the protocol names one
exact SQLite build forever: float printing changed between 3.51 and 3.53,
step counts differ between every pair of versions measured, and row order
is left to the planner. SQL's three-valued logic and loose comparisons
also let a wrong contract pass where CEL fails it. None of that matters to a
query that only one node reads, which is where SQLite's tooling pays off.
The reasons are in §8.

## 1. What was built

Everything is in [`scenarios/sql/`](https://github.com/leifriksheim/minca/tree/sql-contracts-prototype/scenarios/sql/), a private workspace, typechecked, linted
and tested with the rest (`npm run sql -w @minca/scenarios`, and
`npm test`). `@sqlite.org/sqlite-wasm` 3.53.4 and `kysely` are dev
dependencies of the scenarios workspace only.

| File                                                                                                                                          | What                                                                                                                       | Lines |
| --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----- |
| [`sql/engine.ts`](https://github.com/leifriksheim/minca/blob/sql-contracts-prototype/scenarios/sql/engine.ts)                                 | The locked-down engine: authorizer, function allowlist, progress-handler step limit, `sqlite3_limit`s, a fresh `:memory:`  | 230   |
| [`sql/host.ts`](https://github.com/leifriksheim/minca/blob/sql-contracts-prototype/scenarios/sql/host.ts)                                     | A stand-in host: chains, pending, membership as of `seen`, cited versions, the line rule built in or left to SQL; `SCHEMA` | 223   |
| [`sql/contracts.ts`](https://github.com/leifriksheim/minca/blob/sql-contracts-prototype/scenarios/sql/contracts.ts)                           | The contracts in SQL                                                                                                       | 128   |
| [`sql/kysely-sketch.ts`](https://github.com/leifriksheim/minca/blob/sql-contracts-prototype/scenarios/sql/kysely-sketch.ts)                   | The hall of fame written with Kysely (§2.6)                                                                                | 68    |
| [`sql/tests/scenarios.test.ts`](https://github.com/leifriksheim/minca/blob/sql-contracts-prototype/scenarios/sql/tests/scenarios.test.ts)     | Chess, co-op, hall of fame, mutual credit twice (line built in, line in SQL), Kysely: 34 tests                             | 376   |
| [`sql/tests/determinism.test.ts`](https://github.com/leifriksheim/minca/blob/sql-contracts-prototype/scenarios/sql/tests/determinism.test.ts) | The lockdown refusing 12 kinds of query, the step limit, and the probes of §4: 23 tests                                    | 153   |

**The engine.** The official wasm build exposes the C API, and both hooks
this needs are reachable and typed: `sqlite3_set_authorizer` and
`sqlite3_progress_handler`. `node:sqlite` (Node 24.14, SQLite 3.51.2) has
`setAuthorizer` and `enableDefensive` but **no progress handler**, so it
can't bound a query; Bun's `bun:sqlite` has neither hook, and on macOS links
the system SQLite, whose version is the OS's. So every runtime would load
the same wasm build anyway; "Bun has it built in" doesn't help a contract.

Per evaluation: a new `:memory:` database; the host's tables created and
filled; `DEFENSIVE` on, triggers, views and trusted schema off; limits on
SQL length (4,000), expression depth (64), value length (1 MB), compound
selects and `LIKE` patterns; then the authorizer, which allows only
`SQLITE_SELECT`, `SQLITE_RECURSIVE`, reads of the host's tables and of
`json_each`/`json_tree`, and functions on the allowlist (`FUNCTIONS` in
[`sql/engine.ts`](https://github.com/leifriksheim/minca/blob/sql-contracts-prototype/scenarios/sql/engine.ts)): core scalars, `count`/`sum`/`total`/`avg`, and the JSON
functions. Left out: `random`, the date functions, `changes`,
`last_insert_rowid`, `sqlite_version`, `printf`/`format`, `group_concat`,
`json_group_array`, window functions, and the math functions (libm). A
contract is one `SELECT` giving one row of one column; it passes when that
is the integer 1. All of a version's conditions share one database and one
step budget.

**What a contract sees** (`SCHEMA` in [`sql/host.ts`](https://github.com/leifriksheim/minca/blob/sql-contracts-prototype/scenarios/sql/host.ts)). Bodies are JSON text.

| Table     | Rows                                                                                                |
| --------- | --------------------------------------------------------------------------------------------------- |
| `this`    | The judged version: `id, collection, key, seq, author, deleted, prev, body, creator, line_key`      |
| `prev`    | The version before it, or none                                                                      |
| `cited`   | The versions it cites: `field, ord`, then the version columns                                       |
| `link`    | Links of all of these: `id, ord, rel, target`                                                       |
| `line`    | Every version held at this key, in this collection, by this author (only for a line written in SQL) |
| `members` | `did`: the members as of the judged version's `seen`                                                |

**Citations are declared.** CEL's `versions(ids)` asks the host for each id
while it runs, and stops as pending at the first one not held. A SQLite
query can't wait on the host, so a definition says which body fields cite
(`"cites": ["received"]`), and the host resolves every id in them, by the
rules of 09 §6.2, before the query runs. That is simpler to specify, but
every declared citation is now resolved, where CEL resolves only those an
`||` reaches.

## 2. The contracts side by side

Each CEL block is as in `scenarios/communities/`; each SQL block is from
[`scenarios/sql/contracts.ts`](https://github.com/leifriksheim/minca/blob/sql-contracts-prototype/scenarios/sql/contracts.ts). `LINK_ON(x)` stands for
`(SELECT target FROM link WHERE id = x AND rel = 'on' ORDER BY ord LIMIT 1)`,
CEL's `link('on')`, which `contracts.ts` writes out with a template.

### 2.1 Chess club: the player whose turn it is moves

```
versions([body.game]).all(g, g.collection == 'app.chess.game' && author == (int(body.ply) % 2 == 0 ? g.body.white : g.body.black))
```

```sql
-- cites: ["game"]
SELECT EXISTS (SELECT 1 FROM cited g, this t WHERE g.field = 'game' AND g.collection = 'app.chess.game'
  AND t.author = CASE WHEN (t.body ->> '$.ply') % 2 = 0 THEN g.body ->> '$.white' ELSE g.body ->> '$.black' END)
```

### 2.2 Co-op: a proposal lists every member as of itself

```
body.members.size() == memberCount && body.members.all(m, member(m)) && body.members.distinct().size() == body.members.size() && body.member in body.members
```

```sql
SELECT json_array_length(t.body, '$.members') = (SELECT count(*) FROM members)
  AND (SELECT count(DISTINCT j.value) FROM json_each(t.body, '$.members') j WHERE j.value IN (SELECT did FROM members))
      = json_array_length(t.body, '$.members')
  AND t.body ->> '$.member' IN (SELECT value FROM json_each(t.body, '$.members'))
FROM this t
```

`memberCount` is not in CEL's subset (the CEL host passes it in); in SQL it
is `count(*)` over a `members` table, which is the more natural form. The
list stays because the removal must count against the members as of the
**proposal**, and the removal's `members` table is as of the removal. A
`members` table per cited version would drop the list; it is a host input
either way.

### 2.3 Co-op: a removal has a majority of the members as of the proposal

```
body.op == 'add' || versions([body.proposal]).all(p, p.collection == 'coop.proposal' && p.body.member == body.did)
body.op == 'add' || versions([body.proposal]).all(p, versions(body.ballots).filter(b, b.collection == 'coop.ballot' && b.link('on') == p.key && b.body.yes == true && b.author in p.body.members).map(b, b.author).distinct().size() * 2 > p.body.members.size())
```

```sql
-- cites: ["proposal", "ballots"]
SELECT t.body ->> '$.op' = 'add' OR EXISTS (SELECT 1 FROM cited p WHERE p.field = 'proposal'
  AND p.collection = 'coop.proposal' AND p.body ->> '$.member' = t.body ->> '$.did')
FROM this t

SELECT t.body ->> '$.op' = 'add' OR (
  SELECT count(DISTINCT b.author) * 2 > json_array_length(p.body, '$.members')
  FROM cited p JOIN cited b ON b.field = 'ballots'
  WHERE p.field = 'proposal' AND b.collection = 'coop.ballot' AND LINK_ON(b.id) = p.key
    AND json_type(b.body, '$.yes') = 'true'
    AND b.author IN (SELECT value FROM json_each(p.body, '$.members')))
FROM this t
```

`json_type(...) = 'true'`, not `->> '$.yes' = true`: SQL reads JSON `true`
as the integer 1, so `{"yes": 1}` would be a yes (test "a ballot of
{"yes": 1} is not a yes").

### 2.4 Hall of fame

```
versions(body.reactions).filter(r, r.collection == 'app.reaction' && !r.deleted && r.link('on') == link('on') && r.body.emoji == '🙂').map(r, r.author).distinct().size() >= 5
```

```sql
-- cites: ["reactions"]
SELECT count(DISTINCT c.author) >= 5 FROM cited c
WHERE c.field = 'reactions' AND c.collection = 'app.reaction' AND NOT c.deleted
  AND c.body ->> '$.emoji' = '🙂' AND LINK_ON(c.id) = LINK_ON((SELECT id FROM this))
```

### 2.5 Mutual credit

CEL, with the line rule built in (`"line": { "once": ["received"] }`):

```
body.amount >= 0.0 && body.to != author
versions(body.received).all(r, r.collection == 'app.pay' && r.body.to == author)
body.balance == (prev == null ? 0.0 : prev.body.balance) - body.amount + sum(versions(body.received).map(r, r.body.amount))
body.balance >= -100.0
```

SQL, with the same built-in line rule:

```sql
-- cites: ["received"]
SELECT typeof(t.body ->> '$.amount') IN ('integer', 'real') AND t.body ->> '$.amount' >= 0
  AND t.body ->> '$.to' IS NOT t.author FROM this t

SELECT NOT EXISTS (SELECT 1 FROM cited r, this t WHERE r.field = 'received'
  AND (r.collection IS NOT 'app.pay' OR r.body ->> '$.to' IS NOT t.author))

SELECT t.body ->> '$.balance' = coalesce((SELECT body ->> '$.balance' FROM prev), 0)
  - (t.body ->> '$.amount') + (SELECT total(body ->> '$.amount') FROM cited WHERE field = 'received')
FROM this t

SELECT typeof(t.body ->> '$.balance') IN ('integer', 'real') AND t.body ->> '$.balance' >= -100 FROM this t
```

And the line rule itself, in SQL (09 §7.2–7.5), run on every version of the
line, deletes included, before the conditions above:

```sql
SELECT key = line_key FROM this

SELECT NOT EXISTS (SELECT 1 FROM line l, this t WHERE l.id != t.id AND l.prev IS t.prev)

WITH RECURSIVE chain(id, prev, deleted, body) AS (
  SELECT id, prev, deleted, body FROM this
  UNION ALL SELECT l.id, l.prev, l.deleted, l.body FROM line l JOIN chain c ON l.id = c.prev)
SELECT NOT EXISTS (SELECT 1 FROM chain WHERE deleted AND id != (SELECT id FROM this))
  AND (SELECT count(*) = count(DISTINCT j.value) FROM chain, json_each(chain.body, '$.received') j
       WHERE json_type(chain.body, '$.received') = 'array')
```

The `typeof` guards are not decoration: without them a body with
`"amount": "lots"` passes `>= 0`, since SQL orders every text above every
number (test "an amount that is not a number fails"). `IS NOT` instead of
`!=` keeps a missing field from slipping through as `NULL` (§4).

### 2.6 Line counts

Characters with white space collapsed; CEL's are as stored.

| Contract                       | CEL: conditions, characters | SQL: conditions, lines, characters | Same verdicts on the scenario's cases |
| ------------------------------ | --------------------------- | ---------------------------------- | ------------------------------------- |
| Chess club                     | 1, 130                      | 1, 2, 214                          | yes (3 moves)                         |
| Co-op proposal                 | 1, 156 (+ `memberCount`)    | 1, 5, 329                          | yes                                   |
| Co-op removal                  | 2, 371                      | 2, 10, 620                         | yes (4 cases, + `{"yes": 1}`)         |
| Hall of fame                   | 1, ~174                     | 1, 3, 340                          | yes (all 7 cases)                     |
| Mutual credit                  | 4, 264 + built-in line      | 4, 8, 592 + built-in line          | yes (11 cases)                        |
| The line rule, in the contract | not expressible             | 3, 8, 538                          | yes (the same 11 cases)               |

SQL is about twice as long, mostly `FROM this t`, `->> '$.'` and the type
and `NULL` guards. A Kysely version of the hall of fame
([`sql/kysely-sketch.ts`](https://github.com/leifriksheim/minca/blob/sql-contracts-prototype/scenarios/sql/kysely-sketch.ts), about 30 lines of types and query) checks field names
against the body types (`.key('emojii')` is a type error), and compiles to
SQL that gives the same verdicts (test "a contract written with Kysely").
Two frictions: Kysely compiles to `?` placeholders and parameters, so a
definition would store both, or the literals inlined; and correlated
subqueries need the outer table in scope, which reads less well than SQL.

## 3. What SQL did better, and worse

**Better.**

- **Counting against a set.** A `members` table makes the quorum complete
  without a new function (`memberCount` in CEL), and `count(DISTINCT ...)`
  with joins reads naturally.
- **Walking a line.** `WITH RECURSIVE` walks the chain and checks "claimed
  once" along it without carrying every claim so far in the body, which
  CEL couldn't (the comparison's §2.5, before the built-in `once`).
- **Numbers.** JSON integers stay integers and compare with reals by value;
  no `int()` before `%`, no `0.0` literals. (But `sum()` of no rows is
  `NULL`; `total()` is `0.0`, the same trap as CEL's old `sum([])` in
  another form.)
- **Naming.** CTEs and table aliases name a cited version once, where CEL
  has no `let`.
- **Tooling and familiarity.** Kysely types, any SQL client to try a
  contract, and nothing new to learn for most developers.

**Worse.**

- **Fails open.** A comparison with `NULL` is `NULL`, and `WHERE` drops it:
  `NOT EXISTS (... WHERE body ->> '$.emoji' != '🙂')` passes a reaction with
  no emoji (test "NULL: a missing field…"). CEL errors on a missing field,
  and an error fails. Every negated condition needs `IS NOT`.
- **Comparisons never err.** Text is above every number, `'1' = 1` is false,
  `true = 1` is true, `'12abc' + 0` is 12, `1 / 0` is `NULL`, and an integer
  overflow silently becomes a float. Every numeric field needs a `typeof`
  guard to fail as CEL would.
- **Citations must be declared** (§1), and an `||` can't skip one.
- **Cost depends on the plan.** `LINK_ON` is a correlated subquery: the hall
  of fame takes 407 steps with 5 citations, 45,057 with 100 and 262,557
  with 250, past the 100,000 limit, while CEL's 256-citation limit fits.
  With an index on `link(id, rel, ord)` the same query at 250 takes 8,552.
  So the indexes would be protocol too.

**Can the built-in line rule go?** It can be _written_ in SQL: the three
conditions of §2.5 give the same verdicts on all 11 credit cases, double
spends, deletes as twins, a delete ending a line, griefing and second lines
included ([`scenarios/sql/tests/scenarios.test.ts`](https://github.com/leifriksheim/minca/blob/sql-contracts-prototype/scenarios/sql/tests/scenarios.test.ts), "line in SQL"). It can't
be _removed from the protocol_:

1. Its input is the one thing in a contract not fixed by citation: every
   version a reader holds at the key, deletes, versions without `retain`
   and twins nobody cites included (09 §7.3). The protocol still has to
   define the `line` table, which is most of what §7.3 says.
2. The line key is SHA-256 and base32 of the collection (09 §7.2): the host
   computes it (`this.line_key`) or the allowlist grows a hash function.
3. Owned-key standing (02 §4.1) still keeps Carol out of Alice's line.
4. It must run on deletes, which contracts otherwise skip (09 §4.1), so a
   collection needs two kinds of condition.
5. Each collection could write a weaker line. Payees rely on the rule
   meaning one thing; a built-in is one audited rule, where SQL is one per
   collection that every payee would have to read.

So SQL moves the checking (about 30 lines of `checkLine` and `lineBreak`)
into each definition and keeps everything hard in the spec. Keep it built in.

## 4. Determinism

Measured on three builds: `@sqlite.org/sqlite-wasm` 3.53.4 (the bundled
one), 3.46.1, and Node's `node:sqlite` 3.51.2. The tests in
[`sql/tests/determinism.test.ts`](https://github.com/leifriksheim/minca/blob/sql-contracts-prototype/scenarios/sql/tests/determinism.test.ts) assert what 3.53.4 gives; the cross-version
runs were a scratch script, summarised here.

| Probe                                      | Result                                                                                                      | Same across versions?                                   |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `cast(0.1 + 0.2 AS text)`                  | `'0.30000000000000004'` on 3.53; `'0.3'` on 3.46 and 3.51                                                   | **No**                                                  |
| `cast(1e15 AS text)`                       | `'1000000000000000.0'` on 3.53; `'1.0e+15'` before                                                          | **No**                                                  |
| `json_quote(0.1 + 0.2)`                    | 17 digits on 3.53, 15 before; `SQLITE_DBCONFIG_FP_DIGITS = 15` (3.52+) restores `cast` but not `json_quote` | **No**                                                  |
| `0.1 + 0.2 = 0.3`, `round(2.5)`            | 0; 3 (IEEE, half away from zero)                                                                            | yes                                                     |
| `9223372036854775807 + 1`                  | a `real`, silently; `abs(-2^63)` and an overflowing `sum()` raise                                           | yes                                                     |
| `1 / 0`, `1 % 0`                           | `NULL`                                                                                                      | yes                                                     |
| `'{"n":9007199254740993}' ->> '$.n'`       | the exact int64, where CEL and JavaScript read 2^53; `node:sqlite` throws converting it                     | yes in SQLite; differs from every JSON-as-double reader |
| `NULL = NULL`, `1 NOT IN (2, NULL)`        | `NULL`, `NULL`; `sum()` of nothing `NULL`, `total()` 0.0                                                    | yes                                                     |
| `'a' > 9e999`, `'1' = 1`, `true = 1`       | 1, 0, 1                                                                                                     | yes                                                     |
| `lower('ÄB')`, `'Ä' LIKE 'ä'`              | `'Äb'`, 0: ASCII only without ICU (the wasm build has none)                                                 | yes, unless a peer links ICU                            |
| `char(65535) < char(128512)`               | 1: UTF-8 byte order, where CEL and canonical JSON (02 §1) order by UTF-16 units                             | yes                                                     |
| NFC `é` = NFD `é`                          | 0: no normalization                                                                                         | yes                                                     |
| `'{"a":1,"a":2}' ->> '$.a'`                | 1: the first                                                                                                | yes                                                     |
| `json('{a:1}')`                            | accepted as JSON5 (since 3.42); `json_valid` says 0                                                         | no before 3.42                                          |
| Malformed JSON in `->>`                    | an error, so the condition fails                                                                            | yes                                                     |
| `json_extract('"\ud800"', '$')`            | 3 bytes that are not UTF-8, where CEL reads U+FFFD                                                          | yes                                                     |
| `(SELECT x FROM r LIMIT 1)`, no `ORDER BY` | `'a'`; `'b'` with `PRAGMA reverse_unordered_selects`, as another plan may give                              | **not promised**                                        |
| Steps for the same query and tables        | e.g. 28 / 30, 41 / 64, 263,307 / 263,561 (3.53.4 / 3.46.1); 29 of 48 measured pairs differ                  | **No**                                                  |

What a spec for (B) would have to fix:

1. **One exact SQLite build**, not a floor: the version, the compile
   options (no ICU, the JSON and math options), and `FP_DIGITS`. Float to
   text changed inside three minor versions, through `CAST`, `||` and
   `json_quote`, none of which the authorizer can refuse (`CAST` and `||`
   are not functions). Upgrading SQLite becomes a protocol change, and no
   other engine can ever be a conforming implementation.
2. **The function allowlist by name and arity**, per that version.
3. **The tables, their columns, their indexes, and their row order**, since
   steps and unordered results depend on them.
4. **JSON input**: bodies given to SQL as canonical JSON text (02 §1), so
   that every peer gives the same text, including integers past 2^53 and
   escaped lone surrogates.
5. Rules for what a query may leave unordered (`LIMIT` without `ORDER BY`,
   a scalar subquery with several rows, bare columns in aggregates). These
   can't be refused without parsing SQL ourselves, which would be a subset
   language with its own spec: the cost CEL already paid.

What can't be made identical across peers: anything across two SQLite
versions, as above; and any implementation that isn't that SQLite.

## 5. The cost limit

SQLite counts virtual machine instructions, through a callback every _N_.
That is a good **time** bound within one build: a recursive CTE that never
ends stops at the limit (test "a query that never ends…"), and the
evaluation is deterministic for one build, one schema and one set of rows.
It falls short of CEL's in three ways:

- **Not the same across versions** (§4): a version near the limit passes on
  one peer and fails on another. Only one pinned build makes it exact.
- **Not a unit of work.** `instr()` over a 900 KB body is under 30 steps
  (test "steps are counted per VM instruction…"). Bounding work means
  bounding value sizes (`SQLITE_LIMIT_LENGTH`) and `LIKE` patterns, and
  accepting steps × the largest value as the worst case. CEL counts work by
  size of operands (09 §4.3).
- **Depends on the plan.** The hall of fame takes 262,557 steps or 8,552 at
  250 citations, with or without one index (§3). An author can't predict the
  count from the SQL, and the planner's choices are a version's.

## 6. Private spaces

A contract needs only a fresh `:memory:` database, filled with opened
bodies and closed after one evaluation. That is workable: nothing touches
disk, and nothing outlives the call but freed pages in the wasm heap
(`sqlite3_free` doesn't zero them; the JavaScript heap holds the same
plaintext today). The cost is filling the tables for every evaluation:
about 0.4 ms for 5 citations and 3.8 ms for 250, before the query runs (§7).

A **query** layer is different: its value is an index kept beside the
records, and for a private space that index is plaintext. A SQLite file in
OPFS would need sealing at rest as the registry has (05 §15), which SQLite
doesn't do (no SEE or SQLCipher in the official wasm build). It could stay
in memory and be rebuilt on open; the [query format](../../packages/core/docs/query-format.md)
already names this open question for full-text search. That is a library
decision, not protocol.

## 7. Browsers, the extension, size and speed

- **CSP.** Compiling wasm needs `'wasm-unsafe-eval'` in `script-src`. An MV3
  extension may add it to `extension_pages` (the one relaxation MV3
  allows); a site must allow it. The mini-app screen
  (`apps/example/public/screen.html`) doesn't, which is fine since screens
  don't judge contracts.
- **OPFS.** Only for a persistent query store, not for contracts. The
  official VFSs need a dedicated Worker (`opfs-sahpool`), or COOP/COEP
  headers for `SharedArrayBuffer` (`opfs`); neither runs in the extension's
  service worker.
- **Size.** `sqlite3.wasm` is 869 KB, 403 KB gzipped, 349 KB brotli; its
  JavaScript glue is 538–643 KB unminified (118–141 KB brotli). CEL is
  `packages/core/src/records/cel.ts` and `contracts.ts`, 1,720 lines of
  TypeScript already in core.
- **Cold start.** Importing and instantiating in a new Node process: 19–21
  ms. CEL: none.
- **Per evaluation** (Node 24, M-series laptop, warm; the hall of fame):

| Citations | CEL (`runContracts`) | SQL: database and tables alone | SQL: total |
| --------- | -------------------- | ------------------------------ | ---------- |
| 5         | 73 µs                | 426 µs                         | 430 µs     |
| 100       | 623 µs               | 1,919 µs                       | 3,117 µs   |
| 250       | 1,597 µs             | 3,762 µs                       | 9,946 µs   |

SQLite's query speed is not what costs here: building a fresh database per
version is. Reusing one would be faster and would let one evaluation's rows
leak into the next.

## 8. Recommendation: (C), and why

**(C): SQL for local queries, CEL for contracts.** The deciding reasons:

1. **Agreement needs one SQLite forever.** A contract is judged by every
   peer, now and years from now, and must give the same verdict. SQLite is
   deterministic only within one build: float printing changed between
   3.51 and 3.53, step counts differ between every pair of versions we
   measured, and row order is the planner's. The spec would have to name a
   SQLite build and its options as normative (§4), so upgrading SQLite
   becomes a protocol version, and no other implementation can exist. CEL
   has a spec, a conformance suite Minca passes, and an exact cost model.
2. **SQL fails open where CEL fails closed.** `NULL` and loose comparisons
   let a careless contract pass a version it meant to refuse (§3); every
   contract here needed `typeof`, `IS NOT` or `json_type` guards to match
   CEL's verdicts. Contracts are a security boundary: a wrong one that
   passes is worse than a wrong one that fails.
3. **The cost limit is a time bound, not an agreement.** Steps vary by
   version and plan, and don't count work (§5).
4. **The wins are host inputs, not language.** The `members` table and the
   `line` table are what made the quorum and the line easy, and CEL can be
   given the same (`memberCount`, or a members list, as the comparison's §9
   proposed). The line rule can't leave the spec either way (§3).
5. **Queries are where SQLite fits, and they aren't protocol.** Only one
   node reads its own query results, so a SQLite version there is that
   node's business, as are indexes, plans and unordered rows. That is where
   Kysely, Drizzle, familiarity and speed pay off, and where a query over
   everything held is the point rather than a hazard.

"One language for contracts and queries" is the cost of (C). It is smaller
than it looks: a contract verifies cited evidence and a query searches what
a node holds, so they read different inputs whichever language they share.

(B) would be worth reopening if a single pinned SQLite build were
acceptable as part of the protocol for good, with Minca writing its own
conformance suite for it; or if contracts came to need joins over large
cited sets, where SQL's plans beat CEL's macros.

_Source: [`scenarios/sql/engine.ts`](https://github.com/leifriksheim/minca/blob/sql-contracts-prototype/scenarios/sql/engine.ts) (`engineOn`, `FUNCTIONS`), [`scenarios/sql/host.ts`](https://github.com/leifriksheim/minca/blob/sql-contracts-prototype/scenarios/sql/host.ts) (`judgeSql`, `SCHEMA`), [`scenarios/sql/contracts.ts`](https://github.com/leifriksheim/minca/blob/sql-contracts-prototype/scenarios/sql/contracts.ts), [`scenarios/sql/kysely-sketch.ts`](https://github.com/leifriksheim/minca/blob/sql-contracts-prototype/scenarios/sql/kysely-sketch.ts). Tests: [`scenarios/sql/tests/scenarios.test.ts`](https://github.com/leifriksheim/minca/blob/sql-contracts-prototype/scenarios/sql/tests/scenarios.test.ts), [`scenarios/sql/tests/determinism.test.ts`](https://github.com/leifriksheim/minca/blob/sql-contracts-prototype/scenarios/sql/tests/determinism.test.ts); the CEL side is `scenarios/communities/` and `scenarios/tests/`, with `packages/core/src/records/contracts.ts` (`runContracts`)._
