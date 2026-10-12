# The Weave protocol

This is the specification of Weave: what goes over the wire, what is stored,
what is signed, and what every peer must check. It is written so that someone
can build a client that interoperates with this implementation without
reading its code, and so that a reader, or a model, can understand the
architecture from the spec and the tests alone.

The code in `packages/core/src/` is the reference implementation. Where this document and
the code disagree, that is a bug in one of them: open an issue, and say which.

## Parts

**The core.** What every peer implements to sync with others, store what they
store, and judge every record the same way:

| Part                                            | Covers                                                                                                                                                                                           |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [01 — Identity](01-identity.md)                 | Seeds and recovery codes, key derivation, DIDs, root and session signers, UCAN delegations, what a note lets a key do, envelopes and HPKE, contact keys, the account vault, device keys, pairing |
| [02 — Records](02-records.md)                   | Records and their versions, canonical encoding and hashing, signatures, which version wins, links, collection definitions, rules, topics, the validation pipeline                                |
| [03 — Spaces](03-spaces.md)                     | Spaces, roles and the access log, invites, encryption and key distribution, the account registry, profiles                                                                                       |
| [04 — Network](04-network.md)                   | Relays and the signaling protocol, several relays at once, peer authentication, WebRTC and WebSocket transports, the mesh, introductions, live messages, ICE and TURN                            |
| [05 — Sync and storage](05-sync-and-storage.md) | Negentropy set reconciliation and its messages, what is stored and how, data folders, sealing at rest, segments, mirrors, blobs                                                                  |

**Built on the core.** Exchanges between two parties that a peer needs only
if it takes part in them; a peer that doesn't still syncs, stores and judges
everything the same:

| Part                                                      | Covers                                                                                                                            |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| [06 — Nodes, sessions and apps](06-nodes-and-sessions.md) | The session note and following the account, the account home and app grants, connecting by code, carriers                         |
| [07 — Doors](07-doors.md)                                 | Names and doors: how someone you share no space with can ask to become your contact, and the relay mailbox that holds their knock |
| [08 — Hosting](08-hosting.md)                             | Hosts: subscriptions and payment, a space's own fund, bots a host runs                                                            |

### A minimal peer

A peer that joins spaces and syncs them needs, from the core:

- 01 §1–9: keys, DIDs, UCAN notes, what a note lets a key do, and envelopes;
  §10.2 and §11.1 for the member keys a private space's new keys are boxed to;
- 02 whole;
- 03 §1–7, and §8–9 for private spaces;
- 04 §1–2, one transport from §5, §6–7 and §9;
- 05 §1–10.

The rest of the core is shared between the devices of one account (the vault,
device keys, pairing, the data folder, sealing at rest) or optional (several
relays, introductions, blobs and mirrors). An implementation can add it
later and still interoperate.

What it defends, against whom, and where it does not yet, is in the
[threat model](threat-model.md). Every part answers to it, and every change to
the protocol is reviewed against it before it merges.

## What is not in it

Only what two implementations must agree on to work together is here. What
one implementation offers its own users is not, however useful: another may
do it differently and still interoperate. Those parts are described with the
package, in [`packages/core/docs/`](../packages/core/docs/README.md), and
change without touching this spec:

- **The library's interface**: creating a node, its stores, holding spaces,
  events, sign-in, the app-side client, React ([node](../packages/core/docs/node.md),
  [sign-in](../packages/core/docs/sign-in.md)).
- **How the library handles spaces**: role presets, invite defaults, how it
  reads and publishes profiles, and where it keeps spaces and their keys
  ([spaces](../packages/core/docs/spaces.md)).
- **The query format** a node answers ([query format](../packages/core/docs/query-format.md)).
  Peers never exchange queries.
- **Checks**: the CEL conditions a definition's `rules.check` holds, what a
  version cites as evidence, and counting only versions that pass. Peers keep
  `check` and every version that fails it ([checks](../packages/core/docs/checks.md)).
- **Node actions** and the tools the CLI, MCP and WebMCP make of them
  ([actions](../packages/core/docs/actions.md)).
- **The standard collections** (`std.*`), which are a naming convention, not
  reserved ([standard library](../packages/core/docs/standard-library.md)).
