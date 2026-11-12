# Collections

A collection is a named kind of record in a space, like a table in a
database. You define one when your app keeps something of its own. For things
many apps share, like events, comments and polls, look in the
[standard library](#the-standard-library) first.

## Defining a collection

A collection has a name, a title and a schema for its records' bodies:

```typescript
import * as z from 'zod';
import { collection } from '@minca/core';

export const polls = collection({
  name: 'app.poll',
  title: 'Poll',
  schema: z.object({
    question: z.string().min(1).max(500),
    options: z.array(z.string().min(1)).min(2).max(10),
  }),
});

await node.collections.define(space.id, polls);
```

`define` stores the definition in the space as a signed record. Any app or
agent that opens the space can read it and know what a poll is, without your
code.

`collection(…)` itself only attaches types. Pass `polls` wherever a
collection name goes, and writes and queries are typed from its schema.

## Names

A name is reverse-DNS, lower case, with at least two parts: `app.poll`,
`com.example.recipe`. Each part holds letters, digits and `-`. Names starting
`sys.` belong to the protocol, and `std.` to the standard library.

A name means something only inside its space. Nobody registers or owns one
across spaces. When two apps share a space, a person settles any clash
before anything is defined, as they read what each app would add
([the blueprint review](blueprints-and-guides.md#the-review)).

## Schemas

Write the schema with the validator you already use. Zod 4.2+, ArkType
2.1.28+ and Valibot with `toStandardJsonSchema` all work, and so does plain
JSON Schema.

What gets stored is JSON Schema, in a small subset every app understands:

`type`, `properties`, `required`, `items`, `enum`, `const`, `minimum`,
`maximum`, `minLength`, `maxLength`, `minItems`, `maxItems`,
`additionalProperties` (true or false), `title`, `description`

Anything else, like `pattern` or `format`, is refused when you define the
collection, with the reason. So a Zod `.regex()` or `.email()` won't define.

A validator's schema is converted with target `draft-2020-12`, its `$schema`
member is dropped, and the result is checked like any other. For checks that
stay on your own device, `createSchemaEngine().registerCollection({ name, schema })`
takes any [Standard Schema v1](https://standardschema.dev/) validator as it
is.

### Choices

Two keywords say what a field may be chosen from, so any app can show a
picker:

- `oneOf: [{ const, title }]` is a fixed set of choices, each with a label.
- `x-choicesFrom: { rel, field }` picks from a list in another record: the
  one this record links to as `rel`, in its field `field`. A number is a
  position in that list. Anything else is the option itself. A vote's
  `choice` picks from its poll's `options` this way.

`x-choicesFrom` is only a display hint. It is never checked when validating.

### Kinds of value

`x-kind` says what kind of value a field holds, so any app can show it well:

| `x-kind`   | The value                                                  | An app shows                              |
| ---------- | ---------------------------------------------------------- | ----------------------------------------- |
| `did`      | an account's DID, `did:key:z…`                             | who it is; a list of people to pick from  |
| `when`     | a moment (RFC 3339) or a whole day (`YYYY-MM-DD`)          | the time in the reader's words; a picker  |
| `day`      | a day, `YYYY-MM-DD`                                        | the day in the reader's words; a picker   |
| `url`      | a web address                                              | a link, opened only for `http` or `https` |
| `money`    | `{ amount, currency }`, `amount` a decimal string          | `€12.50` in the reader's format           |
| `file`     | a file, as `records.addFile` gives it                      | its name and size, or the picture         |
| `image`    | `{ blob, alt }`: a picture and what it shows               | the picture; a picker and a description   |
| `position` | a sort key from [`positionBetween`](#the-standard-library) | nothing: it only orders records           |

The standard library's fragments write these for you: `person` writes `did`,
`blob` writes `file`, and so on. With Zod, add one yourself with
`.meta({ 'x-kind': 'did' })`.

An app shows a kind it doesn't know as the plain value. A definition keeps
the kinds it was written with, so a collection defined before a kind existed
shows that field plainly until it is defined again.

### Your own annotations

Any keyword starting `x-` is an annotation. It can hold any JSON, and it never
affects whether a body fits. A new annotation, or a new `x-kind`, is a
convention between apps, not a change to the protocol.

Keep annotations to plain values. If the validator can't build from a schema,
it checks nothing against it. An `$id` inside an annotation is enough to
cause that.

### Validating

A body is checked against the stored schema as draft 2020-12 JSON Schema.
Keywords it doesn't know are ignored, so a space written by a newer app stays
readable by an older one. Every failing value is reported, not only the
first, each with a JSON Pointer to it.

The validator interprets the schema rather than compiling it, so it runs
under a strict Content Security Policy. A schema it can't build a validator
from checks nothing, as if there were no definition. Reading never fails
because of one.

Shape is checked when you write. It is not enforced when a record arrives,
because two peers may have seen different versions of a definition. A record
that doesn't fit is still kept and synced, and comes back with
`conforms: false` and its issues. [Rules](#rules) are different: every peer
enforces them.

## Links

Records point at each other with links: `{ rel: 'about', to: <record key> }`.
A definition says which link roles its records may carry, and where each may
point:

```typescript
import type { DefineCollection } from '@minca/core';

const links: DefineCollection['links'] = {
  about: { to: ['app.poll'], cardinality: 'one' }, // only at polls, at most one
  mentions: { to: '*' }, // at anything, many
};
```

A role's name is lower camel case. Queries follow links with `include`, and
filter on them with `link:<rel>` ([records and queries](records-and-queries.md)).

When a record points at another record, use a link. Don't put the other
record's key in a body field. Everything that follows relations reads links
and only links: rules, contracts, `include` and counts,
[automations](automations.md), and the "what points here" on a record's
page. To all of them, a key in a body field is just a string. Use fields for
values and for people (DIDs), and links for records.

Links are checked like a schema. Your node refuses to sign links that don't
fit the declaration. A record that arrives with links that don't fit is kept,
and comes back with `conforms: false`.

## Rules

Rules say what a collection's records must keep to. Every peer enforces them.

| Rule     | Means                                                  |
| -------- | ------------------------------------------------------ |
| `onePer` | at most one record per combination of these values     |
| `fixed`  | fields that keep the value the record was created with |
| `final`  | `true`: written once, then never edited or deleted     |

None is set by default. To keep a poll's options from changing after people
vote:

```typescript
import type { CollectionRules } from '@minca/core';

const rules: CollectionRules = { fixed: ['options'] };
```

Rules don't say who may write. That belongs to the space's [roles](permissions.md).
A definition with `create`, `edit`, `delete` or `check` in its rules is
invalid: every peer treats it as no definition at all, and your node refuses
to write it.

### One per

`onePer` names `@author` (the writer), `link:<rel>` (the record a link
points at) or a body field. One vote per person per poll is:

```typescript
import type { CollectionRules } from '@minca/core';

const rules: CollectionRules = { onePer: ['@author', 'link:about'] };
```

It works by giving the record a key made from those values. A second vote
from the same person on the same poll lands on the same key, so it becomes
the first vote's next version.

With `@author`, the key is the writer's own, so nobody else can write their
vote. Without it, as in one decision per proposal, the key is shared. Anyone
allowed to write may write first, and two people who do so apart each start a
version of their own, with the later edits of one outranking the other's. A
grant on `.byCreator` only keeps others from editing your version. If a
collection needs one writer per key, name `@author`, or let fewer roles
create it.

`node.records.onePerKey(space, collection, body, { links })` gives the key a
body would have, so you can read the record without searching for it.

## Roles

Who may write lives in the space, not in a definition: in its roles. See
[Permissions](permissions.md).

## Contracts

A contract says what a version must be to count. It can check the body, the
version before it, and other versions it cites as evidence. With one, a space
can hold things that usually need a server: a proposal that passes only with
enough votes, points that can't be spent twice.

```typescript
import * as z from 'zod';
import { collection, type NodeRecord } from '@minca/core';

const vote = collection({
  name: 'app.proposal.vote',
  schema: z.object({ choice: z.enum(['yes', 'no']) }),
  links: { about: { to: ['app.proposal'], cardinality: 'one' } },
  rules: { onePer: ['@author', 'link:about'], final: true },
});

export const passed = collection({
  name: 'app.proposal.passed',
  schema: z.object({ votes: z.array(z.string()) }),
  links: { about: { to: ['app.proposal'], cardinality: 'one' } },
  rules: { onePer: ['link:about'] }, // one "passed" per proposal
  contract: {
    // Each key is why a version failing its condition doesn't count
    check: ({ body, cited, link }) => ({
      'A proposal passes with yes votes from at least three members': cited(body.votes, vote)
        .where((v) => v.link('about').eq(link('about')).and(v.body.choice.eq('yes')))
        .map((v) => v.author)
        .distinct()
        .count()
        .gte(3),
    }),
  },
});

// The app finds the votes and cites them by version id
async function pass(proposal: NodeRecord) {
  const votes = await node.records.linked(space.id, proposal.key, { collection: vote.name });
  await node.records.put(
    space.id,
    passed,
    { votes: votes.map((v) => v.version) },
    { links: [{ rel: 'about', to: proposal.key }] },
  );
}
```

The writer does the work of finding the votes, and cites them. Every reader
checks that what was cited proves the claim. A version that fails is kept and
synced, but reads skip it and show the version before.

When a value only needs to look the same in every app, like a to-do that is
done once two people react, a [computed field](computed.md) is simpler. How
to write contracts, and what they can check, is in [Contracts](contracts.md).

## Other options

A definition also takes `history`, `topics` and `version`. Each option is
described on [`DefineCollection`](https://minca.dev/api/core/interfaces/DefineCollection/).

Under `history: 'latest'`, some earlier versions are still kept whole. A
record's first version is, when the rules have `onePer` or `fixed`, since
those rules are checked against it. With a `contract`, every version is, so
the contract can read and cite them.

How `version` is numbered is [below](#versions-of-a-definition).

## Versions of a definition

Defining a collection again writes the next version of its definition, one
higher unless you give a `version`. Your node refuses a `version` that isn't
higher than the one in force, or isn't below 2^53. Peers don't check it. A
definition in force at 2^53 or more, which nothing could follow, is followed
by 1.

Records don't name the version they were written under. Each is judged by
the definition in force as of the access changes its writer had seen. So a
change to the rules binds only what was written after seeing it. A record
written against an older definition counts if its writer could have written
it then, since nobody can tell it from one written offline. To stop someone
at once, take their role or remove them: what they wrote that you hadn't
seen stops counting.

A write that races a change to its collection's rules is retried once, under
the new rules.

`node.collections.delete` removes a definition only once the collection has
no records left, since records left behind would lose their shape and rules.

Whoever first defined a collection may change it while they are a member, as
may anyone granted `/collection/define` for it. If two accounts each defined
it first without seeing the other, `definedBy` is `null` and only those
granted `/collection/define` may change it. Until one does, the collection
has a definition only if both say the same thing. If they differ,
`collections.list` leaves it out and its records are judged by no rules.

## The standard library

The standard library is about eighty ready-made collections. Using the same
one is how two apps agree: a poll asked in one app can be voted on in
another.

```typescript
import { reaction, comment, poll, vote, useSchemas } from '@minca/std';

await useSchemas(node, space.id, [poll, vote, reaction, comment]); // defines only what the space is missing
```

They are ordinary collections, grouped by area in `standardGroups`:

- annotations on any record: `reaction`, `comment`, `rating`, `bookmark`,
  `claim`…
- people: `profile`, `follow`…
- messaging and publishing: `message`, `post`, `article`, `doc` and
  `docBlock`, `note`…
- lists: `list`, `listItem`
- files and media
- time and planning: `event`, `rsvp`, `task`, `booking`…
- places
- home and life: `recipe`, `meal`…
- money: `expense`, `settlement`…
- community: `poll`, `vote`, `proposal`, `decision`, `goal`…

The full list is in [the standard library](standard-library.md).

For shapes of your own, the `fragments` export builds times, money, places
and files the way the library does. `fragments.define(definition)` gives
records a type worked out from the schema, as every library definition has:
`Task` is `BodyOf<typeof task>`.

For order people set by hand, like cards on a board, use a `position` string.
`positionBetween(before, after)` makes one that sorts between two others, so
moving a card rewrites only that card.
