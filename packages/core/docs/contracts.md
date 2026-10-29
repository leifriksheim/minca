# Contracts

A collection's contract says what a version must _be_ to count: conditions
over its body, the version before it, and other versions it cites as
evidence, in a subset of CEL. A line is one account's sequence of versions
in a collection, where two versions after the same one cancel each other.
What they mean exactly (the language, citations, limits, verdicts and the
line rule) is protocol, in [spec 09](../../../spec/09-contracts.md), so that
two implementations count the same records. How to write contracts, with
patterns, is in [collections.md](collections.md#contracts). This page is how the
library builds, checks and runs them.

## Writing one in TypeScript

Write `check` as a function in the collection. It gets the version's names,
typed from the collection's own schema, and gives an object: each key says
why a version failing its condition doesn't count, and each value is the
condition. Peers still see CEL: `define` builds it, as a query builder writes
SQL.

```ts
import * as z from 'zod';
import { collection } from '@minca/core';

const reaction = collection({
  name: 'app.reaction',
  schema: z.object({ emoji: z.string() }),
  links: { on: { to: ['app.comment'], cardinality: 'one' } },
});

export const fame = collection({
  name: 'app.fame',
  schema: z.object({ reactions: z.array(z.string()) }),
  links: { on: { to: ['app.comment'], cardinality: 'one' } },
  contract: {
    check: ({ body, cited, link }) => ({
      'Needs five different people': cited(body.reactions, reaction)
        .where((r) => r.link('on').eq(link('on')).and(r.body.emoji.eq('🙂')))
        .map((r) => r.author)
        .distinct()
        .count()
        .gte(5),
    }),
  },
});
```

That stores:

```json
[
  {
    "that": "versions(body.reactions).filter(x0, x0.collection == \"app.reaction\").filter(x0, x0.link(\"on\") == link(\"on\") && x0.body.emoji == \"🙂\").map(x0, x0.author).distinct().size() >= 5",
    "else": "Needs five different people"
  }
]
```

- **Typed from the schemas.** `body.` completes the collection's fields, and
  `body.amont`, `body.to.eq(1)` or a condition that gives a number are type
  errors.
- **`cited(ids, collection)`** reads the versions cited by `ids` that are in
  `collection`, typed from its schema, so `r.body.emojii` is a type error
  too. Versions of any other collection are left out, so nothing can be cited
  in their place. Where a citation of anything else must refuse the version
  instead, use `versions(ids)`, untyped until `.of(collection)`, and test
  `collection` yourself.
- **What it reads:** `body`, `prev` (`prev.eq(null)` on a first version),
  `links`, `key`, `seq`, `collection`, `author`, `creator`, `createdAt`, and
  the functions `cited(ids, collection)`, `versions(ids)`, `link(rel)`,
  `member(did)`, `hash(x)`, `has(field)`, `when(test, then, otherwise)` and
  `raw(cel)`.
- **Methods by type.** Comparison: `eq` `ne` `lt` `lte` `gt` `gte` `in`.
  Numbers: `add` `sub` `mul` `div` `neg`, ints also `mod`, and `toInt`,
  `toDouble`. Bools: `and` `or` `not`. Strings: `size` `contains`
  `startsWith` `endsWith` `add`. Lists: `size` (or `count`), `where` (or
  `filter`), `map`, `all`, `exists`, `existsOne`, `distinct`, `sum`,
  `includes`, `at`.
- **Literals take the kind CEL needs.** A body's numbers are doubles and a
  size is an int, so `body.amount.gte(0)` writes `0.0` and
  `list.count().gte(5)` writes `5`. A fraction where an int is needed throws.
- **`raw(cel)`** writes CEL by hand for what the builder doesn't cover:
  `math.greatest`, map literals, `string()`, indexing a map. Its result is
  untyped unless you say: `raw<boolean>('…')`.
- **Each reason once.** Two conditions under the same reason are one key,
  and the later replaces the earlier, so a contract loses a condition
  without a word. Give each its own reason, or join them with `and`.
- `define` throws when what it builds isn't a condition it would take,
  saying why.

What it can't express, and `raw` covers: map literals, `math.greatest` and
`math.least`, `string()`, `bool()`, `uint` values, `.map` with a filter
(`map(x, p, t)`), and a field of an untyped value whose name is one of the
methods above (use `.get('size')`).

`contract(schema, that, else)` builds one condition outside a collection,
for one shared by several, and gives the `{ that, else }` that a `check`
list holds.

## Writing it by hand

A condition is a CEL string, and a hand-written one is stored the same way:

```ts
await node.collections.define(space, {
  name: 'app.pay',
  schema: Payment,
  contract: {
    check: [
      {
        that: 'body.balance == (prev == null ? 0.0 : prev.body.balance) - body.amount + sum(versions(body.received).map(r, r.body.amount))',
        else: 'The balance follows from the one before',
      },
      { that: 'body.balance >= -100.0', else: 'No account goes below −100' },
    ],
    line: { once: ['received'] },
  },
});

// The first payment starts this account's line, at its line key;
// each one after is the line's next version.
const line = await lineKey(node.did, 'app.pay');
await node.records.put(space, 'app.pay', { to, amount: 30, balance: -30, received: [] }, { key: line });
await node.records.update(space, line, { to: other, amount: 20, balance: -50, received: [] });
```

A contract is the definition's `contract`, apart from its `rules`: peers
check `rules` and refuse `check` there, and never read `contract`
(spec 09 §1). The functions and types are `Contract`, `CollectionContract`, `ContractContext`,
`contract`, `contractCostHints` and `node.records.contracts`.

## Checked against the schema when defined

`collections.define` reads every condition, built or hand-written, against
the collection's JSON Schema, and refuses one it can show is a mistake,
saying where:

- a field an object doesn't declare (`body.amont`, `prev.body.balanse`).
  This is stricter than JSON Schema: an object without
  `additionalProperties` counts as closed, as a Zod object writes it. Say
  other fields may be there (`additionalProperties: {}` or a schema, as
  `z.looseObject` and `.catchall()` write it) to read one;
- a comparison that is never equal or always an error: a string with a
  number, `body.n > "1"`;
- arithmetic that is always an error: `body.n + 1` (a body's numbers are
  doubles: write `1.0`);
- a value used where it can't be: `versions(body.game)` on a string,
  `sum()` of strings, `size()` of a number, `&&` or `||` where no side is a
  bool, a field of a string, a condition that gives anything but a bool.

This is the library's care, not protocol: another writer's definition that
it would refuse still stands, and peers judge it by spec 09. It can't catch:
a missing optional field (ask `has()`); anything read from a cited version
not narrowed by the schema (a cited body is untyped to it); a cited version
of the wrong collection; values out of range; and whatever `dyn()` or a
schema it can't follow (no `type`, a mix of types) hides. A number's
`integer` type reads as a double, as CEL reads JSON, and a sum of ints is
untyped, since `sum([])` is `0.0`.

## How the library reads them

- **Counted only when it passes.** `get`, `list`, `linked`, queries and their
  counts, automations and notifications count only versions that pass; `history`
  lists every version and gives a failing one its reason.
- **`node.records.contracts(space, key, version?)`** says how the record's
  newest version that stands fares, or the version named:
  `{ version, passes, reason?, pending?, unjudged? }`. `passes` is `true`,
  `false` with the failing condition's `else` as `reason`, or `null` when the
  collection has no contract, the version waits (`pending: true`), or this
  library can't judge it (`unjudged: true`, with why).
- **The writer refuses its own failing version.** The node judges a version's
  contract before signing it, and throws with the condition's `else` when it
  fails, when a version it cites hasn't arrived, or when it would be a double
  spend. Another implementation, or a writer that signs anyway, can still
  send one: every peer keeps it, and no reader counts it.
- **Kept whole.** The node sets `retain` on every version of a collection
  under a contract or a line that is not a delete, as spec 09 §4.2 asks of
  writers.
- **Pending, read again.** A version waiting on one it cites is judged again
  whenever anything arrives, for up to **256** records at a time; beyond
  that, when the space's index is next rebuilt. Only a pass or a fail is
  cached.
- **Double spends undo verdicts.** A version arriving in a line collection
  throws away every cached verdict in the space, since it can make a counted
  payment a double spend, and every version citing it fail with it.
- **Defining.** `collections.define` refuses a contract outside the subset,
  one that misreads its schema ([above](#checked-against-the-schema-when-defined)),
  a `contract` with any key but `check` and `line`, and a `line` with any key
  but `once` (spec 09 §8).
- **Cost hints.** `contractCostHints(check)` flags conditions whose cost grows
  fast with the records they read (macros three deep, `versions()` inside a
  macro), so one that passes on small records doesn't run out of steps on
  large ones. Advice only: no verdict depends on it.

A line is checked by walking its counted chain for each version judged, so a
very long line costs time in proportion to its length squared, once; the
verdicts are cached.

_Source: `packages/core/src/records/contract-builder.ts` (`contract`, `buildChecks`, `storedContract`), `packages/core/src/records/cel-types.ts` (`typeCheckCel`, `typeOfSchema`), `packages/core/src/records/contracts.ts` (`checkContracts`, `checkContractShape`, `checkContractTypes`, `runContracts`, `contractCostHints`, `checkLine`), `packages/core/src/node/space-checks.ts` (`checksOf`, `lineBreak`, `counts`), `packages/core/src/node/space-writing.ts` (`contractsFor`, `after`, `write`), `packages/core/src/node/space-runtime.ts` (`recordsChanged`, `define`), `packages/core/src/node/node-records.ts` (`contracts`). Tests: `packages/core/tests/contract-builder.test.ts`, `packages/core/tests/contracts.test.ts`, `packages/core/tests/contracts-shape.test.ts`, `packages/core/tests/contracts-line.test.ts`, `packages/core/tests/contracts-pending.test.ts`, `packages/core/tests/contracts-reads.test.ts`, `scenarios/tests/fame.test.ts` and `scenarios/tests/credit.test.ts` (each case with the built contract and the hand-written one)._
