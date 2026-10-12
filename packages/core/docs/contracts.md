# Contracts

A collection's contract says what a version must _be_ to count: conditions
over its body, the version before it, and other versions it cites as
evidence, in a subset of CEL. A line is one account's sequence of versions
in a collection, where two versions after the same one cancel each other.
What they mean exactly (the language, citations, limits, verdicts and the
line rule) is protocol, in [spec 09](../../../spec/09-contracts.md), so that
two implementations count the same records. How to write contracts, with
patterns, is in [collections.md](collections.md#contracts). This page is how the
library runs them.

```ts
await node.collections.define(space, {
  name: 'app.pay',
  schema: Payment,
  rules: {
    check: [
      {
        that: 'body.balance == (prev == null ? 0.0 : prev.body.balance) - body.amount + sum(versions(body.received).map(r, r.body.amount))',
        else: 'The balance follows from the one before',
      },
      { that: 'body.balance >= -100.0', else: 'No account goes below −100' },
    ],
  },
  line: { once: ['received'] },
});

// A payment: the next version of this account's line.
const key = await lineKey(node.did, 'app.pay');
await node.records.update(space, key, { to, amount: 30, balance: -30, received: [] });
```

The definition's field is still `rules.check`: peers check the names in
`rules`, so renaming it would make older peers treat new definitions as
invalid. The functions and types are `Contract`, `contractCostHints` and
`node.records.contracts`.

## How the library reads them

- **Counted only when it passes.** `get`, `list`, `linked`, queries and their
  counts, rules and notifications count only versions that pass; `history`
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
  and a `line` with any key but `once` (spec 09 §8).
- **Cost hints.** `contractCostHints(check)` flags conditions whose cost grows
  fast with the records they read (macros three deep, `versions()` inside a
  macro), so one that passes on small records doesn't run out of steps on
  large ones. Advice only: no verdict depends on it.

A line is checked by walking its counted chain for each version judged, so a
very long line costs time in proportion to its length squared, once; the
verdicts are cached.

_Source: `packages/core/src/records/contracts.ts` (`checkContracts`, `runContracts`, `contractCostHints`, `checkLine`), `packages/core/src/node/space-runtime.ts` (`checksOf`, `lineBreak`, `contractsFor`, `counts`, `recordsChanged`, `after`, `write`, `define`), `packages/core/src/node/node.ts` (`records.contracts`). Tests: `packages/core/tests/contracts.test.ts`, `packages/core/tests/contracts-line.test.ts`, `packages/core/tests/contracts-pending.test.ts`, `packages/core/tests/contracts-reads.test.ts`._
