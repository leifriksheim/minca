# 08 — Hosting

A **host** is a carrier ([06](06-nodes-and-sessions.md) §4) that many accounts
pay to keep their spaces online. This part is the exchange between a device
and a host: subscriptions, payment, a space's own fund, and bots a host runs.
It is not part of the core: peers sync, store and judge every record the same
way whether or not anyone uses a host, and an implementation that never talks
to one needs none of it.

## 1. Hosts

A **host** is a carrier for many accounts, run as a service. Each account that
uses it has a **subscription**: a key pair the account made, a date it is paid
until, and, once a device hands it over, the account's carry space. Spaces
several subscriptions name are held once.

**The subscription key.** When an account first uses a host, the node makes a 32-byte random seed, derives a
P-256 key pair from it, and keeps a `sys.hosting` record in the account
registry, key `hosting:<hex of the first 20 bytes of SHA-256(utf8(url))>`, body:

| Field     | Meaning                                                                      |
| --------- | ---------------------------------------------------------------------------- |
| `url`     | The host's origin: `https://`, or `http://` on `localhost`/`127.0.0.1`.      |
| `host`    | The host's DID, from its description when first used.                        |
| `seed`    | The subscription key's seed, base64url.                                      |
| `since`   | ISO date.                                                                    |
| `name`    | The host's name, as it described itself.                                     |
| `peer`    | Optional: where the host takes peers, resolved from its description (below). |
| `receipt` | The latest `SignedStatus` the host gave (below).                             |

Every device of the account signs as the same subscription. It is not the
account's key: the host learns a subscription, not who pays.

**Description.** `GET <url>/.well-known/minca-host`, public:

| Field    | Meaning                                                                                                                                                              |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `minca`  | `"host/1"`                                                                                                                                                           |
| `did`    | The host's key: its identity to peers, and what signs its statuses.                                                                                                  |
| `name`   | For people.                                                                                                                                                          |
| `free`   | Every subscription counts as paid.                                                                                                                                   |
| `price`  | Optional, free text.                                                                                                                                                 |
| `terms`  | Optional, for people.                                                                                                                                                |
| `peer`   | Optional: where it takes peers over WebSocket ([04](04-network.md)), relative to the host's address or absolute. Absent: devices cannot reach it by its description. |
| `plans`  | Optional: what can be paid for, and how (below). Absent or empty: it takes no payments.                                                                              |
| `remind` | Optional: `true` when it sends reminders by email before paid time runs out (`…/remind`).                                                                            |
| `bots`   | Optional: `true` when it runs bots for the spaces it carries (§3).                                                                                                   |
| `fund`   | Optional: how communities pay here, through a fund (§2). Absent: they can't.                                                                                         |

A device MUST refuse a description whose `minca` is not `host/1` or whose `did`
is not a `did:key`, and MUST treat a host whose `did` changed since it was first
used as a different host.

A **plan** is one way to pay:

| Field    | Meaning                                                                                                                 |
| -------- | ----------------------------------------------------------------------------------------------------------------------- |
| `id`     | What a device sends to start it (`…/pay`).                                                                              |
| `label`  | For people, with the price: `"$4 a month, by card"`.                                                                    |
| `method` | `checkout`: the host answers with a page at a payment provider. `request`: with a payment request for a wallet to send. |
| `renews` | Charged again by itself until cancelled (a card). `false` for time paid up front.                                       |
| `for`    | Who may use it: `["account"]`. A space pays through its fund instead (§2).                                              |

A device shows only plans whose `for` names the subscription it pays for, and
ignores a plan whose `method` it does not know. Example:

```json
{
  "minca": "host/1",
  "did": "did:key:zDnaeXL64…",
  "name": "Minca host",
  "free": false,
  "price": "$4 a month or $36 a year",
  "peer": "/peer",
  "remind": true,
  "bots": true,
  "fund": {
    "monthly": "4",
    "min": "1",
    "methods": ["checkout", "request"],
    "recurring": true,
    "botDailyCap": "1.50"
  },
  "plans": [
    {
      "id": "card-monthly",
      "label": "$4 a month, by card",
      "method": "checkout",
      "renews": true,
      "for": ["account"]
    },
    {
      "id": "wallet-yearly",
      "label": "$36 a year, from a wallet (USDC on Base)",
      "method": "request",
      "renews": false,
      "for": ["account"]
    }
  ]
}
```

