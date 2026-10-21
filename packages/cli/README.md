# minca — the protocol from a terminal

One program, three jobs:

- **Manage your spaces** — every command the Node API has, as `minca spaces …` and `minca records …`
- **Run an always-on node** — `minca run` keeps every space syncing, serves sockets browsers dial into, and is a relay too
- **Connect an agent** — `minca connect <code>`, then Claude Code, Claude Desktop, Cursor, VS Code or another MCP client starts `minca mcp` by itself, or `minca agent` runs it on its own

It uses the same data folder layout a browser does. Point `--home` at the folder
you picked in Chrome and the CLI, the daemon and the browser all share one
account.

## At a terminal, and anywhere else

Run `minca` alone at a terminal and pick what to do: set up an account,
invite someone, join a space, connect or run an agent, run a bot, add an
automation. Any command asks for what it still needs there: a space picked from
your spaces, a role, a collection, a record, a yes before something that
can't be undone.

Anywhere else (an agent like Claude Code, a script, CI) nothing is ever
asked, since nobody would answer. A missing value fails at once and names
the flag that gives it:

```
$ minca spaces invite
minca: Missing --space. Its id is in `minca spaces list`.
```

So every question has a flag, and a person and an agent reach the same result
by different roads. `--yes` answers yes ahead of time. Prompts draw on
stderr: what a command prints as data stays on stdout, JSON unless it goes
straight to a person (an invite then prints on its own line, to copy).

## Quick start

In this repo, `npm run dev` (at the root) already runs a node with a throwaway
identity, and `npm run minca -- <command>` talks to it — no setup.

To make the dev node _your_ account's node — so it serves every list you make
in the browser, with nothing to hand it — give it your account password once:

```bash
rm -rf .minca-dev                                  # drop the throwaway identity
MINCA_RECOVERY_CODE='XXXX-…' npm run minca -- init --existing --passphrase --name Me
npm run dev
```

To have `minca` everywhere:

```bash
npm install -g @minca/cli            # or run it without installing: npx @minca/cli <command>
```

From this repo: `npm install` at the repo root (the CLI is a workspace), then `cd packages/cli && npm run bundle && npm link`, or a
binary with no Node at all: `bun build.ts --native`.

```bash
minca init --name Leif --passphrase          # prints your recovery code once
export MINCA_PASSPHRASE='…'                  # so later commands don't ask

minca spaces create --name Groceries --visibility private --roles team   # or solo, community, coop
minca records put --space <id> --collection app.todo.item --body '{"text":"milk","completed":false,"order":1}'
minca records list --space <id>
minca spaces invite --space <id>             # a secret: it carries the space key and the invite's own secret
minca spaces invite --space <id> --view-only # they can read it, not change it
minca spaces join --invite 'https://…#invite=…'
minca spaces assign --space <id> --did <did> --role editor   # --remove takes it away
minca spaces step_down --space <id> --keep editor            # stop being a founder, for good
minca spaces succeed --space <id> --successor <new id>       # name the space that carries on from this one
minca run                                    # stay up and serve; --create makes an account on first start
```

Every data command is an action from `NODE_ACTIONS`: `minca records put` runs
`records_put`, and its flags are that action's input fields. `minca actions`
prints them all with their schemas. `--json '{…}'` passes an input whole.

## Unlocking

Secrets never go on the command line, where `ps` shows them:

|                                                |                                             |
| ---------------------------------------------- | ------------------------------------------- |
| `MINCA_RECOVERY_CODE` or `--code-file FILE`    | the account's recovery code                 |
| `MINCA_PASSPHRASE` or `--passphrase-file FILE` | a passphrase added with `init --passphrase` |
| neither                                        | you are asked, without echo                 |

Nothing ever writes the seed in the clear: the account file holds only wrapped
copies, exactly as in a browser folder.

## The always-on node

```bash
minca run --port 8787
```

