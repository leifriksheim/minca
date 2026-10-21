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

| Field        | Meaning                                                                                                                                                              |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `minca`      | `"host/1"`                                                                                                                                                           |
| `did`        | The host's key: its identity to peers, and what signs its statuses.                                                                                                  |
| `name`       | For people.                                                                                                                                                          |
| `free`       | Every subscription counts as paid.                                                                                                                                   |
| `price`      | Optional, free text.                                                                                                                                                 |
| `terms`      | Optional, for people.                                                                                                                                                |
| `peer`       | Optional: where it takes peers over WebSocket ([04](04-network.md)), relative to the host's address or absolute. Absent: devices cannot reach it by its description. |
| `remind`     | Optional: `true` when it sends reminders by email before paid time runs out (`…/remind`).                                                                            |
| `bots`       | Optional: `true` when it runs bots for the spaces it carries (§3).                                                                                                   |
| `fund`       | Optional: how money goes in here, and the price: into an account's balance (below) and a community's fund (§2). Absent: it takes no payments.                        |
| `connectors` | Optional, with `bots`: the services its bots can be connected to (§3.1), each `{ id, name }`.                                                                        |
| `limits`     | Optional: what it keeps for free (§1.1). Absent: every subscription is paid for, or free with `free`.                                                                |

A device MUST refuse a description whose `minca` is not `host/1` or whose `did`
is not a `did:key`, and MUST treat a host whose `did` changed since it was first
used as a different host.

Example:

```json
{
  "minca": "host/1",
  "did": "did:key:zDnaeXL64…",
  "name": "Minca host",
  "free": false,
  "price": "$0.10 a GB a month",
  "peer": "/peer",
  "remind": true,
  "bots": true,
  "fund": {
    "perGb": "0.10",
    "min": "5",
    "methods": ["checkout", "request"],
    "recurring": true,
    "botDailyCap": "1.50"
  }
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

| Call                                    | Body                                                                             | Answer                                                                                                                                                                              |
| --------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /host/subscriptions/<id>`          | —                                                                                | `SignedStatus`                                                                                                                                                                      |
| `PUT /host/subscriptions/<id>/carry`    | `{ "account": "<account DID>", "invite": "<carry invite, ≤ 16 000 chars>" }`     | `SignedStatus`. 402 when not paid (or lapsed); 403 when the host carries only named accounts and this is not one; 400 for a bad invite.                                             |
| `DELETE /host/subscriptions/<id>/carry` | —                                                                                | `SignedStatus`. Stops carrying; the subscription stays.                                                                                                                             |
| `POST /host/subscriptions/<id>/pay`     | `{ "amount": "<dollars>", "method": "checkout" \| "request", "monthly"?: true }` | A pay answer (below) that adds `amount` to its balance. 400 for an amount below `fund.min` or not matching it as in §2, or a method it doesn't take; 404 when it takes no payments. |
| `POST /host/subscriptions/<id>/remind`  | `{ "email": "<address>" }`                                                       | `{}`. 404 when it sends no reminders; 400 for an address it can't use.                                                                                                              |

Errors are `{ "error": "<message>" }` with 400, 401 (not signed by the
subscription), 402, 403, 404, 405. The reference host sends
`Access-Control-Allow-Origin: *` on these paths and answers `OPTIONS`.

**Signed status.** `SignedStatus = { payload, sig }`, where `payload` is the JSON
text of a `HostStatus` and `sig` is the host key's signature (base64url) over
`utf8("minca-host-status/v1\n" + payload)`. `HostStatus`:

