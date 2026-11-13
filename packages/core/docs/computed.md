# Computed fields

A computed field is a value every app works out from the records it holds,
instead of one somebody writes. Use one for counts, tallies and flags that
follow from other records, like "a to-do is done once two people have
reacted 👍".

Computed fields are a library convention. Peers store a definition's
`computed` member and never read it
([#247](https://github.com/leifriksheim/minca/issues/247)).

## An example

Say it once, in the collection's definition, then query on it like any
field:

```ts
import * as z from 'zod';
import { collection } from '@minca/core';

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

const { records } = await node.records.query(space.id, {
  collection: todo,
  where: { done: false },
  sort: { thumbs: 'desc' },
});
records[0]?.body.text; // what was written
records[0]?.computed.done; // what this node works out: boolean | null
```

No one writes `done`, and no one signs a claim about it.

## A view, not a verdict

Each node works computed fields out from what it holds. Two nodes holding
different records see different values until they have synced. Bob sees
`done` as soon as he reacts. Alice sees it once his reaction reaches her.

Withdraw a reaction and `done` turns back. The same happens when a member is
removed and the removal keeps nothing of theirs. A node that holds only some
collections counts only what it holds.

That is right for what an app shows: done flags, like counts, tallies,
leaderboards. It is wrong for anything that can't be taken back, like a
payment, or a move the next move depends on. Those need a verdict that is the
same on every node and stays fixed. That is what a [contract](contracts.md)
gives: the writer cites the evidence, and every reader judges exactly that.

The two are written the same way. Where a computed field searches with
`linked(reaction, 'on')`, a contract reads what a claim cites with
`cited(body.reactions, reaction)`. The rest of the expression is the same.

## Writing them

`computed` is a function that gets the record's names and returns an object
of fields. It is turned into CEL, the language contracts use, when you define
the collection.

What it can read and call is on
[`ComputedContext`](https://minca.dev/api/core/interfaces/ComputedContext/).
The one a contract lacks is `linked(collection, rel)`, the records that link
to this one. Pass the definition, and a role it lacks, or one that points
elsewhere, is a type error.

- **Methods** are a contract's
  ([Contracts](contracts.md#writing-one-in-typescript)): `where`, `map`,
  `distinct`, `count`, `sum`, `exists`, `all`, comparisons and arithmetic. A
  balance is `linked(payment, 'to').map((p) => p.body.amount).sum()`.
- **One field can use another.** Name it with `const` and use it in the next,
  as `done` uses `thumbs`. Each `linked()` lookup runs once per record,
  however many fields use it.

A field's type follows from its expression: a count is a `number`, a
comparison a `boolean`. A field is `null` for a record it can't be worked out
for, such as when the body lacks a field it reads, or it runs past the limits
contracts have.

## As data

A definition stores each field as CEL, so an agent or another language can
write the same thing:

```json
"computed": {
  "thumbs": "linked(\"app.reaction\", \"on\").filter(r, r.body.emoji == \"👍\").map(r, r.author).distinct().size()",
  "done": "linked(\"app.reaction\", \"on\").filter(r, r.body.emoji == \"👍\").map(r, r.author).distinct().size() >= 2"
}
```

## What `define` refuses

`collections.define` refuses these, saying where:

- more than 16 fields;
- a name that isn't lower camel case;
- an expression over 4,000 characters, or over 2,000 parts in all;
- anything outside the CEL subset contracts have
  ([spec 09 §5](https://github.com/leifriksheim/minca/blob/main/spec/09-contracts.md)),
  or `prev`, `versions` or `member`;
- `linked()` with anything but a literal collection name and link role;
- a field named like a field of the body's schema;
- a field that misreads the schemas: a body field that isn't there, a string
  compared with a number, or `linked()` of a collection the space doesn't
  define, that doesn't declare that role, or whose role points at other
  collections.

A `std.*` collection the space doesn't define is read untyped. A contract
can't call `linked()`, since what a contract reads must be the same on every
node.

A definition may come from another implementation, or be written by hand.
When its `computed` is malformed, too large, or names a field the body's
schema declares, readers treat it as having no computed fields.

## Reading them

Every record a query gives has `computed` beside `body`, with its
collection's fields, or `{}` without any. Included records have theirs too.
`body` stays what its author signed, so writing `{ ...record.body, text }`
back never writes a computed value.

`where` and `sort` name a computed field the way they name a body field:
`{ done: false }`. An include's `where` reads the computed fields of what it
finds. With a typed collection, a name that is neither a body field nor a
computed field is a type error.

A computed field always wins over a body member of the same name. A schema
that lets bodies hold extra members can't make a query read one in its place.
Whoever defines the collection decides both anyway.

Fields are worked out by the definition as it is now, not as it was when each
record was written.

## Watching them

A record can come to match `{ done: true }` without changing. Bob's 👍 makes
the to-do done, so anything that watches a filter on a computed field also
watches what it reads:

- an [automation](automations.md) sets off when the 👍 is written (after its
  `since`);
- an app's own notifications say so then, once.

## Cost

Filtering or sorting on a computed field works it out for every candidate.
Otherwise it is worked out only for the page returned. A `linked()` lookup
follows the link index once per record, so keep fields to what a screen
shows.

## Showing them in a form

An app that draws records from their definitions, as the example's data view
does, gets each computed field as JSON Schema from
`computedSchemas(definition, definitionOf)`. A count is an `integer`, a
comparison a `boolean`, and each is marked `readOnly`. Show them beside the
body's fields, marked as worked out here, and leave them out of forms.

## Not yet

- Computed fields on `records.get` and `records.list`.
- A `linked()` that follows a record's own links out.
