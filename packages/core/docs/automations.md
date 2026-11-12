# Automations

An automation does something when records in a space look a certain way.
"When a poll has 10 votes, close it." "When someone mentions the bot, answer
them." "When a channel passes 100 messages, say so in it."

Your app can run automations for a person, so can their agent, and so can a
bot a community adds. Unlike a collection's [rules](collections.md#rules),
which every peer enforces and which can only refuse a write, an automation
acts.

## An automation

An automation is a `std.automation` record. Everyone in the space sees what
runs and who made it. Here is one that tells you when someone mentions you:

```json
{
  "name": "Mentioned",
  "when": {
    "query": { "collection": "std.message", "where": { "mentions": { "$contains": "$me" } } }
  },
  "then": { "kind": "notify", "text": "Someone mentioned you" },
  "since": "2026-09-29T12:00:00Z"
}
```

`when` holds a query in [the query format](query-format.md). Each record it
finds sets the automation off, once. `then` says what to do. `$me` is whoever
runs the automation.

`since` is when it starts. A record that already matched before then is left
alone. That counts the record's last change, the newest record any `include`
found, and the newest record its computed fields read.

You save an automation like any other record:

```ts
import { automation } from '@minca/std';

await node.records.put(space.id, automation, {
  name: 'Mentioned',
  when: { query: { collection: 'std.message', where: { mentions: { $contains: '$me' } } } },
  then: { kind: 'notify', text: 'Someone mentioned you' },
  since: new Date().toISOString(),
});
```

The space must have `std.automation` and `std.automation-run` defined.
Without them, nothing runs.

## Counting with `holds`

`holds` is a second filter, run over each result. It can read
`include:<name>`: what the query's `include` of that name found. That is a
number for an include with `count`, and a list of records otherwise. Use it
for what a query's own `where` can't say, like "more than 100 messages":

```json
{
  "name": "Busy channels",
  "when": {
    "query": {
      "collection": "std.channel",
      "include": { "messages": { "rel": "in", "from": "std.message", "count": true } }
    },
    "holds": { "include:messages": { "$gte": 100 } }
  },
  "then": {
    "kind": "add",
    "collection": "std.message",
    "text": "#{title} just passed {messages} messages",
    "links": [{ "rel": "in", "to": "$it" }]
  },
  "since": "2026-09-29T12:00:00Z"
}
```