| Field          | Meaning                                                                                                                                                                     |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `subscription` | The subscription DID.                                                                                                                                                       |
| `host`         | The host's DID.                                                                                                                                                             |
| `state`        | `active` (paid, or a free host), `grace` (past `paidUntil`, within the grace period), `lapsed`, `none` (no such subscription).                                              |
| `paidUntil`    | Unix seconds; 0 before any payment.                                                                                                                                         |
| `renews`       | Paid through something that renews by itself. Always `false` for a balance: a card that adds every month is the payer's own (`fund.manage`).                                |
| `carrying`     | Whether it carries the account's spaces now.                                                                                                                                |
| `spaces`       | How many spaces the carry space's passes name.                                                                                                                              |
| `at`           | When the host said it, unix seconds.                                                                                                                                        |
| `bytes`        | Optional: what the subscription's spaces take at the host, as it last measured.                                                                                             |
| `quota`        | Optional: what they may take. Past it the host takes no new space for the subscription; at a host with `limits`, the free room while its balance does not pay (Room, §1.1). |
| `balance`      | Optional, at a host that takes payments: what is in the subscription's balance, in millionths of a dollar; below zero by what its grace (and a bot's last call, §3) took.   |
| `daily`        | Optional, with `balance`: what it spends a day as things go, in millionths of a dollar.                                                                                     |
| `plan`         | Optional, at a host with `limits`, for an account's subscription: `"paid"` while its balance pays for what is past its free room, `"free"` otherwise (§1.1).                |
| `over`         | Optional, at a host with `limits`: the spaces this subscription names that are over the free line (§1.1), each an `OverSpace`.                                              |
| `usage`        | Optional, at a host with `limits`, for a space's own subscription: how much the space is used (§1.1), a `SpaceUsage`.                                                       |
| `full`         | Optional, at a host with `limits`: `{ since, until }`, unix seconds, from when its spaces took more than `quota` until a whole window after they fit again (§1.1, Room).    |

A device MUST accept a status only if it verifies under the host's recorded DID,
its `host` equals that DID, and its `subscription` is the device's own. Example:

```json
{
  "payload": "{\"subscription\":\"did:key:zDnaet57…\",\"host\":\"did:key:zDnaeXL64…\",\"state\":\"active\",\"paidUntil\":1821536000,\"renews\":true,\"carrying\":true,\"spaces\":4,\"at\":1790422901}",
  "sig": "cC4uQLCnF0tkMzhAuxHp58tjc2XWhdRpj9RpWgb-wYIhzKvhXhi97DoBn_hvcz9NLyv0ch2bqFMJfTIXgYxQhw"
}
```

(The format only: the DIDs are shortened and the signature is illustrative.)

**The balance.** An account pays as a community does (§2): into a balance,
any amount, from which the host takes its `fund.perGb` rate a month for each
GB (10⁹ bytes) the subscription's spaces take past `limits.accountBytes`
(every GB, at a host without `limits`), by the byte and for the time they
do. Its state, its grace and `paidUntil` go as a fund's do (§2): `active`
while the balance is above zero, a grace lent as a fund's is, and
`paidUntil` the host's estimate. At a host with `limits` an account's
balance is lent no grace: its room's notice is its grace (§1.1). Its status says `balance` and `daily`. The
host learns how much was paid into which subscription, never by whom.

**Paying.** A device never handles a payment: it shows the host's price
(`fund`), and what the host answers when asked to take one. A **pay answer**
is one of:

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

A host sees a request paid by itself, on the network, and adds it to the
balance; how is its business. A device asks for the status until it moves. Where a
checkout page sends people back to is the host's business too; a device
never follows a link the host gives, only opens `checkout`.

**Reminders** (`…/remind`) are the host's to send, and its business: the
reference host mails a link to confirm the address before anything else.

