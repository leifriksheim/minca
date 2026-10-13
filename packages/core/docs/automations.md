# Automations

"When a channel has more than 100 messages, say so in it." "When a poll has
10 votes, close it." "When someone mentions the bot, answer them." An automation
finds records with a query, keeps those a filter matches, and does one
thing for each, once; or does it at set times.

One kind of record for all of these, whoever runs it: a person's app, their
agent, or a bot a community added.

> Not protocol. A peer that has never heard of automations syncs, stores and judges
> `std.automation` and `std.automation-run` like any other record. These are not the
> `rules` of a definition ([collections.md](collections.md#rules)), which
> every peer enforces and which can only refuse a version; these act.

## An automation

An automation is a `std.automation` record, so everyone in the space sees what runs and
who made it:

```json
{
  "name": "Busy channels",
  "when": {
    "query": {
      "collection": "std.channel",
      "include": { "messages": { "rel": "channel", "from": "std.message", "count": true } }
    },
    "holds": { "include:messages": { "$gte": 100 } }
  },
  "then": {
    "kind": "add",
    "collection": "std.message",
    "text": "#{title} just passed {messages} messages",
    "links": [{ "rel": "channel", "to": "$it" }]
  },
  "since": "2026-09-29T12:00:00Z"
}
```

| Field    | Meaning                                                                                                                                                                     |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`   | What people call it                                                                                                                                                         |
| `when`   | `query`: a query in [the query format](query-format.md). `holds`, optional: a filter each result must match. `from` and `others`, optional: below.                          |
| `every`  | Optional. Five cron fields, minute hour day month weekday, in the runner's local time: the automation also runs by itself then. An automation has `when`, `every`, or both. |
| `then`   | What it does, below                                                                                                                                                         |
| `by`     | Optional. The DID of the bot that runs it; without it, its maker's own devices and agent do ([Who runs an automation](#who-runs-an-automation))                             |
| `picked` | Optional. How an app's builder showed the automation, so it can show it in words and open it again. Never read to run it.                                                   |
| `paused` | Optional. Kept, but not run.                                                                                                                                                |
| `since`  | Nothing that came to hold before this sets it off: a record whose last change, and the newest record any include found, are older is left alone.                            |

`"$me"`, anywhere in `query` or `holds`, is whoever runs the automation: its maker,
or the bot in `by`. So "a message mentioning me" is `{ "mentions":
{ "$contains": "$me" } }` for a person and for a bot alike. `from` lists role
names; only records written by someone holding one of them set the automation off,
and `"member"` is any member at all, the founders included. With `others`,
only records someone other than its runner wrote set it off.

`every` uses `*`, a number, a range `a-b`, a step `/n` and lists with commas;
weekday 0 or 7 is Sunday; a day and a weekday both given means either. At
those times the automation acts once, about no record: `$it` links nothing and
`{title}` stays as written, so an automation that changes a record needs a `when`.

`holds` is a filter in [the query format](query-format.md) over each result,
which may also read `include:<name>`: what the query's `include` of that name
found for the record, a number for an include with `count`, else the list of
records. Use it for what a query's own `where` can't say, like "more than 100
messages".

Anything a query can find, an automation can act on. What points at a record is
counted by following links, so a relation must be a link to be counted
([collections.md](collections.md#links)).

## What it does

| `then.kind` | Fields                                | Does                                                                                        |
| ----------- | ------------------------------------- | ------------------------------------------------------------------------------------------- |
| `notify`    | `text`                                | Shows a notification on the device that runs it, through the runner's `notify`              |
| `add`       | `collection`, `text`, `links`         | Adds a record to `collection`, made from `text` alone (`quickAddBody`), carrying `links`    |
| `set`       | `field`, `value` (text, number, bool) | Sets one field of the record, when its maker may edit it                                    |
| `ask`       | `text`                                | Gives `text`, in the maker's words, to an agent that runs automations, with what set it off |

`add` works with any collection whose records one line of text can make: its
naming field (`title`, `name`, `text`, …) is filled with `text`, and every
other field must have an empty value, a `default`, `false` or `[]`, or not be
required. A message, a comment and a task are all added this way, and so is a
collection someone defined yesterday. Each of `links` is `{ "rel", "to" }`,
where `to` is a record's key or `"$it"`, the record the automation holds for: a
message posted in a channel the automation is about links `channel` to `"$it"`, one
that shares it links `shares`.

In `text`, `{title}` is what the record is called (its `title`, `name`,
`question` or `text`, or the runner's `title`), and `{<include>}` how many
that include found: `{messages}` above.

`ask` is for an agent: `weave agent`, or a bot. It is told the automation's words
as its maker's, and what set it off as data, never as instructions, with one
exception: when whoever wrote that record may instruct it (for a bot, the
automation's maker or any member granted `/std.automation/instruct` in the space, and
only one who holds every grant of the bot's roles, so nobody reaches past
their own grants through it; for a person's own agent, only the person),
the runner says so, and what they ask
in it may be done. What it quotes, and the messages before it, stay data. A
runner without one leaves automations that ask to one that has.

Holding every grant of the bot's roles is not holding what the bot can do
with them. `.byCreator` reads whose record it is, and when the bot acts, its
own records are the ones it wrote: a reply, a summary, an app it made for
someone. So whoever may instruct a bot can have it edit or delete a record
it wrote for someone else, though their own `.byCreator` grant would never
reach that record.

_Source:_ `packages/cli/src/agent-automations.ts` (`triggerPrompt`, `ruleContext`,
`writerInstructs`); `packages/cli/tests/agent-automations.test.ts`.

## Running

For each record an automation newly holds for, the runner first writes a
`std.automation-run`, then acts, then says in the run what it did, and the key of
the record it added (`made`). A run is one per automation per record (`onePer:
['link:automation', 'link:about']`), which is how an automation acts once for each record
however often, and by however many devices, it is looked at; it is the automation's
history for anyone in the space.

A runner that asks a model, which takes seconds, also says so where people
look: its `std.activity` about the record that set the automation off (or the
automation, for one set off by the time) is `waiting` while it is queued behind
another, `working` while it runs, then `done` or `failed`. The space must
keep `std.activity`; where it doesn't, nothing is shown and the automation runs as
before ([standard library](standard-library.md)).

Nothing an automation added sets off an automation: a record some run names in `made` is
left alone. Without that, "when a message is added, add a message" would
answer itself forever, and two automations could answer each other. Nor does
anything the runner's agent, or the bot, wrote itself, so an agent asked to
act can't set itself off.

Whatever an automation writes is written as its runner, so an automation can do nothing its
runner couldn't do by hand. Who may change or delete one is the space's
grants, as for any record: in `community`, its maker, the moderators and the
admins.

A bot answering mentions, from anyone holding a role, run by the bot:

```json
{
  "name": "Answer when mentioned",
  "when": {
    "query": { "collection": "std.message", "where": { "mentions": { "$contains": "$me" } } },
    "from": ["member"]
  },
  "then": { "kind": "ask", "text": "Answer them briefly, in the same channel." },
  "by": "did:key:zDnae…",
  "since": "2026-09-29T12:00:00Z"
}
```

### Who runs an automation

- Without `by`, its maker: `runAutomations(node, space, maker)` once, or
  `startAutomations(node, { account })`, which runs them in every space the node
  follows, again after each change, and at the times they name. The example
  app runs them while it is open, but not those that ask or run at set times
  (`timed: false`); `weave agent` runs all of them.
- With `by`, only that bot, and only while the maker may invoke
  `/std.automation/instruct` in the space (`INSTRUCT`): a grant held by a role says
  who may direct a bot there. It is a command of the library's own: peers
  never check it, and a space grants it like any other, to a role
  ([spec 03 §2](https://github.com/leifriksheim/weave/blob/main/spec/03-spaces.md)).
  The space's founders hold it.
- An automation whose current version was written under a records-only note
  (`recordsOnly`, an agent's) runs nowhere: an agent may suggest one, and it
  waits until the person saves it themselves.

Two runners of one account, an app and an agent, may both claim a record
before either hears the other. `startAutomations` waits `claimMs` after claiming;
the earlier claim acts, and the later is taken back. Nothing runs while every
runner is closed: to keep automations running with every device off, run
`weave agent --no-chat`, or a bot on a host.

_Source: `packages/core/src/schemas/automations.ts` (`automation`, `automationRun`, `checkAutomation`, `matching`, `act`, `automationsFor`, `runAutomations`, `startAutomations`, `fillAutomationText`, `IT`, `ME`), `packages/core/src/schemas/cron.ts`, `packages/core/src/schema/quick-add.ts` (`quickAddBody`), `packages/core/src/query/filter.ts` (`checkFilter`, `matches`), `packages/cli/src/main.ts` (`runAgent`), `packages/cli/src/agent-automations.ts` (`triggerPrompt`), `apps/example/src/automations.ts` (`compile`, `useRunAutomations`). Tests: `packages/core/tests/automation-records.test.ts`, `packages/core/tests/automation-runners.test.ts` (all)._

## The account's own

"Let me know when someone mentions me, in any of my spaces." An automation
kept in the account registry rather than in a space is the account's own:
nobody else sees it, and it looks at the spaces it names. It is the same
`std.automation` record, with three more fields, and for now it only
notifies:

```json
{
  "name": "Mentioned",
  "when": {
    "query": { "collection": "std.message", "where": { "mentions": { "$contains": "$me" } } },
    "others": true
  },
  "then": { "kind": "notify", "text": "Someone mentioned you" },
  "spaces": "all",
  "open": "https://chat.example/",
  "app": { "origin": "https://chat.example", "name": "Chat" },
  "since": "2026-09-29T12:00:00Z"
}
```

| Field    | Meaning                                                                                      |
| -------- | -------------------------------------------------------------------------------------------- |
| `spaces` | `"all"`, every space of the account, or a list of space ids                                  |
| `open`   | Optional. Where clicking its notification goes, an `https://` address. Default: the home.    |
| `app`    | Optional. The app that proposed it, `{ origin, name? }`, by the origin the browser reported. |

It must check out as one (`checkOwnAutomation`): `then.kind` is `notify`; no
`every` and no `by`, since the account runs it on new records; `when.query`
is one collection and, optionally, a `where` over each record alone (its
body, `link:<role>`, `@key`, `@collection`, `@createdBy`, `@createdAt`), with
no `include`, and no `holds` or `from`. `$me` is the account. It looks at new
records only: `seq` 0, written after `since` and within the last day.

**Apps propose them**, the person says yes in the account home, and the home
writes them, naming the app ([spec 06 §2.11](../../../spec/06-nodes-and-sessions.md), whose `Proposal` is the shape below).
An app describes what it can notify about with `notifyOn`:

```ts
import { notifyOn } from '@weaveprotocol/core/schemas';

connection.propose([
  notifyOn('Mentioned', 'std.message', { mentions: { $contains: '$me' } }),
  { ...notifyOn('New message in Club', 'std.message'), spaces: [club] },
]);
```

A proposal leaves out what the home fills in: `then` defaults to notifying
with its name, `when.others` to true, `spaces` to all the app may reach,
`open` to the app's address, and `since` to now. The app shows what they
match itself, while it runs (`watchNotifications`), and
`node.automations` lists, pauses and removes them where the account key is.

**Carriers wake an app for them.** A carrier can't read, so each device with
the account key copies each one into every carry space as a wake (`sys.wake`,
[spec 03 §15](../../../spec/03-spaces.md)): the collection, the spaces,
`others`, and in each space, the tags of the values its `where` requires of
a topic. A condition requires values when it is on a field the space's
definition declares a topic and is at the top of `where`, or in an `$and`
there: `field: value`, `$eq`, `$contains` or `$in`. The first such
condition gives the tags: one per value, so "near me" as
`{ "place.cells": { "$in": [nine cells] } }` is nine tags. A space where
`where` requires no topic value gets no tags, so any new record of the
collection wakes the app, which then turns down what `where` doesn't match.
A private space whose key the device lacks gets an empty list, and wakes
nothing.

A wake can only let through more than the app would, never less, with one
exception: `$contains` on a text field matches part of it, and a tag only a
whole value. Mark as topics only fields that hold whole values: people,
links, cells.

_Source: `packages/core/src/space/own-automations.ts` (`checkOwnAutomation`, `notifyOn`, `checkProposal`, `fromProposal`, `wakeFor`, `matchesRecord`), `packages/core/src/node/node.ts` (`automations`, `syncPasses`), `packages/core/src/node/watch-notifications.ts`. Tests: `packages/core/tests/topics.test.ts` ("an automation of the account’s own: its where"), `packages/core/tests/carrier.test.ts` ("notifications through a carrier"), `packages/core/tests/connect.test.ts` ("an app proposing automations", "an app showing its own notifications"), `packages/core/tests/geo.test.ts`._
