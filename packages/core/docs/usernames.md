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

## Claiming a name

```ts
import { claimUsername } from '@minca/core/inbox';
import { deriveNameKeyBytes } from '@minca/core';

const nameKey = await deriveNameKeyBytes(contactKey, 'leif@minca.social');
const until = await claimUsername('leif@minca.social', nameKey, inboxCode);
```

`claimUsername` looks the name up first. A Minca name service says, in every
answer, where claims go and how much work one needs:

```json
{ "names": {}, "claim": "https://minca-names.fly.dev/.well-known/minca.json", "work": 20 }
```

Then it posts the claim there:

```json
{
  "name": "leif",
  "key": "<name key public half>",
  "at": 1790000000000,
  "work": 731042,
  "code": "<inbox code>",
  "sig": "<base64url>"
}
```

| Field  |                                                                                                                       |
| ------ | --------------------------------------------------------------------------------------------------------------------- |
| `key`  | The **name key**'s public half, compressed P-256, base64url                                                           |
| `at`   | When the claim was made, ms. It must be within 10 minutes of the service's clock, and later than the claim it follows |
| `work` | A counter: SHA-256 of `minca/name-work/v1\|<name>@<domain>\|<key>\|<at>\|<work>` starts with `work` zero bits         |
| `code` | The inbox code, at most 4,096 characters. None gives the name up                                                      |
| `sig`  | The name key's ECDSA P-256 signature over `minca/name-claim/v1\|<name>@<domain>\|<at>\|<code, or empty>`              |

The answer is `{ "until": <ms> }`, when the name lapses, or
`{ "error": "…" }` with a 4xx status.

**The name key** is derived from the contact key, one per username:
`HKDF-SHA-256(contact key, info = "minca/p256-name-key/v1|" + name@domain)`,
in lower case, as the inbox keys are. Every device that holds the contact key
derives the same one; it is not an inbox key, so replacing the inbox keeps
the name, and nothing ties it to the account. Only the key that holds a name
can point it elsewhere, renew it or give it up.

**Who may.** A name leads to the account's inbox, so only what may run the
inbox may claim one: a node whose note grants `/account/write` for the whole
account, holding the contact key. An app given the contact key could claim
the account's names too
([#313](https://github.com/leifriksheim/minca/issues/313)).

## What the service keeps to

| Rule                       | On minca.social                                                                  |
| -------------------------- | -------------------------------------------------------------------------------- |
| How long a claim holds     | A year. Claiming again, with the same code or a new one, renews it               |
| New names from one address | 3 a day (an IPv4 address, or an IPv6 /48). Changing or renewing a name is free   |
| Work                       | 20 bits: a second or two on a laptop, a few on a phone                           |
| Names held                 | 200,000                                                                          |
| Reserved                   | `admin`, `support`, `security`, `minca` and a few more that pass for the service |
| Given up                   | Free again after 10 minutes, so no earlier claim can be replayed to take it back |

The work is a speed bump for bots, not a gate: a server does it ten times
faster than a phone. The address budget and the year are what keep squatting
in check; a name nobody renews comes back.

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
