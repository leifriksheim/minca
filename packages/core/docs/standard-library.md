# The standard library

The standard library is a set of ready-made collections for the things most
apps keep: messages, events, tasks, files, reactions. When your app keeps one
of those, use the standard one. Every other app that uses it reads your
records, and you read theirs.

```ts
import type { NodeRecord } from '@minca/core';
declare const post: NodeRecord;
// ---cut---
import { reaction, comment, useSchemas } from '@minca/std';

await useSchemas(node, space.id, [reaction, comment]);
await node.records.put(
  space.id,
  reaction,
  { emoji: '👍' },
  {
    links: [{ rel: 'about', to: post.key }],
  },
);
```

`useSchemas` defines the ones the space doesn't know yet and leaves the rest
alone, so you can call it every time a space opens.

The definitions are ordinary collections. The protocol knows none of them.
They are drawn from atproto lexicons, Nostr NIPs, JSContact (RFC 9553),
JSCalendar (RFC 8984) and schema.org; issue
[#36](https://github.com/leifriksheim/minca/issues/36) has the sources.

## What a `std.*` name means

A collection name belongs to the space that defines it. There is no
registry, so two spaces could give one name different shapes. What lets two
apps read each other's records is a shared definition, and the library is
where apps find one.

`std.*` names belong to the library by convention. Peers don't refuse a
`std.*` definition of another shape, but the node's agent actions keep to it:

- `collections_standard` lists the library, and gives any definition in
  full.
- `collections_propose` takes a standard collection by name (`"std.event"`)
  and stores the library's definition for it.
- `collections_propose` refuses a `std.*` name the library doesn't have, and
  a `std.*` definition whose `schema`, `links`, `rules`, `topics` or
  `history` differ from the library's. The `title` and `description` may be
  your own.

Name your app's own collections for what they hold (`carpool.ride`), not
with a generic prefix (`app.ride`) another app may want too. To open
collections by what they hold rather than by name, see
[compatible definitions](blueprints-and-guides.md#compatible-definitions).
See also [actions](actions.md) and
[spec 02 §6.4](https://github.com/leifriksheim/minca/blob/main/spec/02-records.md).

## How the library is shaped

People build several apps over the same records, often by asking an agent.
That only works if every app picks the same collection for the same thing.
Five rules keep the choice obvious.

1. **One collection per kind of thing.** Variants are optional fields. A
   photo, a video and a PDF are each a `std.file`, with `width`, `duration`
   or neither. Two collections an agent could pick for the same thing is a
   bug in the library.
2. **A group is a relation, not a field.** `std.tag` is a loose label, any
   number per record. `std.list` with a `std.list-item` per member is a
   named, ordered group that exists while empty: a folder, an album, a
   playlist, an itinerary (`kind`). So one file can be in a chat, a category
   and an album at once. A facet nearly every app filters by, like an
   event's `category`, may stay a field.
3. **What your app adds to a standard record is a record of its own.** Say
   your recipes app needs more on a `std.file`. Define `recipes.photo-note`
   with an `about` link to the file and `onePer: [link:about]`. Every app
   still reads the file. Never a parallel `recipes.photo`.
4. **Links share one vocabulary** (below). Where a record sits is always
   `in`: a channel, a board column or a list.
5. **A description says when not to use it.** Agents choose by reading
   descriptions, so a definition names the neighbour it could be mistaken
   for: "To vote on a std.proposal, use std.ballot."

## Conventions

- What several people edit is several records, not an array in one body. A
  list and its items, a document and its blocks, an order and its updates.
- "One per person" or "one per slot" is the `onePer` rule.
- A picture or a video in a `std.file` may carry a `thumbnail`: a small
  still, about 480 px on its longer side, that apps show in its place until
  someone opens it. It is small enough for every device to fetch ahead, so a
  long chat shows its pictures without fetching each file whole. A picture
  that is already small has none, and an app shows the picture itself. An
  app shows a thumbnail only for a `mime` of `image/` or `video/`, and only
  one of at most 256 KiB: it is the writer's word, like the rest of the body.
- Bodies have no `createdAt`, since the record has one. They carry only the
  times of the thing itself: `start`, `due`, `takenAt`.
- Link roles: `about` (what an annotation is on), `replyTo` and `root`
  (threads), `parent` (trees), `in` (member of a list, album, calendar,
  document or account), `shares` (quotes).
- What only one person should see is kept where only they read it: a block
  on the contact ([contacts](contacts.md)), and their own settings and
  reminders in the account registry, `node.account.space()`
  ([the node](node.md#records-and-the-account)).

See [spec 02 §4.3 and §7.3](https://github.com/leifriksheim/minca/blob/main/spec/02-records.md).

## Fragments

Shared shapes like a time or an amount of money are built by the library's
`fragments`, so they are identical in every definition. You can use them in
your own definitions too.

| Fragment   | Shape                                                                                                                                                       |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `when`     | string 10–64, `x-kind: "when"`: RFC 3339 (`2026-03-01T18:30:00+01:00`), or `YYYY-MM-DD` for a whole day                                                     |
| `day`      | string of 10, `x-kind: "day"`: `YYYY-MM-DD`                                                                                                                 |
| `url`      | string 1–2048, `x-kind: "url"`                                                                                                                              |
| `timeZone` | string 1–64: an IANA zone, `Europe/Oslo`                                                                                                                    |
| DID        | string 1–256, `x-kind: "did"`: an account (built by `person`)                                                                                               |
| `money`    | `{ amount, currency }`, `x-kind: "money"`, both required. `amount` is a decimal string 1–32 (`"12.50"`), never a number. `currency` is ISO 4217             |
| `address`  | `{ street, locality, region, postcode, country }`, each optional. `country` is ISO 3166-1 alpha-2                                                           |
| `place`    | `{ name, address, lat, lon, cells }` (built by `placeRef`), each optional. WGS 84. `cells` is up to 8 geohash cells ([Places and areas](#places-and-areas)) |
| `blob`     | `{ hash, size, mime, name?, key?, salt? }`, `x-kind: "file"`: what `records.addFile` gives                                                                  |
| `image`    | `{ blob, alt? }`, `x-kind: "image"`, `alt` ≤ 2000                                                                                                           |
| `position` | string 1–200, `x-kind: "position"` ([Positions](#positions))                                                                                                |

A `blob`'s `hash` is the file's id (64 hex characters), and its `key` and
`salt` open it (22 base64url characters each). See [storage](storage.md#files).

`when` and `day` are checked only for length until the schema dialect has
`format` (Planned, below).

## The definitions

How to read the tables:

- A **bold** field is required.
- `string 1–200` gives its shortest and longest length.
- `[]` is a list, with its most items in brackets.
- `a`/`b` is a choice of values.
- Links read `role` → what it may point at, and how many.
- Rules are `onePer`, `fixed` and `final`, and whether it has a contract.

Who may add, change and remove records isn't up to the definition, but to
the space's grants. In the `community` template, members change only what
they made, moderators change anything, and only moderators and admins write
in the collections in `STAFF_COLLECTIONS` ([spaces](permissions.md#presets)).

The tables are made from the definitions in `@minca/std` each time
[minca.dev](https://minca.dev/collections/standard-library/#the-definitions)
is built, so they always match the code.

<!-- catalogue: standard -->

## About some of them

### `std.call`

Calls themselves are kept nowhere ([calls](../../calls/README.md)). If the
space defines `std.call`, a call leaves a record of its history there.

| Field       | Type                    | Meaning                                      |
| ----------- | ----------------------- | -------------------------------------------- |
| `status`    | `"missed"` \| `"ended"` | Required.                                    |
| `to`        | string ≤ 256            | For a missed call: who was rung.             |
| `startedAt` | ISO date, ≤ 64          | Required.                                    |
| `endedAt`   | ISO date, ≤ 64          | For an ended call.                           |
| `people`    | string ≤ 256[] (≤ 64)   | For an ended call: every account seen in it. |

```json
{
  "status": "ended",
  "startedAt": "2026-09-26T10:00:00.000Z",
  "endedAt": "2026-09-26T10:14:02.311Z",
  "people": ["did:key:zDnaeSm3…", "did:key:zDnaeXL64…"]
}
```

The call a device is in is kept in `sessionStorage` under `minca-call` as
`{ space, call }`, so after a reload the page can offer to rejoin.

### Tasks

A task is `in` its column, or `in` its project when it has no column. A
column is `in` its project.

### Proven outcomes

Nobody declares a `std.decision` or a `std.goal-reached`. Each one cites the
records that prove it, by version id, and every device checks the proof
before it counts. Anyone in the space may write one, once, when the proof is
there.

- A `std.decision` cites the proposal's first version (`proposal`) and the
  ballots (`ballots`). It holds when the ballots about that proposal that
  chose `outcome` come from at least `quorum` different people. A proposal
  without a `quorum` can't be decided this way.
- A `std.goal-reached` cites the goal's first version (`goal`) and the
  pledges (`pledges`). It holds when the pledges add up to `target`,
  counting each person once.

```json
{ "outcome": 0, "proposal": "bay24o4l…", "ballots": ["bq7x…", "b3kd…", "bm2a…"] }
```

A ballot's `choice` and a pledge's `amount` are `fixed`, so what was counted
can't change. That's why `std.ballot` exists beside `std.vote`: a vote can be
changed, a ballot can't. See [contracts](contracts.md).

### `std.host`

A `std.host` names a host the space pays to keep it online. Anyone in the
space may chip in, and members' devices hand the host the space's pass. That
means naming a host sends it every member's pass, so the `community`
template leaves `std.host` to admins and moderators. See
[node](node.md#a-space-paying-for-itself) and
[spec 08 §2](https://github.com/leifriksheim/minca/blob/main/spec/08-hosting.md).

### Automations, bots, blueprints and guides

- `std.automation` and `std.automation-run`: what a space does by itself
  when records change or at set times, and what each run did. See
  [automations](automations.md).
- `std.bot`, `std.connect` and `std.connector`: how a community wants its
  bot to be, asking a bot's host to connect it to a service like GitHub, and
  what the bot is connected to. See [bots](bots.md).

`std.blueprint` holds collections someone proposes for the space, not yet
added. `std.guide` says how some of the space's collections are meant to be
used. See [blueprints and guides](blueprints-and-guides.md).

## Activity

`std.activity` shows that someone is at work on a record, for as long as it
lasts: "My bot is working on it…" under a message, or a spinner on a task.
Anyone may write one, but only about their own work.

| Name           | Body                                                                                                   | Links              | Rules                           |
| -------------- | ------------------------------------------------------------------------------------------------------ | ------------------ | ------------------------------- |
| `std.activity` | **`state`** `working`/`waiting`/`done`/`failed`; `label` string ≤ 120; **`at`** when, since this state | `about` → any, one | `onePer: [@author, link:about]` |

There's one per account per record, so writing again moves the same record
from `waiting` to `working` to `done` or `failed`. A label left out keeps
the one it had.

```ts
import type { NodeRecord } from '@minca/core';
declare const message: NodeRecord;
// ---cut---
import { setActivity, activeNow } from '@minca/std';

await setActivity(node, space.id, message.key, 'working', 'Reading the thread');
```

A `working` or `waiting` activity whose `at` is more than five minutes old
(`ACTIVITY_STALE_SECONDS`) must be shown as over, since its writer may have
gone away. `activeNow(body)` tells you whether one is still going.

An agent or bot says what it's doing with the `activity_set` action
([actions](actions.md)). A bot's automation runner marks what set each
automation off: `waiting` when queued, `working` with the automation's name
when it starts, then `done` or `failed`
([automations](automations.md#running)).

## Bots

A bot is an account of its own that people invite to their spaces as a
member. The protocol can't tell bots and people apart. A bot says it is one
with `bot: true` on its own `std.profile`, which only it can write, and apps
may show that. It's the account's own word, like its name, so leaving it out
proves nothing.

A bot that may add collections adds `std.profile` where a space has none.
Besides its own automations, it runs the space's automations that name it in
`by`, made by members granted `/std.automation/instruct`. In the `community`
template, admins and moderators hold that grant. Nothing the bot writes sets
an automation off. See [automations](automations.md#who-runs-an-automation).

What a bot writes shows as the bot, and every member's device checks it
against the bot's role. So a role that may post but not delete keeps a
misled bot from deleting.

## The space's profile

`std.space-profile` is how a space presents itself, the way `std.profile` is
how a person does. Apps show its `name` and `avatar` in place of the name
the space was founded with.

The founding name stays in the constitution, where nobody can change it. An
invite shows that name to someone who can't read the space yet, so the name
they see after joining may differ.

There's one per space. `space` holds the space's id, and `onePer: [space]`
gives everyone the same key, so changing it is editing one shared record.
Which edit stands follows the order of versions, never a writer's clock. A
reader takes only the record whose `space` is its own space's id.

Anyone who may write there could also start a rival record at that key, so
who may write it matters. It's in `STAFF_COLLECTIONS`: in a `community`,
admins and moderators can and members can't. In a `coop`, stewards can.

A space made before `std.space-profile` existed keeps the grants it was made
with. There, any member decides the name and picture, and outranks staff,
until an admin redefines the member role.

The example app reads no `std.space-profile` in a space for two. It names
the space for the other person.

## Text is Markdown

The `text` of a `std.message`, `std.comment` or `std.post` is Markdown:
CommonMark, with GitHub's tables and `~~strikethrough~~`. A plain sentence is
Markdown too, so an app that shows text as it is still shows it right.

````json
{ "text": "Shipped **today**:\n\n- the chat\n- `code` blocks\n\n```\nnpm run dev\n```" }
````

Draw it as elements, never as HTML, so a message can't put markup on the
screen. A screen gets this from the kit: `MentionText` draws it and
`MentionInput` writes it.

## Mentions and replies

A `std.message`, `std.comment` or `std.post` names the accounts it calls on
in `mentions`. When it replies to someone, it names their account in
`replyingTo`. `std.note`, `std.doc-block` and `std.article` have `mentions`
too.

```json
{ "text": "@Sam are you coming?", "mentions": ["did:key:zDnae…Sam"], "replyingTo": "did:key:zDnae…Sam" }
```

Fill them from what the person picked, like an `@name` they chose or the
message they replied to. Never fill them by matching text.

They are topics, as is a message's `in` link. So an automation of the
account's own can ask for only what mentions it, replies to it, or is in one
channel:

```json
{ "where": { "mentions": { "$contains": "$me" } } }
```

A `std.task`'s `assignees` is a topic the same way, so "assigned to me" is
`where: { "assignees": { "$contains": "$me" } }`.

A comment can be `about` any record. So commenting is how to mention someone
on a record whose definition has no `mentions`. Your own collections can
name a `mentions` field as a topic too. See
[automations](automations.md#the-accounts-own) and
[spec 02 §8](https://github.com/leifriksheim/minca/blob/main/spec/02-records.md).

## Responses

A record written in answer to someone's record names them in
`respondingTo`. It's the author of what it answers:

| Record                                      | `respondingTo`                      |
| ------------------------------------------- | ----------------------------------- |
| `std.reaction`, `std.comment`, `std.repost` | the author of what it is about      |
| `std.rsvp`                                  | the event's author                  |
| `std.vote`, `std.ballot`                    | the poll's or the proposal's author |
| `std.pledge`                                | the goal's author                   |
| `std.claim`                                 | the claimed record's author         |
| `std.order`, `std.order-update`             | the listing's or the order's author |

It's a topic, so "someone answered what I wrote" is
`where: { "respondingTo": { "$contains": "$me" } }`.
Fill it from the author of the linked record, and leave it out when that's
the writer.

A comment can carry all three: `respondingTo`, `replyingTo` and `mentions`.

Some annotations name nobody. A `std.report` doesn't, so whoever is
reported isn't told, and a keeper can't tell whom it's about. Highlights,
pins and tags are the writer's own. What tracks the writer's own life
(`std.progress`, `std.checkin`, `std.visit`, `std.meal`, `std.time-entry`,
`std.reminder`) answers nobody.

## People as topics

Where a record names the people it is about, they are its topics:

- `did` on `std.award`, `std.follow` and `std.list-item`
- `from` and `to` on `std.settlement`
- `to` and `people` on `std.call`
- `paidBy` and `owedBy` on `std.expense`

A topic can't reach into a list of objects, so `std.expense` repeats the
people in `split` as `owedBy`. It holds at most 63, so that with `paidBy`
each one is tagged: a record carries at most 64 tags. See
[spec 02 §8.1](https://github.com/leifriksheim/minca/blob/main/spec/02-records.md).

## Channels

A space with more than one conversation keeps `std.channel` records, sorted
by `position` then name. A message is `in` its channel.

```ts
import type { NodeRecord } from '@minca/core';
declare const channel: NodeRecord;
// ---cut---
import type { Query } from '@minca/core';

// A channel's messages
const messages: Query = { collection: 'std.message', where: { 'link:in': channel.key } };

// Each channel, with how many messages it holds
const channels: Query = {
  collection: 'std.channel',
  include: { messages: { rel: 'in', from: 'std.message', count: true } },
};
```

A message in no channel is in the space's own room, which a chat shows
first as "general". In the `community` template only moderators and admins
make or rename channels.

A channel is a label, not a boundary: every member reads every channel. For
something only some members may read, use a space of its own or a direct
message.

## Direct messages

A `std.direct` is sealed. Only the people in `to` and whoever wrote it can
read `data`. Write and read it through `node.direct`
([direct messages](direct-messages.md)).

A chat groups direct messages into conversations by everyone in them: `to`
plus the writer. One it can't open must show as unreadable, not disappear.
`to` is a topic, so "direct messages to me" can be an automation of the
account's own that a keeper matches unread.

## Positions

A `position` is a string that sorts where a record goes in a hand-made
order, by plain string comparison. Make one with `positionBetween`:

```ts
import type { NodeRecord } from '@minca/core';
declare const above: NodeRecord<{ position: string }> | undefined;
declare const below: NodeRecord<{ position: string }> | undefined;
// ---cut---
import { positionBetween } from '@minca/std';

positionBetween(above?.body?.position, below?.body?.position);
```

Either side may be missing, for the ends. Digits are `0–9a–z`, and a
position never ends in `0`, so there's always room between two. Equal
positions sort by key. A record without one goes at the end. Any string that
sorts correctly is valid.

## Places and areas

A place with a point also carries its `cells`: the geohash of `lat` and
`lon` at precisions 3, 4, 5 and 6, coarsest first. They're about 156 km,
39 km, 4.9 km and 1.2 km across. `cellsOf(lat, lon)` makes them.

For Grünerløkka in Oslo, `lat` 59.9226 and `lon` 10.7522 give
`["u4x", "u4xs", "u4xsu", "u4xsus"]`. Geohash here is Niemeyer's: longitude
and latitude bits interleaved, longitude first, five to a character of
`0123456789bcdefghjkmnpqrstuvwxyz`.

`std.event` and `std.listing` name `place.cells` as a topic, and `std.place`
names `cells`. So a keeper that can't read a private space can still hand
over "listings in these cells". Tags match only when equal, which is why
each size is written out instead of one long geohash.

### Finding what is nearby

`cellsAround(lat, lon, km)` gives the nine cells that cover a circle: the
point's own cell and the eight around it, at the finest precision whose
cells are at least `km` across. Match any of them, then let the exact
distance decide:

```json
{ "$or": [{ "place.cells": { "$contains": "u4xs" } }, { "place.cells": { "$contains": "u4xk" } }] }
```

`distanceKm` is haversine on a sphere of 6371.0088 km. `cellsAround` returns
null for a radius over about 150 km, or a circle around a pole. Then every
place is a candidate. A record written without cells is found only by its
point.

Nothing checks that `cells` agree with `lat` and `lon`. A peer only checks
that the tags match the cells. Apps that read the body use the point, so a
wrong cell only hides a record from area matches.

A listing usually means someone's home, so the example's marketplace keeps
only the part of town. It moves the point to the middle of its precision 6
cell and leaves out the street.

Finding places by name isn't part of the library. The example asks Photon,
which uses OpenStreetMap's data (set by `VITE_MINCA_PLACES`), and shows OpenStreetMap's credit beside the results.
See [spec 02 §8](https://github.com/leifriksheim/minca/blob/main/spec/02-records.md).

## Changing a definition

Before v1 the library changes without migrations. A space that holds an
earlier definition keeps it until someone applies a blueprint that carries
the new one.

A field that becomes a topic tags only what is written after the change.
Older records carry no tags, so "mentions me" or "assigned to me" match only
from then on.

Recent changes:

- `std.attachment`, `std.photo`, `std.video`, `std.folder` and `std.album`
  became one `std.file`. Groups of files are `std.list`s.
- `std.booking` is a `std.claim` about a `std.slot`. `std.bookmark` is a
  `std.list-item`. `std.reference` is gone: any link refers.
- `std.message`'s `channel` link and `std.task`'s `column` link are now `in`.
- `std.vote` is for polls only. A proposal is decided by `std.ballot`s.
- `mentions`, `replyingTo`, `respondingTo` and `owedBy` were added, and the
  people fields became topics
  ([#105](https://github.com/leifriksheim/minca/issues/105)).

## Planned

> **Planned:** references to other spaces. `std.follow`'s `space` is a plain
> space id, and a repost or list item can only point within its own space
> ([#38](https://github.com/leifriksheim/minca/issues/38),
> [spec 02 §5.3](https://github.com/leifriksheim/minca/blob/main/spec/02-records.md)).

> **Planned:** `format` in the schema dialect, to check `when`, `day` and
> `url` ([spec 02 §6.2](https://github.com/leifriksheim/minca/blob/main/spec/02-records.md)).