- `ws://host:8787/peer?space=<id>` — the protocol's WebSocket transport. Browsers
  reach it with `network: { nodes: ['wss://host/peer#<account DID>'] }` (the
  example app reads `VITE_MINCA_NODES`). No relay, no TURN. The fragment pins
  the node to your account, so nothing else answering at that address is let
  in; `minca run` prints the pinned address when it starts. Plain `ws://` works
  only on this machine.
- `ws://host:8787` — the signaling relay, so one process bootstraps a space.
- `GET /health` — `{"ok":true}`, nothing more

It listens on this machine only (`127.0.0.1`). On a server, put it behind
whatever terminates TLS — browsers need `wss://` anyway — or pass
`--host 0.0.0.0` to listen on every interface.

It opens every space the account holds and notices new ones within five
seconds, whoever added them: `minca spaces join` in another terminal, a browser
pointed at the same folder, a pairing. It also meets the account's other
devices, a browser among them, through the relays (`$MINCA_RELAYS`, or the
default) over WebRTC, so a fresh `minca init --existing` on a laptop finds its
spaces with nothing pointed at it. `--no-relays` leaves that out, for a node
that browsers dial; a single-file binary, which carries no WebRTC, always does. It validates everything with the same
gates as any peer. It is an **anchor, not a host** — uptime, no authority.

For a server, `bun build.ts` makes single-file binaries for this machine,
`linux-x64` and `linux-arm64`; `minca-node.service` is a systemd unit.

## Carrying your spaces from a folder

```bash
minca carry --data DIR
```

A carrier, as the Chrome extension is one: it keeps one account's spaces
online with a pass for each, and nothing that reads or writes them
(`createCarrierNode`). It needs no account unlocked and listens on no port. It
meets the account's devices through the relays, over WebRTC.

The folder holds its key (`carrier-key`, made on first start, readable by you
alone), the carry grant an account home gave that key (`carry-grant.json`),
and what it carries (`store/`). The grant comes from something with a window
for the home: the desktop app (`apps/desktop`) connects it and writes the
file. With no grant it prints `{"state":"not-connected"}` and exits. Otherwise
it prints one JSON line on stdout whenever what it carries changes, for
whatever started it. When a record arrives that one of the account's wakes
(its own automations) asks about, it says so too: `{"state":"wake","space":…,
"collection":…,"at":…,"open"?:…}`, which space and what kind of record, never
what it says. The desktop app shows these as notifications. When the account
takes the carrier off, it deletes the grant and what it carried.

## Hosting other people's spaces

`minca host` is a hosting service in one process. It carries every paying
account's spaces — sealed, as they travel — and serves them over sockets and a
relay, like `minca run`. It holds no account and no space key.

```bash
# Try it on this machine: every subscription counts as paid
minca host --free --port 8787

# Host only yourself and your family, on a server: the accounts named, and nobody else
minca host --free --host 0.0.0.0 --allow did:key:zDnae… --allow did:key:zDnae…

# As a service: Stripe for payments, R2 (or any S3) for storage
STRIPE_SECRET_KEY=sk_live_… STRIPE_WEBHOOK_SECRET=whsec_… \
MINCA_S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com MINCA_S3_BUCKET=minca-host \
MINCA_S3_ACCESS_KEY_ID=… MINCA_S3_SECRET_ACCESS_KEY=… \
minca host --host 0.0.0.0 --port 8787 --data /var/lib/minca-host
```

- `--free` on an address others can reach needs `--allow` (or
  `MINCA_HOST_ALLOW`, comma separated): otherwise anyone who found it could
  fill its disk. An account's DID is under its name in the account home's
  Settings, with a Copy button. `--allow` works on a paying host too.
- The host's key is made once, in `--data` (`host-key`, readable by you alone).
  A new key is a new host: every account would hand its spaces over again.
