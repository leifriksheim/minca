# Collections

A collection is a named kind of record in a space. Its definition is stored in
the space as a signed record, so another app, or an agent, can open the space
and know what its data means without your code.

```typescript
import * as z from 'zod'; // or Valibot, ArkType, or plain JSON Schema
import { collection } from '@minca/core';

const Poll = z.object({
  question: z.string().min(1).max(500),
  options: z.array(z.string().min(1)).min(2).max(10),
});

export const polls = collection({
  name: 'app.poll',
  title: 'Poll',
  schema: Poll,
  rules: { fixed: ['options'] },
});

await node.collections.define(space.id, polls);
```

`collection(…)` only keeps the definition's types, so queries and writes that
name `polls` are typed from the schema. Pass it where a collection name goes.

## Names

Reverse-DNS, lower case, at least two parts: `app.poll`, `com.example.recipe`.
Letters, digits and `-` in each part. `sys.*` is the protocol's own and
`std.*` is the standard library.

Names are local to a space: nothing registers or owns one across spaces. Two
apps sharing a space settle a clash over a name before anything is defined,
when a person reads what each would define
([the blueprint review](blueprints-and-guides.md#the-review)).

## Schemas

What gets stored is JSON Schema, in a small subset every app agrees on:

`type`, `properties`, `required`, `items`, `enum`, `const`, `minimum`,
`maximum`, `minLength`, `maxLength`, `minItems`, `maxItems`,
`additionalProperties` (true or false), `title`, `description`

and three that say what a value means, so any app can show it well:

- `oneOf: [{ const, title }]`: fixed choices with labels.
- `x-choicesFrom: { rel, field }`: the value picks from a list in the record
  this one links to as `rel`, in its field `field`. A number is a position in
  that list; anything else is the option itself. A vote's `choice` picks from
  its poll's `options`. It is a display hint, never checked when validating.
- `x-kind: "<name>"`: what kind of value a field holds. The names apps read:

  | `x-kind`   | The value                                                                                                          | An app shows                                                          |
  | ---------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
  | `did`      | an account's DID, `did:key:z…` ([spec 01 §4](https://github.com/leifriksheim/minca/blob/main/spec/01-identity.md)) | who it is, and a list of people to pick from                          |
  | `when`     | a moment, RFC 3339, or a whole day, `YYYY-MM-DD`                                                                   | the time in the reader's words, a date and time picker with "all day" |
  | `day`      | a day, `YYYY-MM-DD`                                                                                                | the day in the reader's words, a date picker                          |
  | `url`      | a web address                                                                                                      | a link, opened only when it is `http` or `https`                      |
  | `money`    | `{ amount, currency }`, `amount` a decimal string                                                                  | `€12.50` in the reader's format; an amount and a currency             |
  | `file`     | a file, as `records.addFile` gives it                                                                              | its name and size, a picture when it is one; a file picker            |
  | `image`    | `{ blob, alt }`: a picture and what it shows                                                                       | the picture; a picker and its description                             |
  | `position` | a sort key (`positionBetween`)                                                                                     | nothing: it orders records, nobody reads it                           |

  Each is what the fragment of the same name writes (`person` writes `did`,
  `blob` writes `file`). An app shows a kind it doesn't know as the plain
  value. A definition
  already in a space keeps the labels it was written with: a space defined
  before these labels shows those fields plainly until the collection is
  redefined.

Any keyword starting `x-` is an annotation like these: any JSON, and it says
nothing about whether a body fits. A new one, or a new `x-kind`, is a row
here, never a change to the protocol. With Zod, add one with
`.meta({ 'x-kind': 'did' })`. Keep annotations to plain values: a validator
that can't build from a schema (an `$id` inside one is enough) checks
nothing against it, so the collection's shape goes unchecked.

Anything else, like `pattern` or `format`, is refused when you define the
collection, with the reason. A Zod `.regex()` or `.email()` fails for that
reason. Validators that can describe themselves as JSON Schema work directly:
Zod 4.2+, ArkType 2.1.28+, Valibot with `toStandardJsonSchema`. They are
converted with target `draft-2020-12` before storing, a `$schema` member is
dropped, and the result is checked like any other. For checks that stay
local, `createSchemaEngine().registerCollection({ name, schema })` takes any
[Standard Schema v1](https://standardschema.dev/) validator directly.

### Validating

A body is checked against a stored schema as draft 2020-12 JSON Schema, with
unknown keywords ignored, so a space written by a newer app that allows more
stays readable by an older one. Every failing leaf is reported, not only the
first, with a JSON Pointer to the value. The validator is
`@cfworker/json-schema`, which interprets rather than compiles, so it runs
under a strict CSP. A schema it can't build a validator from (it follows
`$id`s into any key it doesn't know, so a bad one in an annotation is enough)
checks nothing, like an invalid definition; reading never fails on it.

A record that doesn't fit the schema is still kept and synced, and comes back
with `conforms: false` and the issues. Shape is checked when you write, not
enforced on arrival, because two peers may have seen different versions of a
definition ([spec 02 §9.6](https://github.com/leifriksheim/minca/blob/main/spec/02-records.md)).
Rules, below, are enforced everywhere.

_Source: `packages/core/src/schema/collection-def.ts` (`validateJsonSchema`, `toJsonSchema`, `asStandardSchema`), `packages/core/src/node/space-runtime.ts` (`contentIssues`). Tests: `packages/core/tests/space-catalog.test.ts` ("validate and reject within the supported subset", "an unknown keyword is ignored when validating, so newer spaces stay readable", "choices can carry labels, or come from a linked record", "an x-\* keyword is an annotation: any one publishes, and no value is checked against it", "a record that does not fit is kept and flagged when it arrives, never rejected"), `packages/core/tests/attacks.test.ts` ("a definition the validator can't use can't break reading the collection, or the space"), `packages/core/tests/schemas.test.ts` ("schemas from a validator you already use")._

## Links

Records point at each other with links: `{ rel: 'about', to: <record key> }`.
A definition declares the roles its records may carry:

```typescript
links: {
  about: { to: ['app.poll'], cardinality: 'one' },   // only at polls, at most one
  mentions: { to: '*' },                              // at anything, many
},
```

A link role is lower camel case. Queries follow links with `include`, and
filter on them with `link:<rel>` ([records-and-queries.md](records-and-queries.md)).

**A record that points at another record says so with a link**, never with
the other record's key in a body field. Everything that follows relations
works on links and only on links: declarations and conformance, `onePer`,
contracts, `include` and counts, automations ([automations.md](automations.md)), and the "what
points here" a record's page shows. A key in a body field is a string to all
of them. Fields are for values and for people (DIDs); links are for records.
If a keeper must match on a link without reading, make it a topic:
`topics: ['link:channel']`.

Like a schema, link declarations are checked when you write: the node refuses
to sign links that don't conform. A record that arrives with links that
don't conform is kept and comes back with `conforms: false`.

_Source: `packages/core/src/records/links.ts` (`checkLinks`), `packages/core/src/node/space-runtime.ts` (`linkIssues`, `write`). Tests: `packages/core/tests/links.test.ts` ("refused on write when they break the declaration; flagged, never rejected, when they arrive")._

## Rules

A definition says what its records must keep to, not who may write them:
who may create, change and delete records is the space's grants, held by its
roles ([roles](#roles)). Its rules are about the records alone
([spec 02 §7](https://github.com/leifriksheim/minca/blob/main/spec/02-records.md)):

| Rule     | Means                                                  | Default |
| -------- | ------------------------------------------------------ | ------- |
| `onePer` | At most one record per combination of these            | none    |
| `fixed`  | Fields that keep the value the record was created with | none    |
| `final`  | `true`: written once, then never edited or deleted     | none    |

A definition with `create`, `edit`, `delete` or `check` in its rules is
invalid: every peer treats it as no definition at all, and the node refuses
to write it. What a version must be to count is not a rule but the
definition's `contract` ([below](#contracts)).

`onePer` names `@author` (the writer), `link:<rel>` (the record a link points
at) or a body field. It works by construction: the record's key is derived
from those values, so a second vote from the same person on the same poll is
the first vote's next version, not a new record.

```typescript
rules: {
  onePer: ['@author', 'link:about'];
} // one vote per person per poll
```

With `@author`, the key is the writer's own, so nobody else can write their
vote. Without it (one decision per proposal) the key is shared: anyone
allowed to write there may write first, and two who do so apart each start a
version of their own, the later edits of one outranking the other's. A grant
on `.byCreator` only keeps others from editing your version. If a collection
needs one writer per key, grant creating it to fewer roles, or name
`@author`. `node.records.onePerKey(space, collection, body, { links })` gives
the key a body would have, to read a record without searching for it.

_Source: `packages/core/src/records/rules.ts` (`checkRules`, `onePerKey`). Tests: `packages/core/tests/rules.test.ts`, `packages/core/tests/record-keys.test.ts` ("onePer keys")._

## Contracts

What only needs to look the same in every app, like a todo that is done
once two people react 👍, is a [computed field](computed.md): every node
derives it from what it holds, with nothing to cite. A contract is for what
must be fixed and the same on every node.

Grants say who may write, and the rules above what a record must keep to;
every peer enforces both. A contract, the definition's `contract`, says
what a version must be to count: conditions over the body, the version before
it, and other versions it **cites** as evidence. With them a space can hold things
that normally need a server or a smart contract: a proposal that passes only
with enough votes, a game whose moves must be legal, points that can't be
spent twice, a reward that unlocks when its condition is met.

```typescript
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
const votes = await node.records.linked(space.id, proposal.key, { collection: 'app.proposal.vote' });
await node.records.put(
  space.id,
  passed,
  { votes: votes.map((v) => v.version) },
  { links: [{ rel: 'about', to: proposal.key }] },
);
```

A contract never searches, because no device holds everything. The writer does
the work (finds the votes, adds up the balances, picks the move) and cites
what proves it. Every reader then checks that exactly what was cited proves
it.

Contracts are judged by readers, not enforced by peers
([spec 09](../../../spec/09-contracts.md), [contracts.md](contracts.md)). A version that fails them is kept and synced
everywhere like any other, but `get`, `list` and queries count only a
record's newest version that passes: one that fails is skipped, and the
version before shows instead. Your own node refuses to sign a version that
fails, with the condition's `else` as the reason. `node.records.contracts(space, key)`
says how a record's newest version fares, and why. A version citing one that
hasn't arrived yet is pending, and doesn't count until it does.

A condition is a [CEL](https://cel.dev) expression: the Common Expression
Language that Kubernetes, Firebase and Envoy use for policies. It reads `body`,
`links`, `key`, `seq`, `collection`, `author` (the account), `creator`,
`createdAt` and `prev` (the version before, or `null`). It has CEL's
operators, `has()`, the macros `all` `exists` `exists_one` `filter` `map`,
`size`, `contains` `startsWith` `endsWith`, the conversions `int` `uint`
`double` `string` `bool`, and from CEL's extensions `distinct()`,
`math.greatest` and `math.least`. Minca adds `sum(list)`, `hash(x)`,
`link("rel")` and `v.link("rel")`, and two that ask the space:
`versions(ids)` (read cited versions by id) and `member(did)`.

Some things to know:

- A body's numbers are doubles, as JSON's are, and a literal like `1` is an
  int. They compare with each other freely, but don't mix in arithmetic:
  write `body.n + 1.0`, or `int(body.n) + 1`.
- Reading a field that isn't there is an error, not `null`: ask
  `has(body.note)` first. `&&` and `||` let an error pass when the other side
  decides.
- A condition holds only when it gives `true`, and it always ends: its
  only loops are over lists in hand, and there is a step limit.

`contractCostHints(check)` flags what makes a condition costly as records grow:
macros nested three deep, or `versions()` called inside a macro. A condition
over more than its limits is refused, so one that passes on small
records can fail on large ones; the hints say where to look.

`check` written as a function, as above, builds that CEL from TypeScript,
typed from the collection's own schema and, through `cited(ids, collection)`,
from the schemas of what it cites: a misspelled field is a compile error
([contracts.md](contracts.md#writing-one-in-typescript)). A list of
`{ that, else }` with the CEL written by hand is stored the same way. Either
way, `collections.define` refuses a condition that misreads the schema.

Bytes, timestamps, durations, regular expressions and types as values are
left out. The exact subset, and its limits, are in [spec 09](../../../spec/09-contracts.md).

**Lines.** A collection whose contract has `line: { once: [...] }` is one line per
account, at `lineKey(account, collection)`: each version names the account's
previous one, so a payment can carry a running balance its contract checks.
Two versions after the same one are a double spend, and neither counts, nor
anything after either; there is no way back, so keep a line on one device at
a time. Each citation in a `once` field may appear only once along the line
([spec 09 §7](../../../spec/09-contracts.md#7-lines)).

**What can be cited.** Only versions kept whole, so every device reads the
same thing however late it joins: any version in a collection with
`history: 'all'` or with a contract of its own (the node keeps those whole), and
a first version under `onePer` or `fixed`. A cited version must also pass its
own contract. Give a collection you mean to cite `history: 'all'`,
or an edited vote's latest version can't be cited. A cited version proves
what was signed, not that it is still current, so make evidence final where
it matters: `final: true` on a vote, so nobody can change or delete it once
it is counted, or `fixed: ['choice']` to allow other edits.

**A proof stays a proof.** A cited version is judged as of what the citing
version saw: removing a voter later, or revoking the device that voted,
doesn't undo a decision that already counted the vote. A decision written
after seeing the removal can't count it. Peers keep such withdrawn versions,
and the library reads them for this, without showing them.

The standard library has two ready-made: `std.decision`, a proposal decided
by a quorum of ballots, and `std.goal-reached`, a goal reached by pledges
([standard-library.md](standard-library.md)).

**Patterns.**

- **Quorums and multisig.** "Three members approved": cite the approvals, and
  check `distinct()` authors with `member(v.author)`. Who may approve at all
  is the grant on the approvals' collection.
- **State machines.** Check each version against `prev`: a task moves from
  `open` to `done` only, a counter goes up by one, a chess move is legal from
  the board before. Each step is small, and there is no limit on steps.
- **Ledgers.** A transfer cites the balance records it spends, and checks
  that they are the sender's and add up. Two spends of one balance are two
  versions of it, which everyone sees.
- **Commit, then reveal.** A player first writes `hash` of a secret, then
  reveals it: `hash(body.secret) == "<the commitment>"`.
  Shared dice, lotteries and sealed bids need nothing else.
- **Closing a set.** A contract can prove that something exists, not that nothing
  else does. For "a majority" or "nobody objected", someone granted it
  signs a record that closes the vote and lists what counts, and the result
  cites that.
- **Time.** There is no clock. "Before Friday" is a record from someone
  trusted to say it (a host, a witness) that the result cites.

## Roles

Who may write lives in the space, not in your code, and not in a
definition. A role holds grants: a command and a UCAN policy over its
arguments ([spec 03 §2](https://github.com/leifriksheim/minca/blob/main/spec/03-spaces.md)).
"Members change only their own polls, hosts delete any" is:

```typescript
import { RECORD_DELETE, RECORD_WRITE } from '@minca/core';

await node.spaces.defineRole(space.id, {
  name: 'host',
  title: 'Host',
  grants: [{ cmd: RECORD_DELETE, pol: [['==', '.collection', 'app.poll']] }],
  nests: ['member'], // a host holds what a member holds too
});
await node.spaces.assign(space.id, did, 'host');
```

- `/record/write` and `/record/delete` see `collection` and `byCreator`
  (whether the writer's account made the record's first version; true for a
  new one); a write also sees `body`. So `['==', '.byCreator', true]` is
  "only your own".
- `/collection/define` adds or changes collections; it also needs a note that
  grants `/collection/define`, which an agent's doesn't (spec 01 §8).
- A definition holds only what its writer could do: you can't grant what you
  don't hold. Roles defining roles, assigning, removing and the rest are in
  the spec.
- The space's founders, if it has any, hold every command.

`node.spaces.may(space.id, cmd, args)` says whether this account may do
something now; `node.records.can(space, action, target)` asks it for a
record.

## Other options

- `history: 'all'` keeps every version of every record whole, hash-linked
  (`node.records.history`). The default, `latest`, keeps the current one
  whole and forgets what earlier ones said, and what a deleted record said.
  With `onePer` or `fixed` in the rules, a record's first version is kept
  whole too: those rules are checked against it. With a `contract`, the node
  keeps every version whole, so its contract can read the one before and cite it.
- `topics: ['mentions', 'link:channel']` lets a node that can't read the
  space still match records by a field's value, or by where a link of that
  role points, for the account's wakes ([automations](automations.md#the-accounts-own)).
  At most 8.
- `version`: see [below](#versions-of-a-definition).

## Versions of a definition

Defining a collection again writes the next version of its definition, one
higher unless you give a `version`. The node refuses a `version` that is not
higher than the one in force, or not below 2^53; peers don't check it. One in
force at 2^53 or more, which nothing could follow, is followed by 1. Records don't name the
version they were written under: each is judged by the definition in force
as of the access changes it saw
([spec 03 §5](https://github.com/leifriksheim/minca/blob/main/spec/03-spaces.md)).
A change to the rules is not retroactive: it binds what saw it. A record that
names an older point counts if its writer could have written it then, since
nobody can tell it from one written offline. To stop someone at once, take
their role or remove them: what they wrote that you had not seen stops
counting. A
write that races a change to its collection's rules is retried once, under
the new ones.

`node.collections.delete` removes a definition only once its collection has
no records left, since records left behind would lose their shape and their
rules.

Whoever first defined a collection may change it, while a member, as well as
anyone granted `/collection/define` for it. If two accounts each defined it
first without seeing the other's, `definedBy` is `null` and only those
granted `/collection/define` may change it. Until one does, the
collection has a definition only if the rivals say the same thing; if they
differ, `collections.list` leaves it out and its records are judged by no
rules
([spec 02 §6.3](https://github.com/leifriksheim/minca/blob/main/spec/02-records.md)).

_Source: `packages/core/src/node/space-runtime.ts` (`define`, `undefine`, `write`), `packages/core/src/node/types.ts` (`NodeCollections`). Tests: `packages/core/tests/space-catalog.test.ts`, `packages/core/tests/rules.test.ts` ("grants: changing them")._

## The standard library

```typescript
import { reaction, comment, poll, vote, useSchemas } from '@minca/core/schemas';

await useSchemas(node, space.id, [poll, vote, reaction, comment]); // defines only what the space is missing
```

About eighty definitions, by area (`standardGroups`): annotations that attach
to any record (`reaction`, `comment`, `rating`, `bookmark`, `claim`…), people
(`profile`, `follow`…), messaging and publishing (`message`, `post`,
`article`, `doc` and `docBlock`, `note`…), lists (`list`, `listItem`), files
and media, time and planning (`event`, `rsvp`, `task`, `booking`…), places,
home and life (`recipe`, `meal`…), money (`expense`, `settlement`…) and
community (`poll`, `vote`, `proposal`, `decision`, `goal`…). The full list is in
[standard-library.md](standard-library.md).

They are ordinary collections. Using the same one is how two apps agree: a
poll asked in one can be voted on in another. For shapes of your own, the
`fragments` export builds times, money, places and files the same way the
library does, and `fragments.define(definition)` gives records a type worked
out from the schema, as every library definition's is (`Task` is
`BodyOf<typeof task>`).

Hand-made order (cards on a board) uses a `position` string.
`positionBetween(before, after)` makes one that sorts between two others, so
moving a card rewrites only that card.
