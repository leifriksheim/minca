# Contracts

A contract says when a version of a record counts. Use one when every app
must agree on something no single writer can be trusted with: a proposal
that passes only with enough votes, a move that must be legal, points that
can't be spent twice.

Here is a counter anyone may add to, but nobody can skip ahead:

```ts
import * as z from 'zod';
import { collection } from '@minca/core';

export const counter = collection({
  name: 'app.counter',
  schema: z.object({ count: z.number() }),
  contract: {
    check: ({ body, prev, when }) => ({
      'The count goes up by one at a time': body.count.eq(when(prev.eq(null), 0, prev.body.count).add(1)),
    }),
  },
});
```

Anyone can still write a version with `count: 100`. It just doesn't count:
every app reading the space skips it and shows the version before.

When a value only needs to look the same in every app, like a to-do that is
done once two people react, a [computed field](computed.md) is simpler.

## How a contract is judged

Grants say who may write, and [rules](collections.md#rules) say what a record
must keep to. Every peer enforces both, and refuses what breaks them. A
contract is different: readers judge it, and peers don't enforce it.

A version that fails its contract is kept and synced like any other. But
`get`, `list` and queries count only a record's newest version that passes.
One that fails is skipped, and the version before shows instead.

Your own node refuses to sign a version that fails, with the condition's
reason as the error. Another implementation could still send one, and no
reader would count it.

## Citing evidence

A contract never searches, because no device holds everything. The writer
does the work instead: it finds the votes, adds up the balances or picks the
move, and cites the versions that prove it. Every reader then checks that
exactly what was cited proves it. The example in
[Contracts](collections.md#contracts) on the collections page finds a
proposal's votes and cites them by version id.

A version citing one that hasn't arrived yet is pending, and doesn't count
until it does.

### What can be cited

Only versions kept whole can be cited, so every device reads the same thing
however late it joins:

- any version in a collection with `history: 'all'`,
- any version in a collection with a contract of its own, since the node
  keeps those whole,
- the first version of a record under `onePer` or `fixed`.

A cited version must also pass its own contract. Give a collection you mean
to cite `history: 'all'`, or the latest version of an edited vote can't be
cited.

A citation proves what was signed, not that it is still current. Make
evidence final where it matters: `final: true` on a vote, so nobody can
change or delete it once it is counted, or `fixed: ['choice']` to allow
other edits.

### A proof stays a proof

A cited version is judged as of what the citing version saw. Removing a
voter later, or revoking the device that voted, doesn't undo a decision that
already counted the vote. A decision written after seeing the removal can't
count it. Peers keep such withdrawn versions, and the library reads them for
this without showing them.

## Writing one in TypeScript

Write `check` as a function in the collection. It gets the version's names,
typed from the collection's schema, and returns an object. Each key is the
reason a version failing that condition doesn't count, and each value is the
condition. `define` turns it into CEL, the way a query builder writes SQL.

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

`body.` completes the collection's fields. `body.amont`, `body.to.eq(1)` and
a condition that gives a number are all type errors.

### Cited versions

`cited(ids, collection)` reads the versions cited by `ids` that are in
`collection`, typed from its schema, so `r.body.emojii` is a type error too.
Versions of any other collection are left out, so nothing can be cited in
their place.

When citing anything else should fail the version instead, use
`versions(ids)`. It is untyped until `.of(collection)`, and you test
`collection` yourself.

### What it reads

`check` gets a [`ContractContext`](https://minca.dev/api/core/interfaces/ContractContext/):
the version's fields, like `body` and `prev`, and the functions it may call,
like `cited` and `member`.

Each value has the methods of its type:
[numbers](https://minca.dev/api/core/interfaces/NumExpr/),
[ints](https://minca.dev/api/core/interfaces/IntExpr/),
[bools](https://minca.dev/api/core/interfaces/BoolExpr/),
[strings](https://minca.dev/api/core/interfaces/StrExpr/),
[lists](https://minca.dev/api/core/interfaces/ListExpr/) and
[versions](https://minca.dev/api/core/interfaces/VersionExpr/).

Literals take the kind CEL needs. A body's numbers are doubles and a size is
an int, so `body.amount.gte(0)` writes `0.0` and `list.count().gte(5)` writes
`5`. A fraction where an int is needed throws.

### Writing CEL by hand inside the builder

`raw(cel)` covers what the builder can't express, like map literals,
indexing a map, and `.map` with a filter (`map(x, p, t)`). For a field of an
untyped value named like a method, use `.get('size')`.

### Each reason once

Two conditions under the same reason are one key, and the later replaces the
earlier. The contract silently loses a condition. Give each its own reason,
or join them with `and`.

`define` throws when what it builds isn't a condition it would accept, and
says why.

### One condition on its own

[`contract(schema, that, else)`](https://minca.dev/api/core/functions/contract/)
builds a single condition outside a collection, to share between several. It
gives the `{ that, else }` that a `check` list holds.

## Writing it by hand

A condition is a CEL string, and a hand-written list is stored the same way:

```ts
import * as z from 'zod';

await node.collections.define(space.id, {
  name: 'app.pay',
  schema: z.object({
    to: z.string(),
    amount: z.number(),
    balance: z.number(),
    received: z.array(z.string()),
  }),
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
```

A contract sits in the definition's `contract`, apart from its `rules`. Peers
check `rules` and refuse `check` there. They never read `contract`. Its type
is [`CollectionContract`](https://minca.dev/api/core/interfaces/CollectionContract/).

## The language

A condition is a [CEL](https://cel.dev) expression. CEL is the Common
Expression Language that Kubernetes, Firebase and Envoy use for policies.

A condition reads `body`, `links`, `key`, `seq`, `collection`, `author` (the
account), `creator`, `createdAt` and `prev` (the version before, or `null`).
It has:

- CEL's operators, `has()`, and the macros `all`, `exists`, `exists_one`,
  `filter` and `map`
- `size`, `contains`, `startsWith` and `endsWith`
- the conversions `int`, `uint`, `double`, `string` and `bool`
- from CEL's extensions, `distinct()`, `math.greatest` and `math.least`
- from Minca, `sum(list)`, `hash(x)`, `link("rel")` and `v.link("rel")`
- two that ask the space: `versions(ids)` reads cited versions by id, and
  `member(did)`

Bytes, timestamps, durations, regular expressions and types as values are
left out.

### Things to know

- A body's numbers are doubles, as JSON's are, and a literal like `1` is an
  int. They compare freely, but don't mix in arithmetic. Write
  `body.n + 1.0`, or `int(body.n) + 1`.
- Reading a field that isn't there is an error, not `null`. Ask
  `has(body.note)` first. `&&` and `||` let an error pass when the other side
  decides.
- A condition holds only when it gives `true`.
- A condition always ends. Its only loops are over lists in hand, and there
  is a step limit.

### Cost

A condition that goes over its limits is refused, so one that passes on
small records can fail on large ones.
[`contractCostHints(check)`](https://minca.dev/api/core/functions/contractCostHints/) flags what
makes a condition grow costly: macros nested three deep, or `versions()`
called inside a macro. It is advice only, and no verdict depends on it.

The exact subset and its limits are in [spec 09](../../../spec/09-contracts.md).

## Lines

A line is one account's sequence of versions in a collection. A collection
whose contract has `line: { once: [...] }` gives each account one line, at
`lineKey(account, collection)`. Each version names the account's previous
one, so a payment can carry a running balance its contract checks.

```ts
import { lineKey } from '@minca/core';

// The first payment starts this account's line, at its line key.
// Each one after is the line's next version.
const line = await lineKey(node.did, 'app.pay');
await node.records.put(
  space.id,
  'app.pay',
  { to: did, amount: 30, balance: -30, received: [] },
  { key: line },
);
await node.records.update(space.id, line, { to: did, amount: 20, balance: -50, received: [] });
```

Two versions after the same one are a double spend. Neither counts, and
nothing after either does. There is no way back, so keep a line on one
device at a time.

Each citation in a `once` field may appear only once along the line. That is
what stops one payment received from being counted twice.

The exact rule is in [spec 09 §7](../../../spec/09-contracts.md#7-lines).

## Checked against the schema when defined

`collections.define` reads every condition, built or hand-written, against
the collection's JSON Schema. It refuses one it can show is a mistake, and
says where:

- a field an object doesn't declare, like `body.amont` or
  `prev.body.balanse`
- a comparison that is never equal or always an error, like a string with a
  number: `body.n > "1"`
- arithmetic that is always an error, like `body.n + 1`, since a body's
  numbers are doubles (write `1.0`)
- a value used where it can't be: `versions(body.game)` on a string, `sum()`
  of strings, `size()` of a number, `&&` or `||` with no bool side, a field
  of a string, or a condition that gives anything but a bool

This is stricter than JSON Schema in one way. An object without
`additionalProperties` counts as closed, as a Zod object writes it. To read a
field the schema doesn't declare, say other fields may be there:
`additionalProperties: {}` or a schema, as `z.looseObject` and `.catchall()`
write it.

It can't catch:

- a missing optional field (ask `has()`)
- anything read from a cited version, since a cited body is untyped to it
- a cited version of the wrong collection
- values out of range
- whatever `dyn()`, or a schema it can't follow (no `type`, a mix of types),
  hides

A number's `integer` type reads as a double, as CEL reads JSON. A sum of
ints is untyped, since `sum([])` is `0.0`.

This check is the library's care, not protocol. A definition from another
writer that it would refuse still stands, and readers judge it by spec 09.

## Patterns

- **Quorums and multisig.** "Three members approved": cite the approvals, and
  check `distinct()` authors with `member(v.author)`. Who may approve at all
  is the grant on the approvals' collection.
- **State machines.** Check each version against `prev`. A task moves from
  `open` to `done` only, a counter goes up by one, a chess move is legal from
  the board before. Each step is small, and there is no limit on steps.
- **Ledgers.** A transfer cites the balance records it spends, and checks
  that they are the sender's and add up. Two spends of one balance are two
  versions of it, which everyone sees.
- **Commit, then reveal.** A player first writes `hash` of a secret, then
  reveals it: `hash(body.secret) == "<the commitment>"`. Shared dice,
  lotteries and sealed bids need nothing else.
- **Closing a set.** A contract can prove that something exists, not that
  nothing else does. For "a majority" or "nobody objected", someone granted
  it signs a record that closes the vote and lists what counts, and the
  result cites that.
- **Time.** There is no clock. "Before Friday" is a record from someone
  trusted to say it, like a host or a witness, that the result cites.

The standard library has two ready-made: `std.decision`, a proposal decided
by a quorum of ballots, and `std.goal-reached`, a goal reached by pledges
([standard library](standard-library.md)).

## How the library reads them

- **Counted only when it passes.** `get`, `list`, `linked`, queries and
  their counts, automations and notifications count only versions that pass.
  `history` lists every version, and gives a failing one its reason.
- **Asking how a version fares.**
  [`node.records.contracts`](https://minca.dev/api/core/interfaces/NodeRecords/)
  says how the record's newest standing version fares, or the version named.
- **The writer refuses its own failing version.** The node judges a
  version's contract before signing it. It throws with the condition's `else`
  when the version fails, when a version it cites hasn't arrived, or when it
  would be a double spend.
- **Kept whole.** The node sets `retain` on every version of a collection
  under a contract or a line, apart from deletes.
- **Pending, read again.** A version waiting on one it cites is judged again
  whenever anything arrives, for up to **256** records at a time. Beyond
  that, it waits until the space's index is next rebuilt. Only a pass or a
  fail is cached.
- **Double spends undo verdicts.** A version arriving in a line collection
  throws away every cached verdict in the space. It can make a counted
  payment a double spend, and every version citing that payment fails with
  it.
- **Defining.** `collections.define` refuses a contract outside the subset,
  one that misreads its schema ([above](#checked-against-the-schema-when-defined)),
  a `contract` with any key but `check` and `line`, and a `line` with any key
  but `once`.
- **Long lines.** A line is checked by walking its counted chain for each
  version judged. A very long line costs time in proportion to its length
  squared, once, and then the verdicts are cached.
