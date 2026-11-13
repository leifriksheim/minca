# Draft: the extension is an app with keys

> **Draft.** Not normative, not planned yet, not built. A proposal for review.
> When it is agreed, the parts that are protocol change
> [03 — Spaces](../03-spaces.md) §14 and §15,
> [04 — Network](../04-network.md) §6.3,
> [06 — Nodes and sessions](../06-nodes-and-sessions.md) §4 and
> [08 — Hosting](../08-hosting.md) §2 as **Planned**, with an issue. Sizes are
> estimates until the code is written.
>
> Fourth version: the third, with what its review found. §8 says what the
> first two tried and why they were dropped.

## 1. The problem

A carrier keeps a private space online without being able to read it. Where
it meets peers through relays, each side must prove it may read (04 §6.2),
so the carrier is handed a **secret** to prove it with: the read seed,
derived from the space key (03 §8.4).

A secret has to be handed over in private, and handed over again every time
the key changes. That is why:

- a pass carries the seed (03 §14), and every device holding the account key
  rewrites every pass in every carry space when a key changes (06 §4.2);
- a device behind on a key change overwrites a newer pass (#283);
- a removed carrier keeps proving read until the key changes (#170);
- connecting a carrier is its own exchange with the account home, with its
  own grant (06 §4.3).

## 2. What uses the secret

| Node                 | How it meets peers      | Proves read with the seed                                                                                |
| -------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------- |
| A host               | Devices dial it (08 §1) | No. It joins no relay, proves only its own key (04 §6.1), and checks clients against the access history. |
| The desktop app      | Relays                  | No. It runs an app's node under a grant, and holds keys.                                                 |
| `minca carry`        | Relays                  | Yes, but nothing writes the grant it reads any more.                                                     |
| The Chrome extension | Relays                  | Yes.                                                                                                     |

A host does read the seed's public half: to tell a pass for a later key from
an earlier one, and to say in a space's status which key it carries with. It
takes that from the pass itself, where it is whatever the pass says: a seed
checks out against the `readKey` written beside it, so a pass proves nothing
about who handed it over, today (§7).

So proving read with the seed, and everything that keeps the seed current,
serves the extension.

## 3. The design

### 3.1 The extension runs an app's node

The extension connects through the account home as an app does, with
`scope: account`, `access: write`, `recordsOnly: true` (06 §2.4, §2.8), and
runs an ordinary node in its hidden page: it holds the account key, follows
the registry, opens new keys from their boxes (03 §9.4), and proves the read
key to peers like any app. It is what the desktop app already is, in a
browser.

It keeps doing what it does now: it stays on with every tab closed, syncs
with every member's device through relays, and so keeps the account's spaces
available with no host.

Why that grant:

- **Records only** gives it no contact key, and nothing it signs can change
  who may do what, name keepers, change a key or write in the account's own
  spaces. In a private space it only learns keys.
- **Write, not read**, because disconnecting revokes only keys that write
  (06 §2.10), and the revoke is how the extension learns to forget.

What changes for the person:

- **It holds keys, unsealed.** Whoever copies the browser profile reads
  everything the account key opens, spaces joined later too, and can write
  records and live messages as the account until it is disconnected. Today
  the same copy yields sealed records and read seeds. Taking the account key
  back from a device is #165. The desktop app holds the same keys, sealed
  under one in the system keychain; a browser has no such place.
- **Its connection runs out.** The home grants a year at most, and renewing
  needs the home's window. Past its note the extension stops its node, as
  the desktop app does. A carrier today has no expiry. The extension says so
  on its badge and in a notification, two weeks before and when it happens.
- **It shows as the person** to peers, as their other apps do. Today it
  shows as nobody (06 §4.1).
- **It can show what a notification is about**, reading the account's
  automations as the desktop app does.
- **Disconnecting it** revokes its key (06 §2.10); it sees the revoke and
  forgets what it held.

Every install shares one origin, so the home keeps them as one connection,
as it does an app open in two browsers: a second install's key replaces the
first's, which keeps working until its note runs out, and disconnecting
revokes both (06 §2.10).

**Coming from a carrier.** The extension makes a new key. When it connects,
the home removes the carrier at that origin (06 §4.2), so it is told to
forget and is named a keeper no more.

### 3.2 No carrier meets peers through relays

`minca carry` goes, and a carrier node no longer joins relay rooms or proves
read. A carrier is a host: a node devices dial.

### 3.3 A pass is the constitution

```
sys.pass at pass:<hex40(spaceId)>
{ v: 2, space: <space object> }
```

`read` and `readKey` go. A host MUST NOT take a space's read key from a
pass: it follows it from the access history, as it does to check clients
today. In a space's status (08 §2), `readKey` is the read key the host's
history has as current, so it still says when the host is behind. A device
no longer hands a pass again when a key changes; a host that is behind
catches up by syncing.

A pass is written when the account joins a space or starts using a host,
and deleted when it leaves.

### 3.4 No wakes

Only a carrier matched wakes (03 §15), and only on the person's own machine.
An app's node reads the account's automations itself. So `sys.wake`, copying
automations into carry spaces as wakes, and the rules for matching one from
a record's outside go. A carry space holds passes and kept links.

### 3.5 Who a node counts on

Unchanged: the list a space names (`sys.keepers`), which an account's
devices fill with its carriers in the spaces it manages. Carriers are hosts
only, so a closed laptop is no longer on that list.

## 4. What goes

| Goes                                                              | Where                                                                       |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------- |
| The read seed and `readKey` in a pass                             | 03 §14; 06 §4.1, §4.2; 08 §2; `packages/core/src/space/pass.ts`             |
| Rewriting passes when a key changes; handing a host a pass again  | 06 §4.2; `packages/core/src/node/node-carriers.ts`, `node-hosting.ts`       |
| A carrier reopening a space when its read key changes             | `packages/core/src/node/carrier.ts`                                         |
| A carrier on the mesh: relays, proving read without the space key | `carrier.ts`; `packages/core/src/network/peer-auth.ts`; 04 §6.3             |
| Wakes                                                             | 03 §15; 06 §4.4; `packages/core/src/space/own-automations.ts`; `carrier.ts` |
| `access: "carry"`, the carry grant, connecting a carrier          | 06 §2.4, §4.3; `packages/core/src/session/connect.ts`; `packages/auth`      |
| `minca carry`, and the extension's carrier                        | `packages/cli/src/carry.ts`; `apps/extension`                               |
| Known defect #283; #170's removed carrier                         | 06 §4.2; threat model §3.8                                                  |

Estimate: 600–900 lines of `packages/core/src`, 200–300 of spec, and the
carrier code in the extension and CLI.

## 5. What is new

Nothing a peer checks. What a host checks of a pass gets smaller (§3.3),
and that breaks hosts and devices that haven't updated: §9 orders the work
so nothing is dropped in between.

## 6. What it changes for an attacker

To be gone through against every "Holds" claim before this is Planned.

- **Whoever copies the browser profile** gets the account key, the space
  keys and a key that writes records as the account (§3.1). This is the
  cost of the design.
- **A host that is stolen or removed** holds no seed. It could prove
  nothing with one today either, since it joins no relay; a removed
  extension could, and that goes.
- **A blind node no longer hears live messages**: none is on the mesh.
- **Fewer spaces sync shallow against a laptop**, since an extension is no
  keeper.
- **A stranger, a relay, a former member, a host**: no rule they meet
  changes.

## 7. Open, and found on the way

- **The pod.** Settled: the person picks the folder, and the extension
  finds the account in it by its DID. An app is never given the folder's
  local key (05 §15), so it writes sealed segments and no more, which is
  what a carrier did.
- **Notifications from the account's automations.** An app that may write
  the account's own records can add an automation whose words and link a
  device then shows. The desktop app has this today; the extension joins it.
- **A dialled node on the mesh** (#120) has the node prove read on both
  sides. A host without a seed can't. #120 changes to: the dialled node
  proves its own key only.
- **A host new to a space whose key has changed five times or more** checks
  no device: a device proves at most four earlier keys (04 §6.3). Confirmed
  with a probe against today's code, and not changed here. Its own issue.
- **Web Push** (#60) is closed as an idea, and 03 §15 and 06 §4.4 still call
  it Planned. That text goes with wakes.

## 8. What was tried first

1. **A carrier proving itself with a note from its account.** Review found
   that any valid note makes a peer the account in live messages (04 §6.4),
   that taking in access history from a peer not yet let in gives every
   former member a way to write into it, and that only the root key signs
   notes (01 §7.5), so the devices that are online could not renew one.
2. **A host letting its account's devices in on their note, with passes
   that hold nothing.** Review found that a host keeps one copy of a space
   for every account, so anyone holding a constitution could be served it.

Both tried to give a blind node a new way to prove something. This version
has no blind node that needs to.

## 9. How to get there

Each step leaves everything working with what came before it.

1. **Hosts stop reading the seed.** A host accepts a pass with or without
   `read`, takes no read key from it, and reports the history's. Devices
   still write `read`. Deployed before the next step is released.
2. **The extension as an app**, with `minca carry` removed and the home
   removing the old carrier. Old extensions keep working until they update.
3. **The rest goes**: the carrier on the mesh, the seed in passes (`v: 2`),
   wakes, the carry grant. With the spec.

## 10. What else this points at

Not part of this proposal; each wants its own look.

- **Blind carrying becomes a hosting matter.** With no blind node on the
  mesh, what is left of carriers sits between an account and its host, and
  could move from the core spec parts into [08](../08-hosting.md), and from
  `@minca/core` into a package of its own.
- **Carry spaces could shrink** now that nothing in one is secret from a
  later reader: one per host, without a generation counter.
- **Taking a key back from a device** (#165) matters more with an always-on
  app holding the account key.
- **`copies`** in `sys.keepers` is set by nothing.
