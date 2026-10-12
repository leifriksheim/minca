# 03 — Spaces

A **space** is the container every record lives in. This part specifies what a
space is and how its id is made; how roles, members and invites are recorded
inside it and replayed into one answer about who may do what; how a private
space encrypts its records and changes its key; and the few spaces and
collections built on top of that: the account registry, passes, subscriptions
and profiles. Contacts, built on these, are described in the library's docs
([contacts](../packages/core/docs/contacts.md)).

What a record is, how it is signed, hashed and versioned, and how collection
rules are written is in [02 — Records](02-records.md). Seeds, DIDs, notes
(UCANs), the account key, the contact key and the two ways anything is sealed
(envelopes and HPKE) are in [01 — Identity](01-identity.md).
How peers connect and prove they may read is in [04 — Network](04-network.md).

- [1. The space and its id](#1-the-space-and-its-id)
- [2. Roles and permissions](#2-roles-and-permissions)
- [3. The access history](#3-the-access-history)
- [4. Replaying the access history](#4-replaying-the-access-history)
- [5. Judging a record against the history](#5-judging-a-record-against-the-history)
- [6. Changing who may do what](#6-changing-who-may-do-what)
- [7. Invites](#7-invites)
- [8. Private spaces: encryption](#8-private-spaces-encryption)
- [9. Key changes, member keys and boxes](#9-key-changes-member-keys-and-boxes)
- [10. Relays and keepers](#10-relays-and-keepers)
- [11. Profiles](#11-profiles)
- [12. The space manager](#12-the-space-manager)
- [13. The account registry](#13-the-account-registry)
- [14. Passes and carry spaces](#14-passes-and-carry-spaces)
- [15. Subscriptions (notify)](#15-subscriptions-notify)
- [16. Contacts](#16-contacts)
- [17. Not yet specified](#17-not-yet-specified)

Terms used throughout:

| Term                  | Meaning                                                                                                                                                                                                                                |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **account**           | An identity's root DID (`did:key:zDn…`, [01](01-identity.md)). What a role is held by.                                                                                                                                                 |
| **root** of a version | The account the signing key speaks for: the issuer at the root of the version's note chain, resolved with no time ([01](01-identity.md) §7.4), or the author itself when there is no note ([01](01-identity.md), [02](02-records.md)). |
| **member**            | An account that holds a role that still exists, in a given state of the history.                                                                                                                                                       |
| **reader**            | Same as member, as far as key distribution is concerned (`readers()`).                                                                                                                                                                 |
| **hex40(x)**          | The first 20 bytes of SHA-256(UTF-8 `x`), as 40 lower-case hex characters.                                                                                                                                                             |
| **cid(x)**            | `"b"` + lower-case RFC 4648 base32 (no padding) of SHA-256(`x`). The id format of [02](02-records.md).                                                                                                                                 |

---

## 1. The space and its id

### 1.1 The space object

A space, as it is handed around (in invites, passes, the space manager), is a
JSON object:

| Field             | Type                      | Notes                                                                                |
| ----------------- | ------------------------- | ------------------------------------------------------------------------------------ |
| `id`              | string                    | `cid(canonical(genesis))`, see 1.2                                                   |
| `name`            | string                    | Display name. **Not** part of the id; unauthenticated and may differ between copies. |
| `visibility`      | `"public"` \| `"private"` | Fixed at creation. Private means record bodies are encrypted (§8).                   |
| `creator`         | string                    | The creator's account DID. Starts holding `creatorRole`.                             |
| `roles`           | Role[]                    | The roles it starts with (§2). 1–64 roles, names unique.                             |
| `creatorRole`     | string                    | Name of one of `roles`.                                                              |
| `createdAt`       | string                    | ISO 8601 timestamp.                                                                  |
| `nonce`           | string                    | base64url of 12 random bytes (16 characters). Keeps two spaces made alike apart.     |
| `readKey`         | string                    | Private only: the `did:key` of the space's first read key (§8.4).                    |
| `encryptionKeyId` | string                    | Private only: the id of the space's first key (§8.1).                                |

### 1.2 The genesis and the id

The **genesis** is the space object without `id` and `name`, with a version
field:

```
genesis = { v: 2, creator, visibility, roles, creatorRole, createdAt, nonce,
            readKey?,           // private only
            encryptionKeyId? }  // private only
id = cid( canonical-JSON(genesis) )
```

Canonical JSON is defined in [02 — Records](02-records.md) (sorted keys, no
whitespace). Role objects inside keep their fields as given (`title` omitted
when absent).

A peer handed a space — in an invite, a pass, from a host — **MUST** refuse it
unless all of these hold (`checkSpace`):

1. `id`, `nonce` and `creator` are strings;
2. `visibility` is `public` or `private`;
3. `roles` is a list of 1–64 well-formed roles (§2.1) with distinct names, and
   `creatorRole` names one of them;
4. a private space has both `readKey` and `encryptionKeyId`; a public space
   has neither;
5. `cid(canonical(genesis))` equals `id`.

> Rationale: nobody who passes a space on can change who started it, with which
> roles, or with which first key. The name is left out so it can change.

**Example.** Creator `did:key:zDnaeZLoH5izvFBqsJ62j3zJ2DYJWASAB7QFmkYR6aeAzhCLg`
(the account of seed `01 02 … 10`), two roles — `owner` (title `Owner`, rank
100, permissions `["*"]`) and `editor` (title `Editor`, rank 10, permissions
`["invite","define"]`), the creator holding `owner` — a fixed time and nonce:

```
{"createdAt":"2026-01-01T00:00:00.000Z","creator":"did:key:zDnaeZLoH5izvFBqsJ62j3zJ2DYJWASAB7QFmkYR6aeAzhCLg","creatorRole":"owner","nonce":"AAECAwQFBgcICQoL","roles":[{"name":"owner","permissions":["*"],"rank":100,"title":"Owner"},{"name":"editor","permissions":["invite","define"],"rank":10,"title":"Editor"}],"v":2,"visibility":"public"}
→ id biypcptbxz4vneknbgueo46ksdldc57anajp3kit5wuevkqeh4i6q
```

The same space made private with the AES key whose raw bytes are
`ff fe fd … e0` (base64url `__79_Pv6-fj39vX08_Lx8O_u7ezr6uno5-bl5OPi4eA`):

```
{"createdAt":"2026-01-01T00:00:00.000Z","creator":"did:key:zDnaeZLoH5izvFBqsJ62j3zJ2DYJWASAB7QFmkYR6aeAzhCLg","creatorRole":"owner","encryptionKeyId":"GGXACDHnP37iP8E8stD1iLnDQYNcp0cvjsA1q6S3idY","nonce":"AAECAwQFBgcICQoL","readKey":"did:key:zDnaem2ikLwS3eYm46gspC7nm6dmYYCMHUHU5yvVHNgARcsWf","roles":[…as above…],"v":2,"visibility":"private"}
→ id b63yb6wiefzfrngbgbmozhv7zcf5ikunjr4al6njqyxvbf62dvi7a
```

### 1.3 Creating a space

To create a space a peer picks the starting roles and `creatorRole`, takes the
current time and a fresh 12-byte random nonce, and for a private space
generates a space key (§8.1) and derives its read key (§8.4). Then it computes
the id. Nothing is written into the space at creation: the genesis alone
makes the creator a member. (The library's defaults for roles and
`creatorRole` are in [its docs](../packages/core/docs/spaces.md#presets).)

_Source: `packages/core/src/space/space-access.ts` (`spaceGenesis`, `spaceIdOf`, `checkSpace`, `checkStartingRoles`), `packages/core/src/space/space-manager.ts` (`create`), `packages/core/src/types.ts` (`Space`). Tests: `packages/core/tests/space.test.ts`, `packages/core/tests/space-access.test.ts` ("the space vouches for itself")._

---

## 2. Roles and permissions

### 2.1 Roles

```
Role = { name: string, title?: string, rank: number, permissions: string[] }
```

A role is well-formed (`checkRole`) when:

- `name` matches `^[a-z0-9][a-z0-9._-]{0,39}$`;
- `title`, if present, is a string of at most 80 characters;
- `rank` is a finite number (any sign, may be fractional);
- `permissions` is a list of non-empty strings of at most 200 characters each.

### 2.2 Permissions and matching

A permission is a plain string. Three are checked by the protocol itself:

| Permission | Lets its holder                                                                                                           |
| ---------- | ------------------------------------------------------------------------------------------------------------------------- |
| `manage`   | change roles and members (§6), change the space key (§9), name relays and keepers (§10), change any collection definition |
| `invite`   | open and close invites (§7)                                                                                               |
| `define`   | define a new collection (§3.1)                                                                                            |

Every other permission belongs to a collection and is named
`<collection>/<permission>` — a rule `can:moderate` in collection `app.poll`
asks for `app.poll/moderate` ([02](02-records.md)).

A permission pattern in a role **matches** a permission when it is equal to it,
or is `*`, or — when it contains `*` — when the pattern, with each `*` read as
"any run of characters (possibly empty)" and everything else literal, matches
the whole permission. So `*` is every permission, `*/*` every collection
permission, `app.forum.*/moderate` matches `app.forum.post/moderate`. A role
**holds** a permission when any of its patterns matches it.

### 2.3 Presets

Not protocol: the protocol reads whatever roles a genesis names and never
looks at a preset's name. The library's presets are in
[its docs](../packages/core/docs/spaces.md#presets).

_Source: `packages/core/src/space/roles.ts` (`checkRole`, `permissionMatches`, `roleHolds`), `packages/core/src/records/rules.ts` (`permissionName`). Tests: `packages/core/tests/roles.test.ts` ("permissions")._

---

## 3. The access history

Everything after the genesis that changes who may do what is a record in the
space itself. These records form the **access history**.

### 3.1 The access collections

Each access record lives at a fixed record key, derived from what it changes.
Bodies are JSON objects; `cutoff` is optional everywhere it appears (§6.3).

| Collection       | Record key                                     | Body                                                                                 | Event kind   |
| ---------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------ | ------------ |
| `sys.role`       | `role:<name>`                                  | `{ name, title?, rank, permissions, cutoff? }` or `{ name, removed: true, cutoff? }` | `role`       |
| `sys.member`     | `member:<hex40(account DID)>`                  | `{ did, role: string \| null, cutoff?, invite?: { key, signature } }`                | `member`     |
| `sys.invite`     | `invite:<hex40(invite DID)>`                   | `{ key: <invite DID>, role, open: boolean }`                                         | `invite`     |
| `sys.revoke`     | `revoke:<hex40(key DID + "\|" + account DID)>` | `{ key: <key DID>, cutoff? }`                                                        | `revoke`     |
| `sys.collection` | `collection:<name>`                            | a collection definition ([02](02-records.md)); may be encrypted                      | `definition` |
| `sys.key`        | `key:space`                                    | `{ keyId, readKey, earlier }` (§9)                                                   | `key`        |
| `sys.relays`     | `relays:space`                                 | `{ relays: string[] }` (§10)                                                         | `relays`     |
| `sys.keepers`    | `keepers:space`                                | `{ keepers: [{ did, name }], copies: number \| null }` (§10)                         | `keepers`    |
| `sys.fork`       | `fork:<hex40(writer DID)>`                     | `{ a, b }`: two versions without bodies (§6.5)                                       | `fork`       |

A `sys.revoke` key names the key revoked and the account revoking it, so no
other account's revoke can sit where it belongs.

> Rationale: record keys are lower case and DIDs are not, so a key names a
> hash of the thing and the body names the thing itself.

Example keys for the account above: `member:4ac5085b5ad9c944bd682566b17bbfd1da9c5dab`;
for the invite DID `did:key:zDnaeVSCSBvS7JUHhskZ9mPRzhjsxsgTwSe6h5a9VSE1LJ2vw`:
`invite:fd8ebfa892a6c4bae7cd265123b7844e49fa50e8`.

### 3.2 Every record names what it saw

Every version written in a space — access record or not — is judged as of
its `seen`: the ids of **heads** of the access history as its writer knew
them (§4.6), at most 64. `seen` is optional ([02](02-records.md) §3.1): a
version without it is judged as having seen nothing but the genesis. A writer **SHOULD** name its current heads, and MAY name fewer: what it
leaves out it is judged as not having seen, which can only take something
away from it (§5.1). One with more than 64 names first those its own standing
rests on (its `member:` and `role:` records, its collection's definition),
then the most recently applied. The space id itself may appear in `seen` and stands for
the genesis. Access records **MUST** carry
`retain: true` ([02](02-records.md)); a version without it is not an access
event.

### 3.3 From a version to an event

A peer turns each stored version in an access collection into an **event**, or
into nothing. It **MUST** collect versions by record key prefix — every
version, not only current ones — and use only those whose collection is the
one the prefix belongs to (`role:`→`sys.role`, `member:`→`sys.member`,
`invite:`→`sys.invite`, `revoke:`→`sys.revoke`, `collection:`→`sys.collection`,
`key:`→`sys.key`, `relays:`→`sys.relays`, `keepers:`→`sys.keepers`,
`fork:`→`sys.fork`).

A version yields no event when any of these hold:

- it lacks `retain`;
- its note does not grant the ability it needs: `collection/define` for a
  `sys.collection` version, `access/change` for any other
  ([01](01-identity.md) §8). A key whose note grants records only never
  changes access, whatever its writer's role;
- its signature, or the note chain behind it, does not verify ([02](02-records.md));
- it is not a `sys.collection` version and it is deleted, or its body is
  encrypted, or its body is not an object;
- the fields below do not check out.

Otherwise the event is `{ id: version.id, key: version.key, root, author: version.author, seen: version.seen ?? [], cutoff, kind, … }`,
where `cutoff` is `body.cutoff` read as a map from key DID to a map from
collection to a non-negative integer (absent: empty; anything else, or more
than 1024 places in all: no event),
always empty for `definition`, `key`, `relays`, `keepers` and `fork`, and:

| Kind         | Checks                                                                                                                                                | Event fields                                                                                                |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `definition` | key starts with `collection:`                                                                                                                         | `name` = key after `collection:`; `deleted` = version is deleted                                            |
| `role`       | `body.name` is a string, key = `role:<name>`                                                                                                          | `removed: true` → `role: null`; else `role = {name, title?, rank, permissions}` which must pass `checkRole` |
| `member`     | `did` string, `role` string or null, key = `member:<hex40(did)>`; if `invite` present it must be `{key: string, signature: string}` and verify (§7.3) | `did`, `role`, `viaInvite` = `invite.key` when present                                                      |
| `invite`     | `key` string, `role` string, `open` boolean, record key = `invite:<hex40(key)>`                                                                       | `inviteKey`, `role`, `open`                                                                                 |
| `key`        | record key `key:space`, `keyId` string ≤ 64 chars, `readKey` starts with `did:key:`                                                                   | `keyId`, `readKey`                                                                                          |
| `relays`     | record key `relays:space`, `relays` list of strings, ≤ 8                                                                                              | `relays`                                                                                                    |
| `keepers`    | record key `keepers:space`, `checkKeepers(keepers, copies ?? null)` passes (§10)                                                                      | `keepers`, `copies`                                                                                         |
| `revoke`     | `key` a `did:key`; record key = `revoke:<hex40(key + "\|" + root)>`                                                                                   | `target` = `key`                                                                                            |
| `fork`       | `a` and `b` prove a fork in this space ([02](02-records.md) §4.10, §6.5); key = `fork:<hex40(their author)>`                                          | `writer` = their `author`, `collection` = the forked line's, `from` = its place (§6.5)                      |

A deleted version in any access collection other than `sys.collection` is
therefore ignored: access is taken away by writing a change, never by deleting.

### 3.4 Storing access records

Whether an access event _counts_ can change as others arrive, so a peer stores
every well-formed one and lets the replay decide. A peer **MUST NOT** store an
access version from outside (a peer, a folder) unless:

1. its `space` is this space's id and it has `retain`;
2. it yields an event (§3.3);
3. everything its `seen` names is present and not waiting (§4.1);
4. its root is **named** by the history — the creator, or the `did` of any
   `member` event with a non-null role, whatever became of it — or it is a
   `member` event joining by an invite key that some held `invite` event
   names.

> Rationale: a stranger who knows a space's id can mint signed records for
> free. Only accounts the history has heard of can get anything stored, and
> "named" only grows, so two peers never disagree for good.

_Source: `packages/core/src/space/roles.ts` (collection constants), `packages/core/src/space/space-access.ts` (record keys), `packages/core/src/node/space-runtime.ts` (`buildEvent`, `loadAccess`, `admissible`). Tests: `packages/core/tests/space-access.test.ts` ("a stranger who knows the space cannot write in it…"), `packages/core/tests/attacks.test.ts`._

---

## 4. Replaying the access history

Every peer runs the same pure function over the same events and gets the same
state, whatever order they arrived in. No order decides anything: whether a
change counts follows from what saw what, and from what the changes are.
This section is normative in full.

### 4.1 State

```
State = {
  roles:       Map<name, Role>,
  members:     Map<accountDid, roleName>,
  invites:     Map<inviteDid, { role, open, event }>,
  definitions: Map<collectionName, { event, definedBy }>,
  keys:        [{ keyId, readKey, event }],   // oldest first; last is current
  keyDue:      boolean,
  relays:      string[],
  keepers:     [{ did, name }],
  copies:      number | null,
}
```

The **start state** comes from the genesis: `roles` = the starting roles;
`members` = `{ creator → creatorRole }`; for a private space `keys` =
`[{ keyId: encryptionKeyId, readKey, event: <space id> }]`, else `[]`;
everything else empty, `false` or `null`.

`role(state, did)` is `state.roles[state.members[did]]`, or null when either
lookup fails. `rank(null)` is −∞. `readers(state)` is every `did` in `members`
whose role name is in `roles`.

### 4.2 Input and waiting

Input: the genesis and a set of events, deduplicated by `id` (first kept).
Call `G` the space id.

An event is **waiting** if its `seen` names itself, or names an id that is
neither `G` nor a held event, or names a waiting event. Compute this to a
fixed point. Waiting events are not placed; their status is `waiting`. All
others are **placeable**.

`ancestors(e)` is the transitive closure of `seen` from `e`, excluding `G`:
what `e` **saw**. Two events neither of which saw the other are
**concurrent**.

### 4.3 Allowed, struck, valid

1. **Allowed.** An event `e` is allowed when `refusal(e, V(e))` (§4.5) is null,
   where `V(e)`, its **own view**, is the merge (§4.4) of the allowed events
   in `ancestors(e)`. That depends only on what `e` saw, so it never changes.
2. **Reductions.** An allowed event is a **reduction** of an account when, in
   its own view, it lowers that account's role (§4.5): a `member` event for
   that account, or a `role` event for a role it holds. A `revoke` is a
   reduction of the keys it names for its own account, a `fork` of the key
   whose line forked, and closing an invite of the joins through it.
3. **Strikes.** A reduction `r` **strikes** an allowed event `e` it reaches
   (`e`'s root is the lowered account; for a revoke, `e`'s author is the key
   and its root the revoke's; for a fork, `e`'s author is the key, `e` is in
   the forked collection and its `log.n` is at least the fork's place; for a
   closed invite, `e` joins through it) when `r`'s cutoff does not cover `e`
   (`r.cutoff[e.author][e's collection] ≥ e`'s place in that collection's
   line, `log.n`, §6.3) and, unless `r` is a revoke or a fork, neither had
   seen the other. A revoke or a fork proof reaches its key's events whatever
   either saw: an owner reacting to a thief has seen what the thief did.
   Revokes and forks are never struck.
4. **Valid among a set** `S` (closed under `ancestors`), in two passes:
   1. Take the strongly connected components of the strikes between allowed
      events in `S`, and visit them so that every component comes after the
      ones that strike into it. An allowed event is **unstruck** unless an
      unstruck event from another component strikes it. Strikes within one
      component don't count: reductions that strike each other all stand, as
      concurrent revocations do in Keyhive.
   2. Then, ancestors first, an unstruck event is **valid** when
      `refusal(e, W(e))` is null, where `W(e)` is the merge of the valid
      events in `ancestors(e)`. So a struck grant gives no power to anything
      that rests on it, whether or not that cited the removal.

   The history's valid events are those valid among all placeable events.

An event that is not allowed is **dropped** with its refusal; one that is
allowed but not valid is dropped as struck. Valid events are **applied**.

### 4.4 Merging

The state of a set of events is the start state with, for each record key,
the winning event among those **latest** on it (no other event on that key
saw them) applied:

| Kind                              | Among latest events that didn't see each other, the winner is                                                                                                                                                                                                                             |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `member`, `invite`                | the one giving least: closed before open (invites), then one whose role gives no more than any other's — none, or no higher rank and every permission covered by the other's — by the roles as **its own view** had them; where two can't be compared, the lower rank, then the lowest id |
| `role`                            | the one giving least, by coverage in the same way, by the role it sets                                                                                                                                                                                                                    |
| `definition`, `relays`, `keepers` | the lowest id; rival first definitions of a collection by two accounts, none (below)                                                                                                                                                                                                      |
| `key`                             | every key stands: `keys` holds the start key, then every other key by id, then the current one — the lowest id among the latest                                                                                                                                                           |
| `revoke`, `fork`                  | change no state                                                                                                                                                                                                                                                                           |

Applying sets `roles[name]`, `members[did]`, `invites[inviteDid]`,
`relays`, `keepers` and `copies` as the event says, or removes the entry when
its role is null. A `definition` sets `definitions[name] = { event,
definedBy }`. Of the definitions of that name in the set that saw every
removal the winner saw, those that saw no other are its first definitions;
`definedBy` is their root if they are all one account's, and null if not
([02](02-records.md) §6.3): no id decides it. When `definedBy` is null and
more than one definition is latest, the lowest id does not win: none is set
in `definitions`, and `contested[name]` lists the latest ones instead, for
readers to judge by what they say (02 §6.3); while it does, only someone
holding `manage` may change the definition. A change applied on top, having
seen them, removes `contested[name]`. A deleted one removes the entry.

`keyDue` is true, in a private space, when some event in the set took
reading from someone (in its own view, a reader before and not after) and the
current key's event had not seen it; and, for the current state, when anyone
who held the current key (a reader as it was made, or made a reader by a
change it had not seen) reads no more, however that came about.

The **current state** is the merge of the valid events.

> Rationale: least power wins, so a grant racing a restriction beats it only
> when neither role covers the other, and then by lower rank: a grant its
> author could have made anyway. An id decides only between two equally
> restrictive writes, where either outcome is safe. Rivals are compared by the roles as each one's own
> view had them, so a later edit to a role can't reorder them.

### 4.5 Refusals — the rank rule

`refusal(e, S)` with `A = role(S, e.root)` is:

**`role`**

- `A` must hold `manage`;
- if the role exists, its rank must be below `A.rank`;
- removing: the role must exist;
- otherwise the new rank must be below `A.rank`, and every permission in the
  new role must be matched by some pattern of `A` (a `*` in `A`'s pattern
  matches anything, including a `*`).

**`member`**

- _Joining by invite_ (`viaInvite` set): `root` must equal `did`; the invite
  must exist and be open; its role must equal `e.role`; `did` must have no
  role now; the invite's role must exist.
- _Leaving_: `root = did` and `role` null is allowed when `did` has a role now.
- _Otherwise_: `A` must hold `manage`; if `did` has a role now, its rank must
  be below `A.rank`; removing requires `did` to have a role; a new role must
  exist and its rank must be **at most** `A.rank`.

**`invite`**

- `A` must hold `invite`;
- if the invite exists and its current role exists, that role's rank must be
  at most `A.rank`;
- closing (`open: false`) requires the invite to exist;
- opening requires the role to exist with rank at most `A.rank`.

**`revoke`** — `A` must hold a role. A revoke only ever reaches versions its
own account signed (§5.1), so a member may revoke only its own keys in effect.

**`fork`** — `A` must be non-null: any member may bring the proof, which
stands on its own.

**`definition`**

- a new collection: `A` must hold `define`;
- an existing one (change or delete): `A` holds `manage`, or `A` is non-null
  and `root` is the collection's `definedBy` (never when that is null).

**`key`** — the space must have keys (private); `A` must hold `manage`; the
`keyId` and the `readKey` must both differ from every key already in `keys`.

**`relays`** — `A` must hold `manage`, and the list must pass `checkRelays` (§10).

**`keepers`** — `A` must hold `manage`, and the list must pass `checkKeepers` (§10).

A consequence of the rank rule: two accounts of equal rank can never remove or
demote each other, only themselves.

**Reductions.** When an applied `member` or `role` event lowers an affected
account's role — the `did` of a `member` event; every current holder of the
role for a `role` event — it is a **reduction** of that account. Lowered means
the role is gone, ranked lower, or lacks a permission it had. A promotion takes
nothing away and is not one. Reductions drive §5.

### 4.6 What the replay exposes

- `current` — the final state.
- `status(id)` — `applied` (with index), `dropped` (with reason), `waiting`, or unknown.
- `heads()` — the ids of applied events other than `revoke` and `fork` that no
  other such event saw, directly or through others, sorted ascending. This is
  what a writer puts in `seen`. A dropped event, a revoke and a fork proof are
  never heads: none changes the state, so a writer need not name them, and
  however many of them anyone makes, they can't fill `seen`.
- `at(seen)` — the merge of the events valid among what `seen` names and
  everything they saw, or null when anything in `seen` (other than `G`) is
  missing or waiting.
- `revoked(key, account)` — every applied revoke of that key by that account.
- `named(did)`, `knownInvite(inviteDid)` — as used in §3.4.

**Example (a removal against a concurrent ban).** Admin Alice makes Bob a
moderator and gives moderators `manage`, then adds Carol. Apart, Alice removes
Bob and Bob removes Carol; both saw Carol's addition. Each is allowed in its
own view. Alice's removal is a reduction of Bob that Bob's removal had not
seen, and its cutoff doesn't cover it, so it strikes it; nothing strikes
Alice's. Every arrival order gives Bob: none, Carol: member.

_Source: `packages/core/src/space/roles.ts` (`replayAccess`, `invalidWithin`, `componentsOf`, `merge`, `least`, `definerOf`, `extended`, `refusal`). Tests: `packages/core/tests/record-keys.test.ts` ("who first defined a collection"), `packages/core/tests/access-attacks.test.ts`, `packages/core/tests/access-properties.test.ts` (random histories: order, safety, liveness, ids, reductions), `packages/core/tests/access-convergence.test.ts` (every arrival order, and extending one change at a time, against replaying whole), `packages/core/tests/roles.test.ts` (all of "the rank rule", "invites", "offline conflicts"), `packages/core/tests/key-change.test.ts` ("when a new key is due")._

---

## 5. Judging a record against the history

### 5.1 `judge`

A record is judged in its **own view**, the access changes its `seen` names
and everything they saw, and then against the changes to its author's
standing it had not seen. Those are the only two inputs.

`judge` answers only for the access history. A peer combines it with the
rest of standing as [02](02-records.md) §9.4 says: a version `judge` calls
withdrawn is still judged on its tags and rules, and is refused if they
fail.

A change that took power from someone **covers** a version when the change's
`cutoff` (§6.3) names the version's key and collection with a place at or
above the version's place in that key's line for that collection (`log.n`). What a covering change's author had seen of that key stands,
whatever the change took away.

Given a record's `id`, its root, its `seen`, its `author`, collection and
`log.n`, a predicate `needs(role, state)`, and optionally `within`, the `seen` of a
version that cites this one. Peers never pass `within` when judging a
version's standing; the library's checks do, to judge a version they cite as
of what the citer saw ([checks](../packages/core/docs/checks.md#citing-a-version)):

1. If anything in `seen`, or in `within`, is missing or waiting → not yet
   (retry later).
2. If an applied `revoke` by the record's own root names its `author`
   (§6.4), and does not cover it, and (with `within`) is in
   `within ∪ ancestors(within)` → withdrawn. Every such revoke applies, each
   with its own cutoff.
   The same for a fork: if a fork of `author`'s line in the record's
   collection is recorded (§6.5) whose `from` is at most `log.n`, and (with
   `within`) its event is in `within ∪ ancestors(within)` → withdrawn.
3. `S_seen = at(seen)`. If `needs(role(S_seen, root), S_seen)` is false → refused.
4. Let `U` be the reductions of `root` (§4.5) whose events are **not** in
   `seen ∪ ancestors(seen)`, that do not cover it, and (with `within`) **are**
   in `within ∪ ancestors(within)`. If `U` is not empty, let
   `S' = at(seen ∪ U)`, the record's own view with those changes and everything
   they saw, the rules included. If the record would not stand by §5.2
   steps 6–9 with `S'` in place of `at(seen)` → withdrawn ("its author's access
   was taken away").
5. Otherwise it stands.

So a record stands if its author was allowed as of what it saw, and still is
once every change to its standing it had not seen is added, along with what
those changes saw, unless the change covers it. A writer can't escape a
removal, a demotion, or the rules a demotion saw, by naming an older point. A
narrowed rule on its own binds what saw it: without trusted time, a version
naming an older point can't be told from one written offline then, and it
counts if its author could have written it then. For a version that another
cites, judged `within` the citer's `seen`, only what the citer had seen can take it away.

Withdrawn is a refusal for every purpose but two: the version is still
stored, and the library's checks can count it as evidence cited by a version
that had not seen what withdrew it ([02](02-records.md) §9.5).

_Source: `packages/core/src/space/roles.ts` (`replayAccess`, `judge`, `cutOf`), `packages/core/src/node/space-runtime.ts` (`underUnseen`). Tests: `packages/core/tests/roles.test.ts` ("records against the history"), `packages/core/tests/rules.test.ts` ("a narrowed rule…"), `packages/core/tests/checks.test.ts` ("a proof stays a proof…")._

### 5.2 Standing of an ordinary record

A version outside the access collections **stands** when, in this order:

1. its `space` equals the space id;
2. its signature and note chain verify ([02](02-records.md)) — giving `root`;
3. in the account's own spaces (registry, contacts, carry spaces) its note
   grants `account/write` ([01](01-identity.md) §8);
4. its first version is present, is `seq` 0, has the same key and collection;
5. `at(seen)` is available (else: not yet);
6. with `rules` = the rules of the definition in force for its collection in
   `at(seen)` (none for `sys.*` collections, or when the definition is missing
   or unreadable), the action (`create` for `seq` 0, `delete` for a deleted
   version, else `edit`), and `creator` = whether the root of the first
   version is `root`:
   `needs(role) = role ≠ null and (no rules or allows(rule for action, { member: true, creator, can: p → role holds <collection>/p }))`
   ([02](02-records.md) for `allows`, `onePer`, `fixed` and topics);
7. `role(at(seen), root)` is non-null and satisfies `needs`;
8. `judge(...)` (§5.1) passes;
9. the [02](02-records.md) checks on topic tags, `onePer` keys and `fixed`
   fields pass (skipped where the body cannot be opened);
10. §5.1 step 4 holds: with the changes to its author's standing it had not
    seen, and what they saw, it would still have stood.

> **Known defect:** a peer applies step 3 only where it knows the space is
> one of the account's own (`accountOnly` in
> `packages/core/src/node/space-runtime.ts`). The account's devices know,
> since they derive those ids (§13.1). A peer without the account key, such as
> a carrier, a host or a mirror reader, may not be able to tell those spaces
> from any other, and then lets stand a version the account's devices refuse.
> Tracked in [#90](https://github.com/leifriksheim/weave/issues/90).

So a record is judged by the rules it saw, and by any rules that a change to
its author's standing it had not seen had seen. Rules that loosened take
nothing away, since what kept to the stricter rules keeps to these.

An access record stands when its event's status is `applied`.

A non-member — including someone holding only a view-only invite — can
therefore write nothing at all in a space, not even `sys.profile`.

_Source: `packages/core/src/space/roles.ts` (`judge`), `packages/core/src/node/space-runtime.ts` (`judgeStanding`, `rulesAt`, `underUnseen`, `underRules`, `definitionIn`). Tests: `packages/core/tests/roles.test.ts` ("records against the history"), `packages/core/tests/space-access.test.ts` ("who may write", "taking it back"), `packages/core/tests/rules.test.ts` ("rules: changing them"), `packages/core/tests/access-convergence.test.ts`._

---

## 6. Changing who may do what

### 6.1 Members and roles

- **Add or change a member:** write `sys.member` at `member:<hex40(did)>` with
  `{ did, role }`.
- **Remove a member:** the same with `role: null`.
- **Define or change a role:** write `sys.role` at `role:<name>` with the role.
- **Remove a role:** `{ name, removed: true }`. Its holders stay in `members`
  but hold nothing (they are no longer readers).

Each is judged by §4.5.

### 6.2 Leaving and handing over

**Leaving the space's history:** an account writes its own member record with
`role: null`. Anyone may do this, whatever their rank.

**Handing over:** someone at the top gives another account their own role
(allowed: a role up to your own rank), then removes themselves. The new holder
keeps managing.

**Leaving on a device:** when an account stops holding a space in which it
holds a role, the device that leaves **SHOULD** first write the account's own
`sys.member` with `role: null`, and give it to at least one peer of another
account before it forgets the space, since nothing sends it afterwards. It
then deletes the space's membership record in the account registry (§13.2)
and forgets the space and its keys. The replay drops the account from
`readers`, a key change becomes due (§9.2), and a manager changes the key
(§9.3).

- A device that follows a deleted membership in the registry, while the
  account still holds a role in that space, **SHOULD** write the self-removal
  too: the device where the person left may have had no peer to give it to,
  or no note that may change access. Two such removals made apart are both
  accepted.
- An account with no role (a view-only holder) has nothing to remove and
  writes nothing.
- An account that is the space's only reader writes nothing: nobody else
  holds a key to change.
- Anyone may leave whatever their rank, so the last account at the top can
  leave too. The space is then left with no one holding `manage`, and that
  is accepted.

What the library does, and how long it waits for a peer, is in
[its docs](../packages/core/docs/node.md#leaving-a-space).

_Source: `packages/core/src/node/node.ts` (`spaces.leave`, `giveUpPlace`, `reconcileOnce`), `packages/core/src/node/space-runtime.ts` (`giveUpPlace`). Tests: `packages/core/tests/key-change.test.ts` ("leaving a private space"), `packages/core/tests/node.test.ts` ("the account registry")._

### 6.3 Cutoffs

A change that takes power from people — lowering or removing a member, lowering
or removing a role, revoking a key — **SHOULD** carry `cutoff`: for each key of
the affected accounts and each collection, the end of the unbroken line its
writer holds of that key's versions in that collection ([02](02-records.md)
§4.10): from place 0 of `log`, each place held and naming the one before it
as `log.prev`. A place held past a gap covers nothing, so one planted far ahead
can't stretch a cutoff over what its writer signs later. A node holding part
of a space keeps the lines of the collections it holds whole
([05](05-sync-and-storage.md) §9), so it covers all it holds. At most 1024 places in all: past that, a writer
orders each account's lines with defined collections first, then the rest,
each in name order, and takes one line from each account in turn (accounts by
DID), so no one's writing can crowd out anyone else's, and nobody can make
themselves unremovable by writing into many collections. What is left out is
judged with the change. A change reaching more than 1024 accounts, such as a role
with that many holders, can't cover them all; lower or remove the role's
holders in smaller changes first. A node covers only the collections it holds: one
holding part of a space, removing someone, leaves their writes elsewhere to be
judged with the change ([#166](https://github.com/leifriksheim/weave/issues/166)).

```json
{
  "did": "did:key:zDnae…bob",
  "role": null,
  "cutoff": {
    "did:key:zDnae…bobLaptop": { "app.chat": 41, "app.photos": 3 },
    "did:key:zDnae…bobPhone": { "app.chat": 7 }
  }
}
```

Everything a covered key signed in a covered collection at or below its place stands, as far as this
change goes. Anything else the affected account wrote that had not seen the
change, whatever point in history it claims, is judged with it (§5.1 step 4):
later places, and keys the change's writer had never seen. A cutoff names a
place, not a branch: a second version at a covered place is a fork of that
key's line, and a fork proof (§6.5) withdraws both. A change to a collection's definition carries no cutoff: it binds what
saw it.

> Rationale: a cutoff is exact and small, one number per key, and doesn't
> depend on which records the writer's node happens to hold, as a list of ids
> did. A writer that sets it lower than it saw takes away what it may take
> away anyway.

### 6.4 Revoking a key

An account revokes one of its keys in a space by writing `sys.revoke` at
`revoke:<hex40(key DID + "|" + account DID)>` with `{ key, cutoff? }`. From
then on, every version that key signed for that account stands only if the
revoke covers it (§5.1 step 2), whatever it saw; the rest are withdrawn. Every
applied revoke applies, each with its own cutoff (§4.3), so no revoke can shield what another takes: a thief who revokes a stolen key first, covering what it signed
in advance, is still undone by the owner's own revoke. A revoke names a key,
not a note, so every note to that key goes with it.

_Source: `packages/core/src/node/space-runtime.ts` (`setMember`, `putRole`, `removeRole`, `revoke`, `cutoffFor`), `packages/core/src/node/node.ts` (`spaces.leave`). Tests: `packages/core/tests/roles.test.ts` ("handing over…", "a revoked key…"), `packages/core/tests/space-access.test.ts` ("taking it back")._

### 6.5 Proving a fork

A member who holds two versions that prove a key's line for a collection is
not one line, a fork or a break ([02](02-records.md) §4.10), writes
`sys.fork` at `fork:<hex40(writer DID)>` with `{ a, b }`: the two versions
without their bodies, `a` the one with the lower id. Every peer checks the
proof itself before the change counts:

- `a` and `b` are objects with no `body` member, each passes the shape check
  ([02](02-records.md) §4.6) and the signature check (02 §3.3, steps 1–3);
- both have this space as `space`, and different ids;
- they are a **break**: one, `v`, has a `log.prev` naming the other, `p`, and
  `p` is another key's or another collection's, or not one place before
  (`p.log.n ≠ v.log.n − 1`). Then the event's `writer` is `v.author`,
  `collection` is `v.collection` and `from` is `v.log.n`;
- or else a **fork**: the same `author`, the same `collection` and the same
  `log.n`. Then `writer` is the shared `author`, `collection` the shared
  `collection` and `from` that `log.n`;
- the record key is `fork:<hex40(writer)>`.

Anything else is not a well-formed change and is ignored like any other
(§3.3). From the first applied fork of a writer's line on, everything it
signed in that collection of the space at `from` or later is withdrawn (§5.1
step 2). A later proof, of another collection or of an earlier place, is the
record's next version, and for each collection the lowest `from` applied
counts. Nothing is kept: no one can say which branch was the owner's.

A peer writes the proof only when no applied fork of that writer's line
already covers the place it found.

> Rationale: the proof names a key, not an account. A copied or stolen key
> is the account's problem, and the owner's way out is to revoke the key
> (§6.4) and go on with another; the account's place in the space is a
> person's decision to change (§6.1).

> Rationale: a fork reaches only the collection it was found in. Nothing
> orders a key's versions across collections ([02](02-records.md) §4.10), so
> a place in one line says nothing about which of the key's versions
> elsewhere came after it. The owner's revoke reaches every collection.

_Source: `packages/core/src/records/fork.ts` (`checkFork`, `breaksLine`, `forkProof`), `packages/core/src/node/space-runtime.ts` (`buildEvent`, `placeInLog`, `reportFork`), `packages/core/src/space/space-access.ts` (`forkKey`), `packages/core/src/space/roles.ts` (`forked`, `forks`). Tests: `packages/core/tests/writer-logs.test.ts` ("a fork", "a fork reaches only the line it is in…"), `packages/core/tests/access-attacks.test.ts` ("a revoke or a fork proof undoes…"), `packages/core/tests/access-convergence.test.ts`._

---

## 7. Invites

### 7.1 Invite secret and invite key

An invite link that lets someone join with a role carries a **secret**: 32
random bytes. It stands for a P-256 key pair:

```
seed    = HKDF-SHA256(ikm = secret, salt = empty, info = "weave/space-invite/v1", L = 32)
keypair = deriveKeyPairFromSeed(seed)      // 01 — Identity
invite DID = did:key of the public key     // P-256 multicodec
```

Example: secret `00 01 02 … 1f` (base64url `AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8`)
→ `did:key:zDnaeVSCSBvS7JUHhskZ9mPRzhjsxsgTwSe6h5a9VSE1LJ2vw`.

A secret of any length other than 32 bytes **MUST** be refused.

### 7.2 Opening and closing an invite

An account holding `invite` opens one by writing `sys.invite` at
`invite:<hex40(inviteDid)>` with `{ key: inviteDid, role, open: true }`. Only
the invite's public key goes into the space; the secret goes only into the link.

It is closed by writing the next version of the same record with `open: false`
(same `key` and `role`). Whether deleting the record should also close it is
not yet specified; a writer closing an invite SHOULD write `open: false`. A
view-only invite (§7.5) has no record and cannot be closed; only a key change
(§9) stops it working for new records.

> **Known defect:** deleting an invite record does not close it. A deleted
> access version yields no event (§3.3), so the invite stays open as of its
> last undeleted version. `closeInvite` writes `open: false`
> (`packages/core/src/node/space-runtime.ts`). Other implementations MUST NOT rely on a
> deleted invite staying open.
> Tracked in [#20](https://github.com/leifriksheim/weave/issues/20).

> **Planned:** a deleted access record cannot leave access standing. The
> original design took access back by deleting the record (a member, an
> invite, a role); the build writes a change instead (`role: null`,
> `removed: true`, `open: false`). What is left is to settle the delete
> case, one of two ways: a deleted `sys.invite` version yields an `invite`
> event with `open: false` (and likewise a deleted `sys.member` or
> `sys.role` yields a removal), or a peer refuses to store a deleted version
> in any access collection other than `sys.collection` (§3.4). The second is
> simpler and keeps "access is taken away by writing a change" as the only
> rule. Fixes the known defect above, tracked in
> [#20](https://github.com/leifriksheim/weave/issues/20).

### 7.3 Joining with a secret

Once the invite's record has reached the joiner and is open in the current
state, the joiner writes **its own** member record:

```
sys.member at member:<hex40(joinerDid)>
{ did: joinerDid, role: <the invite's role>,
  invite: { key: inviteDid, signature: base64url(sig) } }

sig = ECDSA-P256-SHA256 (P1363, 64 bytes) by the invite private key over
      UTF-8 "weave/space-invite/v1|<spaceId>|<joinerDid>"
```

Verification imports the public key from `inviteDid` and checks `sig` over
the same bytes; a member record whose `invite` does not verify yields no event
(§3.3). The signature binds the join to one account and one space.

If the joiner already holds a role, joining is a no-op. If the invite's record
has not arrived yet, the joiner keeps the secret and tries again as records
arrive; once joined it forgets the secret. The joiner writes this record
before it is a member; its `seen` must include the invite event.

> **Known defect:** a joiner can count itself a member for a moment after the
> invite was closed elsewhere, until the close reaches it. Other members
> refuse its member record, and it converges, but the joiner's own view is
> optimistic until then. Other implementations MUST NOT treat a join as
> accepted before the invite's current state says it is open. Tracked in
> [#10](https://github.com/leifriksheim/weave/issues/10).

### 7.4 The invite string

An invite is `base64url( UTF-8( JSON.stringify(SpaceInvite) ) )` — plain
`JSON.stringify`, not canonical:

| Field       | Type                                  | Present                                                           |
| ----------- | ------------------------------------- | ----------------------------------------------------------------- |
| `space`     | space object (§1.1), including `name` | always                                                            |
| `invitedBy` | string, the inviter's account DID     | always; unauthenticated, for display                              |
| `key`       | base64url of the raw 32-byte AES key  | private spaces (the inviter's current key)                        |
| `invite`    | base64url of the 32-byte secret       | role invites only                                                 |
| `role`      | string                                | role invites only; for display — the invite record is what counts |
| `relays`    | string[]                              | when known: the space's relays (§10), else the inviter's own      |

> **Known defect:** `space.name` and `invitedBy` are not authenticated. Neither
> is in the space's genesis (§1.2), and nothing signs the invite string, so
> anyone passing the link on can change them. A reader MUST NOT treat them as
> verified. A fix will authenticate them or drop them from the invite.
> Tracked in [#20](https://github.com/leifriksheim/weave/issues/20).

Example (private space of §1.2, role invite with the secret of §7.1), decoded:

```json
{
  "space": {
    "id": "b63yb6wiefzfrngbgbmozhv7zcf5ikunjr4al6njqyxvbf62dvi7a",
    "visibility": "private",
    "creator": "did:key:zDnaeZLoH5izvFBqsJ62j3zJ2DYJWASAB7QFmkYR6aeAzhCLg",
    "roles": [
      { "name": "owner", "title": "Owner", "rank": 100, "permissions": ["*"] },
      { "name": "editor", "title": "Editor", "rank": 10, "permissions": ["invite", "define"] }
    ],
    "creatorRole": "owner",
    "createdAt": "2026-01-01T00:00:00.000Z",
    "nonce": "AAECAwQFBgcICQoL",
    "readKey": "did:key:zDnaem2ikLwS3eYm46gspC7nm6dmYYCMHUHU5yvVHNgARcsWf",
    "encryptionKeyId": "GGXACDHnP37iP8E8stD1iLnDQYNcp0cvjsA1q6S3idY",
    "name": "Plans"
  },
  "invitedBy": "did:key:zDnaeZLoH5izvFBqsJ62j3zJ2DYJWASAB7QFmkYR6aeAzhCLg",
  "key": "__79_Pv6-fj39vX08_Lx8O_u7ezr6uno5-bl5OPi4eA",
  "invite": "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
  "role": "editor",
  "relays": ["wss://relay.example"]
}
```

encoded: `eyJzcGFjZSI6eyJpZCI6ImI2M3liNndpZWZ6ZnJuZ2JnYm1vemh2N3pjZjVpa3VuanI0YWw2bmpxeXh2YmY2MmR2aTdhIiwidmlzaWJpbGl0eSI6InByaXZhdGUi…`
(the full string is the base64url of the JSON above).

A private-space invite carries the space key, so the whole string is a
secret. When embedded in a URL it **SHOULD** go in the fragment. A reader
**MUST** accept either the bare string or a link containing
`#invite=<string>` (also `?invite=` / `&invite=`), taking the value up to the
next `&` or whitespace.

### 7.5 View-only and role invites

- A **view-only** invite has no `invite` and no `role`. It gives the space
  (and, for a private space, the key) — enough to sync and read — and no
  standing: the holder writes nothing.
- A **role** invite also carries the secret of an open `sys.invite` record.

Which kind of invite to make, and for which role, is the inviter's choice; the
library's defaults are in [its docs](../packages/core/docs/spaces.md#invites).

### 7.6 Accepting and previewing

On `join`, a peer **MUST**:

1. parse the string (reject if it is not base64url JSON with `space.id` and `space.name`);
2. refuse the space unless `checkSpace` passes (§1.2);
3. refuse a `key` for a public space;
4. refuse an `invite` secret that is not 32 bytes.

A carried `key` is imported as-is; its id is its hash (§8.1), so it is either
a key the history names or one that opens nothing. It is not checked against
`encryptionKeyId` (it may be a later key). Relays from the invite are used
only if they pass `checkRelays` (§10).

Closing an invite by its link: derive the invite DID from the link's secret
(§7.1) and close that record.

_Source: `packages/core/src/space/space-access.ts` (`generateInviteSecret`, `deriveInviteKey`, `signInvite`, `verifyInvite`), `packages/core/src/space/space-manager.ts` (`encodeSpaceInvite`, `parseSpaceInvite`, `join`), `packages/core/src/node/space-runtime.ts` (`openInvite`, `closeInvite`, `join`), `packages/core/src/node/node.ts` (`spaces.invite`, `preview`, `join`, `closeInvite`, `bareInvite`). Tests: `packages/core/tests/space-access.test.ts` ("the keys", "invites"), `packages/core/tests/space.test.ts` ("invites"), `packages/core/tests/roles.test.ts` ("invites")._

---

## 8. Private spaces: encryption

### 8.1 The space key

A space key `K` is 32 random bytes. It is only ever key material for HKDF
(01 §5); nothing uses it as a key itself. From it:

```
sealKey = HKDF(K, "weave/space-seal/v1", 32)                 // AES-256-GCM: every envelope under this space key
keyId   = base64url(HKDF(K, "weave/space-key-id/v1", 16))    // 22 characters
readKey = §8.4;  topic key = 02 §8.2
```

The first key's id is the genesis's `encryptionKeyId`; later keys are named by
`sys.key` (§9). A peer that receives a raw key (in an invite, a box, a key
record's `earlier`) derives its id from it and takes it only as the key that
id names.

Example: `K = ff fe … e0` → id `aLhvw5pkV65_lcQHEcUOug`.

Envelopes take a random 96-bit nonce, which keeps AES-GCM safe for about 2³²
seals under one key, and a space's seal key lasts until a member is removed
(§9); a space that would write more under one key needs to change it first
([#182](https://github.com/leifriksheim/weave/issues/182)).

### 8.2 What is encrypted

In a private space, the body of every version is encrypted **before signing**,
except in these collections, which stay in the clear:

`sys.role`, `sys.member`, `sys.invite`, `sys.revoke`, `sys.key`, `sys.box`,
`sys.memberkey`, `sys.relays`, `sys.keepers` and `sys.fork` (§6.5): proof every peer must check, holding signed envelopes
rather than anyone's words.

Everything else is encrypted — application records, `sys.collection`
definitions, `sys.profile`, and the registry's own collections. The envelope
([02](02-records.md): `id`, `author`, `collection`, `space`, `key`, `seq`,
`seen`, `createdAt`, `proof`, `tags`, `retain`, `deleted`, signature) is
always in the clear; `links` are moved inside the ciphertext and omitted from
the envelope. A delete carries no body.

> Rationale: a peer holding no secret of the space — a relay-side mirror, a
> carrier, a host — must still replay the access history and reach the same
> verdict as a member. Definitions stay sealed: a peer that cannot read
> records has no use for their rules.

### 8.3 The encrypted body

```
plaintext = UTF-8( JSON.stringify( links.length ? { body, links } : { body } ) )
sealed    = envelope(sealKey, "weave/record-body/v1",
                     { space: <space id>, collection, key: <record key>, keyId }, plaintext)   // 01 §9.1
body      = { sealed: base64url(sealed), keyId }
```

The bound is what a reader knows of a version before it opens it: its space,
its collection and its record key, from the envelope, and the key id the body
names. So a body copied into another record, collection or space, or relabelled
with another key id, does not open.

A writer **MUST** encrypt with the key the history names as current (the last
entry of `keys`); if it does not hold that key it **MUST NOT** write.

A reader treats a body as encrypted when it has string `sealed` and string
`keyId`, looks up `keyId` among the keys it holds, opens it with the version's
own space, collection and record key, and takes `body` and `links` from the
result. A body it cannot open, for any of these reasons, is shown as
unreadable (`body: null`), never refused for that reason.

Example (key of §8.1, space `bexample`, collection `app.note`, record key `k1`,
nonce `a0 a1 … ab`, plaintext `{"body":{"text":"hi"}}`):

```json
{
  "sealed": "AaChoqOkpaanqKmqq0Fx-eCwOhnoZnLVU8hJnQsqWTBRgYQ5jezwBbEdvJDeKm5_wX3j",
  "keyId": "aLhvw5pkV65_lcQHEcUOug"
}
```

### 8.4 The read key

A private space has a **read key** pair per space key, so a peer can prove it
may read without anyone checking it holding the AES key:

```
readSeed = HKDF-SHA256(ikm = K, salt = empty, info = "weave/space-read/v1", L = 32)
readKey  = deriveKeyPairFromSeed(readSeed)      // 01 — Identity; did:key P-256
```

The genesis names the first key's read DID (`readKey`); each `sys.key` names
the new one's. How a peer proves it holds the read key when connecting is in
[04 — Network](04-network.md).

Example: the key of §8.1 → `did:key:zDnaem2ikLwS3eYm46gspC7nm6dmYYCMHUHU5yvVHNgARcsWf`.

_Source: `packages/core/src/privacy/space-encryption.ts` (`spaceKeyFromRaw`, `sealBody`, `openBody`), `packages/core/src/node/space-runtime.ts` (`IN_THE_CLEAR`, `write`, `openBody`), `packages/core/src/space/space-access.ts` (`deriveReadKey`, `deriveReadSeed`). Tests: `packages/core/tests/space.test.ts` ("private space versions"; "a sealed body moved to another record, collection or space does not open"; "the example body of spec 03 §8.3 opens"), `packages/core/tests/space-access.test.ts` ("a view-only invite to a private space reads everything and writes nothing"; the read-key vector)._

### 8.6 What a private space still shows

Encrypting bodies leaves the envelope readable to anyone holding the
ciphertext: a relay-side peer, a carrier, a host, a mirror's storage
provider. It names each version's account (`author`, `proof`), its
collection and its record key.

**`onePer` keys** are an HMAC under a key derived from the space's first key
([02](02-records.md) §7.3), so only readers can compute or test one: someone
holding only the ciphertext can't check a guess of who voted on which poll, or
how. A key whose `onePer` names `@author` starts with its account's owner part
([02](02-records.md) §4.1), which says no more than the version's `author`
and `proof` do. A former member keeps the first key, and can still test
guesses against what it is sent later.

_Source: `packages/core/src/records/rules.ts` (`onePerSecret`, `onePerKey`), `packages/core/src/node/space-runtime.ts` (`onePerKeying`). Tests: `packages/core/tests/record-keys.test.ts` ("in a private space, nobody without its key can compute or test one (#87)")._

> **Planned: what it still gives away.** Tracked in
> [#223](https://github.com/leifriksheim/weave/issues/223).
>
> - **`profile:` keys** (§11) are `hex40` of the account, so anyone can
>   confirm which known accounts have a profile in a space. Membership is
>   public anyway: `sys.member` bodies name each account in the clear (§8.2),
>   by design, so a blind peer can judge writes. Hiding `profile:` keys hides
>   nothing about who is a member until that changes.
> - **Collection names.** `collection` travels in the clear, so the same
>   peers see `app.todo.item`. Encrypting it, or replacing it with a keyed
>   hash, would close that. `sys.*` names stay in the clear: a peer without
>   the key must still recognise the access collections to replay the
>   history. Depends on and touches: the envelope and the rules
>   ([02](02-records.md)); the collections named in a sync hello and what a
>   partial holder keeps ([05](05-sync-and-storage.md)); carried
>   subscriptions, which a carrier matches by collection (§15). _Open:_
>   whether names are hashed or encrypted, and under which key.

---

## 9. Key changes, member keys and boxes

A private space's key changes when someone loses their place in it, so a
removed member reads nothing written afterwards. Peers that let the removed
member in on the old key then let go of them, so nothing more of the space
reaches them ([04](04-network.md) §6.3). Until the key changes, peers that
know of the removal stop sending to them anyway.

### 9.1 Member keys (`sys.memberkey`)

Each account has, per space, a **member key**: a P-256 ECDH key pair derived
from the account key and the space id ([01 §10.2](01-identity.md),
`deriveMemberKeyBytes`: HKDF-SHA256(account key, info
`"weave/p256-member-key/v1|<spaceId>"`, 48 bytes) reduced to a scalar).

Each member publishes its public half, in the clear:

```
sys.memberkey at memberkey:<hex40(accountDid)>
{ key: <compressed P-256 point, 33 bytes, base64url> }
```

A member key record counts only if it is not a delete, it stands, its root's
`hex40` matches its record key, and `key` is a valid point. Of the versions
held at that record key (current, first and retained), the one that wins by
§4.3 of [02](02-records.md) (highest `seq`, then lowest id) among those that
count is the account's member key; versions by anyone else at that key are
passed over. A member that can write **SHOULD** publish its member key, and
publish it again when it differs from what is published.

> **Known defect:** any key whose note lets it write records for the account,
> an app's included, or one granted records only, can publish a member key of its own, and
> it wins as the newest. The next space key is then boxed to it
> ([01](01-identity.md) §8 asks for more only on access collections).
> Tracked in [#169](https://github.com/leifriksheim/weave/issues/169).

> Rationale: one per space, so an account home can hand an app the member keys
> of exactly the spaces it grants.

### 9.2 When a key change is due

`keyDue` (§4.4) is true while some applied event that took reading from
someone (removed, left, their role deleted) was not seen by the current key's
event. A key change made at the same time as a removal, not having seen it,
leaves the key change due ([#173](https://github.com/leifriksheim/weave/issues/173)).

A **former member** is an account named by an applied `member` event that is
not a reader now: removed, left, or holding a role that was removed. Peers
send them no live messages, and while a key change is due, nothing at all
([04](04-network.md) §6.3, §9.2).

### 9.3 Changing the key (`sys.key`)

A member holding `manage` and the current key, seeing `keyDue`, **SHOULD**
change the key. One whose own change made it due SHOULD change it at once,
before it writes anything else or closes the space: until then, the one who
lost their place still reads what others write.

1. generate a new space key `K'`;
2. `earlier` = base64url of an envelope ([01 §9.1](01-identity.md)) under `K'`'s
   seal key, label `weave/earlier-keys/v1`, bound `{ space: <spaceId>, keyId: K'.id }`,
   around `JSON [base64url(K) of every key it holds]`;
3. write `sys.key` at `key:space`: `{ keyId: K'.id, readKey: <K' read DID>, earlier }`;
4. seal `K'` to each member (§9.4).

Two key changes made apart both stand: every key stays in `keys`, so what
was sealed under either stays readable, and the current one is the lowest id
of the latest (§4.4). A key id or read key used before is refused.

A peer holding any key named by a `key` event opens its `earlier` with that
key and the event's `keyId`, and takes each raw key it contains (up to 1000);
repeat until nothing new. So holding the current key opens every earlier one.

A reader **MUST** check that the keys an `earlier` opens to include the
space's first key K₀, the one the genesis's `encryptionKeyId` names (§8.1):
every reader needs it to derive `onePer` keys ([02 §7.3](02-records.md)). A
key change whose `earlier` does not open, or leaves K₀ out, is
**malformed**: the reader takes no key from it. The change still counts in
the access history, which peers that can't open it judge the same way. A
member holding `manage`, K₀ and the key a malformed change names **SHOULD**
change the key, as when one is due; a manager **MUST NOT** change the key
without holding K₀. Until someone does, a newcomer that holds only that key
reads nothing sealed before it.

### 9.4 Boxes (`sys.box`)

The current key is sealed to each reader's member key, in the clear:

```
sys.box at box:<hex40("<keyId>|<toDid>|<fromDid>")>
{ keyId, to: <recipient account DID>, sealed }

sealed = HPKE(recipientMemberKey, "weave/space-key-box/v1",
              { space: <spaceId>, keyId, to: <toDid> }, JSON { key: base64url(K) })
```

`HPKE` is sealing to a key ([01 §9.2](01-identity.md)), with that label and
bound.

A manager seals the current key to every reader who has published a member key
and has no box for that key id yet from themselves or from anyone holding
`manage`.

A recipient opens every box with `to` = its account and `keyId` naming a key
it lacks in the history, with the bound built from the space, that `keyId`
and its own account; it **MUST** accept the opened key only if its derived id
equals `keyId` and its derived read DID equals the history's `readKey` for
that key — whoever sealed it.

### 9.5 Writing and reading after a change

Writers use the current key (§8.3). A node without the current key cannot
write, and proves it may read with the newest key it holds (see
[04](04-network.md)). A view-only invite made before a change carries only the
old key; its holder is not a reader and gets no box.

_Source: `packages/core/src/node/space-runtime.ts` (`learnKeys`, `malformedKeys`, `rotateKey`, `changeKeyNow`, `formerMembers`, `boxForMembers`, `upkeep`, `loadMemberKeys`), `packages/core/src/space/space-access.ts` (`MEMBER_KEY_COLLECTION`, `BOX_COLLECTION`, `boxKey`, `BOX_LABEL`, `boxBound`, `SPACE_KEY_RECORD`), `packages/core/src/identity/contact-key.ts` (`deriveMemberKeyBytes`), `packages/core/src/identity/hpke.ts` (`sealTo`). Tests: `packages/core/tests/key-change.test.ts` ("is taken as malformed: a manager replaces it, and a newcomer still gets the first key", and the rest), `packages/core/tests/envelope.test.ts` ("a box opened with the wrong bound, label or key opens nothing")._

---

## 10. Relays and keepers

**`sys.relays`** at `relays:space`: `{ relays: string[] }` — where the
space's members meet. Valid (`checkRelays`) when it is a list of at most 8
distinct URLs, each at most 200 characters, each `wss://`, or `ws://` only on
`localhost`, `127.0.0.1` or `[::1]`. Only `manage` may set it. Until the space
names some, members meet on relays they learn elsewhere, such as the invite
that brought them (§7.4).

**`sys.keepers`** at `keepers:space`: `{ keepers: [{ did, name }], copies }`
— nodes that hold every record of the space, and how many a write should
reach before a node holding only part lets go of it. Valid (`checkKeepers`)
when there are at most 16 keepers, each `did` starts with `did:key:` and is
at most 200 characters, each `name` a string of at most 80 characters, no
`did` twice, and `copies` is null or an integer 1–16. Only `manage` may set it.
What keepers do is in [05 — Sync and storage](05-sync-and-storage.md).

_Source: `packages/core/src/space/roles.ts` (`checkRelays`, `checkKeepers`, `MAX_RELAYS`, `MAX_KEEPERS`), `packages/core/src/node/space-runtime.ts` (`nameRelays`, `setRelays`, `setKeepers`). Tests: `packages/core/tests/space-relays.test.ts`, `packages/core/tests/carrier.test.ts` ("is named a keeper…")._

---

## 11. Profiles

An account tells a space who it is with one record:

```
sys.profile at profile:<hex40(accountDid)>
{ name: string, contactKey?: <compressed P-256 point, base64url> }
```

`sys.profile` is reserved for this. It is encrypted in a private space (§8.2).
`contactKey` is the public half of the account's contact key
([01 §10.1](01-identity.md)), to which others seal what only the account may
open, and by which they find it ([07](07-doors.md)).

A reader **MUST** take a profile, and its `contactKey`, only from a version of
`sys.profile` that verifies, stands, and whose root's `hex40` is the record
key; anything else written at that key is ignored. So nobody can name, or
plant a contact key for, another account.

How a reader picks among an account's versions, and when the library
publishes a profile, is not protocol; see
[its docs](../packages/core/docs/spaces.md#profiles).

_Source: `packages/core/src/node/space-runtime.ts` (`profileKey`, `loadProfiles`). Tests: `packages/core/tests/profiles.test.ts`, `packages/core/tests/contacts.test.ts` ("the contact key"), `packages/core/tests/attacks.test.ts` ("a contact key on a profile signed by another account is ignored")._

---

## 12. The space manager

Not protocol: how a device keeps the spaces it holds and their keys is its
own, and nothing of it is exchanged. The library's space manager is described
in [its docs](../packages/core/docs/spaces.md#the-space-manager).

---

## 13. The account registry

### 13.1 Derived account spaces

An account derives private spaces that only it can find, the same on every
device, from its account key ([01 §11.1](01-identity.md), `deriveAccountKey`)
and a label:

```
nonce   = base64url( HKDF-SHA256(accountKey, salt = empty, info = "<label>/nonce/v1", 32)[0..12] )
K       = HKDF-SHA256(accountKey, salt = empty, info = "<label>/key/v1", 32)      // the space key, §8.1
space   = { visibility: "private", creator: accountDid,
            roles: [{ name: "owner", title: "Owner", rank: 100, permissions: ["*"] }],
            creatorRole: "owner", createdAt: "1970-01-01T00:00:00.000Z", nonce,
            readKey: readDid(K), encryptionKeyId: keyId(K) }
id      = cid(canonical(genesis))            // §1.2
```

The roles are exactly that one role, title included; in the genesis they
read `[{"name":"owner","permissions":["*"],"rank":100,"title":"Owner"}]`. Any
other bytes give another id.

| Label                    | Space                | Name               |
| ------------------------ | -------------------- | ------------------ |
| `weave/account-registry` | the account registry | `Account registry` |
| `weave/contacts`         | the contacts space   | `Contacts`         |

Example (seed `01 02 … 10`): registry `bvkbzgjhryaxdys2fyi4oifvardlc4b7bv3bvqn6d736v5ngl23iq`
(nonce `Jx8Oo78z30WwKl1X`), contacts `bqg4jypdnk3lvna26eda7bmesxzhbsoisqs5xodhif4d4gyx2adnq`.

> Rationale: the DID alone is not enough to find them — it appears on
> everything the account signs.

In these spaces only the account writes (a record whose root is another
account is ignored by readers), and nothing written under a note without
`account/write` counts ([01](01-identity.md) §8).

### 13.2 What the registry records

| Collection    | Record key                           | Body                                  | Meaning                                                                                                                          |
| ------------- | ------------------------------------ | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `sys.joined`  | `space:<spaceId>`                    | `{ space: spaceId, invite }`          | The account belongs to the space. `invite` is a **view-only** invite (§7.5) — secrets are never kept. Deleted: the account left. |
| `sys.carrier` | `carrier:<hex40(carrySpaceId)>`      | `{ space, invite, did, name, since }` | A carrier the account uses (§14).                                                                                                |
| `sys.notify`  | `notify:<base32 of 10 random bytes>` | `NotifyWhen` (§15)                    | A subscription.                                                                                                                  |
| `sys.hosting` | —                                    | —                                     | Hosting; see [08](08-hosting.md).                                                                                                |

A membership counts only if it verifies, its root is the account, and (unless
deleted) its key is `space:<body.space>`.

A device of the account **SHOULD** follow the registry, holding the spaces it
lists and no others, and **SHOULD** keep each membership's invite carrying the
space's current key, so a new device joins with it. How the library does this
is in [06](06-nodes-and-sessions.md) §1.3. The registry holds other records
of the library's own too, such as the account's name
([docs](../packages/core/docs/spaces.md#profiles)).

_Source: `packages/core/src/space/account-registry.ts`, `packages/core/src/node/node.ts` (`memberships`, `remember`, `forget`, `reconcileOnce`, `ownName`). Tests: `packages/core/tests/node.test.ts` ("the account registry"), `packages/core/tests/account-vault.test.ts` ("the account key, and the spaces derived from it, match the spec's examples"), `packages/core/tests/account.test.ts` ("the account name"), `packages/core/tests/space-access.test.ts` ("invite secrets are never kept…")._

---

## 14. Passes and carry spaces

A **carrier** (an extension, a host) stores and forwards a space it cannot
read. It gets a **carry space**: a private space the account creates, with itself the only member,
and shares with it by a view-only invite recorded in `sys.carrier` (§13.2). In
it the account keeps one **pass** per space to carry:

```
sys.pass at pass:<hex40(spaceId)>
{ v: 1, space: <space object>, read?: base64url(readSeed), readKey?: <read DID> }
```

- public space: `{ v: 1, space }`;
- private space: `read` = the read seed (§8.4) of the key the account holds
  now; `readKey` = its read DID, present only when that key is not the
  genesis key.

A pass holds no space key, no invite secret and no note. A carrier **MUST**
accept a pass only if `v` is 1, the space passes `checkSpace`, and — for a
private space — the read seed gives a read DID equal to `space.readKey` or to
the pass's `readKey`. (With a later key, the space's history is what vouches
for that read key: one it does not name gets the carrier nowhere.)

When the account stops using a carrier, it deletes the passes and writes
`sys.pass` at `carry:closed` with `{ v: 1, closed: true }`; a carrier that
reads it forgets everything. The account registry and contacts space are
passed too.

_Source: `packages/core/src/space/pass.ts`, `packages/core/src/node/node.ts` (`syncPasses`, `carriers`). Tests: `packages/core/tests/carrier.test.ts` ("passes", "a carrier")._

---

## 15. Subscriptions (notify)

A subscription says what the account wants to hear about. It is kept in the
registry, sealed like everything there:

```
sys.notify at notify:<id>
NotifyWhen = { label, collection, spaces: "all" | spaceId[], topic?: { field, value },
               others?: boolean (default true), where?: Filter, open?: url,
               paused?: boolean, since: ISO date, app?: { origin, name? } }
```

For example, urgent tasks assigned to the account:

```json
{
  "label": "Urgent task for me",
  "collection": "std.task",
  "spaces": "all",
  "topic": { "field": "assignees", "value": "did:key:zDnae…" },
  "where": { "priority": { "$gte": 3 } },
  "since": "2026-09-29T12:00:00.000Z"
}
```

Valid (`checkNotify`) when: `label` 1–120 characters, not blank; `collection`
is a collection name ([02](02-records.md) §6.1, `^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$`) and does not start with `sys.`;
`spaces` is `"all"` or 1–256 strings; `topic.field` is a valid topic, a
field or `link:<role>` ([02](02-records.md) §8.1), and `topic.value` a string, number or boolean; `where`,
when present, is a filter in the library's query format that reads only
body fields, `link:<role>`, `@key`, `@collection`, `@createdBy` and
`@createdAt` (`checkFilter`); `open`
an `https://` URL (or `http://` on localhost / 127.0.0.1); `since` a date;
`app.origin`, when present, a web origin (scheme, host and port, nothing
after) or a browser extension's (`chrome-extension://`, `moz-extension://` or
`safari-web-extension://`, then 1–64 letters, digits or dashes), and
`app.name` at most 80 characters.

`where` narrows a subscription to records it matches: a filter in the
library's query format (`packages/core/docs/query-format.md`), judged by a
device that can read the record, over its body, its links and its `@key`,
`@collection`, `@createdBy` and `@createdAt`. It is never carried: a carrier matches on the outside alone
and may wake an app for a record the app then turns down.

`app` names the app that proposed the subscription, by the origin the browser
reported; the account home writes it on its behalf when the person says yes
([06](06-nodes-and-sessions.md) §2.11). How apps show what a subscription
matches is not protocol; see
[the library's docs](../packages/core/docs/spaces.md#subscriptions). `app` and `where` are
not copied to the carried form.

Carriers cannot read, so each device with the account key copies every
subscription into every carry space with the value replaced by tags:

```
sys.subscription at notify:<id>   (same key)
CarriedSubscription = { v: 1, label, collection, spaces, tags?: { <spaceId>: [tag] },
                        others, open?, paused, since }
```

`tags[spaceId]` = `[topicTag(topicKey(space), collection, field, value)]`
([02](02-records.md)), for each space the subscription looks at; a private
space whose key the device lacks gets no entry (never matches). No `topic` →
no `tags`.

A carrier matches an arriving version when: not paused; same collection; `seq`
is 0 and not deleted; the space is in `spaces` (or `"all"`); its `createdAt`
is at or after `since` and within 24 hours of now; if `others`, its root is
not the account; and if `tags` is present, the version's `tags` include one of
`tags[spaceId]`. No carrier shows a notification yet; the carried form is
what a carrier needs to wake an app that is closed ([06](06-nodes-and-sessions.md) §4.4).

_Source: `packages/core/src/space/notify.ts` (`checkNotify`, `whereHolds`), `packages/core/src/query/filter.ts` (`checkFilter`, `matches`), `packages/core/src/node/node.ts` (`notifications`, `syncPasses`), `packages/core/src/node/carrier.ts`. Tests: `packages/core/tests/carrier.test.ts` ("notifications through a carrier"), `packages/core/tests/topics.test.ts` ("a subscription’s where", "names a collection the way a definition must…")._

> **Planned: devices deliver subscriptions, by Web Push.** Issue:
> [#60](https://github.com/leifriksheim/weave/issues/60). Delivery moves to
> per-device receiver records, apart from subscriptions. Specified in
> [06 — Nodes, sessions and apps](06-nodes-and-sessions.md) §4.4.

---

## 16. Contacts

Contacts are not protocol: they are two standard collections, `std.contact`
in the contacts space (§13.1) and `std.contact-request` in a shared space, and
a node procedure. A peer that has never heard of them syncs and judges them
like any other record. They are described in the library's docs,
[contacts](../packages/core/docs/contacts.md).

### 16.1 The contacts space and `std.contact`

Moved to [contacts](../packages/core/docs/contacts.md). The contacts space itself is §13.1.

### 16.2 The contact key

The contact key is [01 §10.1](01-identity.md); its public half is published on
the profile (§11).

### 16.3 `std.contact-request`

Moved to [contacts](../packages/core/docs/contacts.md).

### 16.4 How a request is sealed

Moved to [contacts](../packages/core/docs/contacts.md). It is sealed with HPKE, [01 §9.2](01-identity.md).

### 16.5 Asking, accepting and the rest

Moved to [contacts](../packages/core/docs/contacts.md), with its Planned section
([#40](https://github.com/leifriksheim/weave/issues/40)).

---

## 17. Not yet specified

- Deleting an invite record does not close it; planned in §7.2
  ([#20](https://github.com/leifriksheim/weave/issues/20)).
- That every peer reaches the same access state under any interleaving
  through real sync (partitions and heals, the gatekeeper, waiting versions)
  is not yet tested; the replay alone is, against a reference, over random
  histories ([05](05-sync-and-storage.md) §8). Tracked in
  [#10](https://github.com/leifriksheim/weave/issues/10).
- Content-addressed definitions
  ([#11](https://github.com/leifriksheim/weave/issues/11)), which would pin
  each record to the definition it was written against, as well as judging
  it by the rules in force (§5.2); see [02](02-records.md).
- Any bound on how many events a history may hold, or on the replay's cost.
  Signed checkpoints a new peer starts from, replaying the full history in
  the background, are proposed in
  [#25](https://github.com/leifriksheim/weave/issues/25).
- Expiry or single use of invites: an open invite stays open until closed.
- A way to re-establish a space's key for members who lost every key they held
  other than a fresh role invite.
- `invitedBy` and the space `name` in invites are unauthenticated; no
  signature over the invite string exists. See the known defect in §7.4.
