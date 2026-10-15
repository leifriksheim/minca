# Bots and their connectors

A bot is an account of its own in a space: one a host runs
([spec 08](../../../spec/08-hosting.md) §3), or one a member runs with
`minca agent --bot`. What it does is the space's automations naming it
([automations.md](automations.md)). This page covers who may configure a bot,
the instructions it follows, and how one is connected to a service outside
the space, GitHub first.

## Who may configure a bot

Someone who holds `/std.automation/instruct` in the space and every role the
bot holds there: `mayConfigure(node, space, bot, who)`. The second half means
nobody reaches past their own grants through the bot. In the community
preset, founders, admins and moderators hold the grant.

A bot never passes for itself: steered once, it could otherwise leave
itself instructions that count. Nor does another bot, as no chat app lets
one integration reprogram the next: a host never counts a bot it runs
(`isBot` in `runAutomations`), and the add-bot dialog offers a bot no role
that grants `/std.automation/instruct`. The bot, its host and the app all ask this
one function, of whoever wrote the version in question (`root`):

- a bot follows what a record asks only when its writer passes;
- a bot follows instructions (`std.bot`) only from someone who passes;
- a bot acts on GitHub only for an automation whose current words were
  written by someone who passes, whoever sets it off;
- a host connects or disconnects a bot only for someone who passes.

## Instructions

`std.bot` is how a community wants its bot to be: a name to go by, a tone,
what to know. Each person keeps their own (`onePer: [@author, bot]`), so
nobody's words overwrite another's. The bot reads the newest whose current
version was written by someone who may configure it, as a person and not an
agent, and adds it to its system prompt after its own rules, saying whose
words they are. They can't undo those rules: what set an automation off is
still data, and deleting is still refused. Everyone in the space can read
them. An app showing a bot's instructions must pick them the same way
(`personaIn` in `packages/cli/src/bot-runner.ts`).

| Collection | Body                                            | Rules                    |
| ---------- | ----------------------------------------------- | ------------------------ |
| `std.bot`  | **`bot`** DID; **`instructions`** string ≤ 2000 | `onePer: [@author, bot]` |

```json
{
  "bot": "did:key:zDnaeYffVz7N…",
  "instructions": "You are Ferris, the team's helper. Answer briefly, and link issues as #N."
}
```

## Connecting a bot

A host whose description names `connectors` can connect its bots to those
services. The person never handles a key: they go through the service's own
consent screen, and the host keeps what reaches the service.

1. Their app calls `askToConnect(node, space, bot)`: it makes a random
   32-byte secret, keeps it, and writes a `std.connect` naming the bot, the
   kind and the secret's hash, valid for nine minutes.
2. It opens `connectPage(hostUrl, ask)` in a window of its own, opened in the
   click so the browser doesn't block it. The host checks the request through
   the bot (spec 08 §3.1) and sends the window to the service.
3. When the service sends it back, the bot writes its own `std.connector`
   saying what it is connected to, and the window tells the app (a
   `postMessage` of `{ minca: 'connected' }`) and closes.

Disconnecting is `askToConnect(node, space, bot, { disconnect: true })`, then
`askToDisconnect(hostUrl, ask)`: the host checks it the same way, forgets the
connection, and the bot deletes its `std.connector`. The App stays installed
on GitHub, where whoever installed it can remove it.

An app must show a `std.connector` only when its writer is the bot it names,
and must define the collections before it writes a request. A host's views
of a space (`node.hosting.space`) say which connectors it offers
(`connectors`).

| Collection      | Body                                                                                                                                                                    | Rules                     |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `std.connect`   | **`bot`** DID; **`kind`** `github`; `verifier` base64url(SHA-256(secret)), 43–64 chars; **`expires`** date-time; `disconnect` boolean                                   |                           |
| `std.connector` | **`bot`** DID; **`kind`** `github`; **`account`** string ≤ 100, the GitHub user or organisation; `repos` owner/name strings, ≤ 100; **`by`** DID; **`since`** date-time | `onePer: [@author, kind]` |

Example request, for the secret `AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA` (43 `A`s):

```json
{
  "bot": "did:key:zDnaeYffVz7N…",
  "kind": "github",
  "verifier": "DwBzhbb51LfusnSGBa_hqYSgo7-j8BTQnip4TOnlzRo",
  "expires": "2026-10-15T12:09:00Z"
}
```