What points at a record is counted by following links. So a relation must be
a [link](collections.md#links) to be counted.

## Who sets it off

`$me` works anywhere in `query` or `holds`. It is the automation's maker, or
the bot in `by`. So `{ "mentions": { "$contains": "$me" } }` means "mentions
me" for a person and for a bot alike.

Two more fields in `when` narrow who can set it off:

- `from` lists role names. Only records written by someone holding one of
  them count. `"member"` is any member, founders included.
- `others: true` lets through only records someone other than the runner
  wrote.

When a computed field in the filter made a record match, the record that set
it off is the one the field read. Say Bob's 👍 makes Alice's to-do done. That
was Bob's doing, so `others` lets it through and `from` asks about Bob's
roles. A 😡 after it changes nothing, so it sets nothing off. A to-do done
before the automation existed never does.

Which came last goes by the writers' clocks. Of two people whose 👍s made a
to-do done, either can claim to have been last.

## At set times

`every` runs an automation by itself, on a schedule. It takes five cron
fields, minute hour day month weekday, in the runner's local time:

```json
{
  "name": "Weekly reminder",
  "every": "0 9 * * 1",
  "then": { "kind": "notify", "text": "Plan the week" },
  "since": "2026-09-29T12:00:00Z"
}
```

Each field takes `*`, a number, a range `a-b`, a step `/n`, or a list with
commas. Weekday 0 or 7 is Sunday. When you give both a day and a weekday,
either one matches.

At those times the automation acts once, about no record. `$it` links nothing
and `{title}` stays as written. So an automation that changes a record needs a
`when`. An automation has `when`, `every`, or both.

## What it does

`then.kind` picks one of four actions:

| `then.kind` | Fields                        | Does                                                   |
| ----------- | ----------------------------- | ------------------------------------------------------ |
| `notify`    | `text`                        | Shows a notification on the device that runs it        |
| `add`       | `collection`, `text`, `links` | Adds a record made from `text`, carrying `links`       |
| `set`       | `field`, `value`              | Sets one field of the record, if its maker may edit it |
| `ask`       | `text`                        | Hands `text` to an agent, with what set it off         |

`notify` goes through the runner's `notify`. `set` takes text, a number or a
boolean.

### Adding a record

`add` works with any collection whose records one line of text can make
(`quickAddBody`). Its naming field (`title`, `name`, `text`, …) gets `text`.
Every other field must have an empty value, a `default`, `false` or `[]`, or
not be required. A message, a comment and a task all work this way, and so
does a collection someone defined yesterday.

Each of `links` is `{ "rel", "to" }`. `to` is a record's key, or `"$it"`, the
record the automation is about. A message posted in a channel links `in` to
`"$it"`. One that shares the record links `shares`.

In `text`, `{title}` is what the record is called: its `title`, `name`,
`question` or `text`, or the runner's `title`. `{<include>}` is how many that
include found, like `{messages}` above.

### Asking an agent

`ask` is for an agent: `minca agent`, or a bot. A runner without one leaves
these automations to one that has.

The agent gets the automation's words as its maker's. What set it off comes as
data, never as instructions. The one exception is a writer who may instruct
the agent:

- For a bot, that is the automation's maker, or a member granted
  `/std.automation/instruct` in the space who also holds every grant of the
  bot's roles. Nobody reaches past their own grants through a bot.
- For a person's own agent, only the person.

Then the runner says so, and what they ask may be done. What their record
quotes, and the messages before it, stay data.

Holding every grant of a bot's roles is not the same as holding what the bot
can do. `.byCreator` grants read whose record it is, and the bot's own records
are the ones it wrote: a reply, a summary, an app it made for someone. So
whoever may instruct a bot can have it edit or delete a record it wrote for
someone else, though their own `.byCreator` grant would never reach it.

## Running

For each record an automation newly matches, the runner writes a
`std.automation-run` first, then acts, then fills in the run: what it did, and
the key of any record it added (`made`).

There is one run per automation per record (`onePer: ['link:automation',
'link:about']`). That's how an automation acts once for each record, however
often and by however many devices it is looked at. The runs are its history,
for anyone in the space to see.

A runner that asks a model takes seconds, so it shows its progress in a
`std.activity` about the record that set it off, or about the automation when
it ran on a schedule. The state is `waiting` while queued, `working` while it
runs, then `done` or `failed`. In a space without `std.activity`, nothing is
shown and the automation runs as before ([standard
library](standard-library.md)).

### No loops

Nothing an automation added sets off an automation: a record some run names
in `made` is left alone. Otherwise "when a message is added, add a message"
would answer itself forever. Nothing the runner's agent or bot wrote itself
sets one off either, so an agent can't set itself off.

### Permissions

An automation writes as its runner, so it can do nothing its runner couldn't
do by hand. Who may change or delete one is up to the space's grants, as for
any record. In `community`, that is its maker, the moderators and the admins.

### Who runs an automation

Without `by`, its maker does:

- `runAutomations(node, space, maker)` runs them once.
- `startAutomations(node, { account })` runs them in every space the node
  follows, again after each change, and at the times they name.

The example app runs them while it is open, but not those that ask or run on a
schedule (`timed: false`). `minca agent` runs all of them.

With `by`, only that bot runs it. Here a bot answers mentions from any member:

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

The bot runs it only while the maker may invoke `/std.automation/instruct` in
the space (`INSTRUCT`). A space grants that to a role like any other grant,
and the founders hold it. Peers never check it: it is the library's own
command ([spec 03 §2](https://github.com/leifriksheim/minca/blob/main/spec/03-spaces.md)).
See [bots](bots.md) for more.

An automation whose current version an agent wrote, under a records-only note
(`recordsOnly`), runs nowhere. An agent may suggest one, and it waits until
the person saves it themselves.

Two runners of one account, say an app and an agent, may both claim a record
before either hears of the other. `startAutomations` waits `claimMs` after
claiming. The earlier claim acts and the later one is taken back.

Nothing runs while every runner is closed. To keep automations running with
every device off, run `minca agent --no-chat`, or a bot on a host.

### Fields

Every field of an automation is listed under
[`Automation`](https://minca.dev/api/std/interfaces/Automation/), and how
a runner is set up under
[`startAutomations`](https://minca.dev/api/std/functions/startAutomations/).

## The account's own

"Let me know when someone mentions me, in any of my spaces." An automation
kept in the account registry, not in a space, is the account's own. Nobody
else sees it, and it looks at the spaces it names. For now it only notifies:

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

It is a small shape of its own
([`OwnAutomation`](https://minca.dev/api/core/interfaces/OwnAutomation/)): a
`name`, `when` and `then` as below, `spaces`, the spaces it looks at, `open`,
where its notification leads, `app`, the app that proposed it, `paused` and
`since`. It has no other fields.

It is kept as `sys.automation` at `automation:<id>`. A system collection has
no definition, so no key of the account can redefine it to stop the person
pausing or removing one. That includes an app given all of it.

It must pass `checkOwnAutomation`:

- `then` is `{ kind: 'notify', text }`.
- `when` is `{ query, others? }`, and `query` is one `collection` with an
  optional `where` over each record alone: its body, its
  [computed fields](computed.md), `link:<role>`, `@key`, `@collection`,
  `@createdBy` and `@createdAt`. `$me` is the account.

It notifies about a record when the record **comes to match**. That is when
the record is written, or, for a `where` that names a computed field and an
app that is running, when something the field reads is written, the way a 👍
can make a to-do done. It
notifies once per record. A record edited out of matching and back in is not
news again, so nobody can notify the account over and over with one record.

What sets it off must be written after `since` and within the last day, and,
with `others`, by someone else. Both go by the clock of whoever wrote it.

[Spec 03 §13.2](../../../spec/03-spaces.md).

### Proposing one from an app

Apps propose these, the person says yes in the account home, and the home
writes them, naming the app. Describe what your app can notify about with
`notifyOn`:

```tsx
import { notifyOn } from '@minca/core/schemas';
import { useConnection } from '@minca/react';

function NotifyMe() {
  const { connection } = useConnection();
  const propose = () =>
    connection.propose([
      notifyOn('Mentioned', 'std.message', { mentions: { $contains: '$me' } }),
      { ...notifyOn('New message here', 'std.message'), spaces: [space.id] },
    ]);
  return <button onClick={propose}>Notify me</button>;
}
```

`propose` opens the home, so call it from a click.

A proposal leaves out what the home fills in. `then` notifies with the
proposal's name, `when.others` is true, `spaces` is every space the app may
reach, `open` is the app's address, and `since` is now. An `open` you give
must be on your app's own site. One request takes 1 to 8 proposals.

While your app runs, it shows what they match itself (`watchNotifications`).
`node.automations` lists, pauses and removes them wherever the account key is.

[Spec 06 §2.11](../../../spec/06-nodes-and-sessions.md) defines the
`Proposal` shape.

### Waking an app through a carrier

A carrier can't read, so it can't tell which records match. Instead, each
device with the account key copies each automation into every carry space as
a wake (`sys.wake`). A wake holds the collection, the spaces, `others`, and,
in each space, the tags of the topic values its `where` requires. When a
matching record arrives, the carrier wakes the app, and the app judges it.

A condition requires values when it is on a field the space declares a topic,
at the top of `where` or in an `$and` there: `field: value`, `$eq`,
`$contains` or `$in`. The first such condition gives the tags, one per value.
So "near me" as `{ "place.cells": { "$in": [nine cells] } }` is nine tags.

- A space where `where` requires no topic value gets no tags. Any new record
  of the collection wakes the app, which turns down what `where` doesn't
  match.
- A private space whose key the device lacks gets an empty list, and wakes
  nothing.

A wake is for the automation's own collection only. A `where` that names a
computed field changes when what the field reads is written, like a 👍 that
makes a to-do done: an app that is running notices that, and a carrier does
not.

A wake can only let through more than the app would, never less, with two
exceptions. One is the computed field above. The other is `$contains` on a
text field, which matches part of it, where a tag matches only a whole value. Mark as topics only fields that hold whole values: people,
links, cells.

[Spec 03 §15](../../../spec/03-spaces.md).