- **Pay as it grows.** Every subscription has a balance: an account's, and
  a community's fund. Paying adds any amount to it, at least
  `MINCA_FUND_MIN` dollars (default 5, so a card's fixed fee stays small),
  once or (by card) every month. Keeping spaces online takes
  `MINCA_FUND_PER_GB` dollars a month for each GB (default 0.10), by the
  second: an account pays for what is past its free room, a community for
  its space, at least one GB. Once a community's balance runs out the host
  carries on through a grace until it owes the largest payment since it was
  last above zero (30 days at most), and the next payment pays for it first. An account at a
  host with limits gets its room's notice instead.
- **No pages of its own.** The host gives its price in its description, and
  the account home (or the app, for a space) shows it and pays: a card
  opens Stripe's own checkout page, a wallet gets a payment request as a QR
  code and a link. Stripe sends people back to `/host/paid`, which says done.
- Point Stripe's webhook at `https://<host>/host/billing/webhook`, sending
  `checkout.session.completed` and `invoice.paid`. Card payments need no
  prices in Stripe: the amount goes in the Checkout session.
- Crypto wallets pay with no company in between: USDC on Base, sent straight
  to your address. Next to Stripe, or instead of it:

  ```bash
  MINCA_WALLET_ADDRESS=0x… \
  minca host --host 0.0.0.0 --port 8787 --data /var/lib/minca-host
  ```

  The home shows a payment request for the amount plus a fraction of a
  cent that marks it as theirs: a QR code for a phone wallet, a link, and one
  click for a wallet in the browser (MetaMask, Coinbase Wallet, Rabby…). The
  host reads the network every 10 s while a payment is open, sees it arrive,
  then adds it to the balance. `MINCA_WALLET_NETWORK=base-sepolia` tries it
  with test USDC; `MINCA_WALLET_RPC` points at a network node of your own or a
  provider's (default: the network's public one). Keep the address's private
  key off the host — it only needs to receive.

- **Communities pay through a fund.** A community names the host in its
  space (`std.host`), and anyone in it adds to its fund from the app, any
  amount, by card or wallet, once or (by card) every month, with no sign-in at
  the host. Its bots take what they spend too. Every status says what is in
  it, what it spends a day, and when it will run out at that rate. For those
  who add
  every month, set `STRIPE_PORTAL_LINK` to Stripe's no-code customer portal
  link, which the app offers as "Stop adding every month". Members' devices
  hand the host the space's pass once there is money in the fund, and it
  carries the space blind, like an account's. A host with `--allow` carries no
  space for itself.
- Without limits, each account's spaces may take `MINCA_HOST_QUOTA_GB` if
  set (none by default; a balance pays for what they take). Every status
  says what they take, and the home shows it. At the limit the host takes no
  new space for that account; what it carries stays and keeps syncing.
