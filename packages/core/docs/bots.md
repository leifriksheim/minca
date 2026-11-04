# Bots and their connectors

A bot is an account of its own, added to a space like a member. A host can
run it, or a member can, with `minca agent --bot`. What a bot does is decided
by the space's [automations](automations.md) that name it in `by`.

This page covers who may configure a bot, the instructions it follows, and
how to connect it to a service outside the space, like GitHub.

[Spec 08 §3](../../../spec/08-hosting.md) covers bots on a host.

## Who may configure a bot

Someone who holds `/std.automation/instruct` in the space, and every role the
bot holds there. The second half means nobody reaches past their own grants
through a bot. In the `community` preset, founders, admins and moderators
hold the grant.

Ask with `mayConfigure`:

```ts
import { mayConfigure } from '@minca/core/schemas';

async function openSettings(bot: string, person: string) {
  if (await mayConfigure(node, space.id, bot, person)) {
    // show the bot's settings
  }
}
```

The bot, its host and the app all ask this one function, about whoever wrote
the version in question (its `root`):

- A bot follows what a record asks only when its writer passes.
- A bot follows instructions (`std.bot`) only from someone who passes.
- A bot acts on GitHub only for an automation whose current words were written
  by someone who passes, whoever sets it off.
- A host connects or disconnects a bot only for someone who passes.

### Bots don't configure bots

A bot never passes for itself. Steered once, it could leave itself
instructions that count. Nor does another bot, just as no chat app lets one
integration reprogram the next. A host never counts a bot it runs (`isBot` in
`runAutomations`), and the add-bot dialog offers a bot no role that grants
`/std.automation/instruct`.

## Instructions

A `std.bot` record says how a community wants its bot to be: a name to go by,
a tone, what to know.

```json
{
  "bot": "did:key:zDnaeYffVz7N…",
  "instructions": "You are Ferris, the team's helper. Answer briefly, and link issues as #N."
}
```

| Collection | Body                                            | Rules                    |
| ---------- | ----------------------------------------------- | ------------------------ |
| `std.bot`  | **`bot`** DID; **`instructions`** string ≤ 2000 | `onePer: [@author, bot]` |

Each person keeps their own, so nobody's words overwrite another's. The bot
reads the newest one whose current version was written by someone who may
configure it, as a person and not through an agent. It adds them to its
system prompt after its own rules, saying whose words they are.

Instructions can't undo the bot's rules. What set an automation off is still
data, and deleting is still refused. Everyone in the space can read them.

An app that shows a bot's instructions must pick them the same way, as the
CLI's `personaIn` does.

## Connecting a bot

A host can connect its bots to outside services, like GitHub, a calendar or a
drive. The person never handles a key. They go through the service's own
consent screen, and the host keeps what reaches the service. Your app only
needs each service's id and name.

1. Read what the host offers from `node.hosting.space(space.id)`. Each view has
   `connectors`, a list of `{ id, name }`, and the host's `url`.
2. Call `askToConnect(node, space, bot, id)`. It makes a random 32-byte
   secret, keeps it, and writes a `std.connect` naming the bot, the service
   and the secret's hash. The request is valid for nine minutes.
3. Open `connectPage(hostUrl, ask)` in a new window. Open it in the click
   handler, so the browser doesn't block it. The host checks the request
   through the bot and sends the window on to the service.
4. When the service sends it back, the bot writes its own `std.connector`
   saying what it is connected to. The window posts `{ minca: 'connected' }`
   to your app and closes.

```ts
import type { SpaceHostingView } from '@minca/core';
import { askToConnect, connectPage } from '@minca/core/schemas';

async function connect(host: SpaceHostingView, bot: string) {
  // Opened in the click, before any await, or the browser blocks it.
  const page = window.open('about:blank', 'minca-connect');
  const ask = await askToConnect(node, space.id, bot, 'github');
  if (page) page.location.href = connectPage(host.url, ask);
}
```

Define `std.connect` and `std.connector` in the space before you write a
request. Show a `std.connector` only when its writer is the bot it names.

### Disconnecting

Write the request with `disconnect: true`, then send it with
`askToDisconnect`. The host checks it the same way, forgets the connection,
and the bot deletes its `std.connector`.

```ts
import type { SpaceHostingView } from '@minca/core';
import { askToConnect, askToDisconnect } from '@minca/core/schemas';

async function disconnect(host: SpaceHostingView, bot: string) {
  const ask = await askToConnect(node, space.id, bot, 'github', { disconnect: true });
  await askToDisconnect(host.url, ask);
}
```

### The records

| Collection      | Body                                                                                                      | Rules                     |
| --------------- | --------------------------------------------------------------------------------------------------------- | ------------------------- |
| `std.connect`   | **`bot`** DID; **`kind`** service id, 1–40 chars; `verifier`; **`expires`** date-time; `disconnect` bool  |                           |
| `std.connector` | **`bot`** DID; **`kind`** 1–40 chars; **`account`** ≤ 100; `reaches`; **`by`** DID; **`since`** date-time | `onePer: [@author, kind]` |

- `verifier` is base64url(SHA-256(secret)), 43–64 characters.
- `account` is whose account at the service it is.
- `reaches` is what it reaches: up to 100 strings of up to 200 characters.

A request, for the secret `AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA` (43 `A`s):

```json
{
  "bot": "did:key:zDnaeYffVz7N…",
  "kind": "github",
  "verifier": "DwBzhbb51LfusnSGBa_hqYSgo7-j8BTQnip4TOnlzRo",
  "expires": "2026-10-15T12:09:00Z"
}
```

[Spec 08 §3.1](../../../spec/08-hosting.md) covers how the host checks it.

## Writing a connector

