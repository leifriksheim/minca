# The standard library

> Not protocol. This page describes the reference library, and another
> implementation may do it differently and still interoperate. What peers must
> agree on is in the [spec](https://github.com/leifriksheim/minca/blob/main/spec/README.md).

An optional library of ordinary definitions (`@minca/core/schemas`),
broad enough that most apps need no definitions of their own. The protocol
knows none of them; a space learns one when someone defines it there. All are
`version` 1 when first defined. They are drawn from atproto lexicons, Nostr
NIPs, JSContact (RFC 9553), JSCalendar (RFC 8984) and schema.org; issue
[#36](https://github.com/leifriksheim/minca/issues/36) has the sources.

## What a `std.*` name means

A collection name belongs to the space that defines it. There is no registry,
and two spaces may give one name different shapes. What lets two apps read
each other's records is the definition, not the name, and the library exists
so that apps reach for the same definitions.

`std.*` names are the library's by convention ([spec 02 §6.4](https://github.com/leifriksheim/minca/blob/main/spec/02-records.md)); peers do not refuse a
`std.*` definition of another shape. The reference node's agent actions keep
to the convention:

- `collections_standard` lists the library, and gives any of its definitions
  in full ([actions](actions.md)).
- `collections_propose` takes a standard collection by name (`"std.event"`
  in `collections`) and stores the library's definition for it.
- `collections_propose` refuses a `std.*` name the library does not have, and
  a `std.*` definition whose `schema`, `links`, `rules`, `topics` or
  `history` differ from the library's. Its `title` and
  `description` may be its own.

Names of an app's own collections should say what they are for
(`carpool.ride`) rather than share a generic prefix (`app.ride`) that another
app may want for something else. Making apps open collections by what they
hold rather than by name is [compatible definitions](blueprints-and-guides.md#compatible-definitions).

_Source: `packages/core/src/schemas/blueprints.ts` (`standardCollections`), `packages/core/src/schemas/standard.ts` (`standardDefinition`, `standardGroups`), `packages/core/src/node/actions.ts` (`collections_standard`, `collections_propose`). Tests: `packages/core/tests/records-only.test.ts` ("a standard collection by name is exactly the library’s; a look-alike std.\* is refused", "collections_standard lists the library by area, and gives definitions in full")._

## How the library is shaped

People start with a few apps, then change them, add views, and build new
apps over the same records, often by asking an agent. That only works if
every app reaches for the same collection for the same thing. These rules
keep the library small enough to choose from, and each choice obvious:

1. **One collection per kind of thing.** Variants are optional fields, not
   collections of their own: a photo, a video and a PDF are each a
   `std.file`, with `width`, `duration` or none. Two collections an agent
   could reasonably pick for the same thing is a bug in the library.
2. **A group is a relation, never a field on what is in it.** There are two
   ways to group, and only two: `std.tag` for loose labels, any number on a
   record, and `std.list` with a `std.list-item` per member for a named,
   ordered group that exists while empty: a folder, an album, a playlist, a
   category, an itinerary (`kind`). Because the group is a record of its
   own, one file can be in a chat, a category and an album, and each app
   arranges it without touching the file. A single facet that nearly every
   app filters by, like an event's or a transaction's `category`, may stay a
   field.
3. **What an app adds to a standard record is a record of its own about
   it.** A definition here is exact (`collections_propose` refuses a
   look-alike), so an app that needs more on a `std.file`, say, defines
   `recipes.photo-note` with an `about` link to the file and
   `onePer: [link:about]`. Every other app still reads the file; only the
   recipes app reads the note. Never a parallel `recipes.photo` collection.
4. **Links use one vocabulary**, below. A link that says where a record
   sits is `in`, whether that is a channel, a board column or a list.
5. **A description says when not to use it.** Agents choose by reading
   descriptions, so where a neighbour could be mistaken for it, the
   description names the neighbour: "To vote on a std.proposal, use
   std.ballot."

## Conventions

- What several people edit is several records, not an array in one body,
  because a record resolves as a whole ([spec 02 §4.3](https://github.com/leifriksheim/minca/blob/main/spec/02-records.md)): a list and its items, a
  document and its blocks, an order and the seller's updates to it.
- "One per person" or "one per slot" is `onePer` ([spec 02 §7.3](https://github.com/leifriksheim/minca/blob/main/spec/02-records.md)), over links and
  scalar fields only (see the known defect there).
- Bodies carry no `createdAt`; the record has one. They carry only the times
  of the thing itself (`start`, `due`, `takenAt`).
- Link roles share one vocabulary: `about` (what an annotation is on),
  `replyTo` and `root` (threads), `parent` (trees), `in` (member of a list,
  album, calendar, document, account), `shares` (quotes).
- What only one person should see — blocks, mutes, reminders, settings — goes
  in that person's own space, not in one others read.

**Fragments.** The dialect has no `$ref` ([spec 02 §6.2](https://github.com/leifriksheim/minca/blob/main/spec/02-records.md)), so shared shapes are spelled
out in each definition, built by the library's `fragments` so they are
identical everywhere:

| Fragment   | Shape                                                                                                                                                                                                                |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `when`     | string 10–64: RFC 3339 date-time (`2026-03-01T18:30:00+01:00`), or `YYYY-MM-DD` for a whole day                                                                                                                      |
| `day`      | string of 10: `YYYY-MM-DD`                                                                                                                                                                                           |
| `timeZone` | string 1–64: an IANA zone, `Europe/Oslo`                                                                                                                                                                             |
| DID        | string 1–256: an account DID (built by `person`)                                                                                                                                                                     |
| `money`    | `{ amount, currency }`, both required: `amount` a decimal string 1–32 (`"12.50"`), never a number; `currency` ISO 4217, 3 characters                                                                                 |
| `address`  | `{ street, locality, region, postcode, country }`, each optional; `country` ISO 3166-1 alpha-2                                                                                                                       |
| `place`    | `{ name, address, lat, lon, cells }` (built by `placeRef`), each optional; `lat` −90–90, `lon` −180–180, WGS 84; `cells` string 1–12[] (≤ 8), the geohash cells of `lat` and `lon` (see Places and areas)            |
| `blob`     | `{ hash, size, mime, name?, key?, salt? }`: what `records.addFile` gives: `hash` the file's id (64 hex characters), `size` bytes as stored, `mime` required; `key` and `salt` open it (22 base64url characters each) |
| `image`    | `{ blob, alt? }`: `alt` ≤ 2000, what it shows                                                                                                                                                                        |
| `position` | string 1–200 that sorts where a record goes (Positions, below)                                                                                                                                                       |

Until the dialect has `format` ([spec 02 §6.2](https://github.com/leifriksheim/minca/blob/main/spec/02-records.md)), `when` and `day` are checked only for
length. A `blob` is what `records.addFile` gives
([storage](storage.md#files)): its `hash` is the file's id, and it carries
the `key` and `salt` that open it
([spec 05 §16.6](https://github.com/leifriksheim/minca/blob/main/spec/05-sync-and-storage.md)).

## The definitions

In the tables, a **bold** field is required; `string 1–200` gives its
`minLength`–`maxLength`, `[]` a list with its `maxItems`, and `a`/`b` an
`enum`. Links read `role` → where it may point, cardinality. Rules are what
a definition asks of its records ([spec 02 §7](https://github.com/leifriksheim/minca/blob/main/spec/02-records.md)):
`onePer`, `fixed`, `final`; a contract (`check`) is the definition's
`contract`, beside them. Who may add, change and remove records
is not the definition's to say but the space's grants
([spec 03 §2](https://github.com/leifriksheim/minca/blob/main/spec/03-spaces.md)):
in the `community` template, members change only what they made, moderators
anything, and only moderators and admins write in the collections in
`STAFF_COLLECTIONS` ([spaces](spaces.md#presets)).

**Annotations**

| Name            | Body                                                                                                                                      | Links                                              | Rules                                  |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | -------------------------------------- |
| `std.reaction`  | **`emoji`** string 1–16; `respondingTo` DID; topic `respondingTo`                                                                         | `about` → `*`, one                                 | `onePer: [@author, link:about, emoji]` |
| `std.comment`   | **`text`** string 1–10000; `mentions` DID[] (≤ 64); `replyingTo` DID; `respondingTo` DID; topics `mentions`, `replyingTo`, `respondingTo` | `about` → `*`, one; `replyTo` → `std.comment`, one | —                                      |
| `std.tag`       | **`label`** string 1–100                                                                                                                  | `about` → `*`, one                                 | `onePer: [@author, link:about, label]` |
| `std.rating`    | **`score`** integer 1–5; `review` string ≤ 10000                                                                                          | `about` → `*`, one                                 | `onePer: [@author, link:about]`        |
| `std.highlight` | **`quote`** string 1–10000; `prefix` string ≤ 500; `suffix` string ≤ 500; `note` string ≤ 10000                                           | `about` → `*`, one                                 | —                                      |
| `std.pin`       | `note` string ≤ 500                                                                                                                       | `about` → `*`, one                                 | `onePer: [link:about]`                 |
| `std.report`    | **`reason`** `spam`/`abuse`/`sexual`/`misleading`/`illegal`/`other`; `note` string ≤ 2000                                                 | `about` → `*`, one                                 | `onePer: [@author, link:about]`        |
| `std.label`     | **`value`** string 1–64                                                                                                                   | `about` → `*`, one                                 | `onePer: [link:about, value]`          |
| `std.claim`     | `note` string ≤ 500; `respondingTo` DID; topic `respondingTo`                                                                             | `about` → `*`, one                                 | `onePer: [link:about]`                 |

**People**

| Name          | Body                                                                                                                                                                                                                                                                                                                                                                                                                                   | Links | Rules                    |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------------------ |
| `std.profile` | `name` string ≤ 100; `bio` string ≤ 2000; `avatar` blob; `banner` blob; `pronouns` string ≤ 50; `links` { `title` string ≤ 100, **`url`** string 1–2048 }[] (≤ 16); `bot` boolean                                                                                                                                                                                                                                                      | —     | `onePer: [@author]`      |
| `std.card`    | `name` { `full` string ≤ 200, `given` string ≤ 100, `family` string ≤ 100 }; `emails` { **`address`** string 1–320, `label` string ≤ 50 }[] (≤ 16); `phones` { **`number`** string 1–64, `label` string ≤ 50 }[] (≤ 16); `addresses` { **`address`** address, `label` string ≤ 50 }[] (≤ 16); `organization` string ≤ 200; `jobTitle` string ≤ 200; `birthday` day; `photo` blob; `urls` string 1–2048[] (≤ 16); `note` string ≤ 10000 | —     | —                        |
| `std.follow`  | **`did`** DID; `space` string ≤ 256; topic `did`                                                                                                                                                                                                                                                                                                                                                                                       | —     | `onePer: [@author, did]` |
| `std.block`   | **`did`** DID; `until` when                                                                                                                                                                                                                                                                                                                                                                                                            | —     | `onePer: [@author, did]` |
| `std.mute`    | **`did`** DID; `until` when                                                                                                                                                                                                                                                                                                                                                                                                            | —     | `onePer: [@author, did]` |
| `std.status`  | `text` string ≤ 280; `emoji` string ≤ 16; `until` when                                                                                                                                                                                                                                                                                                                                                                                 | —     | `onePer: [@author]`      |

**Messaging and publishing**

| Name              | Body                                                                                                                                                                                                                                                                     | Links                                                                          | Rules                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | ------------------------------- |
| `std.message`     | **`text`** string 1–10000; `mentions` DID[] (≤ 64); `replyingTo` DID; topics `link:in`, `mentions`, `replyingTo`                                                                                                                                                         | `in` → `std.channel`, one; `replyTo` → `std.message`, one; `shares` → `*`, one | —                               |
| `std.channel`     | **`name`** string 1–100; `topic` string ≤ 500; `position` string 1–200                                                                                                                                                                                                   | —                                                                              | —                               |
| `std.direct`      | **`to`** DID[] (1–16); **`data`** string ≤ 60000; **`boxes`** `{to, sealed}`[] (≤ 17); topic `to`                                                                                                                                                                        | —                                                                              | —                               |
| `std.post`        | `text` string ≤ 10000; `images` image[] (≤ 8); `langs` string 2–35[] (≤ 3); `mentions` DID[] (≤ 64); `replyingTo` DID; topics `mentions`, `replyingTo`                                                                                                                   | `replyTo` → `std.post`, one; `root` → `std.post`, one; `shares` → `*`, one     | —                               |
| `std.repost`      | `respondingTo` DID; topic `respondingTo`                                                                                                                                                                                                                                 | `about` → `*`, one                                                             | `onePer: [@author, link:about]` |
| `std.article`     | **`title`** string 1–300; `summary` string ≤ 1000; `content` string ≤ 200000; `cover` blob; `slug` string 1–200; `publishedAt` when; `draft` boolean; `mentions` DID[] (≤ 64); topic `mentions`                                                                          | `in` → `std.publication`, one                                                  | —                               |
| `std.publication` | **`title`** string 1–200; `description` string ≤ 2000; `icon` blob                                                                                                                                                                                                       | —                                                                              | —                               |
| `std.doc`         | **`title`** string 1–500                                                                                                                                                                                                                                                 | —                                                                              | —                               |
| `std.doc-block`   | **`type`** `paragraph`/`heading1`/`heading2`/`heading3`/`bullet`/`numbered`/`todo`/`quote`/`code`/`image`/`divider`; `text` string ≤ 20000; `checked` boolean; `language` string ≤ 32; `image` image; `position` string 1–200; `mentions` DID[] (≤ 64); topic `mentions` | `in` → `std.doc`, one; `parent` → `std.doc-block`, one                         | —                               |
| `std.wiki-page`   | **`slug`** string 1–200; **`title`** string 1–300; `content` string ≤ 200000                                                                                                                                                                                             | —                                                                              | `onePer: [slug]`; history `all` |
| `std.note`        | `title` string ≤ 500; `content` string ≤ 200000; `pinned` boolean; `color` string ≤ 32; `mentions` DID[] (≤ 64); topic `mentions`                                                                                                                                        | —                                                                              | —                               |
| `std.call`        | **`status`** `missed`/`ended`; `to` string ≤ 256; **`startedAt`** string ≤ 64; `endedAt` string ≤ 64; `people` string ≤ 256[] (≤ 64); topics `to`, `people`                                                                                                              | —                                                                              | —                               |

**Lists**

| Name            | Body                                                                                                                                 | Links                                      | Rules |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ | ----- |
| `std.list`      | **`title`** string 1–200; `description` string ≤ 2000; `icon` string ≤ 16; `kind` string ≤ 32                                        | —                                          | —     |
| `std.list-item` | `text` string ≤ 1000; `url` string 1–2048; `did` DID; `checked` boolean; `quantity` number ≥ 0; `position` string 1–200; topic `did` | `in` → `std.list`, one; `about` → `*`, one | —     |

**Files and media**

| Name        | Body                                                                                                                                                                                                                                                            | Links                      | Rules |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ----- |
| `std.file`  | **`name`** string 1–255; **`mime`** string 1–255; `size` integer ≥ 0; `blob` blob; `url` string 1–2048; `alt` string ≤ 2000; `width` integer ≥ 1; `height` integer ≥ 1; `duration` number ≥ 0; `takenAt` when; `place` place; `thumbnail` blob; `captions` blob | `about` → `*`, one         | —     |
| `std.track` | **`title`** string 1–300; `artists` string 1–200[] (≤ 20); `album` string ≤ 300; `duration` number ≥ 0; `isrc` string ≤ 12; `mbid` string ≤ 36                                                                                                                  | `file` → `std.file`, one   | —     |
| `std.play`  | **`title`** string 1–300; `artists` string 1–200[] (≤ 20); `album` string ≤ 300; `duration` number ≥ 0; `isrc` string ≤ 12; `mbid` string ≤ 36; **`playedAt`** when                                                                                             | `about` → `std.track`, one | —     |

**Time and planning**

| Name             | Body                                                                                                                                                                                                                                                                            | Links                                                               | Rules                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------- |
| `std.calendar`   | **`name`** string 1–200; `color` string ≤ 32                                                                                                                                                                                                                                    | —                                                                   | —                                     |
| `std.event`      | **`title`** string 1–500; `description` string ≤ 10000; `category` string ≤ 100; **`start`** when; `end` when; `tz` string 1–64; `allDay` boolean; `place` place; `url` string 1–2048; `rrule` string 1–1000; `status` `confirmed`/`tentative`/`cancelled`; topic `place.cells` | `in` → `std.calendar`, one                                          | —                                     |
| `std.rsvp`       | **`status`** `going`/`maybe`/`no`; `guests` integer 0–100; `note` string ≤ 500; `respondingTo` DID; topic `respondingTo`                                                                                                                                                        | `about` → `std.event`, one                                          | `onePer: [@author, link:about]`       |
| `std.slot`       | **`start`** when; **`end`** when; `tz` string 1–64; `note` string ≤ 1000                                                                                                                                                                                                        | `in` → `std.calendar`, one                                          | —                                     |
| `std.column`     | **`name`** string 1–200; `position` string 1–200                                                                                                                                                                                                                                | `in` → `std.project`, one                                           | —                                     |
| `std.task`       | **`title`** string 1–500; `notes` string ≤ 10000; `position` string 1–200; `due` when; `status` `todo`/`doing`/`done`/`cancelled`; `assignees` DID[] (≤ 20); `priority` integer 0–4; topic `assignees`                                                                          | `in` → `std.column`, `std.project`, one; `parent` → `std.task`, one | —                                     |
| `std.project`    | **`name`** string 1–200; `description` string ≤ 10000; `status` `planned`/`active`/`paused`/`done`/`cancelled`; `due` when                                                                                                                                                      | —                                                                   | —                                     |
| `std.time-entry` | **`start`** when; `end` when; `note` string ≤ 1000                                                                                                                                                                                                                              | `about` → `*`, one                                                  | —                                     |
| `std.reminder`   | **`at`** when; `note` string ≤ 1000; `done` boolean                                                                                                                                                                                                                             | `about` → `*`, one                                                  | —                                     |
| `std.habit`      | **`name`** string 1–200; `schedule` string ≤ 1000; `target` number ≥ 0; `unit` string ≤ 32; `position` string 1–200                                                                                                                                                             | —                                                                   | —                                     |
| `std.checkin`    | **`date`** day; `value` number; `note` string ≤ 1000                                                                                                                                                                                                                            | `about` → `std.habit`, one                                          | `onePer: [@author, link:about, date]` |

**Places and travel**

| Name           | Body                                                                                                                                                                             | Links                      | Rules               |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ------------------- |
| `std.place`    | **`name`** string 1–200; `address` address; `lat` number -90–90; `lon` number -180–180; `cells` string 1–12[] (≤ 8); `category` string ≤ 100; `url` string 1–2048; topic `cells` | —                          | —                   |
| `std.visit`    | **`at`** when; `note` string ≤ 2000                                                                                                                                              | `about` → `std.place`, one | —                   |
| `std.trip`     | **`title`** string 1–200; `start` day; `end` day; `note` string ≤ 10000                                                                                                          | —                          | —                   |
| `std.location` | **`lat`** number -90–90; **`lon`** number -180–180; `accuracy` number ≥ 0; **`at`** when                                                                                         | —                          | `onePer: [@author]` |

**Home and life**

| Name                | Body                                                                                                                                                                                                                                                                                                        | Links                       | Rules                           |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ------------------------------- |
| `std.recipe`        | **`title`** string 1–300; `description` string ≤ 2000; `ingredients` { **`text`** string 1–500, `quantity` number ≥ 0, `unit` string ≤ 32 }[] (≤ 200); `steps` string 1–5000[] (≤ 200); `servings` integer ≥ 1; `prepMinutes` integer ≥ 0; `cookMinutes` integer ≥ 0; `image` image; `source` string 1–2048 | —                           | —                               |
| `std.meal`          | **`date`** day; **`meal`** `breakfast`/`lunch`/`dinner`/`snack`; `note` string ≤ 1000                                                                                                                                                                                                                       | `about` → `std.recipe`, one | `onePer: [date, meal]`          |
| `std.journal-entry` | **`date`** day; `content` string ≤ 200000; `mood` string ≤ 32                                                                                                                                                                                                                                               | —                           | `onePer: [@author, date]`       |
| `std.measurement`   | **`kind`** string 1–64; **`value`** number; **`unit`** string 1–32; **`at`** when; `note` string ≤ 1000                                                                                                                                                                                                     | —                           | —                               |
| `std.workout`       | **`type`** string 1–64; **`start`** when; `duration` number ≥ 0; `distance` number ≥ 0; `route` blob; `note` string ≤ 2000                                                                                                                                                                                  | —                           | —                               |
| `std.work`          | **`kind`** `book`/`film`/`show`/`album`/`game`/`podcast`/`other`; **`title`** string 1–500; `creators` string 1–200[] (≤ 20); `year` integer 0–9999; `ids` { `isbn` string ≤ 17, `imdb` string ≤ 16, `mbid` string ≤ 36, `wikidata` string ≤ 16 }; `cover` blob                                             | —                           | —                               |
| `std.progress`      | **`status`** `want`/`doing`/`done`/`dropped`; `percent` number 0–100; `finishedAt` when; `note` string ≤ 2000                                                                                                                                                                                               | `about` → `std.work`, one   | `onePer: [@author, link:about]` |

**Money and trade**

| Name                | Body                                                                                                                                                                                                                                                        | Links                           | Rules                       |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | --------------------------- |
| `std.expense`       | **`title`** string 1–200; **`amount`** money; **`paidBy`** DID; `split` { **`did`** DID, `share` string 1–32 }[] (≤ 100); `date` day; `note` string ≤ 2000; `owedBy` DID[] (≤ 63), the people in `split`; topics `paidBy`, `owedBy`                         | —                               | history `all`               |
| `std.settlement`    | **`from`** DID; **`to`** DID; **`amount`** money; `date` day; `note` string ≤ 1000; topics `from`, `to`                                                                                                                                                     | —                               | `fixed: [from, to, amount]` |
| `std.money-account` | **`name`** string 1–200; **`currency`** string 3–3; `kind` string ≤ 32                                                                                                                                                                                      | —                               | —                           |
| `std.transaction`   | **`amount`** money; **`date`** day; `payee` string ≤ 200; `category` string ≤ 100; `note` string ≤ 1000; `cleared` boolean                                                                                                                                  | `in` → `std.money-account`, one | —                           |
| `std.listing`       | **`title`** string 1–300; `description` string ≤ 10000; `price` money; `category` string ≤ 100; `condition` `new`/`like-new`/`good`/`fair`/`for-parts`; `images` image[] (≤ 12); `status` `available`/`reserved`/`sold`; `place` place; topic `place.cells` | —                               | —                           |
| `std.order`         | **`items`** { **`title`** string 1–300, **`quantity`** integer ≥ 1, `price` money }[] (1–100); `total` money; `note` string ≤ 2000; `respondingTo` DID; topic `respondingTo`                                                                                | `about` → `std.listing`, many   | —                           |
| `std.order-update`  | **`status`** `accepted`/`paid`/`shipped`/`delivered`/`cancelled`/`refunded`; `note` string ≤ 2000; `respondingTo` DID; topic `respondingTo`                                                                                                                 | `about` → `std.order`, one      | —                           |

**Community and governance**

| Name               | Body                                                                                                                                                                             | Links                         | Rules                                              |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | -------------------------------------------------- |
| `std.poll`         | **`question`** string 1–500; **`options`** string 1–200[]; `closed` boolean                                                                                                      | —                             | `fixed: [options]`                                 |
| `std.vote`         | **`choice`** integer ≥ 0; `choices` integer ≥ 0[] (≤ 100); `respondingTo` DID; topic `respondingTo`                                                                              | `about` → `std.poll`, one     | `onePer: [@author, link:about]`                    |
| `std.proposal`     | **`title`** string 1–300; `body` string ≤ 20000; **`options`** string 1–200[] (1–20); `closesAt` when; `status` `open`/`passed`/`rejected`/`withdrawn`; `quorum` integer 1–10000 | —                             | `fixed: [options]`                                 |
| `std.ballot`       | **`choice`** integer ≥ 0; `respondingTo` DID; topic `respondingTo`                                                                                                               | `about` → `std.proposal`, one | `onePer: [@author, link:about]`; `fixed: [choice]` |
| `std.decision`     | **`outcome`** integer ≥ 0; **`proposal`** string 1–128 (a version id); **`ballots`** string 1–128[] (≤ 256)                                                                      | `about` → `std.proposal`, one | `onePer: [link:about]`; `check` (below)            |
| `std.goal`         | **`title`** string 1–300; `body` string ≤ 20000; **`target`** integer 1–10⁹; **`unit`** string 1–50; `closesAt` when                                                             | —                             | `fixed: [target, unit]`                            |
| `std.pledge`       | **`amount`** integer 1–10⁹; `note` string ≤ 1000; `respondingTo` DID; topic `respondingTo`                                                                                       | `about` → `std.goal`, one     | `onePer: [@author, link:about]`; `fixed: [amount]` |
| `std.goal-reached` | **`goal`** string 1–128 (a version id); **`pledges`** string 1–128[] (≤ 256)                                                                                                     | `about` → `std.goal`, one     | `onePer: [link:about]`; `check` (below)            |
| `std.announcement` | **`title`** string 1–300; `text` string ≤ 20000                                                                                                                                  | —                             | —                                                  |
| `std.badge`        | **`name`** string 1–100; `description` string ≤ 1000; `image` blob                                                                                                               | —                             | —                                                  |
| `std.award`        | **`did`** DID; `note` string ≤ 1000; topic `did`                                                                                                                                 | `about` → `std.badge`, one    | `onePer: [link:about, did]`                        |

**Proven outcomes.** A `std.decision` and a `std.goal-reached` are not
declared by anyone: each cites the records that prove it, by version id, and
every device checks the proof before it counts one ([contracts.md](contracts.md)). Anyone in the space may write one, once, when the
proof is there:

- `std.decision` cites the proposal's first version (`proposal`) and ballots
  (`ballots`). Its contract: the proposal is the one it is `about`, as first
  put; `outcome` is one of its options; and the ballots cited that are about
  that proposal and chose `outcome` come from at least `quorum` different
  people. A proposal without a `quorum` can't be decided this way.
- `std.goal-reached` cites the goal's first version (`goal`) and pledges
  (`pledges`). Its contract: the goal is the one it is `about`, as first set;
  each person's pledge counts once; and the pledges add up to `target`.

A cited version proves what was signed, so what they count is final: a
ballot's `choice` and a pledge's `amount` are `fixed`, and their first
versions are kept whole (`onePer`), so they can be cited. That is why
`std.ballot` exists beside `std.vote`: a vote can be changed, a ballot can't.

```json
{ "outcome": 0, "proposal": "bay24o4l…", "ballots": ["bq7x…", "b3kd…", "bm2a…"] }
```

_Source: `packages/core/src/schemas/library/community.ts` (`ballot`, `decision`, `goal`, `pledge`, `goalReached`), `apps/example/src/components/apps/Decisions.tsx`. Tests: `packages/core/tests/contracts.test.ts` ("std.decision and std.goal-reached")._

**Settings**

| Name          | Body                                                             | Links | Rules                         |
| ------------- | ---------------------------------------------------------------- | ----- | ----------------------------- |
| `std.setting` | **`app`** string 1–200; **`key`** string 1–200; `value` any      | —     | `onePer: [@author, app, key]` |
| `std.host`    | **`url`** string 1–2048; `did` string 1–256; `name` string ≤ 100 | —     | `onePer: [url]`               |

`std.host` names a host the space pays to keep it online, which anyone in it
may chip in for; members' devices hand it the space's pass
([node](node.md#a-space-paying-for-itself), [spec 08 §2](https://github.com/leifriksheim/minca/blob/main/spec/08-hosting.md)).
Naming a host sends it every member's pass, so only those granted it should:
the `community` template leaves `std.host` to admins and moderators.

_Source: `packages/core/src/schemas/library/community.ts` (`host`)._

**Automations**

`std.automation` and `std.automation-run`: what a space does by itself when records come
to be a certain way, or at set times, and what each automation did. An
account keeps automations of its own in its registry too, which notify it. Described in
[automations.md](automations.md).

**Bots**

`std.bot`, `std.connect` and `std.connector`: how a community wants its bot
to be, someone asking a bot's host to connect the bot to a service such as
GitHub, and the bot saying what it is connected to. Described in
[bots.md](bots.md).

**Activity.** `std.activity` is someone at work on a record, for apps to show
while it lasts: "My bot is working on it…" under a message, a spinner on a
task. Anyone may write one, only about their own work, and apps show it as
that account's word.

| Collection     | Body                                                                                                        | Links              | Rules                           |
| -------------- | ----------------------------------------------------------------------------------------------------------- | ------------------ | ------------------------------- |
| `std.activity` | **`state`** `working` \| `waiting` \| `done` \| `failed`; `label` string ≤ 120; **`at`** when it came to it | `about` → any, one | `onePer: [@author, link:about]` |

One per account per record: writing another about the same record is its
next version, so the work moves from `waiting` to `working` to `done` or
`failed` in one record. A `working` or `waiting` activity whose `at` is more
than five minutes old (`ACTIVITY_STALE_SECONDS`) must be shown as over: its
writer may have gone away mid-way. `setActivity(node, space, key, state,
label?)` writes one, and `activeNow(body)` says whether one is going on now.
A setting without a label keeps the label it had. The action
`activity_set` ([actions](actions.md)) lets an agent or bot say what it is
doing in its own words ("Reading the thread", "Making an app"). A bot's
automation runner marks what set each automation off: `waiting` when queued,
`working` with the automation's name when it starts, then `done` or `failed`, keeping whatever the
model last said it was doing; it tells the model which record to say it on
([automations.md](automations.md#running)).

_Source: `packages/core/src/schemas/automations.ts` (`activity`, `setActivity`, `activeNow`), `packages/cli/src/bot-runner.ts` (`runAutomations`), `apps/example/src/activity.ts`, `apps/example/src/components/apps/Chat.tsx` (`Working`). Tests: `packages/core/tests/automation-runners.test.ts` ("std.activity"), `packages/cli/tests/agent-automations.test.ts` ("while an automation runs")._

**Collections**

`std.blueprint` and `std.guide`: collections someone proposes for the space,
not yet added, and how some of its collections are meant to be used. Neither
is about any one app. Described in [blueprints and guides](blueprints-and-guides.md).

| Collection      | Body                                                                                                                                        | Rules            |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `std.blueprint` | **`title`** 1–100; **`collections`** 1–10 objects, each a definition without `version`; `description` ≤ 1000; `from` ≤ 300; `updates` 1–100 | —                |
| `std.guide`     | **`name`** 1–100; **`title`** 1–200; **`text`** 1–20000; `collections` ≤ 16 names                                                           | `onePer: [name]` |

_Source: `packages/core/src/schemas/library/collections.ts` (`blueprint`, `guide`), `packages/core/src/schemas/blueprints.ts`, `packages/core/src/schemas/guides.ts`. Tests: `packages/core/tests/records-only.test.ts` ("collections proposed in a blueprint")._

**Bots.** A bot is an account of its own that people invite to their spaces
as a member. The protocol does not tell bots and people apart, and has no way
to: an account is an account. Disclosing is a convention. A bot says so with
`bot: true` on its own `std.profile` in a space, which only it can write, and
apps may show it; it is the account's word, like its name, so it proves
nothing about an account that leaves it out. A bot whose role may add
collections adds `std.profile` where a space keeps none, as an app does when
it starts a hosted bot.
Besides its own automations, it runs the automations in a space that name it in `by`,
made by members granted `/std.automation/instruct` there
([automations.md](automations.md#who-runs-an-automation)). In the `community` template, admins
and moderators hold it. Nothing the bot writes sets an automation off.
What it writes shows as the bot, and every member's device checks it against
the bot's role, so a role that may post messages but not delete keeps a
misled bot from deleting.

_Source: `packages/core/src/schemas/library/social.ts` (`profile`), `packages/core/src/schemas/automations.ts` (`automationsFor`), `packages/cli/src/agent.ts` (`discloseBot`). Tests: `packages/cli/tests/agent-automations.test.ts` ("says it is a bot…", "adds std.profile itself…", "a bot’s name"), `packages/core/tests/automation-runners.test.ts` ("a bot")._

**Mentions and replies.** A `std.message`, `std.comment` or `std.post` names
the accounts it calls on in `mentions` (as do `std.note`, `std.doc-block` and
`std.article`) and, when it replies to someone's
message, comment or post, their account in `replyingTo`. An app should fill
them from what the person picked (an `@name` they chose, the one they replied
to), never from matching text. They are topics (with the `channel` link on a message),
so an automation of the account's own can ask for only those that mention the
account, or reply to it, or are in one channel
([automations](automations.md#the-accounts-own), `where: { "mentions": { "$contains": "$me" } }`),
and a carrier's wake can match it unread ([spec 02 §8](https://github.com/leifriksheim/minca/blob/main/spec/02-records.md)).
A `std.task`'s `assignees` is a topic in the same way: "assigned to me" is
`where: { "assignees": { "$contains": "$me" } }`, with a tag for each assignee.

```json
{ "text": "@Sam are you coming?", "mentions": ["did:key:zDnae…Sam"], "replyingTo": "did:key:zDnae…Sam" }
```

A comment can be `about` a record of any kind, so commenting is how to
mention someone on a record whose own definition has no `mentions`, without
changing that definition. An app's own collection can name a `mentions` field
as a topic the same way.

_Source: `packages/core/src/schemas/library/publishing.ts` (`message`, `post`), `packages/core/src/schemas/library/annotations.ts` (`comment`), `packages/core/src/schemas/library/planning.ts` (`task`), `apps/example/src/components/std/Mentions.tsx`, `apps/example/src/components/apps/Chat.tsx`, `apps/example/src/components/std/Comments.tsx`. Tests: `packages/core/tests/topics.test.ts` ("mentions and replies are tagged, so “mentions me” and “replies to me” match only those", "a std.comment is tagged like a message…", "a std.post is tagged like a message…", "a task carries a tag for each assignee…", "an app that needs std.message gets its topics…")._

**Responses.** A record written in answer to someone's record names them in
`respondingTo`: a `std.reaction`, `std.comment` or `std.repost` the author of
what it is about, a `std.rsvp` the event's, a
`std.vote` the poll's, a `std.ballot` the proposal's, a `std.pledge` the
goal's, a `std.claim` the claimed record's, a `std.order` the listing's, and a
`std.order-update` the order's. It is their topic, so "someone reacted to,
commented on, or answered what I wrote" is `where: { "respondingTo":
{ "$contains": "$me" } }`, matched unread by a carrier's wake. The link says the same for a node
that can read, but a carrier can't read a private space's links, so the
account is written out. An app fills it from the author of the record it
links to, and leaves it out when that is the writer themselves.

A comment can carry all three: `respondingTo` the author of what it is
about, `replyingTo` the author of the comment it answers, and `mentions`.

Not every annotation has one. A `std.report` names nobody, so whoever is
reported is not told, and a keeper can't tell whom it is about. Bookmarks,
highlights, pins and tags are the writer's own, and what tracks the writer's
own life (`std.progress`, `std.checkin`, `std.visit`, `std.meal`,
`std.time-entry`, `std.reminder`) answers nobody.

**People as topics.** Where a record names people it is about, they are its
topics: `did` on `std.award` (given a badge), `std.follow` (followed) and
`std.list-item` (put on a list); `from` and `to` on `std.settlement`; `to`
and `people` on `std.call`. A `std.expense` names who owes a share inside
`split`, a list of objects, which a topic can't reach (spec 02 §8.1: a path
goes through objects only), so `owedBy` repeats those accounts as a list, at
most 63 so that with `paidBy` every one is tagged: a record carries at most
64 tags.

_Source: `packages/core/src/schemas/library/annotations.ts`, `packages/core/src/schemas/library/publishing.ts`, `packages/core/src/schemas/library/planning.ts`, `packages/core/src/schemas/library/community.ts`, `packages/core/src/schemas/library/money.ts`, `packages/core/src/schemas/library/social.ts`, `packages/core/src/schemas/library/media.ts`; `apps/example/src/derive/people.ts` (`respondingTo`), `apps/example/src/components/std/Reactions.tsx`, `apps/example/src/components/std/Comments.tsx`, `apps/example/src/components/apps/Polls.tsx`, `apps/example/src/components/apps/Decisions.tsx`, `apps/example/src/components/apps/Events.tsx`, `apps/example/src/components/apps/Marketplace.tsx`. Tests: `packages/core/tests/topics.test.ts` ("every standard collection that names people has them as topics…", "a report names nobody…", "a std.reaction is tagged for the person in its respondingTo…" and the rest of that list)._

**Channels.** A space with more than one conversation lists `std.channel`
records, by `position` then name, and a message is `in` its channel:
`where: { 'link:in': key }` finds a channel's messages, and
`include: { messages: { rel: 'in', from: 'std.message', count: true } }`
counts them. A message in no channel is in the space's own room,
which a chat shows first, as "general". In the `community` template only
moderators and admins make or rename a channel. A channel is a label, not a boundary: every member reads
every channel. Something only some members may read is a space of its own, or
a direct message.

**Direct messages.** A `std.direct` is sealed (`node.direct`, [direct-messages.md](direct-messages.md)):
only the people in `to` and whoever wrote it can read `data`. A chat groups
them into conversations by everyone in them, `to` plus the writer, and must
show one it can't open as unreadable, not drop it. `to` is a topic, so
"direct messages to me" is an automation of the account's own whose wake a
keeper can match unread.

_Source: `packages/core/src/schemas/library/publishing.ts` (`channel`, `direct`), `packages/core/src/privacy/direct.ts`, `apps/example/src/components/apps/Chat.tsx`. Tests: `packages/core/tests/direct.test.ts`._

**Changes to earlier definitions.** Before v1 the library is reshaped
without migrations, to keep to the rules above. The last such change merged
`std.attachment`, `std.photo`, `std.video`, `std.folder` and `std.album` into
one `std.file` (groups of files are `std.list`s); removed `std.booking` (a
booking is a `std.claim` about a `std.slot`), `std.reference` (any link
refers) and `std.bookmark` (a saved thing is a `std.list-item`); renamed
`std.message`'s `channel` link and `std.task`'s `column` link to `in`, and
dropped the task's `project` link (a task is `in` a project when it has no
column, and a column is `in` its project); made `std.tag` one record per
person, record and label; gave `std.track` a `file` link and `std.play` an
`about` link to its track; and narrowed `std.vote` to polls, since a proposal
is decided by `std.ballot`s. A space that holds an earlier definition keeps
it until someone applies a blueprint that carries the new one.

Since then ([#105](https://github.com/leifriksheim/minca/issues/105)), `std.comment` and `std.post` gained the same optional
`mentions` and `replyingTo` as a message, and `std.note`, `std.doc-block` and
`std.article` a `mentions`, all as topics; eleven annotations and answers
gained `respondingTo` (Responses, above); `std.expense` gained `owedBy`; and
the people fields of `std.task`, `std.award`, `std.follow`,
`std.list-item`, `std.settlement`, `std.call` and `std.expense` became
topics. A new topic tags only what is
written under the new definition: records written before it carry no tags,
so "mentions me" and "assigned to me" match from then on.

**Also exported** from the same module (specified with their features):

| Name                  | Body                                                                                    | Rules             | Where                   |
| --------------------- | --------------------------------------------------------------------------------------- | ----------------- | ----------------------- |
| `std.contact`         | `did` ≤ 256 and `name` ≤ 200, required; `space` ≤ 256; `note` ≤ 2000; `blocked` boolean | `onePer: [did]`   | [contacts](contacts.md) |
| `std.contact-request` | `to` ≤ 256 and `sealed` ≤ 16000, required                                               | —                 | [contacts](contacts.md) |
| `std.door`            | `id` 16–64 and `relays` (1–3, each ≤ 200), required; `name` ≤ 64; `label` ≤ 64          | `onePer: [id]`    | [doors.md](doors.md)    |
| `std.knock`           | `space` ≤ 256, `name` ≤ 64, `door` ≤ 64, `sign` ≤ 64 and `invite` ≤ 8000, all required  | `onePer: [space]` | [doors.md](doors.md)    |
| `std.knock-answer`    | `sig` ≤ 200, required                                                                   | —                 | [doors.md](doors.md)    |

**Positions.** `position` is a string that sorts (by plain string comparison)
where a record goes in a hand-made order. Digits are `0–9a–z`; a position
never ends in `0`, so there is always room between two. Equal positions sort by
key. A record without one goes at the end. `positionBetween(before, after)` in
the library makes one; any string that sorts correctly is valid.

_Source: `packages/core/src/schemas/fragments.ts`, `packages/core/src/schemas/library/` (one file per area), `packages/core/src/schemas/standard.ts` (`standardGroups`), `packages/core/src/schemas/index.ts` (`positionBetween`, `useSchemas`), `packages/core/src/schemas/contacts.ts`. Tests: `packages/core/tests/schemas.test.ts` ("the standard library", "standard nouns"), `packages/core/tests/contacts.test.ts`, `packages/core/tests/records-only.test.ts`._

**Places and areas.** A place with a point also carries its `cells`: the
geohash of `lat` and `lon` at precisions 3, 4, 5 and 6, coarsest first, about
156 km, 39 km, 4.9 km and 1.2 km across (`cellsOf(lat, lon)`). Geohash is
Niemeyer's: longitude and latitude bits interleaved, longitude first, five to
a character of `0123456789bcdefghjkmnpqrstuvwxyz`. For Grünerløkka in Oslo,
`lat` 59.9226 and `lon` 10.7522 give `["u4x", "u4xs", "u4xsu", "u4xsus"]`.

`std.event` and `std.listing` name `place.cells` as a topic, and `std.place`
names `cells`, so each cell is a blind tag ([spec 02 §8](https://github.com/leifriksheim/minca/blob/main/spec/02-records.md)): a keeper that
cannot read a private space can still hand over "listings in these cells".
Tags match by equality only, which is why the cells are written out at each
size instead of one long geohash and a prefix.

To find what is within a radius, `cellsAround(lat, lon, km)` picks the finest
precision whose cells are at least `km` wide and tall at that latitude, and
returns the point's own cell and the eight around it. Everything inside the
circle is in one of them, so a query or a keeper matches those (in a query,
`{ "$or": [{ "place.cells": { "$contains": cell } }, …] }`), and the exact
distance (`distanceKm`, haversine on a sphere of 6371.0088 km) decides the
rest. It returns null for a radius over about 150 km, or a circle around a
pole; then every place is a candidate. A record written by something that
knows nothing of cells has none, and is found only by its point.

`cells` say what `lat` and `lon` already say, and nothing checks that they
agree: a peer only checks that the tags match the cells. An app that reads
the body uses the point; a wrong cell only hides a record from area matches.
A listing usually means someone's home, so the example's marketplace keeps
only the part of town, moving the point to the middle of its precision 6 cell
and leaving out the street.

Finding places by name is not part of the library. The example asks Photon
(OpenStreetMap's data, `apps/shared/src/places.ts`), set by `VITE_MINCA_PLACES`,
and shows OpenStreetMap's credit beside what it finds.

_Source: `packages/core/src/schemas/geo.ts` (`geohash`, `cellsOf`, `cellsAround`, `aroundCell`, `distanceKm`), `apps/example/src/components/apps/Where.tsx`, `apps/shared/src/places.ts`. Tests: `packages/core/tests/geo.test.ts` (all)._

## Planned: what the library still waits on

> **Planned.** Not normative. Each item names its own issue.
>
> - **References to other spaces** ([spec 02 §5.3](https://github.com/leifriksheim/minca/blob/main/spec/02-records.md),
>   [#38](https://github.com/leifriksheim/minca/issues/38)). `std.follow`'s
>   `space` is a plain space id, and a repost or a list item can point only
>   within its own space.
> - **`format`** ([spec 02 §6.2](https://github.com/leifriksheim/minca/blob/main/spec/02-records.md)), to check `when`, `day` and `url`.

## `std.call`

Calls themselves are kept nowhere ([calls](calls.md)). Their history is a
`std.call` record in the space, written only if the space defines `std.call`:

| Field       | Type                            | Meaning                                      |
| ----------- | ------------------------------- | -------------------------------------------- |
| `status`    | `"missed"` \| `"ended"`         | required                                     |
| `to`        | string ≤ 256                    | For a missed call: who was rung.             |
| `startedAt` | string ≤ 64 (ISO date)          | required                                     |
| `endedAt`   | string ≤ 64 (ISO date)          | For an ended call.                           |
| `people`    | string[] ≤ 64 items, each ≤ 256 | For an ended call: every account seen in it. |

Rules: none ([02](https://github.com/leifriksheim/minca/blob/main/spec/02-records.md)); who may change it is the space's grants.

```json
{
  "status": "ended",
  "startedAt": "2026-09-26T10:00:00.000Z",
  "endedAt": "2026-09-26T10:14:02.311Z",
  "people": ["did:key:zDnaeSm3…", "did:key:zDnaeXL64…"]
}
```

_Implementation detail:_ the call a device is in is kept in `sessionStorage`
under `minca-call` as `{ space, call }`, so after a reload the page can offer to
rejoin while the call is still going on.

_Source: `packages/core/src/calls/calls.ts`, `packages/core/src/schemas/library/publishing.ts` (`call`). Tests: `packages/core/tests/calls.test.ts`._
