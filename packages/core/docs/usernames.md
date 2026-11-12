# Usernames

A username, like `leif@minca.social`, is a name at a domain that leads to an
inbox code. It lets someone find you by a name they can say aloud. This page
shows how to look one up and claim one, and how to run the Minca name service
for a domain of your own.

## Looking a name up

```ts
import { createP256Provider } from '@minca/core';
import { resolveUsername } from '@minca/core/inbox';

const { code, inbox } = await resolveUsername('leif@minca.social', createP256Provider());
```

This asks `https://minca.social/.well-known/minca.json?name=leif`. It refuses
a redirect, and checks the code it gets like any other. The code then works
wherever a code does, so you can knock on it.

It throws when the text isn't a username, the domain doesn't know the name,
or the code doesn't check out.

How a name is looked up and checked is protocol, the same for every reader:
[spec 07 §9](https://github.com/leifriksheim/minca/blob/main/spec/07-inbox.md).

## On the node

Most apps never call the functions on this page directly. The node does it
for the account's inbox:

```ts
await node.inbox.claim('leif@minca.social');
await node.inbox.knock('anna@minca.social');
await node.inbox.release();
```

`claim` keeps the name in `std.inbox`, so every device knows it. After that,
the node keeps the name pointing at the right place:

- Replacing the inbox, or changing its name or mailboxes, points the name at
  the new code.
- Reading knocks renews the name a month before its year is up.

`knock` knocks by username, and the contact it becomes keeps the username
(`ContactView.username`). `release` gives the name up. See
[the inbox](node.md#the-inbox).

Renewal claims the code of the inbox this device knows. If another device
replaced the inbox and this one hasn't synced that yet, renewing points the
name back at the old inbox until the inbox next changes. Renewal starts only
within a month of the name lapsing, so this is rare.

## At sign-up

Pass `usernames` to `createMincaAuth`, and the account is made with a
username: the create screen asks for one.

```ts
import { createMincaAuth } from '@minca/auth';

const auth = createMincaAuth({ usernames: 'minca.social' });
```

The field shows a tick once the service says the name is free, and a cross
once it's taken. A bare name like `leif` is at that domain, and is how it is
shown. A whole username like `leif@example.org` is checked and claimed at its
own domain. A domain that gives out no Minca usernames says so, with a link to
[running a service](#running-one-for-your-domain).

The account's name starts as the username's (`nameFromUsername`: `leif.r`
becomes Leif R), and can be changed on the account page.

"Continue without a username" makes an account with none, so nobody finds it
by one. It gets a made-up name to show until it is given one (`adHocName`:
Swift Otter).

### The claim runs in the background

`createAccount(name, { username })` claims the name while the recovery code
and password screens are up. Those screens say how it went, in
`state.username`: its `status` goes from `claiming` to `claimed`, or to
`failed` with an `error` (the name was taken meanwhile, or the service was
down).

The account is made either way. If the claim failed, the app's contacts
screen asks for a name again.

### Handing over to the app

The claim is made on the home's node, which may be the only one holding the
inbox. So a connect page that closes once it answers stays open until the
app's node holds the contacts space too (`spaces.reached`, keyed by the app's
key from its request). Otherwise the app would read no knocks until the two
next met.

The account home first waits for what setup began in the background to
finish, however long that takes (`auth.settled()`: the claim, and the host's
handover). Then it waits up to 30 s for the app, and only for an account that
claimed a name there.

## Claiming a name

To claim a name without a node, call `claimUsername` with the contact key and
the inbox code. Pass `null` as the code to give the name up.

```ts
declare const contactKey: Uint8Array;
declare const inboxCode: string;
// ---cut---
import { claimUsername } from '@minca/core/inbox';

const until = await claimUsername('leif@minca.social', contactKey, inboxCode);
```

It returns when the name lapses, in ms, unless claimed again. It throws when
the code isn't this account's, the domain names no name service, or the
service refuses.

### What goes over the wire

`claimUsername` looks the name up first. In every answer, a Minca name
service says where claims go and how much work one needs:

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

| Field  |                                                                                                               |
| ------ | ------------------------------------------------------------------------------------------------------------- |
| `key`  | The name key's public half: compressed P-256, base64url                                                       |
| `at`   | When the claim was made, ms. Within 10 minutes of the service's clock, and later than the last claim          |
| `work` | A counter: SHA-256 of `minca/name-work/v1\|<name>@<domain>\|<key>\|<at>\|<work>` starts with `work` zero bits |
| `code` | The inbox code, at most 4,096 characters. Leave it out to give the name up                                    |
| `bind` | With a code: the inbox signing key's signature over `minca/name-bind/v1\|<name>@<domain>`                     |
| `sig`  | The name key's ECDSA P-256 signature over `minca/name-claim/v1\|<name>@<domain>\|<at>\|<code, or empty>`      |

`bind` makes sure a name leads only to an inbox whose owner chose it.

The service answers `{ "until": <ms> }`, when the name lapses, or
`{ "error": "…" }` with a 4xx status.

### The name key

Each username has its own name key, derived from the contact key:

```
HKDF-SHA-256(contact key, info = "minca/p256-name-key/v1|" + name@domain)
```

The username is written as `formatUsername` writes it, so every spelling a
reader accepts gives the same key. `claimUsername` derives it for you.

Every device that holds the contact key derives the same name key. It isn't
an inbox key, so replacing the inbox keeps the name. Nothing ties it to the
account. Only the key that holds a name can point it elsewhere, renew it or
give it up.

### Who may claim

A name leads to the account's inbox, so only what may run the inbox may claim
one. That's a node whose note grants `/account/write` for the whole account,
holding the contact key.

An app given the contact key could claim the account's names too. It keeps
that power after it's revoked, since a name key has no generation to move on
to ([#313](https://github.com/leifriksheim/minca/issues/313)).

## What the service keeps to

How a name is claimed isn't protocol. A domain can answer lookups from a file
it edits by hand, or from anything else. The **Minca name service**
(`packages/names`) is what minca.social runs, and anyone can run it.

| Rule                       | On minca.social                                                                  |
| -------------------------- | -------------------------------------------------------------------------------- |
| How long a claim holds     | A year. Claiming again, with the same code or a new one, renews it               |
| New names from one address | 3 a day, per IPv4 address or IPv6 /48. Changing or renewing a name is free       |
| Work                       | 18 bits: a fraction of a second on a laptop, about a second on a phone           |
| Names held                 | 50,000, each a file of up to 8 KB, so a 1 GB volume holds them, inodes included  |
| Reserved                   | `admin`, `support`, `security`, `minca` and a few more that pass for the service |
| Given up                   | Free again after 10 minutes, so no earlier claim can be replayed to take it back |

A lookup of a reserved name answers `"reserved": true`, so `usernameFree`
says it isn't free.

The work is a speed bump for bots, not a gate. A server does it ten times
faster than a phone. What keeps squatting in check is the address budget and
the year: a name nobody renews comes back.

The address budget is kept in memory, so a restart forgets it. Nothing a
client sends can stop the service, since whatever goes wrong with one request
only fails that request.

Each name is its own file on disk, so nothing grows in memory and no large
file is rewritten. Lookups are open to any page
(`Access-Control-Allow-Origin: *`).

## Running one for your domain

The service is `packages/names/server.mjs`, with no dependencies:

```bash
NAMES_DOMAIN=example.org \
NAMES_CLAIM_URL=https://names.example.org/.well-known/minca.json \
NAMES_DIR=/data/names \
node packages/names/server.mjs 8080
```

Then answer `https://example.org/.well-known/minca.json` from it. Either serve
the domain from it, or proxy that one path, as minca.social's site does.

Claims go to `NAMES_CLAIM_URL` directly, so the service sees each client's
address. `packages/names/fly.toml` deploys it on Fly.
