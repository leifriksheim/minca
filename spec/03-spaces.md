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
(delegations), the account key, the contact key and the two ways anything is sealed
(envelopes and HPKE) are in [01 — Identity](01-identity.md).
How peers connect and prove they may read is in [04 — Network](04-network.md).

- [1. The space and its id](#1-the-space-and-its-id)
- [2. Roles and grants](#2-roles-and-grants)
- [3. The access history](#3-the-access-history)
- [4. Replaying the access history: `strong-remove/1`](#4-replaying-the-access-history-strong-remove1)
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

| Term                  | Meaning                                                                                                                                                                                                                    |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **account**           | An identity's root DID (`did:key:zDn…`, [01](01-identity.md)). What roles are assigned to.                                                                                                                                 |
| **root** of a version | The account the signing key speaks for: the issuer of the version's note, checked with no time ([01](01-identity.md) §7.5, §7.6), or the author itself when there is no proof ([01](01-identity.md), [02](02-records.md)). |
| **founder**           | The account that created the space, until it leaves (§2.1). It holds every command.                                                                                                                                        |
| **member**            | In a given state of the history, a founder or an account assigned at least one role.                                                                                                                                       |
| **reader**            | Same as member, as far as key distribution is concerned (`readers()`).                                                                                                                                                     |
| **grant**             | A delegation to a role of a command, under a policy on the command's arguments (§2.2).                                                                                                                                     |
| **hex40(x)**          | The first 20 bytes of SHA-256(UTF-8 `x`), as 40 lower-case hex characters.                                                                                                                                                 |
| **cid(x)**            | `"b"` + lower-case RFC 4648 base32 (no padding) of SHA-256(`x`). The id format of [02](02-records.md).                                                                                                                     |

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
| `creator`         | string                    | The creator's account DID: the space's founder (§2.1).                               |
| `roles`           | FoundingRole[]            | The roles it is founded with, and their grants (§2.1). 0–64 roles, names unique.     |
| `createdAt`       | string                    | ISO 8601 timestamp.                                                                  |
| `nonce`           | string                    | base64url of 12 random bytes (16 characters). Keeps two spaces made alike apart.     |
| `readKey`         | string                    | Private only: the `did:key` of the space's first read key (§8.4).                    |
| `encryptionKeyId` | string                    | Private only: the id of the space's first key (§8.1).                                |

### 1.2 The genesis and the id

The **genesis** is the space object without `id` and `name`, with a version
field:

```
genesis = { v: 3, creator, visibility, roles, createdAt, nonce,
            readKey?,           // private only
            encryptionKeyId? }  // private only
id = cid( canonical-JSON(genesis) )
```

Canonical JSON is defined in [02 — Records](02-records.md) (sorted keys, no
whitespace). Role objects inside keep their fields as given (`title` and
`nests` omitted when absent).

A peer handed a space — in an invite, a pass, from a host — **MUST** refuse it
unless all of these hold (`checkSpace`):

1. `id`, `nonce` and `creator` are strings;
2. `visibility` is `public` or `private`;
3. `roles` is a list of at most 64 well-formed founding roles (§2.1) with
   distinct names;
4. a private space has both `readKey` and `encryptionKeyId`; a public space
   has neither;
5. `cid(canonical(genesis))` equals `id`.

> Rationale: nobody who passes a space on can change who founded it, with
> which grants, or with which first key. The name is left out so it can
> change.

**Example.** Creator `did:key:zDnaeZLoH5izvFBqsJ62j3zJ2DYJWASAB7QFmkYR6aeAzhCLg`
(the account of seed `01 02 … 10`), founded with one role, `editor` (title
`Editor`), which may do anything to records, define collections and assign
`editor`; a fixed time and nonce:

```
{"createdAt":"2026-01-01T00:00:00.000Z","creator":"did:key:zDnaeZLoH5izvFBqsJ62j3zJ2DYJWASAB7QFmkYR6aeAzhCLg","nonce":"AAECAwQFBgcICQoL","roles":[{"grants":[{"cmd":"/record","pol":[]},{"cmd":"/collection/define","pol":[]},{"cmd":"/role/assign","pol":[["==",".role","editor"]]}],"name":"editor","title":"Editor"}],"v":3,"visibility":"public"}
→ id bzwgno6q3imhf6eirh7hbowfzmdva6qcfqd7dfrprl6p77jjrrr7q
```

The same space made private with the AES key whose raw bytes are
`ff fe fd … e0` (base64url `__79_Pv6-fj39vX08_Lx8O_u7ezr6uno5-bl5OPi4eA`), its
id and read key as §8.1 and §8.4 derive them:

```
{"createdAt":"2026-01-01T00:00:00.000Z","creator":"did:key:zDnaeZLoH5izvFBqsJ62j3zJ2DYJWASAB7QFmkYR6aeAzhCLg","encryptionKeyId":"aLhvw5pkV65_lcQHEcUOug","nonce":"AAECAwQFBgcICQoL","readKey":"did:key:zDnaem2ikLwS3eYm46gspC7nm6dmYYCMHUHU5yvVHNgARcsWf","roles":[…as above…],"v":3,"visibility":"private"}
→ id bvm5is7n2nm7ex3vy7hn2yllhsoi3dxezkrwvv6thhlfb5dioxdta
```

### 1.3 Creating a space

To create a space a peer picks the founding roles and their grants, takes the
current time and a fresh 12-byte random nonce, and for a private space
generates a space key (§8.1) and derives its read key (§8.4). Then it computes
the id. Nothing is written into the space at creation: the genesis alone
makes the creator its founder. (The library's constitution templates are in
[its docs](../packages/core/docs/spaces.md#presets).)

_Source: `packages/core/src/space/space-access.ts` (`spaceGenesis`, `spaceIdOf`, `checkSpace`), `packages/core/src/space/grants.ts` (`checkFoundingRoles`), `packages/core/src/space/space-manager.ts` (`create`), `packages/core/src/types.ts` (`Space`, `SpaceRole`). Tests: `packages/core/tests/constitution.test.ts` ("the genesis examples"), `packages/core/tests/space.test.ts`, `packages/core/tests/space-access.test.ts` ("the space vouches for itself")._

---

## 2. Roles and grants

Who may do what in a space is a set of **grants**: delegations, in the JSON
profile of UCAN 1.0 ([01](01-identity.md) §7), each to a **role** of the
space, of a command path under a policy on the command's arguments. An
account holds power in a space only through the roles assigned to it. Every
peer judges every change, and every record, by the grants its author held as
of what it saw, and resolves changes made apart by one algorithm,
`strong-remove/1` (§4).

### 2.1 Founders and founding roles

The genesis is, for now, the space's **constitution**. Its `creator` is the
space's **founder**: it holds every command, and nobody but itself can
remove it or change its roles. It stops being the founder only by leaving the
space itself (§2.5), which it may always do; a space whose founder has left
is run by whoever its roles let, and may end up with nobody who can change
roles or the key.

Its `roles` are the **founding roles**:

```
FoundingRole = { name: string, title?: string, grants: Grant[], nests?: string[] }
Grant        = { cmd: string, pol: Policy }
```

A founding role is well-formed (`checkFoundingRole`) when it has no other
members and:

- `name` matches `^[a-z0-9][a-z0-9._-]{0,39}$`;
- `title`, if present, is a string of at most 80 characters;
- `grants` is a list of at most 64 grants, each with exactly `cmd`, a command
  path ([01](01-identity.md) §7, `isCommand`), and `pol`, a well-formed policy
  ([01](01-identity.md) §7.4);
- `nests`, if present, is a list of at most 16 distinct role names, none its
  own.

The constitution's grants for a role are issued by the space itself, the
root of every chain: they are the role's **first definition** (§2.4), and a
later definition that stands replaces them, so founding roles change in place
like any other.

> **Planned: the constitution record** (step 5 of
> [the plan](drafts/constitution-grants-contracts.md) §8). The genesis will
> become a `constitution/1` record: `top`, the founders (several, or none),
> each of whom may step down; the name of the conflict resolver, from a fixed
> list of which `strong-remove/1` is the first; and `/space/succeed`, which
> names a successor space. What this section says of the creator is what
> `top: { founders: [creator] }` will say, and the founding roles move into
> the record as they are.

### 2.2 Grants

A grant in a role's definition (§2.4) is a delegation payload of the JSON
profile ([01](01-identity.md) §7.1) with exactly these members, and is signed
by the version that carries it:

| Field   | Value                                                                                   |
| ------- | --------------------------------------------------------------------------------------- |
| `iss`   | The root of the version that carries it: the definition's author                        |
| `aud`   | `role:<name>`, the role defined. In a space, a grant's audience is never anything else. |
| `sub`   | `space:<id>`, this space                                                                |
| `cmd`   | A command path; a grant of `/record` covers every command under it, `/` every command   |
| `pol`   | A policy on the command's arguments (§2.3), in UCAN's policy language                   |
| `nonce` | base64url, 1–64 characters                                                              |
| `meta`  | Optional, a JSON object no peer reads                                                   |

`exp` and `nbf` **MUST** be absent: time decides nothing in a space
([02](02-records.md) §4.3), and a grant ends only by a change the replay
judges. A definition holding a payload with any other member, or one whose
`iss`, `aud` or `sub` differ from the above, is not a well-formed change
(§3.3).

A grant **fits** an invocation of a command with some arguments when its
`cmd` covers the command and its `pol` holds for the arguments. A policy reads
only the arguments its command defines (§2.3). As in UCAN, a member the
arguments lack reads as `null` ([01](01-identity.md) §7.4): a selector naming
an argument its command doesn't have finds `null`, so `==` against anything
but `null` fails there, and a negated statement (`!=`, `not`) holds. Only
selecting further into it (`.body.text` with no `body`) finds no data, which
never holds.

> **Write what is allowed.** A grant of `/` with
> `["!=", ".role", "admin"]`, meant as "anything but the admin role", also
> holds for `/member/remove`, which has no `role`, and so for removing an
> admin. Name the commands, and say what is allowed with `==`, or an `or` of
> `==` statements: `["or", [["==", ".role", "member"], ["==", ".role", "mod"]]]`
> holds only where a `role` is given.

> Rationale: a grant to a key or an account, rather than a role, would let a
> member hand power to a fresh key that nobody could take back, since nobody
> can unassign a key that holds no role. Only roles hold grants, and an
> account's power is only ever its roles'.

**Arguments a peer cannot read.** A policy on `body` is judged only by a peer
that can open the version's body. One that can't (a private space without
the key) takes a statement that reads `body` and finds no data as holding,
and judges the rest; readers judge it whole. A stub carries no body for
anyone: a peer that can read the space waits for the whole version rather
than take its grant on trust (§5.2 step 8). This is the rule
[02](02-records.md) §7.3 and §7.4 follow for `onePer` and `fixed`. JSON has one
kind of number, so `1` and `1.0` are one value in a policy's `==`.

### 2.3 Commands and their arguments

The commands every peer checks, and the arguments a peer fills in before a
policy runs:

| Command              | Arguments                         | Filled in from                                                                                                                          |
| -------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `/record/write`      | `collection`, `byCreator`, `body` | `byCreator`: whether the writer's root is the root of the record's first version, true for a first version (§5.2); `body`: the new body |
| `/record/delete`     | `collection`, `byCreator`         | As for `/record/write`                                                                                                                  |
| `/collection/define` | `collection`                      | The collection defined, changed or deleted                                                                                              |
| `/member/remove`     | `self`, `roles`                   | `self`: whether the account removed is the invoker's; `roles`: the roles assigned to it in the invocation's own view, sorted names      |
| `/role/define`       | `role`                            | The role whose definition, its grants and nestings, is written                                                                          |
| `/role/assign`       | `role`, `self`, `roles`           | `self`: whether the assignee is the invoker's account; `roles`: the assignee's roles in the invocation's own view. Also opens invites.  |
| `/role/unassign`     | `role`, `self`, `roles`           | As for `/role/assign`                                                                                                                   |
| `/key/change`        | (none)                            | A new key for a private space (§9)                                                                                                      |
| `/space/relays`      | (none)                            | The relays the space names (§10)                                                                                                        |
| `/space/keepers`     | (none)                            | The nodes that keep the space whole (§10)                                                                                               |

`/record/read` (`collection`) is a command a grant may hold, for the
library's use; no peer checks it, since the space key opens every collection
alike. A grant may name any other command path, for an app's own use, and
peers ignore it.

`byCreator` compares accounts, not keys: any device of the creator's account
counts. It reads the root of the record's first version as 02 §4.1 fixes it:
at an owned key the key's owner, and at a shared `one:` key whoever wrote
the first version the record's chain starts from, so anyone granted
`/record/write` there can start a rival chain ([02](02-records.md) §7.3).

Examples:

- "Members may delete their own moves":
  `{ "cmd": "/record/delete", "pol": [["==", ".collection", "app.chess"], ["==", ".byCreator", true]] }`.
- "Admins assign Treasurer, not to themselves":
  `{ "cmd": "/role/assign", "pol": [["==", ".role", "treasurer"], ["==", ".self", false]] }`.
- "Moderators may remove members but not admins":
  `{ "cmd": "/member/remove", "pol": [["==", ".self", false], ["not", ["any", ".roles", ["==", ".", "admin"]]]] }`.

A space that grants `/member/remove` or `/role/unassign` without a policy on
`.roles` lets it reach everyone but the founder. `.roles` protects a target
only from an invoker whose own view includes the target's role. `.roles` is
read as of the invocation's own view (§4.3), and a writer chooses its view by
what it names in `seen` (§3.2): one acting concurrently with a promotion, or
naming a view from before it, isn't stopped by it. So two holders of a role
whose grant says "not those holding this role", such as two `community`
admins, can still remove or demote each other, by naming a view from before
the other's promotion. The removal stands, and strikes what the removed
admin did that hadn't seen it, as any removal does.

### 2.4 Roles and their definitions

A role's grants are written in its **definition**: a `sys.role` record at
`role:<name>` (§3.1) holding the role's grants as delegation payloads (§2.2)
and the roles it **nests**: every member of a role holds what the roles it
nests hold. Only the constitution and a definition issue grants; a grant
anywhere else counts for nothing.

- **Who may define.** A definition stands when its author held `/role/define`
  for the role (`{ role: <name> }`) as of its own view, as any change does
  (§4.3).
- **The latest replaces.** A definition replaces every definition of the role
  it saw, the constitution's included. Taking grants from a role is writing
  its definition again without them.
- **Attenuation.** A definition holds only what its author could do, as of
  the definition's own view: a grant in it fits an invocation only if its
  author could itself have invoked that command with those arguments in that
  view. So does a nesting: through it, a member of the role may do only what
  the definition's author could. The constitution's grants hold whatever they
  say.
- **Judged where it was written.** A definition's grants are judged in its
  own view, once. A role keeps its grants when its author later loses the
  power to define it: the role holds them until someone who may define it
  writes it again.
- **Rivals hold what they share.** Definitions of one role none of which saw
  the others are **rivals**. While they are, the role holds only the grants
  found in every rival, compared as the canonical JSON of `{ cmd, pol }`
  (ignoring `iss`, `nonce` and `meta`), each judged in its own rival's view,
  and a nesting only if every rival has it. The rivalry ends when a
  definition that saw them all stands. An empty intersection leaves the role
  holding nothing: it fails closed. No id decides between rivals, and no
  peer decides whether one policy implies another.

A role exists once the constitution or a definition names it; assigning a
role that doesn't exist is refused.

> Rationale: a definer could weaken a role by writing a rival apart from the
> others, but never strengthen it, since the role holds only what every
> rival holds.

**A role that defines itself can lock.** If a role holds `/role/define` for
itself, two of its members' rival definitions that disagree on that grant
leave the role without it, and then nobody in it can write the definition
that ends the rivalry. The founder can; without one it takes a new space. So
`/role/define` for a role is best held by another role than itself: the
library's templates have the founder, or a steward role, define `admin`.

### 2.5 Assignments and removals

An account holds a role when a `sys.assign` record (§3.1) assigns it and
nothing has taken it since. The account is then a **member**; an account with
no role, and not a founder, is no member and may invoke nothing.

- **Assigning** a role to an account is `/role/assign` with
  `{ role, self, roles }`. It grants nothing the role didn't hold already, so
  the assigner needs only `/role/assign` for that role. The assignee is always
  an account: assigning to a role (`role:<name>`) is refused, since putting a
  role inside another is nesting, which only a definition does.
- **Unassigning** is `/role/unassign`, with the same arguments. **Leaving a
  role** is built in: an account may always unassign itself. Like a
  removal, either strikes everything the account did that hadn't seen it,
  whatever that needed (§4.3), its other devices' concurrent writes
  included.
- **Removing** an account is `/member/remove` with `{ self, roles }`. It
  ends every role assigned to the account that the removal had not seen
  undone, including one assigned concurrently with it: after a re-add, only
  assignments that saw the removal count. **Leaving the space** is built in:
  an account may always remove itself, and a founder that does is a founder
  no more.
- Nobody but the founder itself removes a founder or changes its roles. A
  founder may assign itself a role, and leave one, as anyone may leave a
  role.
- **Invites** are assignments to whoever holds the invite's secret (§7):
  opening, changing or closing an invite for a role needs `/role/assign` for
  that role, with `{ role, self: false, roles: [] }`.

There is no separate command for adding a member: a member is an account
holding a role, and becomes one when the first role is assigned to it.

### 2.6 What a space trusts its definers with

**Whoever may define roles is trusted to.** A definer can write power into a
role it holds itself, or nest it in a role it defines, and keep it after the
role that let it define is taken: unassigning takes only that assignment, and
what the definer wrote stays until someone who may define the role writes it
again. A space that doesn't trust someone to define roles doesn't grant them
`/role/define`.

A member with two accounts sidesteps `.self`: an admin who may assign `hr`
can assign it to her second account. That account is a member holding `hr`,
visible as one and unassignable like any other.

The library's templates of founding roles are in
[its docs](../packages/core/docs/spaces.md#presets); the protocol reads
whatever roles a genesis names and never looks at a template's name.

_Source: `packages/core/src/space/grants.ts` (`checkFoundingRole`, `readDefinition`, `grantFits`, `grantShape`, the command constants), `packages/core/src/space/roles.ts` (`may`, `roleMay`, `refusal`, `rolesOf`, `isMember`), `packages/core/src/identity/policy.ts` (`policyOutcome`, `policyReads`). Tests: `packages/core/tests/roles.test.ts` (all of "founders and roles", "definitions", "unassigning and removing", "invites"), `packages/core/tests/access-attacks.test.ts` ("attacks on grants"), `packages/core/tests/constitution.test.ts`._

---

## 3. The access history

Everything after the genesis that changes who may do what is a record in the
space itself. These records form the **access history**.

### 3.1 The access collections

Each access record lives at a fixed record key, derived from what it changes.
Bodies are JSON objects; `cutoff` is optional everywhere it appears (§6.3).

| Collection       | Record key                                     | Body                                                                     | Event kind   |
| ---------------- | ---------------------------------------------- | ------------------------------------------------------------------------ | ------------ |
| `sys.role`       | `role:<name>`                                  | `{ name, title?, grants: Delegation[], nests: string[] }` (§2.4)         | `role`       |
| `sys.assign`     | `assign:<hex40(account DID + "\|" + role)>`    | `{ did, role, assigned: boolean, cutoff?, invite?: { key, signature } }` | `assign`     |
| `sys.remove`     | `remove:<hex40(account DID)>`                  | `{ did, cutoff? }`                                                       | `remove`     |
| `sys.invite`     | `invite:<hex40(invite DID)>`                   | `{ key: <invite DID>, role, open: boolean }`                             | `invite`     |
| `sys.revoke`     | `revoke:<hex40(key DID + "\|" + account DID)>` | `{ key: <key DID>, cutoff? }`                                            | `revoke`     |
| `sys.collection` | `collection:<name>`                            | a collection definition ([02](02-records.md)); may be encrypted          | `definition` |
| `sys.key`        | `key:space`                                    | `{ keyId, readKey, earlier }` (§9)                                       | `key`        |
| `sys.relays`     | `relays:space`                                 | `{ relays: string[] }` (§10)                                             | `relays`     |
| `sys.keepers`    | `keepers:space`                                | `{ keepers: [{ did, name }], copies: number \| null }` (§10)             | `keepers`    |
| `sys.fork`       | `fork:<hex40(writer DID)>`                     | `{ a, b }`: two versions without bodies (§6.5)                           | `fork`       |

A `sys.revoke` key names the key revoked and the account revoking it, so no
other account's revoke can sit where it belongs. A `sys.assign` key names the
account and the role, so assigning and unassigning one role to one account
are versions of one record, and two made apart are rivals (§4.4).

> Rationale: record keys are lower case and DIDs are not, so a key names a
> hash of the thing and the body names the thing itself.

Example keys for the account above: its assignment of `editor`,
`assign:0ce7d5918bd19e9cbf36c04809fd02ff2b61e3af`; its removal,
`remove:4ac5085b5ad9c944bd682566b17bbfd1da9c5dab`; for the invite DID
`did:key:zDnaeVSCSBvS7JUHhskZ9mPRzhjsxsgTwSe6h5a9VSE1LJ2vw`:
`invite:fd8ebfa892a6c4bae7cd265123b7844e49fa50e8`.

### 3.2 Every record names what it saw

Every version written in a space — access record or not — is judged as of
its `seen`: the ids of **heads** of the access history as its writer knew
them (§4.6), at most 64. `seen` is optional ([02](02-records.md) §3.1): a
version without it is judged as having seen nothing but the genesis. A writer **SHOULD** name its current heads, and MAY name fewer: what it
leaves out it is judged as not having seen. For its own standing that can
only take something away: what it didn't see of its own removal or
unassignment takes it all the same (§5.1). It is not so for arguments read in
its own view: a target's `roles` (§2.3) are read without the promotions it
leaves out, so a policy on `.roles` binds only a writer whose view includes
the role. One with more than 64 names first those its own standing
rests on (its `remove:` record, its `assign:` and `role:` records, its
collection's definition), then the most recently applied. The space id
itself may appear in `seen` and stands for the genesis. Access records
**MUST** carry `retain: true` ([02](02-records.md)); a version without it is
not an access event.

### 3.3 From a version to an event

A peer turns each stored version in an access collection into an **event**, or
into nothing. It **MUST** collect versions by record key prefix — every
version, not only current ones — and use only those whose collection is the
one the prefix belongs to (`role:`→`sys.role`, `assign:`→`sys.assign`,
`remove:`→`sys.remove`, `invite:`→`sys.invite`, `revoke:`→`sys.revoke`,
`collection:`→`sys.collection`, `key:`→`sys.key`, `relays:`→`sys.relays`,
`keepers:`→`sys.keepers`, `fork:`→`sys.fork`).

A version yields no event when any of these hold:

- it lacks `retain`;
- its proof does not grant what it requires: `/collection/define` for a
  `sys.collection` version, `/access/change` for any other, with the
  arguments of [01](01-identity.md) §8. A key whose note grants records
  only never changes access, whatever its writer's roles;
- its signature, or the note behind it, does not verify ([02](02-records.md));
- it is not a `sys.collection` version and it is deleted, or its body is
  encrypted, or its body is not an object;
- the fields below do not check out.

Otherwise the event is `{ id: version.id, key: version.key, root, author: version.author, seen: version.seen ?? [], cutoff, kind, … }`,
where `cutoff` is `body.cutoff` read as a map from key DID to a map from
collection to a non-negative integer (absent: empty; anything else, or more
than 1024 places in all: no event),
always empty for `role`, `definition`, `key`, `relays`, `keepers` and `fork`, and:

| Kind         | Checks                                                                                                                                                                                                    | Event fields                                                                           |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `definition` | key starts with `collection:`                                                                                                                                                                             | `name` = key after `collection:`; `deleted` = version is deleted                       |
| `role`       | no `cutoff`; `readDefinition` passes: `name`, `title?`, `grants` and `nests` as §2.1, each grant a payload as §2.2 with `iss` = root; key = `role:<name>`                                                 | `name`, `title?`, `grants` = each `{ cmd, pol }`, `nests` (absent: `[]`)               |
| `assign`     | `did` a string starting `did:key:`, `role` a string, `assigned` a boolean, key = `assign:<hex40(did + "\|" + role)>`; if `invite` present it must be `{key: string, signature: string}` and verify (§7.3) | `did`, `role`, `assigned`, `viaInvite` = `invite.key` when present                     |
| `remove`     | `did` a string, key = `remove:<hex40(did)>`                                                                                                                                                               | `did`                                                                                  |
| `invite`     | `key` string, `role` string, `open` boolean, record key = `invite:<hex40(key)>`                                                                                                                           | `inviteKey`, `role`, `open`                                                            |
| `key`        | record key `key:space`, `keyId` string ≤ 64 chars, `readKey` starts with `did:key:`                                                                                                                       | `keyId`, `readKey`                                                                     |
| `relays`     | record key `relays:space`, `relays` list of strings, ≤ 8                                                                                                                                                  | `relays`                                                                               |
| `keepers`    | record key `keepers:space`, `checkKeepers(keepers, copies ?? null)` passes (§10)                                                                                                                          | `keepers`, `copies`                                                                    |
| `revoke`     | `key` a `did:key`; record key = `revoke:<hex40(key + "\|" + root)>`                                                                                                                                       | `target` = `key`                                                                       |
| `fork`       | `a` and `b` prove a fork in this space ([02](02-records.md) §4.10, §6.5); key = `fork:<hex40(their author)>`                                                                                              | `writer` = their `author`, `collection` = the forked line's, `from` = its place (§6.5) |

A deleted version in any access collection other than `sys.collection` is
therefore ignored: access is taken away by writing a change, never by deleting.

### 3.4 Storing access records

Whether an access event _counts_ can change as others arrive, so a peer stores
every well-formed one and lets the replay decide. A peer **MUST NOT** store an
access version from outside (a peer, a folder) unless:

1. its `space` is this space's id and it has `retain`;
2. it yields an event (§3.3);
3. everything its `seen` names is present and not waiting (§4.1);
4. its root is **named** by the history — the founder, or the `did` of any
   `assign` event with `assigned: true`, whatever became of it — or it is an
   `assign` event joining by an invite key that some held `invite` event
   names.

> Rationale: a stranger who knows a space's id can mint signed records for
> free. Only accounts the history has heard of can get anything stored, and
> "named" only grows, so two peers never disagree for good.

_Source: `packages/core/src/space/roles.ts` (collection constants), `packages/core/src/space/space-access.ts` (record keys: `assignKey`, `removalKey`, `inviteKey`, `revokeKey`, `roleKey`), `packages/core/src/space/grants.ts` (`readDefinition`), `packages/core/src/node/space-runtime.ts` (`buildEvent`, `loadAccess`, `admissible`). Tests: `packages/core/tests/space-access.test.ts` ("a stranger who knows the space cannot write in it…"), `packages/core/tests/access-attacks.test.ts` ("a fresh key outliving its issuer…"), `packages/core/tests/constitution.test.ts` ("access record keys"), `packages/core/tests/attacks.test.ts`._

---

## 4. Replaying the access history: `strong-remove/1`

Every peer runs the same pure function over the same events and gets the same
state, whatever order they arrived in. No order decides anything: whether a
change counts follows from what saw what, and from what the changes are.
This section is normative in full. The algorithm is named `strong-remove/1`:
a removal strikes what its account did concurrently with it, as in p2panda's
strong removal and the eventually consistent access control of Jacob and
Hartenstein (CODASPY 2025).

### 4.1 State

```
State = {
  founders:    Set<accountDid>,
  roles:       Map<name, RoleDefinition[]>,   // one, or rivals
  assigned:    Map<accountDid, Map<roleName, assignmentId>>,
  invites:     Map<inviteDid, { role, open, event, by: accountDid[] }>,
  definitions: Map<collectionName, { event, definedBy }>,
  contested:   Map<collectionName, eventId[]>,
  keys:        [{ keyId, readKey, event }],   // oldest first; last is current
  keyDue:      boolean,
  relays:      string[],
  keepers:     [{ did, name }],
  copies:      number | null,
}
RoleDefinition = { event, by: accountDid | null, title?, grants: Grant[], nests: string[], view: State | null }
```

The **start state** comes from the genesis: `founders` = `{ creator }`;
`roles[name]` = one definition per founding role, `{ event: <space id>, by:
null, grants, nests: nests ?? [], view: null }`; for a private space `keys` =
`[{ keyId: encryptionKeyId, readKey, event: <space id> }]`, else `[]`;
everything else empty, `false` or `null`.

`rolesOf(S, did)` is the names in `S.assigned[did]`, sorted. `isMember(S,
did)` is `did ∈ S.founders` or `rolesOf(S, did)` is not empty.
`readers(S)` is every member.

**`may(S, did, cmd, args)`**, whether an account may invoke a command with
these arguments in a state, is true when `did ∈ S.founders`; otherwise when
some role `r` in `rolesOf(S, did)` **holds** it, where a role `r` holds it in
`S`, with `D = S.roles[r]` (false when absent or empty), when:

1. some grant `g` of `D[0]` fits (§2.2) and every other definition in `D` has
   a grant with the same `{ cmd, pol }`, **or** some role `n` in `D[0].nests`,
   other than `r` and present in every other definition's `nests`, holds it in
   `S` (a role already being asked about holds nothing: nestings that loop end);
2. **and** for every definition `d` in `D` with `d.by` not null:
   `may(d.view, d.by, cmd, args)`.

Step 2 is attenuation: a definition holds only what its author could do as
of its own view. It recurses into ever older views, so it ends.

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
2. **Reductions.** An allowed event is a **reduction** when, in its own view,
   it takes something from an account: a `remove` of a member, or an
   `assign` with `assigned: false` of a role the account holds, the
   account's own leaving included. A `revoke` is a reduction of the keys it
   names for its own account, a `fork` of the key whose line forked, and
   closing an invite of the joins through it. A definition is never a
   reduction: it binds what saw it.
3. **Strikes.** A reduction `r` **strikes** an allowed event `e` it reaches
   when `r`'s cutoff does not cover `e` (`r.cutoff[e.author][e's collection] ≥
e`'s place in that collection's line, `log.n`, §6.3) and, unless `r` is a
   revoke or a fork, neither had seen the other. It reaches:
   - for a removal of `did`, or an unassignment of any role from `did`:
     every event whose root is `did`, whatever it needed;
   - for a revoke: events whose author is the revoked key and whose root is
     the revoke's; for a fork: events whose author is the key, in the forked
     collection, with `log.n` at least the fork's place; for a closed invite:
     joins through it.

   A revoke or a fork proof reaches its key's events whatever either saw: an
   owner reacting to a thief has seen what the thief did. Revokes and forks
   are never struck.

   An unassignment never strikes a removal of its own author: a removed
   member can't undo its removal by taking a role from its remover, backdated
   to a view where it still could. Removals of each other strike each other
   and both stand, and so do unassignments of each other, since neither pair
   can be told from one made honestly apart.

   > Rationale: an unassignment strikes what its account did concurrently,
   > not only what needed the role. What an event needed could only be judged
   > in `V(e)`, a view its author chooses by naming an older point, while
   > whether it stands is judged in `W(e)`. A demoted admin could then
   > backdate a self-assignment of another role that is struck, and cite it
   > so that nothing she does seems to need the role she lost; and two
   > unassignments, each of a role the other also gave, would each strike
   > nothing. The cost: whoever may take a minor role from an account
   > strikes what it did unseen, as a removal would. "Unseen" is what a
   > partition or a backdate gives; honest nodes sync, and a cutoff covers
   > what the writer holds (§6.3).

4. **Valid among a set** `S` (closed under `ancestors`), in two passes:
   1. Take the strongly connected components of the strikes between allowed
      events in `S`, and visit them so that every component comes after the
      ones that strike into it. An allowed event is **unstruck** unless an
      unstruck event from another component strikes it. Strikes within one
      component don't count: reductions that strike each other all stand, as
      concurrent revocations do in Keyhive.
   2. Then, ancestors first, an unstruck event is **valid** when
      `refusal(e, W(e))` is null, where `W(e)` is the merge of the valid
      events in `ancestors(e)`, each definition in it judged in its own `W`.
      So a struck grant, assignment or definition gives no power to anything
      that rests on it, whether or not that cited the reduction.

   The history's valid events are those valid among all placeable events.

An event that is not allowed is **dropped** with its refusal; one that is
allowed but not valid is dropped as struck. Valid events are **applied**.

### 4.4 Merging

The state of a set of events is the start state with, for each record key,
the events **latest** on it (no other event on that key saw them) merged:

| Kind                              | Of the latest events on a key                                                                                                                                                                                                                      |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `role`                            | All stand: `roles[name]` = each as a definition `{ event, by: root, title?, grants, nests, view }`, sorted by id, `view` its own view (`V`, or `W` among valid events). More than one are rivals (§2.4).                                           |
| `assign`                          | If any is `assigned: false`, the role is not assigned. Otherwise it is assigned when some latest one saw every latest `remove` of its account in the set; `assigned[did][role]` = the lowest such id.                                              |
| `remove`                          | Change no entry of their own; they decide assignments (above). If any `remove` of a founder in the set has the founder as its root, `founders` loses it.                                                                                           |
| `invite`                          | Closed if any is closed, or if they name different roles; otherwise open. `invites[inviteDid]` = `{ role, open, event, by }`, `role` and `event` of the lowest closed one, or of the lowest id, and `by` the roots of all the latest ones, sorted. |
| `definition`, `relays`, `keepers` | the lowest id; for `definition`, only between changes one account, or the first definer and those who may define it, made: otherwise none (below)                                                                                                  |
| `key`                             | every key stands: `keys` holds the start key, then every other key by id, then the current one — the lowest id among the latest                                                                                                                    |
| `revoke`, `fork`                  | change no state                                                                                                                                                                                                                                    |

Where an id picks the event an entry names, the outcome is the same either
way: two assignments of one role to one account give the same power, a
closed invite is closed, and rival openers of an invite all stand in `by`.
No id decides between role definitions, which account holds a role, or who
first defined a collection. Relays, keepers and the current key are the
exception: among the latest changes, which may be different accounts', the
lowest id picks. Each of their authors could have made its own the latest
alone, by writing again after the other, so the pick gives nobody more than
its grant does.

A `definition` sets `definitions[name] = { event, definedBy }`. Of the
definitions of that name in the set that saw every removal the winner saw,
those that saw no other are its first definitions; `definedBy` is their root
if they are all one account's, and null if not ([02](02-records.md) §6.3): no
id decides it. Where several changes to a definition are latest, the lowest
id wins only when they are one account's, or when none is a delete and their
definitions name the same first definer; otherwise none is set in
`definitions`, and `contested[name]` lists the latest ones instead, for
readers to judge by what they say (02 §6.3). While it does, only someone
holding `/collection/define` for it may change the definition. A change
applied on top, having seen them, removes `contested[name]`. A deleted one
removes the entry.

`keyDue` is true, in a private space, when some event in the set took
reading from someone (in its own view, a reader before and not after) and the
current key's event had not seen it; and, for the current state, when anyone
who held the current key (a reader as it was made, or made a reader by an
assignment it had not seen) reads no more, however that came about.

The **current state** is the merge of the valid events.

> Rationale: rivals resolve toward less power. An unassignment beats an
> assignment, a closed invite an open one, and rival definitions hold only
> what they share. An id picks only between outcomes that are the same.

### 4.5 Refusals — the grant rule

`refusal(e, S)` is null when the event's root, `A`, may make the change in
`S`, by `may(S, A, cmd, args)` with the command and arguments of §2.3, or
because it is one of the changes anyone may make for themselves:

**`role`** — `may(S, A, /role/define, { role: name })`.

**`assign`**

- `did` starting `role:`: refused (roles go to accounts).
- _Joining by invite_ (`viaInvite` set): `assigned` is true; `A = did`; the
  invite exists and is open; its role equals `role`; `did` does not hold
  `role` now; the role exists; and a join is the assignment its opener
  makes: for every account `o` in the invite's `by`,
  `may(S, o, /role/assign, { role, self: o = did, roles: rolesOf(S, did) })`.
  So an opener's `.self` and `.roles` policies hold for whoever joins, the
  opener included. `S` is the join's own view, which the joiner chooses: one
  naming a view from before the opener lost the grant still gets in, so an
  invite is stopped by closing it.
- _Leaving a role_ (`assigned: false`, `A = did`): allowed when `did` holds
  `role` now.
- _Otherwise_: `did` is not a founder, unless `A = did`; the role exists;
  `args = { role, self: A = did, roles: rolesOf(S, did) }`; assigning needs
  `may(S, A, /role/assign, args)`; unassigning needs `did` to hold `role` now
  and `may(S, A, /role/unassign, args)`.

**`remove`** — `did` must be a member now. Leaving (`A = did`) is allowed,
a founder's included. Otherwise `did` is not a founder, and
`may(S, A, /member/remove, { self: false, roles: rolesOf(S, did) })`.

**`invite`** — for a role `x`, `assigns(x)` is: `x` exists and
`may(S, A, /role/assign, { role: x, self: false, roles: [] })`. If the invite
exists, `assigns(its role)`; closing (`open: false`) requires the invite to
exist; opening requires `assigns(role)`.

**`revoke`** — `A` must be a member. A revoke only ever reaches versions its
own account signed (§5.1), so a member may revoke only its own keys in effect.

**`fork`** — `A` must be a member: any member may bring the proof, which
stands on its own.

**`definition`** — with `defines` = `may(S, A, /collection/define, { collection: name })`:

- a new collection: `defines`;
- an existing one (change or delete): `defines`, or `A` is a member and
  `A` is the collection's `definedBy` (never when that is null);
- a contested one: `defines`.

**`key`** — the space must have keys (private); `may(S, A, /key/change, {})`;
the `keyId` and the `readKey` must both differ from every key already in `keys`.

**`relays`** — `may(S, A, /space/relays, {})`, and the list must pass `checkRelays` (§10).

**`keepers`** — `may(S, A, /space/keepers, {})`, and the list must pass `checkKeepers` (§10).

### 4.6 What the replay exposes

- `current` — the final state.
- `status(id)` — `applied` (with index), `dropped` (with reason), `waiting`, or unknown.
- `heads()` — the ids of applied events other than `revoke` and `fork` that no
  other such event saw, directly or through others, sorted ascending. This is
  what a writer puts in `seen`. A dropped event, a revoke and a fork proof are
  never heads: none changes the state, so a writer need not name them, and
  however many of them anyone makes, they can't fill `seen`.
- `at(seen, within?)` — the state a record is judged by: the merge of the
  events among what `seen` names and everything they saw that are valid in
  the whole history (§4.3), or, given `within`, valid among what `seen` and
  `within` name and everything they saw. A change struck since gives
  nothing, even to a record that cites it. Null when anything named (other
  than `G`) is missing or waiting.
- `seenAs(seen)` — the state as a record's writer saw it: the merge of the
  events valid among what `seen` names and everything they saw, judged
  among themselves alone. Null as for `at`.
- `revoked(key, account)` — every applied revoke of that key by that account.
- `named(did)`, `knownInvite(inviteDid)` — as used in §3.4.

**Example (a removal against a concurrent ban).** Alice founds the space with
a role `mod` holding `/member/remove`. She assigns it to Bob, and `member` to
Carol. Apart, Alice removes Bob and Bob removes Carol; both saw Carol's
assignment. Each is allowed in its own view. Alice's removal reaches Bob's,
which had not seen it, and its cutoff doesn't cover it, so it strikes it;
nothing strikes Alice's. Every arrival order gives Bob: no member, Carol:
`member`.

**Example (a definition concurrent with its author's unassignment).** Erin
holds `admin`, which may define `member`. Alice unassigns her from `admin`;
apart, Erin redefines `member` to hold `/member/remove`, and Bob, a member
who saw her definition, removes Carol. Erin's definition hadn't seen the
unassignment, so the unassignment strikes it; Bob's removal rests on it,
and with it gone from his view, is refused. Carol stays. A record Bob
writes citing the definition is withdrawn (§5.1 step 5).

_Source: `packages/core/src/space/roles.ts` (`replayAccess`, `invalidWithin`, `validWithin`, `componentsOf`, `merge`, `may`, `refusal`, `reductionOf`, `definerOf`, `extended`). Tests: `packages/core/tests/roles.test.ts` ("what a struck change carries with it", "unassigning and removing"), `packages/core/tests/access-attacks.test.ts` ("backdating past an unassignment", among them invites judged as their opener's assignment), `packages/core/tests/access-properties.test.ts` (random histories: order, safety, liveness, ids, reductions, removals), `packages/core/tests/access-convergence.test.ts` (every arrival order, and extending one change at a time, against replaying whole), `packages/core/tests/access-fuzz.test.ts` (the same with nestings, invites and people changing their own roles), `packages/core/tests/record-keys.test.ts` ("who first defined a collection"), `packages/core/tests/key-change.test.ts` ("when a new key is due")._

---

## 5. Judging a record against the history

### 5.1 `judge`

A record is judged in its **own view**, the access changes its `seen` names
and everything they saw, then against the changes to its author's standing
it had not seen, and then counting only the changes of its own view that
stand. Those are the only inputs.

`judge` answers only for the access history. A peer combines it with the
rest of standing as [02](02-records.md) §9.4 says: a version `judge` calls
withdrawn is still judged on its tags and rules, and is refused if they
fail.

A change that took power from someone **covers** a version when the change's
`cutoff` (§6.3) names the version's key and collection with a place at or
above the version's place in that key's line for that collection (`log.n`). What a covering change's author had seen of that key stands,
whatever the change took away.

Given a record's `id`, its root, its `seen`, its `author`, collection and
`log.n`, a predicate `needs(S)` (whether the root may do what the record
does in `S`), and optionally
`within`, the `seen` of a version that cites this one. Peers never pass
`within` when judging a version's standing; the library's checks do, to judge
a version they cite as of what the citer saw
([checks](../packages/core/docs/checks.md#citing-a-version)):

1. If anything in `seen`, or in `within`, is missing or waiting → not yet
   (retry later).
2. If an applied `revoke` by the record's own root names its `author`
   (§6.4), and does not cover it, and (with `within`) is in
   `within ∪ ancestors(within)` → withdrawn. Every such revoke applies, each
   with its own cutoff.
   The same for a fork: if a fork of `author`'s line in the record's
   collection is recorded (§6.5) whose `from` is at most `log.n`, and (with
   `within`) its event is in `within ∪ ancestors(within)` → withdrawn.
3. If `needs(seenAs(seen))` is false → refused.
4. If an applied reduction `u` of `root` (§4.3), a removal or an
   unassignment of any role, is **not** in `seen ∪ ancestors(seen)`, does not
   cover it, and (with `within`) **is** in `within ∪ ancestors(within)` →
   withdrawn ("its author's access was taken away").
5. If `needs(at(seen, within))` is false → withdrawn ("it rests on a change
   that was struck"): a change it saw, and perhaps cites, was struck since.
6. Otherwise it stands.

So a record stands if its author was allowed as of what it saw; no removal
or unassignment of its account it had not seen takes it away, unless the
change covers it; and it is still allowed counting only the changes that
stand. A writer can't escape a removal, or the loss of a role, by naming an
older point, nor gain anything from a change that was struck, by citing it.
A narrowed rule or a role written
again binds only what saw it: without trusted time, a version naming an
older point can't be told from one written offline then, and it counts if
its author could have written it then. For a version that another cites,
judged `within` the citer's `seen`, only what the citer had seen can take it
away.

Withdrawn is a refusal for every purpose but two: the version is still
stored, and the library's checks can count it as evidence cited by a version
that had not seen what withdrew it ([02](02-records.md) §9.5).

_Source: `packages/core/src/space/roles.ts` (`replayAccess`, `judge`, `at`, `seenAs`, `cutOf`). Tests: `packages/core/tests/roles.test.ts` ("records against the history", "a definition concurrent with its author’s unassignment… (Q1)"), `packages/core/tests/access-attacks.test.ts` ("backdating past an unassignment"), `packages/core/tests/checks.test.ts` ("a proof stays a proof…")._

### 5.2 Standing of an ordinary record

A version outside the access collections **stands** when, in this order:

1. its `space` equals the space id;
2. its signature and note verify ([02](02-records.md)) — giving `root`;
3. in the account's own spaces (registry, contacts, carry spaces) its proof
   grants `/account/write` there ([01](01-identity.md) §8);
4. its first version is present, is `seq` 0, has the same key and collection;
5. `at(seen)` and `seenAs(seen)` are available (else: not yet);
6. its **invocation** is `/record/delete` with `{ collection, byCreator }` for
   a deleted version, else `/record/write` with
   `{ collection, byCreator, body }`, where `byCreator` is true for `seq` 0 and
   otherwise whether the root of the first version is `root`, and `body` is
   the version's body as this peer opens it (§2.2 for one it can't);
   `needs(S) = isMember(S, root)` in a `sys.*` collection, and
   `may(S, root, cmd, args)` otherwise;
7. `root` is a member in `seenAs(seen)` and `needs(seenAs(seen))` holds;
8. for a stub (02 §4.5), at a peer that reads the space (a public space, or a
   private one whose key it holds): `needs` holds without taking a policy on
   `body` as holding (§2.2). Else not yet: the peer stores the stub, as its
   record's history, and judges the whole version when it arrives;
9. with `rules` = the rules of the definition in force for its collection in
   `at(seen)` (none for `sys.*` collections, or when the definition is missing
   or unreadable), a `final` rule refuses every `seq > 0` version
   ([02](02-records.md) §7.4);
10. `judge(...)` (§5.1) passes;
11. the [02](02-records.md) checks on topic tags, `onePer` keys and `fixed`
    fields pass (skipped where the body cannot be opened).

A stub and its whole version share an id and a signature, but not a
verdict: a peer **MUST** judge the whole version on its own, never by what it
found for the stub, which was judged without its body.

> **Known defect:** a peer applies step 3 only where it knows the space is
> one of the account's own (`accountOnly` in
> `packages/core/src/node/space-runtime.ts`). The account's devices know,
> since they derive those ids (§13.1). A peer without the account key, such as
> a carrier, a host or a mirror reader, may not be able to tell those spaces
> from any other, and then lets stand a version the account's devices refuse.
> Tracked in [#90](https://github.com/leifriksheim/weave/issues/90).

An access record stands when its event's status is `applied`.

A non-member — including someone holding only a view-only invite — can
therefore write nothing at all in a space, not even `sys.profile`.

_Source: `packages/core/src/node/space-runtime.ts` (`judgeStanding`, `invocationOf`, `needsOf`, `rulesAt`, `definitionIn`), `packages/core/src/space/roles.ts` (`judge`, `may`). Tests: `packages/core/tests/roles.test.ts` ("records against the history"), `packages/core/tests/space-access.test.ts` ("who may write", "taking it back"), `packages/core/tests/rules.test.ts`, `packages/core/tests/access-convergence.test.ts`._

---

## 6. Changing who may do what

### 6.1 Roles, assignments and removals

- **Define or change a role:** write `sys.role` at `role:<name>` with its
  grants, each a delegation payload from the writer's account (§2.2), and the
  roles it nests. It replaces the definitions it saw.
- **Assign a role:** write `sys.assign` at `assign:<hex40(did|role)>` with
  `{ did, role, assigned: true }`.
- **Take a role:** the same with `assigned: false`.
- **Remove an account:** write `sys.remove` at `remove:<hex40(did)>` with
  `{ did }`. Every role assigned to it that the removal saw ends.

Each is judged by §4.5. There is no record for removing a role: write its
definition with no grants instead. Its holders stay members.

### 6.2 Leaving and handing over

**Leaving a role:** an account writes its own `sys.assign` for that role with
`assigned: false`. **Leaving the space's history:** an account writes its own
`sys.remove`. Anyone may do either, whatever their roles; a founder that
leaves the space is a founder no more.

**Handing over:** a founder assigns another account a role whose grants run
the space, then leaves. The new holder keeps running it, as far as its role's
grants go; nobody is the founder any more.

**Leaving on a device:** when an account stops holding a space in which it
holds a place, the device that leaves **SHOULD** first write the account's
own `sys.remove`, and give it to at least one peer of another account before
it forgets the space, since nothing sends it afterwards. It then deletes the
space's membership record in the account registry (§13.2) and forgets the
space and its keys. The replay drops the account from `readers`, a key change
becomes due (§9.2), and someone granted `/key/change` changes the key (§9.3).

- A device that follows a deleted membership in the registry, while the
  account still holds a place in that space, **SHOULD** write the
  self-removal too: the device where the person left may have had no peer to
  give it to, or no note that may change access. Two such removals made apart
  are both accepted.
- An account with no place (a view-only holder) has nothing to remove and
  writes nothing.
- An account that is the space's only reader writes nothing: nobody else
  holds a key to change.
- Anyone may leave, so the founder can leave too. The space is then left with
  no one holding what the founder alone held, and that is accepted.

What the library does, and how long it waits for a peer, is in
[its docs](../packages/core/docs/node.md#leaving-a-space).

_Source: `packages/core/src/node/node.ts` (`spaces.leave`, `giveUpPlace`, `reconcileOnce`), `packages/core/src/node/space-runtime.ts` (`giveUpPlace`, `assign`, `removeAccount`, `defineRole`). Tests: `packages/core/tests/key-change.test.ts` ("leaving a private space"), `packages/core/tests/node.test.ts` ("the account registry"), `packages/core/tests/roles.test.ts` ("a founder steps down by leaving…")._

### 6.3 Cutoffs

A change that takes power from an account — taking a role from it, removing
it, revoking a key — **SHOULD** carry `cutoff`: for each key of the affected
account and each collection, the end of the unbroken line its
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
judged with the change. A node covers only the collections it holds: one
holding part of a space, removing someone, leaves their writes elsewhere to be
judged with the change ([#166](https://github.com/leifriksheim/weave/issues/166)).

```json
{
  "did": "did:key:zDnae…bob",
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
key's line, and a fork proof (§6.5) withdraws both. A role's definition and a
change to a collection's definition carry no cutoff: each binds what saw it.

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

A key can't pass its note on ([01](01-identity.md) §7.5), so no other key
acts through a revoked one: the revoke of a key is all there is to undo.

_Source: `packages/core/src/node/space-runtime.ts` (`assign`, `removeAccount`, `revoke`, `cutoffFor`, `packCutoff`), `packages/core/src/node/node.ts` (`spaces.leave`). Tests: `packages/core/tests/roles.test.ts` ("a revoked key…"), `packages/core/tests/cutoff-limits.test.ts`, `packages/core/tests/space-access.test.ts` ("taking it back", "a key cannot pass its note on: a two-link proof counts for no peer")._

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

An account granted `/role/assign` for a role (§2.5) opens an invite to it by
writing `sys.invite` at `invite:<hex40(inviteDid)>` with
`{ key: inviteDid, role, open: true }`. Only the invite's public key goes into
the space; the secret goes only into the link.

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
> original design took access back by deleting the record (an assignment,
> an invite); the build writes a change instead (`assigned: false`,
> `sys.remove`, `open: false`). What is left is to settle the delete
> case, one of two ways: a deleted `sys.invite` version yields an `invite`
> event with `open: false` (and likewise a deleted `sys.assign` yields an
> unassignment), or a peer refuses to store a deleted version
> in any access collection other than `sys.collection` (§3.4). The second is
> simpler and keeps "access is taken away by writing a change" as the only
> rule. Fixes the known defect above, tracked in
> [#20](https://github.com/leifriksheim/weave/issues/20).

### 7.3 Joining with a secret

Once the invite's record has reached the joiner and is open in the current
state, the joiner writes **its own** assignment:

```
sys.assign at assign:<hex40(joinerDid + "|" + role)>
{ did: joinerDid, role: <the invite's role>, assigned: true,
  invite: { key: inviteDid, signature: base64url(sig) } }

sig = ECDSA-P256-SHA256 (P1363, 64 bytes) by the invite private key over
      UTF-8 "weave/space-invite/v1|<spaceId>|<joinerDid>"
```

Verification imports the public key from `inviteDid` and checks `sig` over
the same bytes; an assignment whose `invite` does not verify yields no event
(§3.3). The signature binds the join to one account and one space.

If the joiner already holds the invite's role, joining is a no-op. If the invite's record
has not arrived yet, the joiner keeps the secret and tries again as records
arrive; once joined it forgets the secret. The joiner writes this record
before it is a member; its `seen` must include the invite event.

> **Known defect:** a joiner can count itself a member for a moment after the
> invite was closed elsewhere, until the close reaches it. Other members
> refuse its assignment, and it converges, but the joiner's own view is
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
    "id": "bvm5is7n2nm7ex3vy7hn2yllhsoi3dxezkrwvv6thhlfb5dioxdta",
    "visibility": "private",
    "creator": "did:key:zDnaeZLoH5izvFBqsJ62j3zJ2DYJWASAB7QFmkYR6aeAzhCLg",
    "roles": [
      {
        "name": "editor",
        "title": "Editor",
        "grants": [
          { "cmd": "/record", "pol": [] },
          { "cmd": "/collection/define", "pol": [] },
          { "cmd": "/role/assign", "pol": [["==", ".role", "editor"]] }
        ]
      }
    ],
    "createdAt": "2026-01-01T00:00:00.000Z",
    "nonce": "AAECAwQFBgcICQoL",
    "readKey": "did:key:zDnaem2ikLwS3eYm46gspC7nm6dmYYCMHUHU5yvVHNgARcsWf",
    "encryptionKeyId": "aLhvw5pkV65_lcQHEcUOug",
    "name": "Plans"
  },
  "invitedBy": "did:key:zDnaeZLoH5izvFBqsJ62j3zJ2DYJWASAB7QFmkYR6aeAzhCLg",
  "key": "__79_Pv6-fj39vX08_Lx8O_u7ezr6uno5-bl5OPi4eA",
  "invite": "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
  "role": "editor",
  "relays": ["wss://relay.example"]
}
```

encoded: `eyJzcGFjZSI6eyJpZCI6ImJ2bTVpczduMm5tN2V4M3Z5N2huMnlsbGhzb2kzZHhlemtyd3Z2NnRoaGxmYjVkaW94ZHRhIiwi…`
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

`sys.role`, `sys.assign`, `sys.remove`, `sys.invite`, `sys.revoke`, `sys.key`,
`sys.box`, `sys.memberkey`, `sys.relays`, `sys.keepers` and `sys.fork` (§6.5): proof every peer must check, holding signed envelopes
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
>   public anyway: `sys.assign` bodies name each account in the clear (§8.2),
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
someone (removed, left, or unassigned from their last role) was not seen by the current key's
event. A key change made at the same time as a removal, not having seen it,
leaves the key change due ([#173](https://github.com/leifriksheim/weave/issues/173)).

A **former member** is an account named by an applied `assign` or `remove`
event that is not a reader now: removed, left, or holding no role. Peers
send them no live messages, and while a key change is due, nothing at all
([04](04-network.md) §6.3, §9.2).

### 9.3 Changing the key (`sys.key`)

A member granted `/key/change` and holding the current key, seeing `keyDue`, **SHOULD**
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
key and the event's `keyId`, and takes each raw key it contains (up to 1000)
whose id and read key the history names; repeat until nothing new. Only the
`key` event that counted for that key id is opened: anyone can store a
version at `key:space`. So holding the current key opens every earlier one.

A reader **MUST** check that the keys an `earlier` opens to include the
space's first key K₀, the one the genesis's `encryptionKeyId` names (§8.1):
every reader needs it to derive `onePer` keys ([02 §7.3](02-records.md)). A
key change whose `earlier` does not open, or leaves K₀ out, is
**malformed**: the reader takes no key from it. The change still counts in
the access history, which peers that can't open it judge the same way. A
member granted `/key/change` and holding K₀ and the key a malformed change
names **SHOULD** change the key, as when one is due. A writer **MUST NOT**
change the key without holding K₀. Until someone does, a newcomer that holds only that key
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

A member granted `/key/change` seals the current key to every reader who has
published a member key and has no box for that key id yet from themselves or
from anyone granted `/key/change`.

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

_Source: `packages/core/src/node/space-runtime.ts` (`learnKeys`, `malformedKeys`, `rotateKey`, `changeKeyNow`, `formerMembers`, `boxForMembers`, `upkeep`, `loadMemberKeys`), `packages/core/src/space/space-access.ts` (`MEMBER_KEY_COLLECTION`, `BOX_COLLECTION`, `boxKey`, `BOX_LABEL`, `boxBound`, `SPACE_KEY_RECORD`), `packages/core/src/identity/contact-key.ts` (`deriveMemberKeyBytes`), `packages/core/src/identity/hpke.ts` (`sealTo`). Tests: `packages/core/tests/key-change.test.ts` ("is taken as malformed: a manager replaces it, and a newcomer still gets the first key", "forces no key change, however malformed", "gives no reader a key the history doesn’t name", and the rest), `packages/core/tests/envelope.test.ts` ("a box opened with the wrong bound, label or key opens nothing")._

---

## 10. Relays and keepers

**`sys.relays`** at `relays:space`: `{ relays: string[] }` — where the
space's members meet. Valid (`checkRelays`) when it is a list of at most 8
distinct URLs, each at most 200 characters, each `wss://`, or `ws://` only on
`localhost`, `127.0.0.1` or `[::1]`. Only someone granted `/space/relays` may set it. Until the space
names some, members meet on relays they learn elsewhere, such as the invite
that brought them (§7.4).

**`sys.keepers`** at `keepers:space`: `{ keepers: [{ did, name }], copies }`
— nodes that hold every record of the space, and how many a write should
reach before a node holding only part lets go of it. Valid (`checkKeepers`)
when there are at most 16 keepers, each `did` starts with `did:key:` and is
at most 200 characters, each `name` a string of at most 80 characters, no
`did` twice, and `copies` is null or an integer 1–16. Only someone granted
`/space/keepers` may set it.
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
space   = { visibility: "private", creator: accountDid, roles: [],
            createdAt: "1970-01-01T00:00:00.000Z", nonce,
            readKey: readDid(K), encryptionKeyId: keyId(K) }
id      = cid(canonical(genesis))            // §1.2
```

There are no founding roles: the account is the space's founder, and holds
every command. Any other bytes give another id.

| Label                    | Space                | Name               |
| ------------------------ | -------------------- | ------------------ |
| `weave/account-registry` | the account registry | `Account registry` |
| `weave/contacts`         | the contacts space   | `Contacts`         |

Example (seed `01 02 … 10`): registry `bvlkecmz3ywm4lzqjcjs4iwy7gjyk6d2xou6di2rk3juquwffqarq`
(nonce `Jx8Oo78z30WwKl1X`), contacts `b5fmel466vf72tqpijj4l5yj3pfmbjet5y55wp2db66vhswunomyq`.

> Rationale: the DID alone is not enough to find them — it appears on
> everything the account signs.

In these spaces only the account writes (a record whose root is another
account is ignored by readers), and nothing written under a note without
`/account/write` counts ([01](01-identity.md) §8).

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
- An argument that tells writing a new record from editing one, so a grant
  of `/record/write` can allow one and not the other: `byCreator` is true for
  both ([the plan](drafts/constitution-grants-contracts.md) §7).
- A way to re-establish a space's key for members who lost every key they held
  other than a fresh role invite.
- `invitedBy` and the space `name` in invites are unauthenticated; no
  signature over the invite string exists. See the known defect in §7.4.
