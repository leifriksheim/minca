# Computed fields

"A todo is done once two people have reacted 👍." A collection's definition
can say this once, as a computed field, and every app that reads the
collection works it out the same way, from the records its node holds. No
one writes `done`, and no one signs a claim.

> Not protocol. Peers keep the definition's `computed` member and never read
> it, as they keep `contract`: a peer that has never heard of computed fields
> syncs, stores and judges every record the same way
> ([#247](https://github.com/leifriksheim/minca/issues/247)).

```ts
const reaction = collection({
  name: 'app.reaction',
  schema: z.object({ emoji: z.string() }),
  links: { on: { to: ['app.todo'], cardinality: 'one' } },
});

const todo = collection({
  name: 'app.todo',
  schema: z.object({ text: z.string() }),
  computed: ({ linked }) => {
    const thumbs = linked(reaction, 'on')
      .where((r) => r.body.emoji.eq('👍'))
      .map((r) => r.author)
      .distinct()
      .count();
    return { thumbs, done: thumbs.gte(2) };
  },
});

const { records } = await node.records.query(space, {
  collection: todo,
  where: { done: false },
  sort: { thumbs: 'desc' },
});
records[0]?.body.text; // what was written
records[0]?.computed.done; // what this node works out: boolean | null
```

## A view, not a verdict

Each node works computed fields out from what it holds. Two nodes holding
different records read different values until they have synced: Bob reads
`done` as soon as he has reacted, and Alice only once his reaction reaches
her. A withdrawn reaction, or a removed member's, turns `done` back. A node
holding only some collections counts only what it holds.

That is right for what an app shows: done flags, like counts, tallies,
leaderboards. It is wrong for what something else builds on or can't take
back: a payment, a proposal that moves money, a move the next move depends
on. Those need a verdict that is the same on every node and stays fixed,
which is what a [contract](contracts.md) gives: the writer cites the
evidence, and every reader judges exactly that.

The two are written the same way. Where a computed field searches with
`linked(reaction, 'on')`, a contract's condition reads what a claim cites with
`cited(body.reactions, reaction)`; the rest of the expression is the same.

## Writing them

`computed` is a function that gets the record's names and gives an object:
each field, and how it is worked out. It is built into CEL, the language
contracts use, when the collection is defined.

- **`linked(collection, rel)`**: the records of `collection` that link to
  this one with role `rel`, current and readable here, as versions: `key`,
  `author` (the account), `createdAt`, `body`, `links`. Pass the definition,
  and `rel` completes from its link roles that may point at this collection;
  a role it lacks, or one that points elsewhere, is a type error. Each
  record's `body` is typed from its schema.
- **What else it reads:** `body`, `links`, `key`, `seq`, `collection`,
  `author`, `creator`, `createdAt`, `updatedAt`, and `link(rel)`, `hash(x)`,
  `has(field)`, `when(test, then, otherwise)` and `raw(cel)`. Not `prev`,
  `versions` or `member`: those are a contract's.
- **Methods** are a contract's ([contracts.md](contracts.md#writing-one-in-typescript)):
  `where`, `map`, `distinct`, `count`, `sum`, `exists`, `all`, comparisons and
  arithmetic. A balance is `linked(payment, 'to').map((p) => p.body.amount).sum()`.
- **One field from another**: give one a name with `const`, and use it in the
  next, as `done` uses `thumbs`. Each lookup of what links here is done once
  per record, however many fields use it.

A field's type follows from its expression: a count is a `number`, a
comparison a `boolean`. Each is `null` for a record it can't be worked out
for, as when a body lacks a field it reads, or it runs past the limits
contracts have.

## As data

A definition stores each field's CEL, and an agent or another language
writes the same:

```json
"computed": {
  "thumbs": "linked(\"app.reaction\", \"on\").filter(r, r.body.emoji == \"👍\").map(r, r.author).distinct().size()",
  "done": "linked(\"app.reaction\", \"on\").filter(r, r.body.emoji == \"👍\").map(r, r.author).distinct().size() >= 2"
}
```

`collections.define` refuses, saying where:

- more than 16 fields, a name that isn't lower camel case, or an expression
  over 4,000 characters or 2,000 parts in all;
- anything outside the subset contracts have (spec 09 §5), and `prev`,
  `versions` and `member`;
- `linked()` with anything but a literal collection name and link role;
- a field named like a field of the body's schema;
- a field that misreads the schemas: a body field that isn't there, a string
  compared with a number, `linked()` of a collection that isn't defined in
  the space, doesn't declare that role, or whose role points at other
  collections. A `std.*` collection the space doesn't define is read untyped.

A contract can't call `linked()`: what it reads must be the same on every
node.

## Reading them

- **Every record a query gives** has `computed` beside `body`: its
  collection's fields, or `{}` without any. Included records have theirs too.
  `body` stays what its author signed, so writing `{ ...record.body, text }`
  back never writes a computed value.
- **`where` and `sort` name a computed field as they name a body field**:
  `{ done: false }`. A computed field may not share a name with a field of
  the body's schema, so a name means one thing, and a body member with a
  computed field's name (in a schema that lets bodies hold more) is never
  read in its place. With a typed collection, a name it has neither of is a
  type error. An include's `where` reads the computed fields of what it
  finds.
- **Whatever watches a filter on them watches what they read.** A record
  comes to match `{ done: true }` when it is written, or when a record its
  computed fields read is: Bob's 👍 makes the todo done without changing
  it. So an [automation](automations.md) sets off when that 👍 is written
  (after its `since`), an app's own notifications say so then, once, and a
  carrier wakes the app on a new 👍 as well as on a new todo. Every one of
  them filters query results, so they read what a query works out.
- Filtering or sorting on one works it out for every candidate; otherwise only
  for the page returned. A `linked()` lookup follows the link index, once per
  record, so keep fields to what a screen shows.
- Worked out by the definition as it is now, not as of each record.

An app that shows records from their definitions, as the example's data
view does, gets each computed field as JSON Schema from
`computedSchemas(definition, definitionOf)`: a count is an `integer`, a
comparison a `boolean`, each marked `readOnly`. Show them beside the
body's fields, marked as worked out here, and leave them out of forms.

Not yet: computed fields on `records.get` and `list`, and a `linked()` that
follows a record's own links out.

_Source: `packages/core/src/query/computed.ts` (`checkComputed`, `checkComputedTypes`, `computedSchemas`, `computeValues`, `readsComputed`), `packages/core/src/query/filter.ts` (`fieldValue`), `packages/core/src/records/contract-builder.ts` (`buildComputed`, `storedComputed`, `ComputedContext`), `packages/core/src/records/cel.ts` (`checkCel`, `evaluateCel`: `linked`), `packages/core/src/records/cel-types.ts` (`typeOfCel`), `packages/core/src/query/engine.ts` (`runQuery`), `packages/core/src/query/types.ts` (`FilterOf`, `ComputedIn`), `packages/core/src/node/space-runtime.ts` (`define`, `computed`). Tests: `packages/core/tests/computed.test.ts`, `packages/core/tests/typed-query.test.ts`._