- **Collections proposed for a space** (`std.blueprint`), their review, and
  guides to how a space's collections are used (`std.guide`)
  ([blueprints and guides](../packages/core/docs/blueprints-and-guides.md)).
  Apps with screens of their own are an app's convention
  ([blueprints and guides](../packages/core/docs/blueprints-and-guides.md#apps-with-a-screen-of-their-own);
  the example app's launcher, `apps/example/src/components/apps/launcher.ts`).
- **Contacts**: the contact list, contact requests and how they are sealed
  ([contacts](../packages/core/docs/contacts.md)).
- **Direct messages**, sealed to members' keys ([direct messages](../packages/core/docs/direct-messages.md)).
- **Doors kept as records**, and how a knock becomes a contact; the relay
  mailbox and the knock itself are in [07](07-doors.md) ([doors](../packages/core/docs/doors.md)).
- **Calls**, built from live messages ([calls](../packages/core/docs/calls.md)).
- **What one node keeps for itself**: its stores and caches, how it paces
  sync, its timers, retries and defaults ([storage](../packages/core/docs/storage.md),
  [node](../packages/core/docs/node.md)).

The test for a new rule: would a peer that has never heard of it still sync,
store and judge every record the same way? Then it is a layer on the
protocol and belongs with the package, even when it seals, signs or fixes
exact bytes two apps must agree on. Does a peer have to check, refuse or send
something new, or do two parties (an app and its account home, a carrier, a
relay) exchange it? Then it belongs here. What only one node ever reads is
not protocol either; a number is, only when the other side enforces it.

## Conventions

- **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT** and **MAY** are used as
  in RFC 2119, and only where they mean it. Everything else is description.
- **Wire and storage formats** are given exactly: field names, types, byte
  layouts, encodings, and an example. A format a peer must produce or accept
  is normative; a format only this implementation uses internally is marked
  _implementation detail_.
- **Encodings.** Unless a part says otherwise: JSON is UTF-8; `base64url` is
  RFC 4648 §5 without padding; `base58btc` is the Bitcoin alphabet; hashes are
  SHA-256; keys are P-256 (secp256r1); signatures are ECDSA P-256 over SHA-256
  in the 64-byte IEEE P1363 form (r ‖ s).
- **Canonical JSON** is defined once, in [02 — Records](02-records.md), and
  every "hash of" or "signature over" a JSON value means over its canonical form.
- **Labels.** Keys derived from the seed, and signed or sealed messages, are
  bound to string labels. The full list is in [01 — Identity](01-identity.md),
  including the few places one label serves two uses today.
- **Source.** Each section ends with the files that implement it and the
  tests that pin it down, e.g. _Source: `packages/core/src/sync/negentropy.ts`. Tests:
  `packages/core/tests/sync.test.ts`._ Tests are the executable half of this spec.
- **Rationale** is kept short and set apart, so the rules can be read without it.
- **Planned.** Work that is designed but not built lives in the part it
  belongs to, in a section or blockquote headed **Planned**, saying what it
  will add, what it depends on, and its issue when one exists. Planned text is
  not normative. This spec is the working document: when planned work is
  built, its section becomes the specification; when plans change, it is
  edited. (Earlier plans lived in `docs/blocks/`, kept in git history.)
- **Not yet specified.** Where behaviour is left to the implementation, or is
  still moving, the spec says so rather than guessing.
- **Known defect.** Where this implementation does something the protocol
  should not require, the spec says so in a blockquote starting
  "> **Known defect:**", describing current behaviour and what a fix will
  change. Other implementations MUST NOT rely on it, and SHOULD NOT copy it.

## Planned work

Designed but not built. Each entry is specified, as **Planned**, where it
belongs. Rows marked _after v1_ link parked issues, closed with the `idea`
label. Issues track the larger ones. Known defects link their issue where
they are described; the smaller ones share
[#20](https://github.com/leifriksheim/weave/issues/20).

| Planned                                                                                           | Where                                                                                                                                    |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| A check character on recovery codes                                                               | [01 §2](01-identity.md), [#20](https://github.com/leifriksheim/weave/issues/20)                                                          |
| One spelling per key; one valid form per token; strict token shape                                | [01 §4, §7](01-identity.md)                                                                                                              |
| Proof chains that travel (fixes a known defect)                                                   | [01 §7.5](01-identity.md), [#19](https://github.com/leifriksheim/weave/issues/19)                                                        |
| Delegations as UCAN 1.0                                                                           | [01 §7](01-identity.md), [#19](https://github.com/leifriksheim/weave/issues/19)                                                          |
| Grants narrower than a space                                                                      | [01 §7.1](01-identity.md), [06 §2](06-nodes-and-sessions.md), [#19](https://github.com/leifriksheim/weave/issues/19)                     |
| Removing a lost device from another one (sign-out already revokes)                                | [01 §7.4](01-identity.md), [#165](https://github.com/leifriksheim/weave/issues/165)                                                      |
| Keys that belong to their creator                                                                 | [02 §4.7](02-records.md), [#72](https://github.com/leifriksheim/weave/issues/72)                                                         |
| Merging inside one record                                                                         | [02 §4.8](02-records.md)                                                                                                                 |
| Forgetting in blob stores                                                                         | [02 §4.9](02-records.md)                                                                                                                 |
| References to records in other spaces _(after v1)_                                                | [02 §5.3](02-records.md), [#38](https://github.com/leifriksheim/weave/issues/38)                                                         |
| `pattern` and `format` in definitions                                                             | [02 §6](02-records.md)                                                                                                                   |
| Private `onePer` keys; uniqueness that cannot be a key                                            | [02 §7.3](02-records.md), [#72](https://github.com/leifriksheim/weave/issues/72)                                                         |
| Deleted access records can't leave access standing                                                | [03 §7.2](03-spaces.md), [#20](https://github.com/leifriksheim/weave/issues/20)                                                          |
| What a private space still shows (hashed keys and collection names)                               | [03 §8.6](03-spaces.md), [#72](https://github.com/leifriksheim/weave/issues/72)                                                          |
| Access-control convergence                                                                        | [05 §8](05-sync-and-storage.md), [#10](https://github.com/leifriksheim/weave/issues/10)                                                  |
| Limits on what one peer can cost another                                                          | [04 §7.4](04-network.md), [05 §6.4, §8](05-sync-and-storage.md), [#33](https://github.com/leifriksheim/weave/issues/33)                  |
| Binary sync messages                                                                              | [05 §4](05-sync-and-storage.md)                                                                                                          |
| Caches that fetch by record key; subsets smaller than a collection _(after v1)_                   | [05 §9.1](05-sync-and-storage.md), [#27](https://github.com/leifriksheim/weave/issues/27)                                                |
| Mirrors: restoring an account, absorbing a quiet store writer                                     | [05 §16.5](05-sync-and-storage.md)                                                                                                       |
| Files: blob references, bytes synced by hash _(after v1)_                                         | [05 §16.6](05-sync-and-storage.md), [#37](https://github.com/leifriksheim/weave/issues/37)                                               |
| A wallet as the account home                                                                      | [06 §2](06-nodes-and-sessions.md)                                                                                                        |
| Connecting by code: renewing notes, programs that can't run code of their own                     | [06 §3.1](06-nodes-and-sessions.md)                                                                                                      |
| Subscriptions that match any of several topic values _(after v1)_                                 | [06 §4.4](06-nodes-and-sessions.md), [#141](https://github.com/leifriksheim/weave/issues/141)                                            |
| Subscriptions delivered per device, by Web Push to an app that is closed _(after v1)_             | [03 §15](03-spaces.md), [06 §4.4](06-nodes-and-sessions.md), [#60](https://github.com/leifriksheim/weave/issues/60)                      |
| Hosts: invites naming hosts, stopping a host, user storage, metering, reminders, private payments | [08 §4](08-hosting.md), [#220](https://github.com/leifriksheim/weave/issues/220)                                                         |
| Names: handles that lead to a door                                                                | [07 §9](07-doors.md)                                                                                                                     |
| Content-addressed definitions; definition tiers, additive-only _(after v1)_                       | [02 §6.5](02-records.md), [#11](https://github.com/leifriksheim/weave/issues/11), [#12](https://github.com/leifriksheim/weave/issues/12) |

Proposed in an issue but not yet designed into the spec, so listed under
**Not yet specified** in their part: key rotation, KERI-style pre-rotation
([01 §16](01-identity.md), [#9](https://github.com/leifriksheim/weave/issues/9)), and access-history checkpoints
([03 §17](03-spaces.md), [#25](https://github.com/leifriksheim/weave/issues/25)).

## The shape of it, in one page

```
 account (seed) ──derives──▶ root key ──signs UCAN──▶ session key ──signs──▶ records
                                                                           │
                                                          stored per space │ synced by Negentropy
                                                                           ▼
 space = { id, visibility, roles & access log, collections, records } ◀── peers in the space
                                                                           ▲
             relays (WebSocket) introduce peers ─▶ WebRTC data channels ───┘
```

- An **account** is a 16-byte seed. Everything else about it is derived.
- The **root key** almost never signs data. It signs short-lived delegations
  (UCANs) to **session keys**, which sign **records**.
- A **record** is a signed, versioned JSON document in a **collection** of a
  **space**. Private spaces encrypt record bodies with the space key.
- A **space** carries its own rules: roles, who holds them, what each
  collection accepts. Every peer replays the same history and reaches the
  same answer about who may write what. There is no server to ask.
- **Relays** only introduce peers. **Carriers** and **hosts** keep spaces
  online without being able to read them. Neither has authority.
- **Doors** let someone you share no space with ask to become your contact,
  through a relay mailbox that holds only sealed knocks.