**Signed requests.** Every call about a subscription carries

```
Authorization: Minca did=<subscription DID>, at=<unix seconds>, sig=<base64url>
```

where `sig` is the subscription key's signature over the UTF-8 bytes of

```
minca-host/v1\n<METHOD>\n<path and query>\n<at>\n<base64url(SHA-256(body))>
```

(`body` is the exact request body, empty string when none). A host MUST refuse a
request whose header does not match
`^Minca did=(did:key:z[1-9A-HJ-NP-Za-km-z]{1,120}), at=(\d{1,12}), sig=([A-Za-z0-9_-]{1,200})$`,
whose `at` is more than 300 s from its clock, whose signature fails, or whose
signer is not the subscription in the path. Example:

```
Authorization: Minca did=did:key:zDnaet57TmtMH7vQJT8HzNLSZV5sc5JGJub2ZzpX3oHshR2k2, at=1790422901, sig=UD0ynCDYHqxRQ2N08X3On5ljQhEZwyczof1_Zuiv0jhN4rYpoh0pEZ88mPx7hit20d9A5T2oSgvK-UPTetIO_Q
```

(The format only: the signature is illustrative, as the key is not given.)

**Calls.** `<id>` is the subscription DID, URL-encoded or not.

| Call                                    | Body                                                                         | Answer                                                                                                                                  |
| --------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /host/subscriptions/<id>`          | —                                                                            | `SignedStatus`                                                                                                                          |
| `PUT /host/subscriptions/<id>/carry`    | `{ "account": "<account DID>", "invite": "<carry invite, ≤ 16 000 chars>" }` | `SignedStatus`. 402 when not paid (or lapsed); 403 when the host carries only named accounts and this is not one; 400 for a bad invite. |
| `DELETE /host/subscriptions/<id>/carry` | —                                                                            | `SignedStatus`. Stops carrying; the subscription stays.                                                                                 |
| `POST /host/subscriptions/<id>/pay`     | `{ "plan": "<plan id>" }`                                                    | A pay answer (below). 400 for a plan it doesn't have, or one not `for` accounts.                                                        |
| `POST /host/subscriptions/<id>/manage`  | `{}`                                                                         | A pay answer with `checkout`: the provider's page to change the card or cancel. 404 when nothing renews.                                |
| `POST /host/subscriptions/<id>/remind`  | `{ "email": "<address>" }`                                                   | `{}`. 404 when it sends no reminders; 400 for an address it can't use.                                                                  |

Errors are `{ "error": "<message>" }` with 400, 401 (not signed by the
subscription), 402, 403, 404, 405. The reference host sends
`Access-Control-Allow-Origin: *` on these paths and answers `OPTIONS`.

**Signed status.** `SignedStatus = { payload, sig }`, where `payload` is the JSON
text of a `HostStatus` and `sig` is the host key's signature (base64url) over
`utf8("minca-host-status/v1\n" + payload)`. `HostStatus`:

| Field          | Meaning                                                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `subscription` | The subscription DID.                                                                                                          |
| `host`         | The host's DID.                                                                                                                |
| `state`        | `active` (paid, or a free host), `grace` (past `paidUntil`, within the grace period), `lapsed`, `none` (no such subscription). |
| `paidUntil`    | Unix seconds; 0 before any payment.                                                                                            |
| `renews`       | Paid through something that renews by itself (a card).                                                                         |
| `carrying`     | Whether it carries the account's spaces now.                                                                                   |
| `spaces`       | How many spaces the carry space's passes name.                                                                                 |
| `at`           | When the host said it, unix seconds.                                                                                           |
| `bytes`        | Optional: what the subscription's spaces take at the host, as it last measured.                                                |
| `quota`        | Optional: what they may take. Past it the host takes no new space for the subscription; those it carries stay.                 |

A device MUST accept a status only if it verifies under the host's recorded DID,
its `host` equals that DID, and its `subscription` is the device's own. Example:

```json
{
  "payload": "{\"subscription\":\"did:key:zDnaet57…\",\"host\":\"did:key:zDnaeXL64…\",\"state\":\"active\",\"paidUntil\":1821536000,\"renews\":true,\"carrying\":true,\"spaces\":4,\"at\":1790422901}",
  "sig": "cC4uQLCnF0tkMzhAuxHp58tjc2XWhdRpj9RpWgb-wYIhzKvhXhi97DoBn_hvcz9NLyv0ch2bqFMJfTIXgYxQhw"
}
```

(The format only: the DIDs are shortened and the signature is illustrative.)

**Paying.** A device never handles a payment: it shows the host's plans, and
what the host answers when asked to start one. A **pay answer** is one of:

```json
{ "checkout": "https://checkout.stripe.com/c/pay/cs_live_a1b2c3" }
```

```json
{
  "request": {
    "uri": "ethereum:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913@8453/transfer?address=0x1111111111111111111111111111111111111111&uint256=36004217",
    "amount": "36.004217 USDC on Base",
    "expires": 1791027701,
    "evm": {
      "chainId": 8453,
      "chainName": "Base",
      "token": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "to": "0x1111111111111111111111111111111111111111",
      "units": "36004217"
    }
  }
}
```

- `checkout` is a page at a payment provider. A device MUST refuse one that is
  not `https://` (`http://` only on `localhost` or `127.0.0.1`), and opens it
  in a new browsing context with no opener, so the page cannot reach back
  into the device's.
