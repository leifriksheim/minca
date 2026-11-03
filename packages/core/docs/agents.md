# Agents

An agent can read and write in a person's spaces as them. It might be Claude
in a chat app, a coding agent in your terminal, or a program you write. This
page shows how to connect one, and what it may do once it is in.

## From a chat app

The simplest way is Minca's MCP service. Add it to your chat app by its
address:

```bash
claude mcp add --transport http minca https://mcp.minca.social/mcp
```

[minca.social/mcp](https://minca.social/mcp) has one-click links for Claude
and Cursor. The app opens a page where you sign in at your account home and
pick the spaces it may use, up to 8. The access lasts 30 days. Then its
tools arrive, and the chat app's own
model does the thinking.

How the service works, and how to run your own, is under
[The MCP service](#the-mcp-service) below.

## From a terminal

An agent with a shell, like Claude Code, Codex or Cursor's agent, uses
Minca through the `minca` command. Connect it once:

```bash
npx @minca/cli connect
```

Your browser opens your account home. Sign in, or make an account, and allow
it. The home shows six digits to type into the terminal, and the agent keeps
its access only once they match.

From then on, every `minca spaces …` and `minca records …` command on this
computer runs as the agent, unless `--account` names an account. Tell your
agent to start with `minca help`. Each command catches up with the space's
always-on nodes before it acts, and refuses when it can't.

The details are in [the CLI's README](https://github.com/leifriksheim/minca/blob/main/packages/cli/README.md#agents).

## Helping you build an app

These docs ship inside `@minca/core`, matched to the installed version. A
coding agent in your repository finds them at
`node_modules/@minca/core/docs/`. One line pointing there in your
project's `AGENTS.md` or `CLAUDE.md` is enough.

## What an agent may do

An agent gets a note from the person's account that lets it write records
and nothing more. It never gets the account's keys. Every peer refuses an
agent that tries to define collections, change who may do what, or write for
the account.

What it writes counts as the person's. Each record carries
`recordsOnly: true`, which apps may show. The example app says "via agent".

The note's format is in [spec 01 §8](https://github.com/leifriksheim/minca/blob/main/spec/01-identity.md).

## The tools

An agent gets the same tools from the CLI, the MCP service and WebMCP: the
node's actions that read spaces and records, write records, say what it is
doing, and propose collections. Each one, with what it takes, is in
[the list of actions](https://minca.dev/automations/actions/#the-list).

The MCP service leaves out `spaces_preview_invite`, which would have it dial
addresses a caller chose. `records_query` takes the same JSON query as `node.records.query`
([Records and queries](records-and-queries.md)).

A bot also gets `direct_list` and `direct_send`. It holds its own member key,
and an agent isn't given the person's ([Direct messages](direct-messages.md)).

## Making something new

An agent can't define collections, so it proposes the ones it needs with
`collections_propose`. Someone who may define collections reads what the
proposal would do, and applies it. A person whose role can't define
collections works the same way.

`collections_list` points at the guides a space's apps wrote (`std.guide`),
which say how they want new things proposed there. See
[Proposing collections](proposing-collections.md).

## An agent in the terminal: `minca agent`

`minca agent` runs the same agent without a chat app. It chats in the
terminal and thinks with your own Anthropic API key. With
`--provider openai` it uses any server that speaks OpenAI's Chat Completions,
including a model on your own machine.

It also runs the person's [automations](automations.md): when some records
come to be a certain way, or at set times, it does what they say. An agent
may write an automation when asked, but it runs only once the person has
saved it themselves.

See the [CLI's README](https://github.com/leifriksheim/minca/blob/main/packages/cli/README.md).

## Bots

A bot is an agent that is its own account. People invite it to their spaces
as a member. It writes as itself, is checked against its role like any
member, and is mentioned by its account's name.

The usual way to have one is to let the community's host run it
(`node.hosting.startBot`). An admin picks its name and role in the app, and
the host makes its account and joins. The community pays for it as it pays
for hosting. The host thinks with its own model key, within a daily cap per
bot. It holds the bot's keys, so it can read what the bot can read.

`minca agent --bot` runs the same bot yourself, with your own model key.

A bot runs the automations that name it in `by`, written by members granted
`/std.automation/instruct`. Where a space keeps `std.profile`, the bot marks
itself `bot: true` there as soon as the definition arrives, and adds
`std.profile` itself where its role may add collections. Apps list bots from
that, so a space without `std.profile` shows none.

See [Bots](bots.md), [who runs an automation](automations.md#who-runs-an-automation)
and the [standard library](standard-library.md). Hosted bots are in
[spec 08 §3](https://github.com/leifriksheim/minca/blob/main/spec/08-hosting.md).

## Every operation, described once

Every node operation is in `NODE_ACTIONS`, with a name, a sentence and a JSON
Schema for its input. The CLI, the MCP service and WebMCP tools are all made
from it. You can run one by name:

```typescript
import { runAction } from '@minca/core';

await runAction(node, 'records_put', {
  space: space.id,
  collection: 'app.todo.item',
  body: { text: 'milk' },
});
```

See [Actions](actions.md).

## In your own code

`node.asAgent({ keys, note })` gives the same node acting as an agent, from
a records-only note the account home issued. Everything it writes is signed
under that note, and carries `recordsOnly: true`. An app that runs what a
record holds as code should trust only records without it.

Records don't say which program wrote them, only that its note grants
records only. A name would be the program's own word, not proof. An app that
wants to show one can keep its own list of connected programs by key, as the
account home does.

## The MCP service

`minca mcp-server` is the service chat apps connect to. It has an MCP
endpoint at `/mcp`, and apps sign in with OAuth.

The consent page the app opens is an app like any other to the account home.
It makes a key in the browser and asks for a records-only note in the spaces
the person picks, with `connectToHome`. It hands the key and note to the
service. The service checks them with
`checkGrant(grant, did, { recordsOnly: true })`, and keeps them sealed under
a key only the app's access token carries.

Each call starts a node in memory from what the token opens
(`startGrantedAgent`). It reaches only the always-on nodes and relays the
person's invites and spaces name at public addresses, and the service's own
(`network.reach`, see [The node](node.md)). A write is done once the space's
keepers have it (`spaces.kept`). The one thing kept between calls is where
the key has signed, so the next node doesn't sign at a place it used.

Nothing new goes over the wire between the home and the page. See
[the CLI's README](https://github.com/leifriksheim/minca/blob/main/packages/cli/README.md#agents).

## Connecting at your account home

`minca connect` uses a one-time code to reach the account home. The code,
the channel it opens and the messages sent over it are protocol, and know
nothing of agents ([spec 06 §3](https://github.com/leifriksheim/minca/blob/main/spec/06-nodes-and-sessions.md)).

The program's side is `connectWithCode`, and the account home's is
`receiveConnectCode`:

- `newConnectCode()` makes a code, and `connectCodeUrl(home, code)` the link
  to open: `https://home.minca.social/connect#mc_…`.
- [`connectWithCode`](https://minca.dev/api/session/functions/connectWithCode/)
  waits in the code's room. Once it learns the home's origin, it signs the
  proof (`keyProof(key, { via: 'code', recordsOnly: true, origin })`) and
  calls `onWaiting({ origin })`. It keeps a records-only note made out to its
  key only after `check(matches)` has had the person enter the six digits.
- [`receiveConnectCode`](https://minca.dev/api/session/functions/receiveConnectCode/) runs on the home's
  connect page. It answers the program and returns the same
  `IncomingRequest` an app's popup does: records only, in the whole account,
  for 30 days, with `check`, the six digits to show.
- `connectCodeIn(location.hash)` finds the code in the address.
  `answerConnectCode` is the same exchange without the request around it.

### What the CLI and the account home add

- The terminal asks which account home to open, with home.minca.social, or
  the one used last, filled in. `--account-home` or `MINCA_ACCOUNT_HOME`
  answers ahead. Where nothing can be asked, it uses the usual one. The MCP
  server's connect tool takes no home, so the model never chooses where the
  person signs in.
- It opens the link in the browser, and shows it only when no browser opens,
  like on a server or over SSH. Whoever else holds the link could answer as
  the home. The link works from any device.
- `connectWithCode` asks only the home it opened, and keeps that home in the
  grant, whatever the answer names. It prints the account's DID beside its
  name.
- The home takes the code out of the address bar and shows the program's name. It says to allow it only if
  the person started it just now. Once answered, it says so and the tab can
  be closed. If no program asks within a minute, it says the link was used
  or has run out.
- The terminal waits 10 minutes for the home to open, since the person may
  make an account first, then 30 minutes for the answer. It checks the grant
  with `checkGrant(grant, did, { recordsOnly: true })` before keeping it and
  each time it starts, and says whose account it joined.
- Each connect makes a new key. Connecting again, to renew or after a
  disconnect, gives a new key and note, and a running `minca agent` picks
  them up without a restart. The earlier connection stays in the account
  home until it is disconnected there, but nothing can use it: its key is
  gone from the computer.
- An app only says how. "Connect an agent" in the example app shows the
  command.