Each host decides which services it connects its bots to. In the reference
host, a service is one module implementing `HostConnector`, passed to
`startHost` as `connectors`. It lives in the CLI, which the API reference
doesn't cover, so here are its members:

| Member                                    | Does                                                         |
| ----------------------------------------- | ------------------------------------------------------------ |
| `id`, `name`                              | What the host's description names                            |
| `consentUrl(state, callback)`             | Where the browser goes to consent                            |
| `complete(query, callback)`               | Handles the browser coming back, and says what was connected |
| `tools(connection, { mayWrite, budget })` | What the bot may do on a connection                          |
| `hook(body, headers)`                     | Optional. Handles calls from the service itself              |

`consentUrl` must send the browser back to `callback`,
`<host>/host/connect/<id>/callback`, with `state`. Set the host's public
address (`MINCA_HOST_URL`) when a connector sends a `redirect_uri`. Otherwise
`callback` is worked out from each request.

`complete` gets the callback's query. It answers what was connected
(`account`, `reaches`, and `data` the host keeps and never shows, like a
refresh token), or why not. The host has already checked the state, the
browser and the request. The connector checks what only the service can say,
like whether this person may give that account to a bot.

`tools` that write must refuse without `mayWrite`, and each call to the
service takes one from `budget`. What the service returns is someone else's
words: mark it as data, as the GitHub tools do.

`hook` gets calls at `<host>/host/connect/<id>/hook`. It answers `unsigned`
for a call that isn't the service's, `forget` with the connections that are
gone, or `reaches` with what they now reach at most. The host only ever
narrows what a connection reaches, since one account at a service may serve
several communities.

Whatever the connector, the reference host:

- stops acting through a connection, and forgets it, once the bot holds no
  role in the space or its maker may no longer configure the bot;
- only ever narrows what a connection reaches;
- refuses two connectors with one id.

A Google Calendar connector, say, would send the browser to Google's consent
screen, exchange the code for tokens in `complete`, and keep the refresh token
in `data`. It would offer `calendar_events`, and with `mayWrite`,
`calendar_add`.

## GitHub, in the reference host

The reference host's GitHub connector is a GitHub App. Whoever
runs the host registers it once, with:

- Callback URL `<host>/host/connect/github/callback`, with "Request user
  authorization (OAuth) during installation" ticked.
- Webhook URL `<host>/host/connect/github/hook`, with a secret, subscribed to
  installation events.
- Permissions: Issues and Pull requests read and write. Contents and Metadata
  read.
- `MINCA_GITHUB_APP_ID`, `MINCA_GITHUB_APP_SLUG`, `MINCA_GITHUB_CLIENT_ID`,
  `MINCA_GITHUB_CLIENT_SECRET`, `MINCA_GITHUB_PRIVATE_KEY` (the PEM, or a path
  to it) and `MINCA_GITHUB_WEBHOOK_SECRET` in the host's environment, with
  `MINCA_HOST_BOTS=1`.

Without the webhook secret, the host takes no webhook calls, and learns of an
uninstall only when a call fails.

### Installing

The person picks the organisation and its repositories on GitHub's install
screen. The bot then acts on GitHub as the App, `<slug>[bot]`, on those
repositories only, with tokens that last an hour.

GitHub doesn't vouch for the installation id it sends back, and lists an
installation to anyone with access to one of its repositories. So the connector
exchanges GitHub's code for the user's own token, and keeps the installation
only if it is on that user's account, or on an organisation they are an
active admin of.

When the App is uninstalled or suspended, the host forgets every connection
through it. After a disconnect the App stays installed on GitHub, where
whoever installed it can remove it.

### Which repositories

One installation may serve several communities of the same account. So a
connection keeps the repositories it was made with. When GitHub says they
changed, the host only narrows them, and each bot says so in its
`std.connector`. To reach a repository added later, connect again.

Repositories are kept by name. If one is renamed and another is made under its
old name, in an installation for all repositories, the new one is reached in
its place.

### The bot's tools

A bot connected in a space has these there, beside its [node
actions](actions.md):

| Tool             | Does                                                                             |
| ---------------- | -------------------------------------------------------------------------------- |
| `github_search`  | Issues and pull requests in its repositories, in GitHub's search syntax          |
| `github_get`     | One issue or pull request: text, labels, latest comments, a pull request's files |
| `github_file`    | A file at a branch, tag or commit                                                |
| `github_comment` | Comments on an issue or pull request                                             |
| `github_issue`   | Opens an issue                                                                   |

It works like a chat app a workspace installs:

- The two that write run for an automation made by someone who may configure
  the bot, whoever sets it off. What sets it off reaches the model as data,
  and can still steer it. An automation whose current words are by someone
  who may not instruct the bot doesn't run at all.
- The three that read run for anyone whose record sets an automation off. A
  member can ask the bot what is in the connected repositories, private ones
  included. So connect only what everyone in the space may read.
- Every call names a repository the installation reaches, checked in code.
- A search is scoped to those repositories, and shows only results whose own
  repository is one of them, whatever the query says. An issue moved out of
  them isn't read at its old address.
- A run keeps the tools it started with until it ends, even through a
  disconnect or uninstall.
- Of several people's instructions, the bot takes the one written last by its
  writer's clock. Whoever may configure the bot is trusted with that, as with
  a bot's settings in any chat app.
- The model never sees a token. Each call adds one.
- What GitHub returns was written by people, possibly outside the space, and
  reaches the model marked as data.
- A bot makes at most 200 calls a day across its connectors, so a loop can't
  use up a service's limits.

## Planned

- GitHub events as records ("PR #12 opened"), so automations can answer them.
- Connectors for a bot a member runs, which has no public address for a
  service to send people back to.