- `request` is a payment for a wallet to send: `uri` a payment URI a wallet
  opens (`ethereum:` per EIP-681, `lightning:` or `bitcoin:`), `amount` for
  people, and `expires` (unix seconds) until when a payment counts. A device
  MUST refuse a `uri` with another scheme. `evm`, optional, spells out an
  ERC-20 transfer (`transfer(to, units)` on `token`, on `chainId`), so a
  wallet in the browser (EIP-1193) can be asked to send it. A device shows
  `amount` as it is: the host tells payments apart by it.

A host sees a request paid by itself, on the network, and moves `paidUntil`;
how is its business. A device asks for the status until it moves. Where a
checkout page sends people back to is the host's business too; a device
never follows a link the host gives, only opens `checkout`.

**Reminders** (`…/remind`) are the host's to send, and its business: the
reference host mails a link to confirm the address before anything else.

**What a device does.** A device asks each host the account uses for its
status. When the status says it is not carrying and it is paid (`active`,
`grace`, or a free host not `lapsed`), the device hands over the carry space
with `PUT …/carry`, making the carrier ([06](06-nodes-and-sessions.md) §4.2) for the host's DID first if the
account has none. It writes the returned receipt into the `sys.hosting` record
when the state, `paidUntil`, `renews` or name changed. To stop using a host it
sends `DELETE …/carry`, removes the carrier and deletes the `sys.hosting`
record. How often the reference asks is in
[the node](../packages/core/docs/node.md#carriers-hosting-and-notifications).

**What a host does.** Subscriptions are `active` while `paidUntil ≥ now` (or
always, when free), `grace` for a grace period after (the host's policy), then
`lapsed`; a lapsed subscription is dropped, and its carry space with it unless
another subscription carries it. Paying again
in time carries again what the grace period kept. A host MAY carry only a
configured list of accounts, and then MUST refuse any other before keeping
anything. It runs the carrier of [06](06-nodes-and-sessions.md) §4.1–4.2 for every carry space.

**Reaching a host.** A device resolves `peer` against the host's address
(`new URL(peer, url + "/")`), reading `https:` as `wss:` and `http:` as `ws:`.
It MUST NOT use an address that is not `wss://`, except `ws://` on
`localhost`, `127.0.0.1` or `[::1]`, and pins it to the host's key
([04 §5.2](04-network.md)). It keeps the resolved address in the
`sys.hosting` record, so the account's other devices have it without asking.
Every device of the account then holds a socket to that address for every
space it holds ([04](04-network.md)), as the host carries all of them through
the carry space. A device also holds one, for that space, to each host a space
it holds pays itself (§2). Example: a host at `https://host.example` that
describes `"peer": "/peer"` is reached at `wss://host.example/peer`, and a
space `b3kq7zp2f4mhx6ydwa5rtc9n1e` at
`wss://host.example/peer?space=b3kq7zp2f4mhx6ydwa5rtc9n1e#<host DID>`.

A device MAY be built with hosts to look for its account registry at before it
knows which the account uses: that is how a new device with only the recovery
code finds its registry, and every space from it. The host learns the
registry's id and the device's session key, and serves it only if it carries
it. The reference reaches those hosts for the registry alone.

_Source: `packages/core/src/session/hosting.ts` (`hostPeerAddress`), `packages/core/src/node/host.ts`, `packages/core/src/node/node.ts` (`hosting`, `reachHosts`), `packages/core/src/node/space-runtime.ts` (`useNodes`), `packages/cli/src/host.ts` (`startPayment`, `watch`), `packages/cli/src/wallet.ts` (`request`, `scan`), `packages/cli/src/reminders.ts`. Tests: `packages/cli/tests/host.test.ts` ("the host API": all; "pay answers": all; "reaching a host at the address it names": all; "a host’s room": all; "wallet payments": all), `packages/cli/tests/reminders.test.ts`._

## 2. A space paying for itself: its fund

A space can also be a host's subscriber: its **own subscription** there, with
a **fund** anyone adds to, so a community keeps itself online together. The
host carries that one space as a carrier would ([06](06-nodes-and-sessions.md) §4.1), from a pass ([06](06-nodes-and-sessions.md) §4.2) any
member's device hands over, and can read no more of it than any carrier.

**The subscription.** It is named `space:<space id>`. It has no key: anyone
may ask how it stands and add to its fund, and a pass proves itself, so
nothing about it is signed but the host's answers. A host MUST refuse a space
id that does not match `^[A-Za-z0-9_-]{1,120}$`.

**The fund.** One balance, in millionths of a US dollar. Every payment into
it adds what was paid, whoever pays and however (once, or every month). The
host takes from it only what it says it will: keeping the space online at its
`fund.monthly` rate, for the time it does, and what the bots it runs in that
space spend (§3). The subscription is `active` while the balance is above
zero, then `grace`, then `lapsed`, as in §1. `paidUntil` is not a date that
was bought: it is the host's estimate of when the balance reaches zero at
what the fund spends now, and it MUST move as that changes (sooner as bots
spend more, later with each payment).

A host that takes payments for communities says how in its description
(§1), as `fund`:

| Field         | Meaning                                                                                                  |
| ------------- | -------------------------------------------------------------------------------------------------------- |
| `monthly`     | Dollars a month that keeping the space online takes from the fund: `"4"`.                                |
| `min`         | Dollars: the least one payment may add.                                                                  |
| `methods`     | How money is added: `checkout` (a page at a payment provider) and/or `request` (a payment for a wallet). |
| `recurring`   | Whether a `checkout` payment may be every month.                                                         |
| `manage`      | Optional: the payment provider's page where someone stops paying every month.                            |
| `botDailyCap` | Optional, when it runs bots: dollars a bot may take from the fund a day at most.                         |

```json
{ "monthly": "4", "min": "1", "methods": ["checkout", "request"], "recurring": true, "botDailyCap": "1.50" }
```

**Calls.** No `Authorization`.

| Call                                  | Body                                                                             | Answer                                                                                                                                                                                        |
| ------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /host/spaces/<space id>`         | —                                                                                | `SignedStatus` (§1), `subscription` `space:<space id>`; `state` `none` before anyone paid or handed a pass                                                                                    |
| `PUT /host/spaces/<space id>/pass`    | `{ "pass": <SpacePass, 06 §4.2> }`                                               | `SignedStatus`. 402 when not paid (or lapsed); 403 when the host carries only named accounts; 400 when the pass does not open, or is for another space. A later pass replaces the one before. |
| `POST /host/spaces/<space id>/pay`    | `{ "amount": "<dollars>", "method": "checkout" \| "request", "monthly"?: true }` | A pay answer (§1) that adds `amount` to the fund. Anyone may. 400 for an amount below `min`, or a method it doesn't take; 403 when the host carries only named accounts.                      |
| `POST /host/spaces/<space id>/remind` | `{ "email": "<address>" }`                                                       | `{}`, as for an account (§1).                                                                                                                                                                 |

`amount` matches `^\d{1,5}(\.\d{1,2})?$`. A `request` for a wallet asks for
the amount plus a fraction of a cent that tells it apart (the reference host
adds 1 to 9 999 millionths); what arrives is added in full.

A host MUST check a pass as a carrier checks one from a carry space ([06](06-nodes-and-sessions.md) §4.2):
its space must verify and hash to the id in the path, and a private space's
read key must be one the space's history names. It carries the space while
the subscription is `active` or `grace`, and drops it when it lapses unless an
account's carry space also names it.

For a space's own subscription, `HostStatus` also has:

| Field     | Meaning                                                                                                                                                                                                                          |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `readKey` | For a private space it carries: the read key it carries it with, as a DID. Absent otherwise.                                                                                                                                     |
| `balance` | What is in the fund, in millionths of a dollar. Absent on a free host.                                                                                                                                                           |
| `daily`   | What the fund spends a day as things go, in millionths of a dollar: the hosting rate and its bots'.                                                                                                                              |
| `bots`    | The bots it runs in the space (§3): `[{ "bot": "<DID>", "name": "<name>", "running": true, "daily": 65000 }]`, `daily` what each took from the fund a day over the last week, in millionths of a dollar (absent on a free host). |

`carrying` is whether it carries the space now, and `spaces` is 1 when it
does. A device compares `readKey` with the space's current read key to know
whether the host needs a newer pass, after the space's key changed. Example
payload:

```json
{
  "subscription": "space:b3kq7zp2f4mhx6ydwa5rtc9n1e",
  "host": "did:key:zDnaeXL64…",
  "state": "active",
  "paidUntil": 1801387701,
  "renews": false,
  "carrying": true,
  "spaces": 1,
  "readKey": "did:key:zDnaejutRdfJ47…",
  "balance": 23400000,
  "daily": 196000,
  "bots": [{ "bot": "did:key:zDnaeYffVz7N…", "name": "Club Bot", "running": true, "daily": 62000 }],
  "at": 1791027701
}
```

**Which host a space uses** is not protocol: the library keeps it in a
`std.host` record that only those who may manage the space write, and every
member's device holding the space key hands that host the pass once the
space is paid for there, and again when its key changes. See
[the node](../packages/core/docs/node.md#a-space-paying-for-itself).

Anyone who knows a space's id can learn whether a host carries it, what is in
its fund and until when, as its status is open. A pass lets its holder
download the space's records sealed, as a carrier does; any member could hand
one over already.

_Source: `packages/core/src/node/host.ts` (`carrySpace`, `spaceSubscription`, `setPaidUntil`), `packages/core/src/node/carrier.ts` (`addPass`, `removePass`), `packages/core/src/session/hosting.ts` (`createSpaceHostClient`, `readPayAnswer`, `FundOffer`), `packages/cli/src/host.ts` (`answerSpace`, `startFund`, `refreshFund`), `packages/cli/src/fund.ts`, `packages/cli/src/stripe.ts` (`fund`). Tests: `packages/cli/tests/host.test.ts` ("a space paying for itself": all), `packages/cli/tests/fund.test.ts`._

## 3. Bots a host runs

A host MAY run **bots** for the spaces it carries: each an account of its own
([01](01-identity.md)) whose keys the host makes and holds, joined to a space
with an invite for the role it should hold ([03](03-spaces.md)), writing as
itself like any member. Every member's device checks what it writes against
that role, as for anyone. It says it is a bot the way any bot does (`bot:
true` on its profile, [the standard library](../packages/core/docs/standard-library.md)).

This is not carrying: a host holding a bot's keys reads what the bot may
read. A device MUST say so to the person before it asks a host for a bot.

**Paid from the space's fund.** A bot has no subscription of its own. It runs
while its space's fund (§2) has money in it, or always on a free host, and
what it spends is taken from that fund, at most `fund.botDailyCap` a day.
With the fund empty, it stays a member and does nothing. What a bot does is
the space's automations naming it ([automations](../packages/core/docs/automations.md)); how
the host thinks for it is the host's business.

**Calls.** No `Authorization`: an invite is all it takes to add a bot, as it
is to add anyone, and its role is all the bot may do.

| Call              | Body                                                       | Answer                                                                                                                                                                                                                                             |
| ----------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /host/bots` | `{ "name": "<≤ 60 chars>", "invite": "<≤ 16 000 chars>" }` | `{ "bot": "<its DID>", "receipt": <SignedStatus> }`, the receipt the invite's space's own (§2). 404 when it runs no bots; 400 for an invite it can't read; 409 when it does not carry the space, or the space has as many bots as the host allows. |

A device MUST accept the answer only if the receipt verifies under the
host's DID and its `subscription` is `space:` and the invite's space id. The
bots a host runs in a space, and whether each is running, are in that
space's status (`bots`, §2), so they are signed with it.

**Stopping a bot** is removing it from the space: it then holds no role
there, and every peer refuses what it writes.

The reference host runs bots only in spaces it carries, each reaching the
space through the host's own socket, so it needs no relay.

_Source: `packages/core/src/session/hosting.ts` (`createSpaceHostClient`: `startBot`), `packages/core/src/node/node.ts` (`hosting.startBot`), `packages/cli/src/hosted-bots.ts`, `packages/cli/src/host.ts` (`answerBot`, `fundOf`), `packages/cli/src/bot-runner.ts`. Tests: `packages/cli/tests/host.test.ts` ("bots a host runs": all)._

## 4. Planned: hosts

> **Planned.** Not normative.
>
> **Storage the person already has.** When the account has connected its own
> storage (a Dropbox or Drive folder, [05](05-sync-and-storage.md) mirrors),
> the device seals the storage grant (for Dropbox, a refresh token) to the
> host's key and hands it over with a new signed call on the subscription. The
> host keeps it encrypted at rest under a key outside its database, never logs
> it, and mirrors the carried spaces into that folder as well as its own
> bucket, so moving to another host means handing it the same folder. A leaked
> grant exposes only ciphertext, since mirrors hold records as they travel.
> Depends on the mirror drivers for those services. Open: Google and OneDrive
> give browser apps no lasting refresh token, so for them consent has to finish
> on the host (or in the extension); and a grant shared by device and host
> disconnects both when revoked at the provider, unless the host gets its own
> consent.
>
> **Invites that name the space's hosts.** A joining device finds a space's
> own hosts (§2) only once it holds the space's records, so with no other
> member online it cannot join through the host that holds the space. An
> invite will name the `peer` addresses of the hosts the space uses, as it
> names relays, and the joining device holds a socket to them until the
> space's records take over. Tracked in
> [#220](https://github.com/leifriksheim/minca/issues/220).
>
> **Stopping a host a space pays.** A space that stops using a host (§2)
> can only act on its own side: it removes the host's bots and changes its
> key, so the host cannot follow. Nothing tells the host, so the fund keeps
> paying and cards that add every month keep being charged. The space will
> say it in `sys.keepers` ([03](03-spaces.md) §10), which is in the clear,
> needs a grant of `/space/keepers`, and every peer already checks: a host carries a space for
> the space's own subscription only while the keepers name its DID, and once
> they no longer do it pauses the subscription, which means it stops carrying,
> stops its bots there, takes nothing more from the fund and cancels payments
> that add every month. The balance stays and counts again if the space names
> the host again. No refunds, and no new call: the subscription has no key,
> so a call would let any pass holder stop it. Open: keepers need
> `/space/keepers` while choosing a host needs only a grant to write
> `std.host`; whether a
> host must be named a keeper before it carries at all; whether a paused fund
> expires. Tracked in [#220](https://github.com/leifriksheim/minca/issues/220).
>
> **Metering beyond storage.** A host that meters requests and bandwidth per
> subscription says so in `HostStatus` as it says `bytes`. Open: the fields,
> and whether a host may stop syncing a space that keeps growing past `quota`
> rather than only taking no new one.
>
> **A reminder before time runs out.** Time paid up front does not renew
> itself (`renews: false`), so the host reminds the person 14 and 3 days before
> `paidUntil` and once when the grace period starts. Email is the host's own
> business: the reference host takes an address with `…/remind` (§1,
> `packages/cli/src/reminders.ts`), and every device already shows the date
> it holds. The protocol route is Web Push through the carry space ([06](06-nodes-and-sessions.md) §4.4,
> Planned): when the person allows it, the home writes a record in the carry
> space, apart from wakes ([03](03-spaces.md) §15), asking for reminders about
> hosting, and the host pushes `{ kind: "hosting", host, paidUntil }`,
> signed like a status. No new call between home and host. Depends on Web Push.
>
> **Paying without being linked to the account.** Today the host can tie a
> payment to the carry space it is then handed. Privacy Pass tokens (RFC 9576)
> — pay once, receive anonymous tokens, spend them for time — would cut that
> link. Not designed.