## GitHub

The host is a GitHub App. Its operator registers it once, with:

- Callback URL `<host>/host/connect/github/callback`, and "Request user
  authorization (OAuth) during installation" ticked.
- Webhook URL `<host>/host/connect/github/hook`, with a secret, subscribed to
  installation events.
- Permissions: Issues and Pull requests read and write; Contents and Metadata
  read.
- `MINCA_GITHUB_APP_ID`, `MINCA_GITHUB_APP_SLUG`, `MINCA_GITHUB_CLIENT_ID`,
  `MINCA_GITHUB_CLIENT_SECRET`, `MINCA_GITHUB_PRIVATE_KEY` (the PEM, or a
  path to it) and `MINCA_GITHUB_WEBHOOK_SECRET` in the host's environment,
  with `MINCA_HOST_BOTS=1`. Without the webhook secret the host takes no
  webhook calls, and learns of an uninstall only when a call fails.

The person picks the organisation and its repositories on GitHub's install
screen, and must be the account it is installed on or an admin of that
organisation: GitHub lists an installation to anyone with access to one of
its repositories, which isn't enough to hand it to a bot. They must come back
in the same browser that opened the host's page, which a cookie shows. The bot then acts on GitHub as the App, `<slug>[bot]`, with tokens
that last an hour, on those repositories only. When the App is uninstalled
or suspended, the host forgets every connection through it. One installation
may serve several communities of the same account, so a connection keeps the
repositories it was made with: when GitHub says they changed, the host only
narrows them, and each bot says so in its `std.connector`. Reaching a
repository added later means connecting again.

### The bot's tools

A bot connected in a space has these there, beside its node actions:

| Tool             | Does                                                                             |
| ---------------- | -------------------------------------------------------------------------------- |
| `github_search`  | Issues and pull requests in its repositories, in GitHub's search syntax          |
| `github_get`     | One issue or pull request: text, labels, latest comments, a pull request's files |
| `github_file`    | A file at a branch, tag or commit                                                |
| `github_comment` | Comments on an issue or pull request                                             |
| `github_issue`   | Opens an issue                                                                   |

- Every call names a repository the installation reaches, checked in code;
  a search is scoped to them.
- It works like a chat app a workspace installs. The two that write run for
  an automation someone who may configure the bot made, whoever sets it off;
  what sets it off reaches the model as data, and can still steer it. An
  automation whose current words are by someone who may not instruct the bot
  isn't run at all.
- The three that read run for anyone whose record sets an automation off. A
  member can ask the bot what is in the connected repositories, private ones
  included, so connect only what everyone in the space may read.
- A search shows only results in the connection's repositories, checked by
  each result's own repository, whatever the query says; an issue moved out
  of them isn't read at its old address.
- Repositories are kept by name. A run keeps the tools it started with until
  it ends, a disconnect or uninstall notwithstanding.
- Of several people's instructions, the bot takes the one written last as
  its writer's clock says; whoever may configure the bot is trusted with
  that, as with editing a bot's settings in any chat app.
- The model never sees a token: each call adds one.
- What GitHub returns was written by people, possibly outside the space, and
  reaches the model marked as data.
- 200 calls a bot a day, so a loop can't use up the installation's limits.

_Source: `packages/core/src/schemas/connectors.ts` (`connect`, `connector`, `botSettings`, `mayConfigure`, `askToConnect`, `connectPage`, `askToDisconnect`), `packages/cli/src/host-connect.ts` (`createBotConnect`), `packages/cli/src/connectors/github.ts` (`createGitHubApp`), `packages/cli/src/connectors/github-tools.ts` (`githubTools`), `packages/cli/src/bot-runner.ts` (`runAutomations`, `personaIn`), `packages/cli/src/host-setup.ts` (`githubFromEnv`), `apps/shared/src/BotConnectors.tsx`. Tests: `packages/cli/tests/host.test.ts` ("connecting a bot to GitHub"), `packages/cli/tests/github.test.ts`, `packages/cli/tests/agent-automations.test.ts` ("a bot’s connectors", "a bot’s instructions", "takes instructions only from someone holding every grant of its roles")._

## Planned

- GitHub events as records ("PR #12 opened"), so automations can answer them.
- Connectors for a bot a member runs, which has no public address for a
  service to send people back to.