**What a device does.** A device asks each host the account uses for its
status. When the status says it is not carrying and it is paid (`active`,
`grace`, or not `lapsed` at a host that is free or has `limits`), the device hands over the carry space
with `PUT …/carry`, making the carrier ([06](06-nodes-and-sessions.md) §4.2) for the host's DID first if the
account has none. It writes the returned receipt into the `sys.hosting` record
when the state, `paidUntil`, `renews` or name changed. To stop using a host it
sends `DELETE …/carry`, removes the carrier and deletes the `sys.hosting`
record. How often the reference asks is in
[the node](../packages/core/docs/node.md#carriers-hosting-and-notifications).

**What a host does.** Subscriptions are `active` while `paidUntil ≥ now` (or
always, when free; or, for an account's, always at a host with `limits`,
§1.1), `grace` for a grace period after (the host's policy), then
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

_Source: `packages/core/src/session/hosting.ts` (`hostPeerAddress`), `packages/core/src/node/host.ts`, `packages/core/src/node/node.ts` (`hosting`, `reachHosts`), `packages/core/src/node/space-runtime.ts` (`useNodes`), `packages/cli/src/host.ts` (`startFund`, `watch`), `packages/cli/src/fund.ts`, `packages/cli/src/wallet.ts` (`request`, `scan`), `packages/cli/src/reminders.ts`. Tests: `packages/cli/tests/host.test.ts` ("the host API": all; "pay answers": all; "reaching a host at the address it names": all; "a host’s room": all; "wallet payments": all), `packages/cli/tests/reminders.test.ts`._

### 1.1 Limits: free hosting, paid room, and the free line

A host may keep every account's spaces online without payment, within
limits, and ask a community to pay for itself once it grows past them. It is
blind, so it draws the line only on what it can see of a space: how many
accounts write there, how many devices read, and how many bytes it holds.
The numbers are each host's own; it says them in its description, so a
person can compare hosts before choosing one.

**Description.** `limits`:

| Field          | Meaning                                                                                                                                                                      |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `accountBytes` | Bytes an account's spaces may take for free: its `quota` while its balance does not pay. Past them, a balance pays (§1).                                                     |
| `space`        | The free line for a space several accounts write in: `{ writers, bytes, windowDays, readers? }`, below.                                                                      |
| `graceDays`    | Days a space over the line is still carried for its members' subscriptions before only its own subscription (§2) carries it; and the notice for room (Room).                 |
| `keepDays`     | Optional: days the host keeps a space it stopped carrying for being over the line, or held back for room (Room), so a fund or room made in that time brings it back at once. |
| `idleDays`     | Optional: days a free subscription is kept with no signed call from any of its devices. Absent: kept while the host runs.                                                    |

```json
{
  "limits": {
    "accountBytes": 250000000,
    "space": { "writers": 10, "bytes": 500000000, "windowDays": 30, "readers": 50 },
    "graceDays": 30,
    "keepDays": 30,
    "idleDays": 180
  }
}
```

Each number is a non-negative integer below 2⁵³, and `space.windowDays` at
least 1. A device MUST ignore a
`limits` that is not an object with every field it requires well formed,
and still read the rest of the description: limits are for showing, and a
host that describes them badly is still a host. `free: true` means what it
always did, every subscription paid and no limits, and a host that says it
MUST NOT also give `limits`.

**Plans.** At a host with `limits`, an account's subscription is `active`
without payment: `plan` is `"paid"` while its balance is above zero and
`"free"` otherwise. Paying, it has no `quota`: its balance pays for what is
past `accountBytes`. On the free plan its `quota` is `accountBytes`. So when
a balance runs out, its room is the free one again, and the notice (Room)
is its grace: nothing below zero is taken from it. A balance whose spaces fit
in the free room draws nothing, so it stays `"paid"` and is not dropped for
`idleDays`. It is never `grace` or `lapsed` for want of payment, and is
dropped only after `idleDays` with no signed call (§1) from any of its
devices. What a space's own subscription carries (§2), while `active`,
counts against no account's quota; its fund pays for its size instead (§2).
A quota of 0 is a quota: no room.

**Room.** At a host with `limits` a quota is kept, not only a bar to new
spaces. A subscription's room counts its carry space and every space it
names, carried or not, but those paying for themselves and those past the
free line. When they pass its `quota`, the host says so in its status
(`full`) and keeps carrying for `graceDays`; the notice is the account's, not
the subscription key's, and goes only after a whole `windowDays` of fitting,
so neither a new key nor a dip under starts it again. Past `until`, while
still over, it MUST NOT carry the largest of those spaces for that
subscription until the rest fit; another subscription with room that names
one still has it carried. It keeps what it held of them, unserved, for
`keepDays` from when each was first held back (none, without `keepDays`),
then deletes what its bucket keeps of one no subscription carries; the
space is still named, comes back once it fits, and goes to the bucket whole
again. An account over by its carry space alone is carried for no more,
under any key, until it pays (its balance then has no room to be over) or
the host's owner says. Members' devices keep
everything. A space's own fund pays for its size instead (§2).

**The free line.** Over the last `windowDays`, a host counts for each space
it carries for members' subscriptions, carry spaces among them:

- **writers**: distinct accounts with a version of the space that reached the
  host and passed its gates (02 §3), the account being the issuer of the
  version's note (`proof`), or its `author` when it has none, and that are
  members of the space (03 §4) when the host counts. Joining writes a
  version, so a member counts from when they join, and one removed counts no
  more. A version counts by when it arrived, never by its `createdAt`, which
  is its writer's to say: only while the host first catches up on a space it
  has just started carrying is a version that says it is older than the
  window taken as history, and not counted (the reference host: the first
  10 minutes). Accounts the host runs, its bots (§3), are not counted.
- **readers**: distinct session DIDs that a socket for the space
  (`/peer?space=`) proved (04 §5). The reference host keeps at most 10 000
  for a space over its window, and a million over every space, so made-up
  keys cost it no more memory past that; one account with many spaces can
  fill the million, after which readers stop growing anywhere. It keeps at
  most 50 000 writers for a space a day.
- **bytes**: what the space takes at the host.

A space is **over the line** when `writers` exceeds `space.writers` (and at
least 1), or when it has at least two writers and `bytes` exceeds
`space.bytes`. Readers are
only reported: they are cheap to make up, so they MUST NOT put a space over
the line. A space only one account writes in is never over the line,
however large: it counts against the quota of every account that names it,
as any space does.

When a space goes over, the host notes when (`since`) and keeps carrying it
for `graceDays` (`until = since + graceDays × 86 400`), saying so in the
status of every subscription that names it. Past `until`, if the space is
over the line then, or was at any look in the 7 days before `until`, it
MUST NOT carry it for members' subscriptions alone:
only its own subscription (§2), while `active` or `grace`, carries it then.
One back under more than 7 days before `until`, as when its members removed
those who pushed it over once told, keeps its line and is carried as before, until it is over again or
free again. Before `until` it MUST carry it as before. While the space's own subscription is `active`, the host still
counts and dates the line, but carrying does not depend on it. The grace is given once: paying for a while does not start it again,
so once the space's own subscription stops being `active`, members'
subscriptions carry it again only if `until` is still ahead or it is under
the line. Its members hear nothing of the line while the fund pays, so a
fund that lapses after `until` stops members' carrying it with no new
notice; the fund's own status says when it runs out. A space comes
back under the line only after `windowDays` with every count at or below 80%
of its limit. One the host stopped carrying sees no writes, so it comes back
only through its own subscription, or once the host forgets it after
`keepDays`, when it is counted again from nothing. A space whose grace is
spent, because it was stopped or because the grace ran out while it was
under, gets only a short notice should it go over again (the reference
host: 7 days), never a whole grace; one free again after a whole window
under has its grace back, and so does one stopped and forgotten, a window
after `keepDays`. Nobody naming a space for a while changes none of this:
its line stays until it ends by these rules. A carry space over the line past `until` stops
being that subscription's carry space, and the host refuses it as one until
its own subscription pays.

Stopping changes nothing a peer checks: members' devices keep their copies
and sync with each other directly, and a subscription that names the space
still names it. The host keeps what it held for `keepDays`, unserved, so
that once the space's own subscription is paid it carries it again from
where it was.

A carry space is the account's alone (06 §4.2): at a host with `limits`, one
the host already carries, or another subscription's passes name, is refused
as a carry space, as is one in which another account is a founder or holds a
role; and one that comes to be shared is let go, so that every member's own
pass carries it and every member is told of the line.

A host with `limits` takes payments for communities (§2 `fund`): a line
that stops carrying a community needs a way for it to pay for itself.

**Status.** For an account's subscription, `over` lists the spaces its
carry space names that are over the line, and those it no longer carries
for that reason, but none whose own subscription is `active`, and none back
under the line and still carried:

| `OverSpace` field | Meaning                                                                      |
| ----------------- | ---------------------------------------------------------------------------- |
| `space`           | The space id.                                                                |
| `since`           | When it went over, unix seconds.                                             |
| `until`           | When carrying it for members' subscriptions stops, or stopped, unix seconds. |
| `reasons`         | Which limits it is over: a non-empty subset of `"writers"`, `"bytes"`.       |

For a space's own subscription, and so at `GET /host/spaces/<space id>`,
`usage` says how the space is used, and `over` holds its one `OverSpace`
while it is over the line, whether or not anyone pays for it:

| `SpaceUsage` field | Meaning                                                |
| ------------------ | ------------------------------------------------------ |
| `writers`          | Distinct accounts that wrote, over the window.         |
| `readers`          | Distinct session DIDs that read, over the window.      |
| `bytes`            | What the space takes at the host, as it last measured. |
| `windowDays`       | The window counted over.                               |

Example payload, for an account on the free plan in a community over the
line:

```json
{
  "subscription": "did:key:zDnaet57…",
  "host": "did:key:zDnaeXL64…",
  "state": "active",
  "paidUntil": 0,
  "renews": false,
  "carrying": true,
  "spaces": 6,
  "bytes": 41200000,
  "quota": 250000000,
  "plan": "free",
  "over": [
    {
      "space": "b3kq7zp2f4mhx6ydwa5rtc9n1e",
      "since": 1791027701,
      "until": 1793619701,
      "reasons": ["writers"]
    }
  ],
  "at": 1791114101
}
```

A device MUST ignore an `over` entry or a `usage` that is not shaped as
above, and SHOULD show a person each space in `over` with its `until`, and
how its members can start its fund (§2) before then.

**Abuse.** A host with `limits` carries for anyone who asks, so it limits how
fast subscriptions are made and how much one account may name. The
reference host makes at most 5 subscriptions a day for one address, an IPv6
/64 counting as one, by any call that makes one, and carries at most 200
spaces for one subscription, counted as it reads the carry space's passes;
one past that takes no new space, as past its quota. Behind a proxy it takes the address from a header only when
told which (on Fly, Fly's own), and then the last address in it, the one
the proxy added. These are its own
numbers, not the protocol's, and they slow a stranger rather than stop one:
an account is only a key.

**Privacy.** The counts are what the host sees already: every version's
note names its account in the clear (02 §3.1), and every socket's hello its
session DID. To count, the reference host keeps, for `windowDays`, the
accounts that wrote in each space on each day as salted hashes; the readers
it keeps in memory only. `usage` gives only counts, never who. It is open
to anyone who knows the space id, as its status is, so it tells them
roughly how busy the space is, and, asked again and again, when its members
are online.

_Source: `packages/core/src/session/hosting.ts` (`HostLimits`, `hostLimits`, `OverSpace`, `SpaceUsage`, `describeHost`), `packages/core/src/node/usage.ts` (`createUsageMeter`), `packages/core/src/node/host.ts` (`plan`, `evaluate`, `sweep`, `setFull`, `holdForRoom`, `refuse`, `fullUntil`), `packages/cli/src/fund.ts` (`settle`, `daily`), `packages/core/src/node/carrier.ts` (`skip`, `onArrived`), `packages/cli/src/host.ts` (`usageOf`, `quotaFor`, `statusOf`), `packages/cli/src/serve.ts` (`onPeer`), `packages/cli/src/host-setup.ts` (`limitsFromEnv`). Tests: `packages/core/tests/usage.test.ts`, `packages/core/tests/host-limits.test.ts`, `packages/cli/tests/host.test.ts` ("a host with limits": all)._

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
`fund.perGb` rate for each GB (10⁹ bytes) its space takes, and for one GB if
it takes less, for the time it does, and what the bots it runs in that space
spend (§3). The subscription is `active` while the balance is above zero,
then `grace`, then `lapsed`, as in §1. A grace is lent, never given, and
in money: after the balance reaches zero the host goes on taking its rate,
below zero, until it owes as much as the largest single payment ever made
into it, or for its grace period at most,
whichever comes first, and then takes nothing more, whatever the space
grows to. So a grace is what that payment would buy again at the size the
space is then, and no payment, whoever makes it, ever shortens one. A
payment that brings a fund back above zero after its grace was spent lends
the grace after it no more than it left above zero, and what is added
after, so whoever revives a fund pays for the grace they start. A fund
nothing was ever added to owes nothing. The rate follows the size as the
host last measured it, and time the host was down for more than an hour is
charged to nobody. A payment pays what is owed
first, so one that leaves the balance at or below zero turns nothing back
on, and each grace is paid for by the payment after it. So the least
payment into a large space buys a short grace. `paidUntil` is not a date
that was bought: it is the host's estimate of when the balance reaches zero
at what the fund spends now, and it MUST move as that changes (sooner as
bots spend more, later with each payment). Once it ran out, it is the date
the host's grace period counts from so that it ends where the fund stops
drawing, in time or in money: while its grace still runs, a payment that
leaves it owing moves it later by what that payment pays for, never past the
grace period from when it ran out; once the grace is spent, in time or in
money, such a payment moves nothing. A fund is never drawn on past it.

A host that takes payments says how in its description (§1), as `fund`, for
accounts' balances and communities' funds alike:

| Field         | Meaning                                                                                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `perGb`       | Dollars a month for each GB kept online: a fund pays for each its space takes, at least one; an account's balance for each past its free room (§1): `"0.10"`. |
| `min`         | Dollars: the least one payment may add.                                                                                                                       |
| `methods`     | How money is added: `checkout` (a page at a payment provider) and/or `request` (a payment for a wallet).                                                      |
| `recurring`   | Whether a `checkout` payment may be every month.                                                                                                              |
| `manage`      | Optional: the payment provider's page where someone stops paying every month.                                                                                 |
| `botDailyCap` | Optional, when it runs bots: dollars a bot may take from the fund a day at most.                                                                              |
| `botTypical`  | Optional, when it runs bots: dollars one usual bot reply takes from the fund, as the host reckons it, matching `^[0-9]{1,5}(\.[0-9]{1,4})?$`: `"0.038"`.      |
| `lines`       | Optional: what it charges for, in words for people, each `{ for, name, price }`.                                                                              |

A host MUST give `perGb`, `min`, `botDailyCap` and `botTypical` as dollars
matching `^[0-9]{1,5}(\.[0-9]{1,4})?$`. Every field but `perGb`, `min`,
`methods` and `recurring` is for people: a
device shows it and counts on none of it, and what the host takes is still
only what this section says. `botTypical` and `lines` are how a host says what
a person can't tell from the numbers, its model and its price per token, say,
without a new field for each. In a line, `for` says where it belongs:
`hosting`, beside keeping the space online; `bots`, beside each bot; any other,
on its own, and a `hosting` line goes beside the `perGb` rate, never in its
place. A device MUST treat a `fund` whose `perGb` or `min` does not match
`^[0-9]{1,5}(\.[0-9]{1,4})?$` as absent, MUST leave out a `botDailyCap` or
`botTypical` that does not match it, a `manage` that is not an `https:` URL,
and a method it does not know, MUST show a host that is not `free` and has
no `fund` it keeps as taking no payments there, never as free, MUST
leave out a line whose `for` does not match `^[a-z0-9-]{1,40}$` or whose `name`
or `price` is not a string of 1 to 60 UTF-16 code units with no control or format
characters (Unicode `Cc`, `Cf`), MUST show at most the first
eight lines that remain, and MUST show them as text only.

```json
{
  "perGb": "0.10",
  "min": "5",
  "methods": ["checkout", "request"],
  "recurring": true,
  "botDailyCap": "1.50",
  "botTypical": "0.038",
  "lines": [{ "for": "bots", "name": "Claude Sonnet 5.5", "price": "$3 / $15 per million tokens" }]
}
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
account's carry space also names it. At a host with `limits`, an account's carry space naming it
keeps it only while it is under the free line, or before that line's `until`
(§1.1).

For a space's own subscription, `HostStatus` also has:

| Field     | Meaning                                                                                                                                                                                                                          |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `readKey` | For a private space it carries: the read key it carries it with, as a DID. Absent otherwise.                                                                                                                                     |
| `balance` | What is in the fund, in millionths of a dollar; below zero by what its grace (and a bot's last call) took, which the next payment pays first. Absent on a free host.                                                             |
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

_Source: `packages/core/src/node/host.ts` (`carrySpace`, `spaceSubscription`, `setPaidUntil`), `packages/core/src/node/carrier.ts` (`addPass`, `removePass`), `packages/core/src/session/hosting.ts` (`createSpaceHostClient`, `readPayAnswer`, `FundOffer`, `fundLines`, `describeHost`), `packages/cli/src/host.ts` (`answerSpace`, `startFund`, `refreshFund`), `packages/cli/src/hosted-bots.ts` (`botFundWords`), `packages/cli/src/fund.ts`, `packages/cli/src/stripe.ts` (`fund`). Tests: `packages/cli/tests/host.test.ts` ("a space paying for itself": all; "bots a host runs": "a bot runs from its community’s fund"), `packages/cli/tests/fund.test.ts`, `packages/core/tests/fund-lines.test.ts`._

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

### 3.1 Connecting a bot to a service

A host may connect its bots to services outside Minca, each through the
service's own consent screen: GitHub, a calendar, a drive. Which services,
and everything between the host and each, is the host's: its pages, what it
keeps, what the bot may do there. This part fixes only the exchange between
the person's app and the host around them, so that any app can connect a bot
at any host. No secret of a service enters the space.

**What a host offers.** Its description names the services as `connectors`:

```json
{
  "connectors": [
    { "id": "github", "name": "GitHub" },
    { "id": "calendar", "name": "Calendar" }
  ]
}
```

`id` is 1 to 40 lowercase letters, digits and dashes, and names the service
in the addresses and records below; `name` is for people, 1 to 60
UTF-16 code units with no control or format characters (Unicode `Cc`, `Cf`), as a
fund's lines (§2). A device MUST ignore an entry that isn't both.

**Who may.** Someone who holds `/std.automation/instruct` in the space and
every role the bot holds there, by the host's view of the space's access
history, read as any peer reads it; never a bot, the one in question or
another this host runs, as no integration installs another. The request is a
`std.*` record, which a host otherwise has no reason to read: here it is the
exchange between the person's app and the host, so this part says how the
host reads it.

**The request.** The person's device makes a random secret of at least 32
bytes, keeps it, and writes a `std.connect` record (packages/core/docs/bots.md),
`kind` the service's `id`:

```json
{
  "bot": "did:key:zDnaeYffVz7N…",
  "kind": "github",
  "verifier": "<base64url(SHA-256(secret))>",
  "expires": "2026-10-15T12:10:00Z"
}
```

It then opens, in a window of its own:

```
GET <host>/host/bots/<bot DID>/connect/<id>?space=<space id>&request=<record key>&secret=<base64url(secret)>
```

The host MUST answer with the service's consent screen only if all of these
hold, and otherwise with a page that says why:

1. It offers that service, runs the bot, and the bot holds the space.
2. The record at `request` is in that space, verified, not deleted, its first
   version (`seq` 0), signed by its creator under a note that may do more than
   write records (not `recordsOnly`, as an agent's note is), in `std.connect`.
3. Its `bot` is the bot in the path, its `kind` the `id` in the path, it has a
   `verifier`, and no `disconnect`.
4. `expires` is later than now and no more than 600 seconds from now.
5. SHA-256 of `secret` is `verifier`, compared in constant time.
6. Its writer may configure the bot, as above.
7. No earlier call used that record.

Once a request passes these checks the host MUST mark it used before it
answers, so that of two calls with it at once only one passes; a call it
refuses leaves it unused, since the record may not have reached it yet. It
MUST bind the consent screen's return to the bot, the space, the service and
the writer with a one-time `state` of at least 32 random bytes that lasts at
most 15 minutes. It MUST also bind that return to the browser: it sets a
cookie of at least 32 random bytes on the answer (`HttpOnly`, `SameSite=Lax`,
`Secure` over https, scoped to where the service returns), keeps its hash
with the state, and refuses a return without it. Otherwise someone could open
the page, then send the service's link to someone else, and finish with
their consent. When the browser returns, the host MUST check again that the
writer may configure the bot.

The secret travels in the page's address, so it can reach the host's logs and
the browser's history. It counts once and for ten minutes at most. Whoever
holds an unused link can finish it with an account at the service they
control: the link is a bearer link, as most "connect your account" links are.

**What the bot says.** Once connected, the bot writes its own `std.connector`
naming the service, the account there and what it reaches, as people read
them, so the app shows whose account it is; an app MUST show one only when
the bot it names wrote it. When a host stops acting through a connection is
its own: no peer can check it (the reference host's is in
[bots](../packages/core/docs/bots.md)).

**Disconnecting.** The device writes a `std.connect` as above with
`"disconnect": true`, and calls:

| Call                                  | Body                               | Answer                                                                   |
| ------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------ |
| `POST /host/bots/:bot/disconnect/:id` | `{ "space", "request", "secret" }` | `{ "disconnected": true }`; 400, 403 or 404 with `{ error }`, as checked |

The host MUST check the request as for connecting, except that it must ask to
disconnect, and then MUST forget the connection; the bot deletes its
`std.connector`.

How the reference host connects GitHub, and what a bot does with a
connection, are the library's ([bots](../packages/core/docs/bots.md)): no
peer can check them.

_Source: `packages/cli/src/host-connect.ts` (`createBotConnect`: `start`, `finish`, `disconnect`, `check`, `usable`), `packages/cli/src/connectors/connector.ts` (`HostConnector`), `packages/core/src/schemas/connectors.ts` (`mayConfigure`, `connect`, `connector`), `packages/core/src/session/hosting.ts` (`connectorOffers`), `packages/cli/src/host.ts` (`CONNECT_PATH`, `CALLBACK_PATH`, `DISCONNECT_PATH`). Tests: `packages/cli/tests/host-connect.test.ts` (all; "a host’s own connectors"), `packages/cli/tests/host.test.ts` ("connecting a bot to GitHub": all), `packages/core/tests/host-connectors.test.ts`._

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
> and an account with several subscriptions or refused for good
> ([#289](https://github.com/leifriksheim/minca/issues/289)).
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
