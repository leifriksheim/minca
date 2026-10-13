# Agents

An agent reads and writes as the person, with a note from their account that
every peer checks. The protocol doesn't know it is an agent: it is a program
that asked for a note that grants writing records and nothing more
(`/record`), so every peer refuses it defining collections, changing who
may do what, or writing for the account ([spec 01 §8](https://github.com/leifriksheim/minca/blob/main/spec/01-identity.md)).
What it writes counts as the person's, and carries `recordsOnly: true`
everywhere, which apps may show (the example app says "via agent"). It never
gets the seed.

An agent that is its own user, such as a community's bot, is an account of
its own instead (see Bots, below).

## Every operation, described once

Every node operation is in `NODE_ACTIONS`: a name, a sentence and a JSON
Schema for its input. The CLI, the MCP server and the browser's WebMCP tools
are all generated from it.

```typescript
import { NODE_ACTIONS, runAction } from '@minca/core';

await runAction(node, 'records_put', { space, collection: 'app.todo.item', body: { text: 'milk' } });
```

`records_query` takes the same plain-JSON query as `node.records.query`
([records-and-queries.md](records-and-queries.md)).

## Connecting an agent to someone's account

From `@minca/cli`, the `minca` command:

```bash
npx @minca/cli connect mc_…   # the code from "Connect an agent" in an app
```

It makes a key for this computer's agent, waits while the person allows it at
their account home, and adds `minca mcp` to Claude Code, Claude Desktop and
Cursor where it finds them. The agent is then a node of its own: it follows
the account's spaces and keeps working with every tab closed.

`minca agent` runs the same agent without a chat client: it chats in the
terminal and thinks with the person's own Anthropic API key, offering the model
the same tools. See `packages/cli/README.md`.

## Connecting with a code

The code, the channel it opens and the messages the two sides trade are
protocol, and know nothing of agents
([spec 06 §3](https://github.com/leifriksheim/minca/blob/main/spec/06-nodes-and-sessions.md)).
The library's two sides are `offerConnectCode` (the app) and `connectWithCode`
(the program).

- `offerConnectCode({ relays, account, origin? }, onStage)` makes a code that
  names `account`, the account the app is signed in to, and tells the
  program `origin` (default: the page's). On `asking` it hands the app the
  program's ask (`did`, `name`, `proof`, `recordsOnly`) and two answers,
  `allow(grant)` and `deny(reason?)`. What the program asked for is only a
  request: the app decides, and denies an ask it won't grant as asked.
- `connectWithCode({ code, key, name, recordsOnly, network, onWaiting? })`
  signs the proof itself once it learns the app's origin
  (`keyProof(key, { via: 'code', recordsOnly, origin })`), tells
  `onWaiting({ origin })` when the app has heard, and refuses a grant from any
  account but the one the code names.

What the reference sides add:

- The terminal (`minca connect`) asks for records only, and shows the app's
  origin while the person decides.
- The app (`apps/example/src/components/ConnectAgent.tsx`) shows the code. It
  gives a program records only (`apps/example/src/program-terms.ts`): it
  denies an ask without `recordsOnly: true`, and otherwise shows the
  program's name and what it may do, and asks the person to allow it.
- Allowing opens the account home (`connectToHome` with `audience` and
  `audienceProof`, which adds `via: 'code'`) with `access: write`,
  `scope: account`, `chooseSpaces: false`, `recordsOnly: true` and the
  lifetime the person chose. The home warns in red when a request by code asks
  for more than records.
- The app shows the agent connected when `code:done` arrives.
- The terminal waits 60 s to hear `code:heard`, then 10 minutes for the
  answer, and checks the grant with `checkGrant(grant, did, { recordsOnly: true })`
  before keeping it, and again each time it starts.

_Source: `packages/core/src/session/connect-code.ts`, `packages/cli/src/agent.ts` (`connectAgent`, `startAgentNode`), `apps/example/src/components/ConnectAgent.tsx`, `apps/example/src/program-terms.ts`, `apps/home/src/components/ConnectPage.tsx`. Tests: `packages/core/tests/connect-code.test.ts`, `packages/core/tests/records-only.test.ts` ("a program connected by code, through the account home"), `apps/example/tests/program-terms.test.ts`._

## Tools an agent gets

`node_info`, `spaces_list`, `spaces_status`, `spaces_preview_invite`, `spaces_access`, `spaces_profiles`,
`collections_list`, `records_query`, `records_list`, `records_get`,
`records_linked`, `records_history`, `records_can`, `records_put`,
`records_update`, `records_delete`, `activity_set` (what it is doing, for
people to see), and for new collections: `collections_standard`,
`collections_proposals`, `collections_propose`. A bot, an account of its own, also gets
`direct_list` and `direct_send`: it holds its own member key, and an agent
isn't given the person's ([direct messages](direct-messages.md)).

To make something new, an agent proposes the collections it needs
(`collections_propose`), the same way a person whose role can't define
collections does. Someone who may reads what it would do and applies it.
What else an app keeps, such as a screen or what is worth hearing about, is
the app's: `collections_list` points at the guides a space's apps wrote
(`std.guide`), which say how to propose one there. See
[blueprints and guides](blueprints-and-guides.md).

## Automations

An agent that runs by itself (`minca agent`) also runs the person's
automations ([automations.md](automations.md)), and does what those that ask
it say: when some records come to be a certain way, or at set times. An agent
may write an automation when asked, but it runs only once the person has
saved it themselves.

`minca agent` can think with Anthropic's models, or with any server that
speaks OpenAI's Chat Completions, including a model on your own machine
(`--provider openai`; see `packages/cli/README.md`).

## Bots

A bot is the same program running as an account of its own
(`minca agent --bot`), which people invite to their spaces as a member. It
writes as itself, is checked against its role like any member, and is
mentioned by the name its account says, like anyone: the one it was made
with, unless its account already says another. It runs the automations that
name it in `by`, of members granted `/std.automation/instruct` in a space. Where a space
keeps `std.profile`, it says it is a bot there with `bot: true`, as soon as
the definition arrives, and where its role may add collections it adds
`std.profile` itself. Apps list bots from that, so a space without it shows
none. See [automations.md](automations.md#who-runs-an-automation)
and [standard-library.md](standard-library.md) (Bots).

The usual way to have one is to let the host that keeps the community online
run it (`node.hosting.startBot`, [spec 08 §3](https://github.com/leifriksheim/minca/blob/main/spec/08-hosting.md)):
an admin picks its name and role in the app, the host makes its account and
joins, and the community pays for it as it pays for hosting. The host thinks
with its own model key, within a daily cap per bot, and holds the bot's keys,
so it can read what the bot can read. `minca agent --bot` is the same bot run
by whoever wants to, with their own key.

## In your own code

`node.asAgent({ keys, note })` gives the same node acting as an agent, from a
note that grants records only, issued by the account home. Everything it
writes is signed under that note. A record written under a note that can't
define collections is `recordsOnly: true`; an app that runs what a record
holds, as code, should trust only records without it.

Records don't say which program wrote them, only that its note grants
records only. Naming it would be the program's own word, signed by the account
on its say-so, not a proof, and peers would judge records the same either way;
an app that wants to show it can keep its own list of connected programs by
key, as the account home does.

## Working on a Minca app with a coding agent

These guides ship inside the package so an agent in your repository can read
them at `node_modules/@minca/core/docs/`, matched to the installed
version. A line in your project's `AGENTS.md` or `CLAUDE.md` pointing there is
enough.
