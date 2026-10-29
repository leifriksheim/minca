# Usernames

A username, `leif@minca.social`, is a name at a domain that leads to an
inbox code, so someone can find you by a name they can say aloud. What a
username is, how it is looked up and what a reader checks are protocol
([spec 07 §9](https://github.com/leifriksheim/minca/blob/main/spec/07-inbox.md)):
every reader must agree on them.

How a name is claimed at a domain is not. A domain can answer from a file it
edits by hand, or from anything else. This page describes the **Minca name
service** (`packages/names`), which minca.social runs and anyone can run for a
domain of their own, and how the library claims a name on one.

## Looking a name up

```ts
import { resolveUsername } from '@minca/core/inbox';

const { code, inbox } = await resolveUsername('leif@minca.social', provider);
```

It asks `https://minca.social/.well-known/minca.json?name=leif`, refuses a
redirect, and checks the code it gets as any other. The code then works
wherever one does: knock on it.

## On the node

`node.inbox.claim('leif@minca.social')` does all of the below for the
account's inbox, and keeps the name in `std.inbox` so every device knows it:
replacing the inbox, or changing its name or mailboxes, points the name at
the new code, and reading knocks renews it a month before its year is up.
`node.inbox.release()` gives it up. `node.inbox.knock('anna@minca.social')`
knocks by username, and the contact it becomes keeps the username
(`ContactView.username`). See [node.md](node.md#the-inbox).

**At sign-up.** `createMincaAuth({ usernames: 'minca.social' })` makes the
create screen of `<minca-auth>` one field: the username, with a tick once the
service says it is free and a cross once it is taken. A bare name is at that
domain, and is how it is shown and handed out (`leif`); a whole username,
`leif@example.org`, is checked and claimed at its own domain, and one that
gives out no Minca usernames says so, with a link to running a service. The account's name
starts as the username's (`nameFromUsername`: `leif.r` is Leif R) and is
changed on the account page. "Continue without a username" makes the account with none, so nobody
finds it by one, and a made-up name to show until it is given one
(`adHocName`: Swift Otter). `createAccount(name,
{ username })` claims it in the background while the recovery code and
password screens are up, and those screens say how it went: `state.username`
is `claiming`, `claimed`, or `failed` with an `error`, when it was taken
meanwhile or the service was down. The account is made either way.

The claim is made on the home's node, which may be the only one holding the
inbox: a connect page that closes once it answers keeps the window open
until the app's node holds the contacts space too (`spaces.reached`, keyed
by the app's key from its request), or else the app would read no knocks
until the two next met. The account home waits for what setup began in
the background (`auth.settled()`: the claim, and the host's handover) to
finish, however long, so neither is cut off halfway; then up to 30 s for the app,
and only for an account that claimed a name there. If the claim failed, the
app's contacts screen asks for a name again.

_Source: `packages/core/src/session/auth.ts` (`createAccount`, `claimInBackground`), `packages/core/src/elements/minca-auth.ts` (`#create`), `packages/core/src/inbox/names.ts` (`adHocName`, `nameFromUsername`, `usernameFree`), `apps/home/src/components/ConnectPage.tsx` (`handOver`). Tests: `packages/core/tests/usernames.test.ts` ("a username at sign-up")._

Renewing claims the code of the inbox this device knows. A device that
hasn't yet synced a replacement made on another one points the name back at
the old inbox until the inbox next changes; renewal starts only within a
month of the name lapsing, so this is rare.

## Claiming a name

```ts
import { claimUsername } from '@minca/core/inbox';

const until = await claimUsername('leif@minca.social', contactKey, inboxCode);
```

`claimUsername` looks the name up first. A Minca name service says, in every
answer, where claims go and how much work one needs:

```json
{ "names": {}, "claim": "https://usernames.minca.social/.well-known/minca.json", "work": 20 }
```

Then it posts the claim there:

```json
{
  "name": "leif",
  "key": "<name key public half>",
  "at": 1790000000000,
  "work": 731042,
  "code": "<inbox code>",
  "bind": "<base64url>",
  "sig": "<base64url>"
}
```

| Field  |                                                                                                                                                  |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `key`  | The **name key**'s public half, compressed P-256, base64url                                                                                      |
| `at`   | When the claim was made, ms. It must be within 10 minutes of the service's clock, and later than the claim it follows                            |
| `work` | A counter: SHA-256 of `minca/name-work/v1\|<name>@<domain>\|<key>\|<at>\|<work>` starts with `work` zero bits                                    |
| `code` | The inbox code, at most 4,096 characters. None gives the name up                                                                                 |
| `bind` | With a code: the inbox signing key's signature over `minca/name-bind/v1\|<name>@<domain>`, so a name leads only to an inbox whose owner chose it |
| `sig`  | The name key's ECDSA P-256 signature over `minca/name-claim/v1\|<name>@<domain>\|<at>\|<code, or empty>`                                         |

The answer is `{ "until": <ms> }`, when the name lapses, or
`{ "error": "…" }` with a 4xx status.

**The name key** is derived from the contact key, one per username:
`HKDF-SHA-256(contact key, info = "minca/p256-name-key/v1|" + name@domain)`,
with the username as `formatUsername` writes it, so every spelling a reader takes gives one key. `claimUsername` derives it itself. Every device that holds the contact key
derives the same one; it is not an inbox key, so replacing the inbox keeps
the name, and nothing ties it to the account. Only the key that holds a name
can point it elsewhere, renew it or give it up.

**Who may.** A name leads to the account's inbox, so only what may run the
inbox may claim one: a node whose note grants `/account/write` for the whole
account, holding the contact key. An app given the contact key could claim
the account's names too, and its hold outlasts revoking it, since a name key
has no generation to move on to
([#313](https://github.com/leifriksheim/minca/issues/313)).

## What the service keeps to

| Rule                       | On minca.social                                                                    |
| -------------------------- | ---------------------------------------------------------------------------------- |
| How long a claim holds     | A year. Claiming again, with the same code or a new one, renews it                 |
| New names from one address | 3 a day (an IPv4 address, or an IPv6 /48). Changing or renewing a name is free     |
| Work                       | 20 bits: a second or two on a laptop, a few on a phone                             |
| Names held                 | 50,000: each is a file of up to 8 KB, so a 1 GB volume holds them, inodes included |
| Reserved                   | `admin`, `support`, `security`, `minca` and a few more that pass for the service   |
| Given up                   | Free again after 10 minutes, so no earlier claim can be replayed to take it back   |

The work is a speed bump for bots, not a gate: a server does it ten times
faster than a phone. The address budget and the year are what keep squatting
in check; a name nobody renews comes back. The budget is kept in memory, so a
restart forgets it; nothing a client sends can make the service stop, since
whatever goes wrong with one request answers that request.

Each name is a file of its own on the service's disk, so nothing grows in
memory and no large file is rewritten. Lookups are open to any page
(`Access-Control-Allow-Origin: *`).

## Running one for your domain

The service is `packages/names/server.mjs`, with no dependencies:

```bash
NAMES_DOMAIN=example.org \
NAMES_CLAIM_URL=https://names.example.org/.well-known/minca.json \
NAMES_DIR=/data/names \
node packages/names/server.mjs 8080
```

Then answer `https://example.org/.well-known/minca.json` from it, by serving
the domain from it or proxying that one path (minca.social's site does this,
in `apps/site/public/_redirects`). Claims go to `NAMES_CLAIM_URL` directly, so
the service sees each client's address. `packages/names/fly.toml` deploys it
on Fly.

_Source: `packages/core/src/inbox/names.ts` (`claimUsername`, `claimMessage`), `packages/core/src/identity/contact-key.ts` (`deriveNameKeyBytes`), `packages/names/names.mjs` (`createNames`, `NAMES_LIMITS`), `packages/names/server.mjs`, `apps/site/public/_redirects`. Tests: `packages/names/tests/names.test.ts`._
