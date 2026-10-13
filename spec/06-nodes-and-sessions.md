# 06 — Nodes, sessions and apps

This part covers what a **node** must do to act for an account: the session
note it writes under, and what it keeps current for the account. Then the
exchanges that let a program act without the seed: **connecting an app** to
an account home, **connecting by code** a program that has no browser, and
**carriers** that keep spaces online without reading them. Hosts, carriers many accounts pay for, are in
[08 — Hosting](08-hosting.md). Calls, built only from live messages, are
a layer on it and described with the library
([calls](../packages/core/docs/calls.md)).

The node's programming interface is not protocol, and another implementation
may shape its own however it likes. The reference one is described in the
package docs: [the node](../packages/core/docs/node.md) (creating one, stores,
holding spaces, following the account, events, the app-side client, carriers
and hosting), [sign-in](../packages/core/docs/sign-in.md) (including the
account home's side of §2), [agents](../packages/core/docs/agents.md) (the
library's and the CLI's use of §3), and
[actions](../packages/core/docs/actions.md) (the CLI, MCP and WebMCP tools).

Material specified elsewhere is linked, not repeated:

| Topic                                                                                                                                                                                                                                                                                                                                  | Where                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Seeds, recovery codes, DIDs, the account vault and its wraps, notes, device keys, contact and member keys, phone pairing and the channel it runs on                                                                                                                                                                                    | [01 — Identity](01-identity.md)                 |
| Records, versions, `seq`, rules, topics and tags                                                                                                                                                                                                                                                                                       | [02 — Records](02-records.md)                   |
| Spaces, roles and grants, the access log (`sys.role`, `sys.assign`, `sys.remove`, `sys.invite`, `sys.revoke`, `sys.collection`, `sys.key`, `sys.relays`, `sys.keepers`, `sys.fork`, `sys.stepdown`, `sys.succeed`), the constitution, invites, encryption, the account registry (`sys.joined`, `sys.profile`, `sys.carrier`), profiles | [03 — Spaces](03-spaces.md)                     |
| Relays, rooms, peer authentication, the network message envelope, the `who` note exchange, live messages and their limits, TURN                                                                                                                                                                                                        | [04 — Network](04-network.md)                   |
| Negentropy, stores, storage adapters, data folders, mirrors, what a node that holds part of a space says it holds                                                                                                                                                                                                                      | [05 — Sync and storage](05-sync-and-storage.md) |
| Names, doors, the relay mailbox                                                                                                                                                                                                                                                                                                        | [07 — Doors](07-doors.md)                       |

Terms used here:

- **Account** — an identity derived from a seed; its DID is the _root_ of every
  record it writes ([01](01-identity.md)).
- **Note** — a delegation from an account (or a key holding one) to
  another key, in the UCAN 1.0 profile of [01](01-identity.md) §7. A **session note** is the note a node's session key writes under.
- **Session key** — the P-256 key a node signs records with and proves on the
  wire. Its DID is the node's `sessionDid`.
- **Account home** — a page that holds an account's seed and grants notes to
  apps. It is a sign-in page (the reference one: [sign-in](../packages/core/docs/sign-in.md)) plus
  the home side of §2.
- **Carrier** — a node that keeps spaces online without being able to read or
  write them. A **host** is a carrier for many accounts, which they pay for.

---

## 1. The node

### 1.1 What a node is

A node acts for one account and signs with one session key at a time. It
holds a set of spaces, each with its own store and its own peers.

A node MAY hold the **account key** ([01 §11.1](01-identity.md)). A node that is
not one of the account's own devices (an app's, or any other program's) is
never given the local key.
With it the node follows the account registry — the account's list of spaces,
its name, its carriers, hosts and subscriptions — and joins and leaves spaces as
the account does on any device (§1.3). Without it, the node holds only the
spaces it was given or joined itself.

A node MAY hold the **contact key** (`deriveContactKeyBytes(seed)`). With it the
node opens contact requests sent to the account and publishes the contact key's
public half on the account's profile in every space it writes in.

_Source: `packages/core/src/node/node.ts`, `packages/core/src/node/types.ts`. Tests: `packages/core/tests/node.test.ts`._

### 1.2 The session note, and renewing it

The root key never signs records. The node asks its signer for one note that
lets the session key do everything the account can, everywhere:

```json
{ "aud": "<sessionDid>", "sub": "<account DID>", "cmd": "/", "pol": [], "exp": <now + ttl>, … }
```

(The token and how peers verify it are in [01](01-identity.md) §7.)
Every record this node signs carries the current note as its `proof`, one
token, and every live connection opens with it (the `who` message,
[04](04-network.md)).

The node asks for a new note before the one it holds runs out. A note's time
bounds only live checks: knocks, live messages, a peer's proof when it
connects ([01](01-identity.md) §7.6). Records are judged with no time at all,
so what a key signed counts until the key is revoked ([02](02-records.md)
§9.3). Signing out writes a revoke of the session key in every space the node writes in,
its carry spaces, the contacts space and the account registry, with a cutoff
at what it wrote, and a device that kept the key forgets it (`revokeSelf`).
The revokes reach other peers as this device next syncs: one that never goes
online again never delivers them. An app's note from an account home is never
renewed in place (§2.9).

> Rationale: one root signature an hour, never one per write. The root — a seed
> in a page, an account home, anything — can stay out of reach of the code that
> writes.