- **Free within limits.** With `MINCA_HOST_FREE_GB` set, an account needs no
  payment: it gets that much room for free, and its balance pays for what is
  past it. A space several accounts write in stays free up to
  `MINCA_HOST_SPACE_WRITERS` accounts writing (default 10) and
  `MINCA_HOST_SPACE_MB` (500) over `MINCA_HOST_WINDOW_DAYS` (30);
  `MINCA_HOST_SPACE_READERS` (50) is only shown, never enforced. Past the
  line it is carried for `MINCA_HOST_GRACE_DAYS` (30) more, then only its own
  fund carries it; the host keeps what it had for `MINCA_HOST_KEEP_DAYS` (30)
  so a fund brings it straight back. A free subscription none of whose
  devices called for `MINCA_HOST_IDLE_DAYS` (180) is dropped. One address may
  make `MINCA_HOST_NEW_PER_DAY` subscriptions a day (5), an IPv6 /64 counting
  as one address, and one subscription carry
  `MINCA_HOST_SPACES_PER_SUBSCRIPTION` spaces (200). Behind a proxy other
  than Fly's, set `MINCA_HOST_CLIENT_IP_HEADER` to the header it puts the
  asker's address in, or everyone shares the proxy's address and its 5. Not with
  `MINCA_HOST_FREE=1`, which has no limits at all. How to choose the numbers:
  [HOSTING.md](HOSTING.md#limits).
- **Bots.** With `MINCA_HOST_BOTS=1` and a model's key, the host runs
  bots for the spaces it carries: an admin adds one from the app ("Set up this
  community", Add a bot), the host makes its account in `--data`'s `bots/`
  and joins with the invite, and it runs the space's automations that name it while
  its community's fund has money in it. What a bot spends is taken from that
  fund at `MINCA_BOT_MARKUP` times what the host pays (default 1.5); on a
  free host bots cost nothing. `MINCA_BOT_MODEL` (default `claude-sonnet-5-5`) and
  `MINCA_BOT_DAILY_CAP` (dollars a day each, default 1) set what they think
  with and may spend. The key is `ANTHROPIC_API_KEY`; or, with
  `MINCA_BOT_PROVIDER=openai`, `OPENAI_API_KEY` and any Chat Completions server
  (`MINCA_BOT_BASE_URL`, default OpenAI's), naming the model. A model whose
  price isn't built in needs `MINCA_BOT_PRICE`, dollars per million tokens
  like `1.25/10`, as `minca agent --price` takes it. The host
  holds each bot's keys, so it reads what the bot can read: the app says so.
- **Reminders by email**, for time paid up front: set `MINCA_MAIL_API_KEY`
  and `MINCA_MAIL_FROM` (Resend's API; `MINCA_MAIL_URL` for another that takes
  the same JSON), and `MINCA_HOST_URL` for the links. The home and the apps
  then offer "Email me before it runs out". Nothing but a link to confirm reaches an address until
  it is confirmed; then a mail 14 and 3 days before the time runs out and one
  when the grace period starts, each with a link that stops them.
- With a bucket, the disk is only a cache: lose it, start on the same key and
  bucket, and every subscription and space comes back.
- Before it takes anyone's money: [HOSTING.md](HOSTING.md).
- Put it behind something that terminates TLS (Caddy does it in two lines).
  The account home offers it under **Keep my spaces online** when built with
  `VITE_MINCA_HOST=https://<host>`, and every app built with it looks there
  for an account's registry, so a new device restores from the recovery code
  alone.
- Devices reach it at the socket its description names (`"peer": "/peer"`),
  as soon as the account or a space uses it: nothing to configure in the apps.

## Your own host

To keep your own spaces online, run a host for yourself rather than a node
that holds your account: `minca host --free` limited to your account. It
carries your spaces sealed, like any host, so the server never holds your
recovery code or a key to your spaces, and the account home uses it like any
other host.

```bash
minca host --free --host 0.0.0.0 --allow did:key:zDnae…   # behind TLS
```

On Fly, `fly.self.toml` does it (the commands are at its top): set
`MINCA_HOST_ALLOW` to your account's DID (Settings, under your name), deploy,
then in the account home choose **Keep my spaces online**, **Use another
host**, and paste its address. `MINCA_HOST_FREE=1` stands for `--free`, so the
image needs no flags. A few dollars a month on a small machine.

`minca run` is still there for a node that acts as your account (writes, runs
rules): it needs the account unlocked on the server, a host never does.

## Agents

In an app, choose **Connect an agent** in the account menu. It shows one
command:

```bash
npx @minca/cli connect mc_…      # in this repo: npm run minca -- connect mc_…
```

It makes a key for this computer's agent (it never leaves `~/.minca/agent/`),
meets the app on a channel only that code opens (introduced by a relay, sealed
end to end), and waits while you allow it at your account home, which signs a
records-only note (`/record`) for every space in your account, for as long as
you chose. The agent is a program connected by code, not a kind of account:
nothing in the note marks it as an agent except that it grants records only. Then it adds `minca` to Claude Code (`claude mcp add`) and every other
agent [add-mcp](https://github.com/neon-solutions/add-mcp) knows — Claude
Desktop, Cursor, VS Code, Windsurf, Zed, Codex, Gemini CLI and more — where
it finds them. `--no-configure` prints the config instead,
`--name` changes what you see ("Agent on leifs-macbook"), and `--relay` adds
one the app uses (`$MINCA_RELAYS` sets the defaults).

From then on the agent starts `minca mcp` itself. It's a node of its own: it
follows your account's list of spaces, meets your other devices over WebRTC,
and keeps working with every tab closed. What it writes is marked as written
under a records-only note, which the example app shows as "via agent". It
isn't offered what needs a person (making, joining or leaving spaces, invites,
roles, defining collections), and its note doesn't let it: it proposes
collections with `collections_propose`, and you add them. Connected from
npx, the agent starts `npx -y @minca/cli@latest mcp`, so restarting it picks
up a new release. `minca disconnect`
forgets it on this computer and takes `minca` out of the agents connecting
added it to (an entry you added by hand stays); disconnecting it in your
account home stops its note working everywhere.

To connect it again, after a disconnect or when its time runs out, run
`minca connect` with a new code. Each connect makes a new key, since a
revoked key never writes again, and a `minca mcp` already running takes the
new connection up by itself, so the agent's session needs no restart. Until
then, a tool that fails says the agent was disconnected.

`minca mcp --account` serves the unlocked account instead, as you:

```json
{
  "mcpServers": {
    "minca": { "command": "minca", "args": ["mcp", "--account"], "env": { "MINCA_PASSPHRASE": "…" } }
  }
}
```

It works offline against the folder; with `minca run` on the same folder,
whatever the agent writes is synced within seconds.

### The agent on its own

`minca agent` runs the connected agent without a chat client: its own node,
and a chat with it in this terminal. It thinks with your own Anthropic API key,
from `ANTHROPIC_API_KEY`, or asked for once and kept in
`~/.minca/agent/anthropic-key`, readable only by you.

```bash
npx @minca/cli connect mc_…      # once
npx @minca/cli agent             # in this repo: npm run minca -- agent
```

It has the tools `minca mcp` serves an agent, and the same limits. Anything
that deletes or overwrites asks you first (and is refused when input is piped).
Every model call is priced; after each answer it shows what it cost, and once
today's spend reaches `--daily-cap` (dollars, default 2) it starts no more calls
until tomorrow. `--model` picks the model (default `claude-opus-5-5`, or
`$MINCA_AGENT_MODEL`); it must be one whose price it knows.

Only one of `minca agent` and `minca mcp` can use an agent at a time: they sign
with the same key, and two signing at once would fork its log, after which
nothing more it signs counts. The second one to start says the agent is
already running, and stops (a lock in the agent's folder, taken over once the
process holding it is gone).

It also runs your **automations** (`std.automation`, see
`packages/core/docs/automations.md`): what to do when some records come to be a
certain way, or at set times ("when a task is given to me, add it to my weekly
plan note"; "weekdays at 8, plan my day"). Those that ask an agent start a
fresh conversation each time, with nobody there to allow deleting or
overwriting, so those are refused; they share the daily cap. Ask the agent to
keep an eye on something and it writes an automation as a suggestion; it starts once
you turn it on in an app (the example app's **Automations**). What the agent
writes never sets an automation off.

`--no-chat` runs only the automations, until stopped: on a server, or in the
background.

### Always on, on a server

`minca agent --no-chat` runs your automations with every device of yours closed; on
a server it stays that way. `fly.agent.toml` and `Dockerfile.agent` do it on
Fly (the commands are at the top of the toml):

1. Deploy it with your model's key as a secret (`ANTHROPIC_API_KEY`, or
   `OPENAI_API_KEY` with `--provider openai …` in `MINCA_AGENT_ARGS`).
2. In an app, choose **Connect an agent**, and run the command it shows over
   `fly ssh console`, with `--no-configure`. Allow it at your account home.
3. It starts within half a minute, and after every restart.

`MINCA_HOSTS=https://<host>` lets it find your spaces through the host your
account uses, with none of your devices online. The same image runs a
community's bot: `MINCA_AGENT_ARGS="--bot"`, then the command the app shows
under **Set up this community**, **Add a bot** (`minca agent --bot --name …
--invite …`) over `fly ssh console`, and the bot's password as the secret
`MINCA_PASSPHRASE`. Its daily cap (`--daily-cap`) is the most it can cost you.

### Other models

At a terminal, the first `minca agent` asks where the model runs (Claude,
DeepSeek, Kimi, OpenAI, OpenRouter, Ollama or another server), which model
and at what price, and keeps the answer in `~/.minca/agent/model.json`.
`minca agent --setup` asks again; flags and the environment win over it.

`minca agent` thinks with Anthropic's models by default. `--provider openai`
talks to any server that speaks OpenAI's Chat Completions instead: OpenAI,
OpenRouter, DeepSeek, Kimi, Groq, Mistral, or a model on your own machine.
The tools, the confirmations, the caps and the automations are the same whichever
model answers.

```bash
# DeepSeek
OPENAI_API_KEY=sk-… minca agent --provider openai --base-url https://api.deepseek.com \
  --model deepseek-v4-pro --price 0.66/1.98

# A model on this machine, with Ollama: no key, nothing leaves the machine
minca agent --provider openai --base-url http://localhost:11434/v1 --model qwen3 --price 0/0
```

- `--price` is dollars per million tokens, `input/output` or
  `input/output/cached`. It is needed for any model whose price `minca agent`
  doesn't know (it knows Anthropic's), since the daily caps depend on it.
- The key comes from `OPENAI_API_KEY` (or `MINCA_AGENT_API_KEY`), or is asked
  for once and kept in `~/.minca/agent/openai-key`. A server on `localhost`
  needs none.
- `--base-url` with the default provider points it at an Anthropic-compatible
  endpoint instead (DeepSeek and Kimi offer one); Anthropic's own additions,
  like thinking and fallbacks, are left out there.
- `MINCA_AGENT_PROVIDER`, `MINCA_AGENT_MODEL`, `MINCA_AGENT_BASE_URL` and
  `MINCA_AGENT_PRICE` set the same from the environment.

Models differ a lot in how well they use tools and resist instructions hidden
in what they read. That matters most for a bot that writes in a community:
its role still limits what it can do, but pick a strong model for one.

### A bot for a space

`minca agent --bot` runs an account of its own as a **bot**: something a
community adds to its spaces to help everyone, rather than one person's
agent. Where a space keeps `std.profile`, it sets `bot: true` on its own
there, so apps can show it as one and offer it under "Done by"; where it
keeps none, a bot whose role may add collections adds it. Elsewhere its name
has to say so. It writes
as itself, and every member's device checks what it writes against its role.
People mention it by its own name.

```bash
minca agent --bot
```

At a terminal that is all: it asks the bot's name, makes its account (with
its own recovery code), asks for an invite for the role the bot should hold,
made by someone who may assign that role, and joins. The name is what the space shows and what people
type after "@" to mention it.

Each bot is kept in a folder of its own, `bots/<name>` in the data folder
(`~/.minca/bots/club-bot`), with its account, model, API key and spending.
It is never the account the data folder already holds. `minca bots` lists
them; `minca agent --bot --name "Club Bot"` starts one again, and at a
terminal `minca agent --bot` asks which. By flags alone:

```bash
MINCA_PASSPHRASE=… minca agent --bot --name "Club Bot" --invite 'https://…#invite=…' --no-chat
```

A bot made before bots had folders of their own kept its account at the top
of its `--home`. Move that folder to `bots/<name>` in the data folder to run
it with `--name`.

Someone who may instruct it adds automations for it, as themselves, naming it in
`by`:

```bash
minca automation add   # at a terminal: space, what sets it off, from whom, what to do, who does it
minca automation add --space <id> --name "Answer when mentioned" --collection std.message \
  --where '{"mentions":{"$contains":"$me"}}' --from member --do "Answer them briefly" --by <bot DID>
minca automation add --space <id> --name Mornings --every "0 8 * * 1-5" --do "Post today's plan" --by me
```

`minca automation add` defines `std.automation` in the space first when it has none and
you may add collections; `minca collections define --standard <std.name>`
does that for any collection in the library. `$me` is whoever runs the automation:
the bot, or you.

It runs the automations in a space that name it in `by`, made by its founder or
members whose roles grant `/std.automation/instruct` there. What sets an automation off
is data to it, except when its writer holds that grant too, and every grant
of the bot's own roles: then an "Answer when mentioned" automation lets them ask it for
things ("make us an expenses app"), and it sees the replies before it.
An automation's `from` narrows what sets it off to records by some roles, so
`"from": ["member"]` is "a mention from anyone with a role".
`--daily-cap-each` limits what each person who sets it off may spend in a
day, a quarter of `--daily-cap` unless given, so nobody can spend the day for
everyone.

Give it a role that can do what it is for and no more: a misled bot can do
only what its role allows.

## Who gets served

Every peer first proves the DID it gives is its own: the node sends a random
challenge, and the client signs it with the key that DID names. So nobody can
connect under someone else's name and knock them off the node.

For a **private** space, the client also proves it may read before anything
moves: it signs the same challenge with the space's read key, which comes from
the space key. The node checks that against the
public read key the space names, so it needs no secret of the space's to do it.
The node then signs the client's challenge with its own key, so the client
knows the welcome comes from the node that sent the challenge. A stranger who
knows the space id gets a challenge and a closed socket, never the ciphertext —
the same answer as for a space the node does not hold, so a web page cannot ask
your node which spaces you have.
A **public** space is served to anyone, as its data is public anyway.

Writing is checked separately, record by record: its author must be a
founder, or hold a role whose grants allow that command (`/record/write`,
`/record/delete`, …) on that record, as of the access history the record says
it saw; and the note its key signs under must allow it too. The node refuses
any that doesn't, as every peer does. The constitution, roles, their grants and
members are kept in the clear, so a node holding no key of a private space
still judges its writes.

## Your node follows your account

Run the node as _your_ account (`minca init --existing` with your recovery code)
and it follows the account registry: every space you create or join, on any
device, is served by the node within moments — no invites to hand it. Leaving a
space anywhere leaves it everywhere.

The other commands work offline, on what the folder has seen. On a new
computer, run `minca run` while a browser with your account is open, until it
says it is serving your spaces; until then a command naming one says it is
unknown here.

## Not yet

- **WebRTC in the single-file binaries.** `minca run` from npm meets devices
  through relays with `node-datachannel`; the Bun binaries don't carry it, so
  browsers reach them over WebSocket only.
- **Publishing.** `minca-protocol-cli` on npm (or a built JS package), and
  trying the Bun binary with `node-datachannel`.
- **Hosting, before it's offered to anyone.** The checklist, what it costs
  to run and the breach plan are in [HOSTING.md](HOSTING.md): a real Stripe
  test-mode run, and a decision on tax, are still to do.
- **Paying.**
  - A real Base Sepolia wallet payment.
  - A Lightning route (BTCPay), and gasless USDC (EIP-3009).
- **TURN.** Run coturn with `use-auth-secret` and quotas, and set
  `TURN_SECRET` and `TURN_URLS` on the relay and the node. Then test calls
  across real networks, behind a strict NAT, in Safari, and on a phone
  switching apps.

What the protocol still has planned is in [the spec](../../spec/README.md),
under **Planned** in each part.