When and how the reference node renews is in [the node](../packages/core/docs/node.md#renewing-the-session-note).

_Source: `packages/core/src/node/node.ts` (`SESSION_COMMAND`, `scheduleRenewal`). Tests: `packages/core/tests/node.test.ts` ("the delegation is renewed before it expires", "records outlive the session that wrote them")._

### 1.3 The spaces a node keeps

The account's list of spaces is the `sys.joined` records in its account
registry, one per space, keyed `space:<id>` ([03](03-spaces.md)). Only
`sys.joined` records that verify and whose root is the account itself count.
A record whose space key changed is rewritten with an invite carrying the key
in use now, so a new device joins with it.

A node holding the account key follows that list, and keeps what carriers
depend on current: each live carrier's passes and `carry:closed` (§4.2), and
the account's carriers named as keepers of the spaces it manages (§4.2). A
carrier sees only what these devices write, so without them it carries stale
passes or none.

The account registry, the contacts space and carry spaces are the account's
own machinery. In them a record counts only under a note that grants
`/account/write` ([01](01-identity.md) §8), and a node always holds them whole
([05](05-sync-and-storage.md) §5). A node whose note lacks it, such as one
granted records only, never writes the account registry: no `sys.joined`, no
passes, no name, no hosting receipts (every peer would ignore them).

When a node joins, leaves and reconciles, which spaces it hides from its own
list, and when it publishes the account's profile are the node's own; the
reference node is in [the node](../packages/core/docs/node.md#following-the-account).

_Source: `packages/core/src/node/node.ts` (`reconcileOnce`, `syncPasses`, `nameKeepers`), `packages/core/src/space/account-registry.ts`. Tests: `packages/core/tests/node.test.ts` ("the account registry"), `packages/core/tests/records-only.test.ts` ("it never writes the account itself…", "in the account's own spaces, a version under a records-only note does not stand")._

## 2. The account home protocol

An **app** acts for an account without ever holding its seed. It gets a note
from the account to a key of its own, signed at the person's **account home**.

```
 app page                                   account home (popup)
    │  opens the home in a popup                  │
    │ ◀──────────── { type: 'minca:hello' } ──────│  posted to '*'
    │── { type: 'minca:request', request } ─────▶ │  to the home's origin
    │                                             │  person unlocks, approves
    │ ◀──── { type: 'minca:grant', grant } ───────│  to the app's origin only
    │    or { type: 'minca:denied', reason }      │  then closes
```

### 2.1 The app's key

An app MUST make its own P-256 key and keep the private half non-extractable.
The key's DID is the grant's audience, and the app's node signs with this key,
not a fresh one. Where the reference keeps it:
[the app-side client](../packages/core/docs/node.md#the-app-side-client).

Every tab or window of one app signs with this key, so they write the same
lines ([02](02-records.md) §4.10): each place in them is taken under a lock
every tab shares, and read from the storage they share.

> **Known defect:** so every tab or window of one app is the same DID on the
> relays, and only the first gets into a space's room; the others report
> `refused` in its status until it closes. The fix is a key per tab, each
> with its own one-link note signed by the account through the home: the
> app's key can't pass its note on ([01](01-identity.md) §7.5). See
> [04](04-network.md) §1.2 and
> [#55](https://github.com/leifriksheim/minca/issues/55).

### 2.2 The home's address

A home is found by its bare domain: an app given only an origin opens
`<origin>/connect`, so a home serves its connect page there. Example:
`minca.example.com` → `https://minca.example.com/connect`. How the reference
client reads what a person typed is in
[the app-side client](../packages/core/docs/node.md#the-app-side-client).

### 2.3 The exchange

The app:

1. MUST open the home in a popup from a user gesture, before awaiting anything.
2. Listens for `message` events from the moment the popup opens, and MUST
   ignore any whose `source` is not the popup it opened or whose `origin` is
   not the home's origin.
3. Posts `{ type: "minca:request", request }` to the popup with
   `targetOrigin` = the home's origin on each `{ type: "minca:hello" }` once
   the request is ready, and MAY post it again at intervals until the home
   answers: a phone may not run the app's tab while the home is in front, so
   the hello can go unheard. It MUST NOT post it with any other
   `targetOrigin`.
4. On `{ type: "minca:grant", grant }`, checks the grant (§2.6) and resolves
   (for a proposal, §2.11, `grant` is the `Proposed` answer instead). On
   `{ type: "minca:denied", reason? }`, fails with `reason`.
5. Fails if the popup is closed first, or after a timeout.

The home:

1. Does nothing unless `window.opener` is set.
2. Posts `{ type: "minca:hello" }` to the opener once, with `targetOrigin`
   `*`. The hello carries nothing secret. Whatever page is in the opener's
   tab while the home waits can send a request without one; the defence is
   step 3, the home showing that page's origin.
3. Takes the first `message` whose `source` is the opener and whose `type` is
   `minca:request`. The **origin of that event**, as the browser reports it, is
   the app's identity; the home MUST NOT trust any name the request gives
   instead, and MUST show the origin to the person.
4. If the request is malformed (§2.4), answers `minca:denied` with a reason
   saying it did not understand, to that origin, and closes.
5. Otherwise waits for the person, then posts exactly one of `minca:grant` or
   `minca:denied` to that origin only, and closes itself.
6. Gives up silently if no request arrives within the timeout, or once the
   opener is closed.

The reference timings (popup size, polling, timeouts) are in
[the app-side client](../packages/core/docs/node.md#the-app-side-client) and
[the account home's side](../packages/core/docs/sign-in.md#the-account-homes-side).

_Source: `packages/core/src/session/connect.ts` (`connectToHome`, `askHome`, `receiveConnectRequest`, `homeAddress`). Tests: `packages/core/tests/connect.test.ts` ("the app asking its home", "the home receiving a request", "an account home typed by a person")._

### 2.4 The request

`ConnectRequest`:

| Field          | Type                            | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `v`            | `1`                             |                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `audience`     | string                          | The app's key, `did:key:…`, or with `via: code` the program's (§3). The note is made out to it.                                                                                                                                                                                                                                                                                                                          |
| `proof`        | string                          | base64url ES256 signature by the `audience` key over the UTF-8 bytes of the canonical JSON `{"audience":<audience>,"proof":"minca/connect-key/v1","recordsOnly":<recordsOnly>,"via":<via>}`, where `recordsOnly` is the request's (`false` when absent) and `via` is `"code"` with `via: code` and `"popup"` otherwise; with `via: code` it also has `"origin":<origin>`, the origin of the app it went through (below). |
| `name`         | string, ≤ 80, optional          | What the app calls itself. Shown, never trusted.                                                                                                                                                                                                                                                                                                                                                                         |
| `access`       | `read` \| `write` \| `carry`    | `write` to change the spaces given, `read` only to look, `carry` for a carrier (§4.3).                                                                                                                                                                                                                                                                                                                                   |
| `scope`        | `spaces` \| `account`, optional | `spaces` (default): the spaces the person picks and any made for the app. `account`: every space, the account's list, making and joining spaces.                                                                                                                                                                                                                                                                         |
| `create`       | `NewSpace[]`, optional          | Spaces the home should make for the app: at most 8, each with a non-empty `name` ≤ 80, `visibility`, and valid founding `roles` if given ([03](03-spaces.md) §2.1).                                                                                                                                                                                                                                                      |
| `contacts`     | boolean, optional               | The contacts space and the contact key.                                                                                                                                                                                                                                                                                                                                                                                  |
| `chooseSpaces` | boolean, optional               | Whether to offer the person's existing spaces. Default true. UI only.                                                                                                                                                                                                                                                                                                                                                    |
| `recordsOnly`  | boolean, optional               | A note that grants records only (`/record` to write, `/record/read` to read; [01](01-identity.md) §8).                                                                                                                                                                                                                                                                                                                   |
| `via`          | `code`, optional                | The audience is not the app's own key but a program's that reached the app over a connect code (§3).                                                                                                                                                                                                                                                                                                                     |
| `days`         | integer 1–365, optional         | How long the note should last. The home decides; default 7.                                                                                                                                                                                                                                                                                                                                                              |

A home MUST refuse a request (as in §2.3 step 4) unless: it has no member
but those in the table; `v` is `1`; `audience` starts with `did:key:`;
`access` is one of the three; `scope`, `name`, `contacts`, `create`, `days`
are absent or valid as above; when `recordsOnly: true`, `access` is not
`carry`, `create` is absent and `contacts` is not true; when `via` is present,
it is `code` and `access` is not `carry`.

Connecting offers no subscriptions: a person signing in has asked to be told
about nothing yet. An app asks later, when they do (§2.11). A home MUST NOT
add a subscription while connecting.

Example:

```json
{
  "type": "minca:request",
  "request": {
    "v": 1,
    "audience": "did:key:zDnaeyrPwbZxpDVLsnvAvAEGYazWB2ZrM7QL4Qb1JPzfiYpKy",
    "proof": "<base64url signature>",
    "name": "Todo",
    "access": "write",
    "scope": "spaces",
    "create": [{ "name": "Todos", "visibility": "private" }],
    "days": 30
  }
}
```

The bytes a key signs for `proof`, for an app's request with the key above:

```
{"audience":"did:key:zDnaeyrPwbZxpDVLsnvAvAEGYazWB2ZrM7QL4Qb1JPzfiYpKy","proof":"minca/connect-key/v1","recordsOnly":false,"via":"popup"}
```

With `via: code`, for a program's key reached through the app at
`https://app.example`:

```
{"audience":"did:key:zDnaeyrPwbZxpDVLsnvAvAEGYazWB2ZrM7QL4Qb1JPzfiYpKy","origin":"https://app.example","proof":"minca/connect-key/v1","recordsOnly":true,"via":"code"}
```

Binding `via` and `recordsOnly` means a program's proof, which it hands to
the app it connects through (§3), can't ask for that app's own connection,
nor for more than records when the program asked for records only. An app's
own proof can't be passed off as a program's either. Binding `origin` means
the proof is no use from any other app: the home checks it against the
origin the browser reports for the request (§2.3), never one the request
names.

### 2.5 The grant

A home MUST refuse a request whose `proof` does not verify with the
`audience` key over the statement of §2.4 (with `via: code`, naming the
origin the request came from), whose `audience` is the home's own session key, or whose
`audience` another connection of a different origin, or a different `via`,
already holds. Disconnecting revokes the audience key (§2.10), so a request
must never be able to name a key its sender doesn't hold.

When the person approves, the home:

1. Makes the spaces in `create`, in the account (so they land in its list on
   every device).
2. With `contacts` and `scope: spaces`, adds the contacts space to the spaces
   granted. (With `scope: account` the app derives it itself.)
3. For each granted space — the ones the person picked, the ones made, and the
   contacts space — makes a **view-only invite** (for a private space it
   carries the key; it never carries a role secret) and, for a private space
   under `scope: spaces`, the account's **member key** for that space
   (`deriveMemberKeyBytes(accountKey, spaceId)`, [01](01-identity.md)), which
   opens that space's next key and nothing else.
4. Computes the lifetime: `days` = the person's choice, else the request's,
   else 7, within the home's own bounds; `expiresAt = now + round(days × 86400)`
   (unix seconds).
5. Signs a note with the account's root key ([01](01-identity.md) §7):
   `aud` = `request.audience`, `exp` = `expiresAt`, `cmd` = `/` for
   `write`, `/record` for `write` with `recordsOnly: true`
   ([01](01-identity.md) §8), and `/record/read` for `read`; and, by the
   spaces granted (`grantTerms(access, scope)`):
   - `scope: account` → `sub` = the account's DID, `pol` = `[]`;
   - `scope: spaces`, one space → `sub` = `space:<id>`, `pol` = `[]`;
   - `scope: spaces`, several → `sub` = the account's DID, `pol` =
     `[["or", [["==", ".space", "<id>"], …]]]`, the ids sorted;
   - `scope: spaces`, none → `sub` = the account's DID, `pol` =
     `[["not", ["and", []]]]`, which nothing satisfies.

   The note carries no `meta`.

6. Remembers the connection (§2.10).
7. Answers with the grant.

`Grant` (the home sends it without `home`; the app adds `home` = the connect
page it opened):

| Field           | Type                                 | Meaning                                                                                                                                                                    |
| --------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `v`             | `2`                                  | 2 since the note is a delegation in the UCAN 1.0 profile. An app MUST refuse any other, and drop a kept grant of another.                                                  |
| `did`           | string                               | The account.                                                                                                                                                               |
| `name`          | string                               | The account's name, for showing who is connected.                                                                                                                          |
| `note`          | object                               | The note: a token ([01](01-identity.md) §7.1).                                                                                                                             |
| `access`        | `read` \| `write`                    |                                                                                                                                                                            |
| `scope`         | `spaces` \| `account`                |                                                                                                                                                                            |
| `spaces`        | `{ id, name, invite, memberKey? }[]` | Granted spaces; `memberKey` is base64url.                                                                                                                                  |
| `accountKey`    | base64url, optional                  | With `scope: account`: the account key (01 §11.1). It opens every private space and the account registry, but cannot sign as the account or open the home's local storage. |
| `contactKey`    | base64url, optional                  | With `contacts` or `scope: account`: the contact key's secret. Never with `recordsOnly`: it opens contact requests and knocks on the account's doors ([07](07-doors.md)).  |
| `contactsSpace` | string, optional                     | With `contacts` and `scope: spaces`: which of `spaces` is the contacts space.                                                                                              |
| `relays`        | string[], optional                   | Relays the home uses; the app joins them too, so the two always share one.                                                                                                 |
| `expiresAt`     | number                               | Unix seconds.                                                                                                                                                              |
| `home`          | string                               | Added by the app.                                                                                                                                                          |

Example (shortened):

```json
{
  "type": "minca:grant",
  "grant": {
    "v": 2,
    "did": "did:key:zDnaemCBstFw5hzNdNggFHZm6GpHoHqNGrwEtrVi9CxGH9V7E",
    "name": "Leif",
    "note": {
      "payload": {
        "aud": "did:key:zDnaeyrPwbZxpDVLsnvAvAEGYazWB2ZrM7QL4Qb1JPzfiYpKy",
        "cmd": "/",
        "exp": 1792614901,
        "iss": "did:key:zDnaemCBstFw5hzNdNggFHZm6GpHoHqNGrwEtrVi9CxGH9V7E",
        "nbf": 1790022901,
        "nonce": "pr0q7Vm5c2T8xkWa",
        "pol": [],
        "sub": "space:bafk…"
      },
      "sig": "…",
      "type": "minca/ucan/dlg@1"
    },
    "access": "write",
    "scope": "spaces",
    "spaces": [{ "id": "bafk…", "name": "Todos", "invite": "…", "memberKey": "q0v…" }],
    "relays": ["wss://p2p-web-relay.fly.dev"],
    "expiresAt": 1792614901
  }
}
```

> Rationale: the note limits **writing**, per space (and, with a policy, per
> collection), and every peer checks it.
> It cannot limit **reading** a private space it was given: reading is holding
> the space's key. Invites are view-only because what lets the app write is the
> note, under the account's own role — never a secret of the space's.

_Source: `packages/core/src/session/auth.ts` (`grant`, `audienceProblem`), `packages/core/src/session/connect.ts` (`ConnectRequest`, `Grant`, `GRANT_VERSION`, `grantTerms`, `isRequest`, `keyProof`, `checkKeyProof`). Tests: `packages/core/tests/connect.test.ts` ("connecting an app to an account home", "an app can only ask for a key it holds, and none the home already uses for something else", "a request with a field it does not know is refused…")._

### 2.6 What the app checks

Before using a grant the app MUST check that `v` is `2`, that the note
verifies as a note ([01](01-identity.md) §7.5), that its `aud` is the
app's own key, and that its `iss` is `grant.did`. An app that asked for
`recordsOnly: true` MUST refuse a note whose command is not under `/record`,
as a program connected by code MUST (§3).

### 2.7 Starting a connected node

The app's node signs with the app's own key (§2.1) under the granted note,
joins the relays in `grant.relays` besides its own, and joins each granted
space with its view-only invite and, when given, its `memberKey`. Without an
account key it sees only the spaces it was given; with one it follows the
whole account (§1.3). How the reference starts it is in
[the app-side client](../packages/core/docs/node.md#the-app-side-client).

_Source: `packages/core/src/session/connect.ts` (`startConnectedNode`, `grantSigner`). Tests: `packages/core/tests/connect.test.ts`._

### 2.8 Scope

|                       | `scope: spaces`                                                    | `scope: account`                        |
| --------------------- | ------------------------------------------------------------------ | --------------------------------------- |
| Note                  | about the one space, or the account with a policy naming them      | about the account, no policy            |
| Account key           | no                                                                 | yes                                     |
| Sees                  | the granted spaces                                                 | every space; the account registry       |
| Makes or joins spaces | the home makes them at grant time                                  | itself; they land in the account's list |
| Contacts              | only with `contacts: true` (list and requests; not `ask`/`accept`) | yes, including `ask`/`accept`           |
| Member keys           | one per granted private space                                      | derived from the account key            |

With `recordsOnly` the note grants `/record` (or `/record/read`) under either
scope, so every peer refuses from it what a records-only note can't do
([01](01-identity.md) §8): it never changes a space's collections or who may
do what, and never writes in the account's own spaces. To make something new
its key proposes collections for someone who may define them (the library's
blueprints, [blueprints and guides](../packages/core/docs/blueprints-and-guides.md)).
A node whose note can't change access never names relays, seals member keys
or rotates a space key; in a private space it only learns keys. With
`scope: account` it still gets the account key, so the contact list is within
its note to read; a home MUST NOT give it the contact key, with which it could
open contact requests and knocks on the account's doors ([07](07-doors.md)).
What the library also ignores from such a key (contact requests, and calls
from a key that writes records here and nothing more) is in
[contacts](../packages/core/docs/contacts.md) and
[calls](../packages/core/docs/calls.md#messages).

_Source: `packages/core/src/session/connect.ts` (`grantTerms`), `packages/core/src/identity/abilities.ts` (`noteTerms`), `packages/core/src/session/auth.ts` (`grant`), `packages/core/src/identity/abilities.ts`, `packages/core/src/node/space-runtime.ts` (`buildEvent`, `judgeStanding`, `write`, `upkeep`). Tests: `packages/core/tests/records-only.test.ts` ("a definition signed by hand under a records-only note is ignored by every peer", "what counts is what the note grants", "it never writes the account itself…", "in the account's own spaces, a version under a records-only note does not stand", "a program on a computer gets the whole account, records only, for as long as asked; each is its own connection"), `packages/core/tests/connect.test.ts` ("the grant is a note from the account to the app key, for the chosen spaces only")._

Either way the app never gets the seed: it cannot sign in as the account, change
its password or passkeys. Its note stops working for live checks at
`expiresAt`, and its records stop counting once the account disconnects it
(§2.9, §2.10).

> **Planned: grants narrower than a space.** Reading a private space is
> holding its key, so an app granted a private space reads all of it until
> the space's key changes ([03](03-spaces.md), `changeKey`). A note can
> already limit writing to some collections, with a policy on `.collection`
> that every peer checks ([01](01-identity.md) §8), but a home doesn't offer
> one yet; reading per collection would need collection keys the home can
> hand out alone. Not designed yet.

### 2.9 Expiry and renewal

A note is never renewed in place. When `expiresAt` passes, the app's note
stops working for live checks everywhere: knocks, live messages, connecting
to peers. Its records are judged with no time (02 §9.3), so they stop counting
when its key is revoked: the home that granted it disconnects it once the
time has passed, while it is signed in, and at sign-out (§2.10). To continue,
the app connects again, which produces a new note (and, at the home, replaces
the old connection record).

> **Known defect:** connections are kept in the browser that granted them,
> so only that home revokes an app whose time has passed, and only while it
> is signed in. Until it does, the app's records still count. Tracked in
> [#165](https://github.com/leifriksheim/minca/issues/165).

### 2.10 Connections and revocation

The home remembers each connection it grants: the app's origin, audience,
access, scope and the spaces granted. Connecting the same origin again replaces
its connection; a connection with `via: code` is kept by its audience, apart
from the app's own, and connecting the same key again replaces it.

**Disconnecting** an app, or a program connected by code, revokes the key of each connection removed
that has `access: write` (never the home's own session key), and connecting
the same app again with a new key revokes the old one the same way:

- `scope: spaces`: in every space it was granted;
- `scope: account`: in every space the account can write in, the contacts
  space, and the account registry.

Disconnecting an app (not only the programs connected through it, which go
with it) also removes every subscription
whose `app.origin` is its origin (§2.11, §4.4).

Revoking writes a `sys.revoke` record naming the key ([03](03-spaces.md) §6.4).
From then on nothing that key signed counts, except what the revoker had
already seen of it. What the app could already read, it keeps. How the reference
home stores connections and what the reference client does when it sees its
key revoked are in [the account home's side](../packages/core/docs/sign-in.md#the-account-homes-side).

_Source: `packages/core/src/session/auth.ts` (`disconnect`, `connections`), `packages/core/src/node/node.ts` (`checkRevoked`). Tests: `packages/core/tests/connect.test.ts` ("disconnecting …")._

### 2.11 Proposing subscriptions

Only an app offers subscriptions, and only when the person asks it to: never
while connecting (§2.4), never a
carrier or a program connected by code, and never the home on its own. The home lets the person
pause and remove what they kept, not add to it. The app uses the exchange of
§2.3 with a `ProposeRequest` in place of the
`ConnectRequest`:

| Field    | Type                   | Meaning                                                      |
| -------- | ---------------------- | ------------------------------------------------------------ |
| `v`      | `1`                    |                                                              |
| `kind`   | `"propose"`            | Tells it apart from a `ConnectRequest`, which has no `kind`. |
| `name`   | string, ≤ 80, optional | What it calls itself. Shown, never trusted.                  |
| `notify` | `NotifyProposal[]`     | 1 to 8 subscriptions to offer the person.                    |

`NotifyProposal` is `{ label, collection, topic?, others?, where?, spaces?, open? }`,
each field as in `NotifyWhen` ([03](03-spaces.md) §15), except that `topic`
is `{ field, value }` or `{ field, me: true }` (`me` stands for
the account's DID, which an app given only some spaces does not know). It looks
at the spaces the app may reach (step 2 below), or with `spaces` only those of
them; it cannot widen them.

A home MUST refuse a request with a `kind` as malformed (§2.3 step 4) unless
it has no member but those in the table, `v` is `1`, `kind` is `propose`, `name` is absent or valid, and `notify` has 1
to 8 entries, each of which would be a valid `NotifyWhen` ([03](03-spaces.md)
§15) with `app.origin` the request's origin and `spaces` its `spaces` when
given (else `"all"`), and whose `open`, when given, is on the request's
origin: a click on a notification leads only back to the app that proposed it.

When the person approves some or all of the proposals, the home:

1. Finds the connection it keeps for the request's origin (§2.10), other than
   one with `via: code` or a carrier's. With none it MUST refuse.
2. Works out what the app may reach: every space (`"all"`) under
   `scope: account`, else the spaces granted without the contacts space
   (none: it refuses).
3. Checks every kept proposal before writing any. It MUST refuse the whole
   proposal when one names in `spaces` a space outside that reach.
4. Adds each kept proposal to the account's subscriptions ([03](03-spaces.md)
   §15): `spaces` is the proposal's own, else the reach; `me` becomes the
   account's DID; `others` defaults to true; `open` defaults to `<origin>/`;
   `since` is now; `app` is `{ origin, name? }` with `name` the connection's,
   else the request's, cut to 80. A proposal equal to a subscription the same
   origin already has (same collection, spaces, topic and `others`) is not
   added again.
5. Answers `minca:grant` with `Proposed`:
   `{ v: 1, kind: "proposed", notify: { id, label }[], versions? }`, the
   subscriptions added or found; empty when the person kept none. For an app
   with `scope: account` that kept at least one, `versions` MUST hold every
   version the home keeps of each of them, as stored in the registry: signed,
   its body sealed. For any other app it MUST be absent.

An app given `versions` SHOULD store them at once, each only once it passes
every check a version arriving from a peer would ([05](05-sync-and-storage.md)), and only
versions of `sys.notify` in its own registry. The home's window closes when it
answers, often before the two have met on the network; without them, the
subscriptions would reach the app only when it next meets another device of
the account.

Nothing else changes: the app gets no access it did not have, no note, and
learns only which of its suggestions were kept, and a whole-account app only
what it could already read.

Example:

```json
{
  "type": "minca:request",
  "request": {
    "v": 1,
    "kind": "propose",
    "name": "Chat",
    "notify": [
      {
        "label": "New message in Club",
        "collection": "std.message",
        "others": true,
        "spaces": ["bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku"]
      }
    ]
  }
}
```

answered with

```json
{
  "type": "minca:grant",
  "grant": {
    "v": 1,
    "kind": "proposed",
    "notify": [{ "id": "notify:k3v6mzq4ha2tmbyx", "label": "New message in Club" }]
  }
}
```

The app shows the notifications itself; how the reference matches records
against its subscriptions is in
[the app-side client](../packages/core/docs/node.md#the-app-side-client).

> Rationale: the home writes the subscriptions, not the app. A subscription is
> the person's intent: the app knows good collections and labels, the person
> says yes, and says no later in one place for every app.

> Rationale: a carrier cannot read what it would notify about, and a label it
> chose from the kinds of record it sees go by would be a guess at the
> person's words. An app they are looking at knows what its records mean.

_Source: `packages/core/src/session/connect.ts` (`ProposeRequest`, `Proposed`, `proposeToHome`, `isRequest`), `packages/core/src/session/auth.ts` (`propose`, `subscriptionsFrom`), `packages/core/src/session/connection.ts` (`propose`), `packages/core/src/node/node.ts` (`notifications.versions`, `notifications.take`), `packages/core/src/node/space-runtime.ts` (`versionsOf`, `take`), `packages/core/src/space/notify.ts` (`checkProposal`, `proposalSpaces`, `fromProposal`, `sameSubscription`), `apps/home/src/components/ConnectPage.tsx` (`ApproveProposal`). Tests: `packages/core/tests/connect.test.ts` ("an app proposing subscriptions", "the home receiving a request")._

> **Planned: a wallet as the account home.** The same job — hold the root and
> hand an app's key a note — done by a credential wallet through the Digital
> Credentials API instead of a popup page. Nothing is designed beyond that: open
> are what the wallet would hold (the seed, or a key the account's note
> delegates to) and how the request and grant of §2.4–2.5 would map onto a
> credential request.

---

## 3. Connecting by code

A program with no browser of its own (a command in a terminal, a server)
connects to an account through an app the person has open. The app shows a
one-time code; the program is given it (`minca connect mc_…`); the two meet on
the code's channel, the app says where it lives, the program says which key
it holds and what it asks for, and the app asks the account home (§2) for a
note made out to that key. The protocol does not care what the program is.
What it asks for is only a request: the app chooses the terms, the person
allows them at the home, and the program gets that or nothing.

**The code.** `mc_` followed by 24 bytes in base64url (32 characters): a
16-byte secret, then the **account fingerprint**, the first 8 bytes of
`SHA-256(UTF-8("minca/code-account/v1") ‖ UTF-8(account DID))` for the
account the app is signed in to. The app MUST make the secret with a CSPRNG
for each offer. A reader MUST accept the code anywhere in pasted text: the
first match of `mc_([A-Za-z0-9_-]{32})` not followed by another base64url
character, decoding to 24 bytes.

For the secret `eYV4XGMvhkky6OWpPfqfRQ` (base64url) and the account
`did:key:zDnaeyrPwbZxpDVLsnvAvAEGYazWB2ZrM7QL4Qb1JPzfiYpKy`, the fingerprint
is `390c0fe099b996c6` (hex) and the code is `mc_eYV4XGMvhkky6OWpPfqfRTkMD-CZuZbG`.

**The channel.** The 16-byte secret is the secret of a channel of kind _connect by
code_ ([01](01-identity.md) §15.2): room `CID(UTF-8("minca/code-room/v1") ‖ secret)`,
keys under `minca/code-key/v1`, sealed messages under `minca/code/v1` bound to
`{ type, seq }`. The app is the offering side, the program the joining side.
Both join that room on a shared relay ([04](04-network.md); introductions off)
under a throwaway `did:key`, and talk over the resulting peer connection.

For the code above, the room is `bihn55ne2az53tlealtmk3ervpyk6xa6364ii25ogc7xv54zkjszq`.

**Messages.** Network messages `{ type, from, payload }`. The first two carry
a point in the clear; the rest are sealed (`payload` is the base64url
envelope of the UTF-8 JSON body).

| `type`        | From    | Payload                                                                                                                                                           |
| ------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `code:hello`  | program | `{ "key": base64url(J) }`, to each peer that connects, until a `code:heard` opens                                                                                 |
| `code:key`    | app     | `{ "key": base64url(O) }`, to each peer that said hello, until one asks                                                                                           |
| `code:app`    | app     | sealed `{ "origin": "<the app's origin>" }`, right after `code:key`; `origin` ≤ 200, a serialized origin such as `https://app.example`                            |
| `code:ask`    | program | sealed `{ "did": "<its key>", "proof": "<keyProof, via code, origin>", "name": "…", "recordsOnly": <bool> }`; `did` starts `did:key:`, `name` ≤ 80, `proof` ≤ 200 |
| `code:heard`  | app     | sealed `{}`                                                                                                                                                       |
| `code:answer` | app     | sealed `{ "grant": <Grant> }` or `{ "denied": "<reason>" }`                                                                                                       |
| `code:done`   | program | sealed `{}`                                                                                                                                                       |

```
App                                                   Program
  shows mc_…, joins room                              joins room
            ◀─────────────── peer connected ───────────────▶
                          ◀── code:hello   { key: J }
  code:key { key: O } ──▶
  code:app sealed { origin } ──▶
                          ◀── code:ask     sealed { did, proof, name, recordsOnly }
  code:heard sealed {} ──▶
  the app decides the terms; the person allows them; the app asks
  the home (§2.3) with audience = did, proof, via: code, recordsOnly
  code:answer sealed { grant } ──▶
                                                      checks the grant
                                                      and the account
                          ◀── code:done    sealed {}
```

- **The app** answers each `code:hello` with `code:key` and `code:app`, and
  runs an exchange with that peer (at most a few dozen), until one `code:ask`
  opens and reads as above. That program is the one asked about, and the code is spent: the
  app MUST NOT answer another hello or ask, and MUST ignore `code:done` from
  any other peer. It sends `code:heard` at once. It sends `code:answer` with a
  grant only once the person has allowed it at the home, and MUST NOT send a
  grant whose note is made out to another key or comes from another account,
  or, when the program asked for records only, one that grants more.
- **The terms are the app's.** The program's ask is a request. The app
  decides what to ask the home for, and when that is not what the program
  asked, it denies the ask (`code:answer` with `denied`): the proof binds the
  program's `recordsOnly`, so the home would refuse anything else.
- **The request** the app makes is a `ConnectRequest` (§2.4) with
  `audience` = the ask's `did`, `proof` = its `proof`, `via: "code"`, and the
  `recordsOnly` the program asked for. The home checks the proof against the
  request's origin (§2.5), so it is no use from any other app.
- **The program** answers each `code:app` whose `origin` reads as above with
  `code:ask` on that exchange, its proof naming that origin, and takes the
  first peer whose `code:heard` opens as the app, ignoring every other from
  then on. It MUST check a grant as an app does (§2.6): `v` is 2; the note
  verifies; `aud` is its own key; `iss` is `grant.did`; and, when it asked
  for records only, the note's command is under `/record`. It MUST
  also refuse a grant whose `grant.did` does not have the account
  fingerprint the code names. Then it sends `code:done` and keeps the grant.

What the reference app shows and asks for, the program's timeouts and how the
CLI keeps its key and grant are in
[agents](../packages/core/docs/agents.md#connecting-with-a-code).

> Rationale: the relay introduces the two sides and could sit between them,
> so everything after the key exchange is sealed. The code is in the key and
> so is the shared point: someone without the code gets a different channel,
> and someone who learns it later, holding a recording, still lacks the
> point. There is no short code to compare, unlike pairing: the code is
> pasted, not typed, so it can be long enough that guessing it gets nowhere,
> and someone in the room without it cannot finish an exchange. A key per
> direction and a count in each message mean nobody in the room can turn one
> side's message into the other's, relabel it or repeat it. A peer that says
> hello without the code costs the app one exchange, and spends nothing.
> Someone else who holds the code can answer the program first and pose as
> the app; the fingerprint means the only note they can hand it is one from
> the account on the app's screen, which they can't sign. Eight bytes are
> enough: they would have to find an account key whose DID matches while the
> code is still on screen.

_Source: `packages/core/src/session/connect-code.ts` (`offerConnectCode`, `connectWithCode`, `readConnectCode`), `packages/core/src/identity/channel.ts` (`CODE_CHANNEL`), `packages/core/src/session/connect.ts` (`connectToHome`, `checkGrant`, `keyProof`). Tests: `packages/core/tests/connect-code.test.ts` ("the room for a code", "the code alone does not open a recorded exchange", "a recording of the room, and the code learned later, open nothing", "a relay that relabels or repeats messages changes nothing", "a code works for one program: a second with the same code is not answered", "saying no reaches the program; a note for another key, account, or for more than records, is refused", "someone else holding the code who answers first, with a note from their own account, is refused"), `packages/core/tests/records-only.test.ts` ("a program connected by code, through the account home": "over a code: the program learns the app’s origin, and its proof is refused from any other"), `packages/core/tests/connect.test.ts` ("an app can only ask for a key it holds, and none the home already uses for something else"), `apps/example/tests/program-terms.test.ts`._

### 3.1 Planned

> **Planned.** Not normative.
>
> - **Renewing a note.** Today, when a note given over a code runs out, the
>   program says to connect again. It could instead ask an open tab of the
>   person's for a new note, while one is open. Open: how the program reaches
>   the tab, and whether the person must approve each renewal.
> - **Programs that cannot run code of their own** (a hosted chat's
>   connectors, a phone app) would need an HTTPS endpoint somewhere else,
>   such as on a relay, which would then see the traffic. If offered at all,
>   it is a separate, clearly labelled option. Not designed.

---

## 4. Carriers and hosts

### 4.1 What a carrier holds, and sees

A carrier keeps an account's spaces online and backed up without being able to
read them. It holds:

- its own P-256 key (its DID is what peers and keepers lists name);
- the key of its **carry space**, which holds nothing but passes and
  subscriptions;
- for each carried space, a **pass**: the space's constitution and, for a private
  space, its read key seed;
- the records of each carried space exactly as they travel.

It holds no seed, no space key, no invite secret and no note: it signs nothing,
and writes nothing. It runs every record it takes in through the same gates
as a member's node, but in a private space it cannot read bodies, so it
skips the checks that read them: `onePer`, `fixed` and tags
([02](02-records.md) §7.3, §7.4, §8.4). It accepts what passes the
rest, as any peer without the key does; peers that hold the key still judge
those checks. On the wire it shows no note, so peers see it as `from: null`.

It can see: which spaces exist, their size and when they change, every record's
outer details (author, collection, times, topic tags; [02](02-records.md)), and
which account asked it to carry which space. It cannot read a private space's
bodies or links, and cannot tell a topic tag's value.

The **read key** in a pass only proves to peers that the carrier may take part
in a private space ([04](04-network.md)); it is derived one way from the space
key and decrypts nothing ([03](03-spaces.md)).

_Source: `packages/core/src/space/pass.ts`, `packages/core/src/node/carrier.ts`. Tests: `packages/core/tests/carrier.test.ts` ("passes", "a carrier")._

### 4.2 Carry spaces and passes

Using a carrier needs the account key:

1. The node makes a private space, with the account as its only writer.
2. It writes a `sys.carrier` record in the account registry, key
   `carrier:<hex of the first 20 bytes of SHA-256(utf8(carry space id))>`, body
   `{ space, invite, did, name, since }`, where `invite` is a view-only invite
   to the carry space ([03](03-spaces.md)).
3. It fills the carry space (below) and returns `{ space, invite }`; the
   carrier joins with the invite.

Every device holding the account key keeps each live carrier's carry space in
step with the account (§1.3): one `sys.pass` record per space, and one
`sys.subscription` per notification subscription.

**Pass records.** Collection `sys.pass`, key
`pass:<hex of the first 20 bytes of SHA-256(utf8(space id))>`, body `SpacePass`:

| Field     | Meaning                                                                                                                                    |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `v`       | `1`                                                                                                                                        |
| `space`   | The space's constitution (`Space`, [03](03-spaces.md)).                                                                                    |
| `read`    | Private spaces: the read key seed (`deriveReadSeed(spaceKey)`), base64url.                                                                 |
| `readKey` | Present once the space's key has changed since it began: the read key's DID, which the space's history (not its constitution) vouches for. |

Passes are written for the account registry, the contacts space, and every
space in `sys.joined` that this device holds with its key (a private space held
without its key gets none until the key arrives). Passes for other spaces are
deleted.

A carrier MUST accept a pass only if the space hashes to its id and, for a
private space, the read seed's DID equals `space.readKey` or the pass's
`readKey`. Only pass records verified as written by the carried account count.
When two accounts name one space, a pass for a later key wins over one for the
first key.

**Removing a carrier**: delete every pass, write `sys.pass` key `carry:closed`
with body `{ "v": 1, "closed": true }`, then delete the `sys.carrier` record. A
carrier that reads `carry:closed` from the account MUST stop carrying for it and
forget what it held. The node keeps the carry space open for a while after, so
the carrier hears it ([the node](../packages/core/docs/node.md#carriers-hosting-and-notifications)).

A pass cannot be taken back. A removed carrier that does not forget keeps the
read key seeds it was given, so it can still prove itself to peers and fetch
ciphertext until each space's key changes ([03](03-spaces.md), `changeKey`).
Removing a carrier does not change any key by itself.

**Keepers.** A node holding the account key that is granted `/space/keepers` in a space names the account's live carriers as
its keepers (`{ did, name }`, at most 16, [03](03-spaces.md)) and stops naming
carriers the account removed. Other keepers stay. So apps holding part of a
space ([05](05-sync-and-storage.md) §5) can rely on the carriers.

_Source: `packages/core/src/node/node.ts` (`carriers`, `syncPasses`, `nameKeepers`), `packages/core/src/space/pass.ts`, `packages/core/src/space/account-registry.ts`. Tests: `packages/core/tests/carrier.test.ts`._

### 4.3 Connecting a carrier through the account home

A carrier (a browser extension) asks the home with `access: "carry"` (§2.4),
from a page that stays open until the answer comes. The home replaces any
earlier carrier from the same origin, adds the carrier (§4.2) with
`did` = the request's `audience`, and answers with a `CarryGrant`:

```json
{
  "v": 1,
  "kind": "carry",
  "did": "<account>",
  "name": "Leif",
  "carry": { "space": "<carry space id>", "invite": "<view-only invite>" },
  "pod": { "dataPath": "accounts/k3j2h4g5f6d7/stores", "folder": "Minca" },
  "relays": ["wss://…"]
}
```

`pod` is `null` when the account lives in the home's browser storage. The
carrier MUST check that `kind` is `carry`, that the invite is to the named
space, that the space is private, with `did` its one founder and no roles
assigned
([03](03-spaces.md) §1.1), and that the invite carries
its key; and that `pod.dataPath` has no empty or `..` segments. A carry
connection has no expiry and no note to revoke; disconnecting it removes the
carrier (§4.2).

_Source: `packages/core/src/session/connect.ts` (`connectCarrier`, `checkCarryGrant`, `CarryGrant`), `packages/core/src/session/auth.ts` (`grantCarry`). Tests: `packages/core/tests/connect.test.ts` ("connecting a carrier to an account home")._

### 4.4 Subscriptions, and carriers

"Let me know when…" subscriptions are kept in the account registry as `sys.notify` records, key
`notify:<base32 of 10 random bytes>`, body `NotifyWhen`, defined in
[03](03-spaces.md) §15.

An app proposes them when the person asks it to, and the home adds the ones
the person keeps, naming the app (§2.11). Disconnecting an app removes its
subscriptions (§2.10). The app shows what they match itself, while it runs
(§2.11). A subscription without `app` was made by an earlier home and is kept.

Each device copies every subscription into every carry space as
`sys.subscription` (same key), with the topic value replaced by the tag it has
in each space ([02](02-records.md)):
`{ v: 1, label, collection, spaces, tags?: { <spaceId>: [<tag>] }, others, open?, paused, since }`.
A private space whose key the device lacks gets no tag.

A version matches a carried subscription when all hold: not paused; same collection; `seq` 0 and not deleted; the space is in
`spaces`; `createdAt` is not before `since` and within the last 24 hours; with
`others`, the record's root is not the account; with `tags`, the record
carries one of that space's tags. No carrier acts on a match today: the copies
are there for waking an app that is closed (below).

_Source: `packages/core/src/space/notify.ts`, `packages/core/src/node/node.ts` (`notifications`, `syncPasses`), `packages/core/src/node/carrier.ts` (`arrived`). Tests: `packages/core/tests/carrier.test.ts` ("notifications through a carrier")._

> **Planned: matching any of several topic values.** `topic` names one
> value, which is enough for "mentions me" but not for an area: places carry
> their geohash cells as a topic, and everything within a radius is in one of
> nine cells (the library's "Places and areas"). The plan: `topic` may be
> `{ field, values }` with 1–9 values, and a version matches when it carries
> a tag for any of them. The carried copy already holds a list of tags per
> space, so carriers change only in computing one tag per value. Tracked in
> [#141](https://github.com/leifriksheim/minca/issues/141).

> **Planned: devices deliver subscriptions, by Web Push.** Issue:
> [#60](https://github.com/leifriksheim/minca/issues/60). Subscriptions are
> the account's and apps propose them (above); which device shows a match is
> not modeled yet. Today only an app that is running shows a match (§2.11),
> so nothing reaches a device where it is closed, and an app with
> `scope: spaces`, which cannot read the registry, shows nothing. The plan:
>
> - Each device registers as a **receiver** in its own record, apart from
>   subscriptions: `push: { endpoint, p256dh, auth }` (the browser's
>   `PushSubscription`, for the app that proposed the subscription) and
>   `device` (a name for people). Subscription records hold no device or
>   endpoint data.
> - By default every receiver gets every subscription; a device can opt out
>   on its own. A removed device's receiver record goes with it.
> - A carrier that stores a new version matching a subscription (the rules
>   above) sends a Web Push to each receiver's endpoint: one HTTPS POST,
>   VAPID-signed (RFC 8292), payload encrypted to the device (RFC 8291). The
>   payload is the version as the carrier holds it (private body still
>   encrypted) when it fits in about 3 KB, otherwise its id and space.
> - The push carries RFC 8030's `Topic` header, derived from the version id,
>   so when several carriers send the same record the push service replaces
>   undelivered copies. The notification's `tag` is the record key, so
>   duplicates that get through replace each other.
> - The app's service worker (installed as a PWA on a phone: Android, and
>   iOS 16.4 or later from the home screen) opens the space key from its own storage,
>   decrypts, checks the rest of the filter (`where` included), and shows the
>   notification. Browsers require every push to show one (`userVisibleOnly`),
>   so a device cannot quietly drop most of a stream: a subscription whose
>   carrier-side part is only a busy collection with no topic tag SHOULD be
>   refused when made, naming the fields to mark as topics.
>
> The push service (chosen by the browser) sees timing and size, never
> content. A carrier learns a device's endpoint and how often a tag matches.
> Depends on nothing else in this part.
>
> _Open:_ a push subscription is bound to one sender's VAPID key
> (`applicationServerKey`). Several carriers pushing to one device need either
> one subscription per carrier (the device subscribes with each carrier's key;
> a host's description would list it as `vapid`) or carriers sharing a key.
> Also open: which device copies subscriptions into carry spaces; where
> receiver records live and which carrier sends to which endpoint; whether
> "not on this device" syncs.

## 5. Calls

Calls are not protocol. A call is live messages (§9.2 of [04](04-network.md))
between copies of an app, plus WebRTC connections of the app's own; no peer
syncs, stores or judges a record differently because of it. The `call.*`
messages two calling apps agree on, and how the reference library rings,
joins and leaves, are in [calls](../packages/core/docs/calls.md).
