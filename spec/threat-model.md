# Threat model

What Weave defends, against whom, and where it does not yet. It is
descriptive: it adds no rules of its own. Every part of the spec answers to
it. A change that weakens a guarantee here, or gives an adversary something
new, says so and changes this page in the same PR.

Guarantees are stated as they hold **today**, and each names the spec
sections that give it and the tests that show a peer refusing the attack. A
"Holds" claim with no such test is a claim nobody has checked: either write
the test or move the claim to "Does not hold yet". Where a guarantee does not
hold, the gap is listed with its issue rather than left out. Every issue
listed links back here.

## 1. What is protected

| Asset               | Meaning                                                                                               |
| ------------------- | ----------------------------------------------------------------------------------------------------- |
| **Integrity**       | A version counts only if its author was allowed to write it, by rules every peer applies the same way |
| **Convergence**     | Peers that hold the same versions reach the same verdicts and the same state, in any order            |
| **Confidentiality** | Only readers of a private space read its records and live messages                                    |
| **Accountability**  | Misconduct by a key is provable to everyone, by evidence nobody has to take on trust                  |
| **Availability**    | A member can sync with the space while one honest peer that holds it can be reached                   |
| **Account control** | Only the account's owner acts as the account, and only as far as it delegated                         |
| **History**         | What a member wrote stays readable to those who could read it, unless it was meant to be taken back   |
| **Metadata**        | What each party learns beyond what it needs                                                           |

## 2. Adversaries

| Adversary            | Holds                                                                                                 |
| -------------------- | ----------------------------------------------------------------------------------------------------- |
| **Stranger**         | Network access; any number of keys and accounts of its own; a space's id, or a leaked invite string   |
| **Member**           | A role in the space, its own keys, the space key of a private space; a modified client                |
| **Former member**    | Everything it held while a member: old keys, space keys, notes, invite secrets, its copy of the space |
| **Key thief**        | One of an account's delegated keys (session, writer, app or agent key), with its note                 |
| **Root thief**       | The account's seed or recovery code                                                                   |
| **App or agent**     | A grant from the account: a note, and perhaps the vault, contact or member keys (06 §2)               |
| **Relay**            | The signaling traffic of the rooms it serves, and the door mailbox it keeps                           |
| **Host or carrier**  | Every version of the spaces it keeps and their envelopes, a pass's read seed, a connection to members |
| **Network attacker** | Can watch, delay, drop and replay traffic between peers                                               |

Peers are assumed to run arbitrary code. Nothing relies on a peer running the
reference implementation, or any implementation, honestly.

## 3. What holds, and what does not yet

### 3.1 Stranger

- **Holds.**
  - What it signs counts for nothing: a version needs a role as of its `seen`
    (03 §5.2), and a change to who may do what needs power as of its `seen`
    (03 §4.5).
  - It cannot forge a version, a note or an invite (02 §3, 01 §7, 03 §7).
- **Does not hold yet.**
  - A leaked view-only invite carries the space key, can't be closed, and
    never causes a key change, so whoever holds it reads everything new
    ([#172](https://github.com/leifriksheim/weave/issues/172)).
  - A leaked role invite lets it join, as often as it likes
    ([#161](https://github.com/leifriksheim/weave/issues/161)).
  - What it sends must be checked, stored or refused, with few limits
    ([#33](https://github.com/leifriksheim/weave/issues/33)).
  - It can squat a session DID in a relay room, or fill a room
    ([#162](https://github.com/leifriksheim/weave/issues/162)).

_Source: 03 §4.5, §5.2; 02 §3. Tests: `packages/core/tests/attacks.test.ts`, `packages/core/tests/roles.test.ts`, `packages/core/tests/validation.test.ts`._

### 3.2 Member

- **Holds.**
  - What it writes counts only if its role allowed it, as of what the version
    says it saw. Claiming to have seen less does not help: a change it had not
    seen that took power away also withdraws what it wrote (03 §5.1, §5.2
    step 10).
  - Peers that hold the same access changes replay them to the same state:
    the order is a function of the signed changes alone (03 §4.3).
  - Two versions one key signed at one place in its log are proof of a fork
    once a peer holds both (02 §4.10, 03 §6.5).
  - What it signs that every peer refuses, and no honest client signs, is
    proof against its account that it cannot withdraw or replace (03 §6.6).
- **Does not hold yet.**
  - Which changes a peer holds can differ for good, and verdicts depend on a
    peer's clock, its keys, or the order it runs checks in
    ([#121](https://github.com/leifriksheim/weave/issues/121),
    [#163](https://github.com/leifriksheim/weave/issues/163)).
  - A change made later can reorder earlier concurrent ones: peers converge,
    but verdicts are not final
    ([#137](https://github.com/leifriksheim/weave/issues/137)).
  - A fork is proven only where both branches meet. One kept apart, writing
    only where the other never does, is never proven.
  - It can disown its own history, withdrawing votes and agreements others
    relied on, by revoking its own note with an empty `keep`, or forking its
    own log at 0, and nothing flags it
    ([#168](https://github.com/leifriksheim/weave/issues/168)).
  - A `seq 0` for someone else's key can take over "creator"
    ([#72](https://github.com/leifriksheim/weave/issues/72)).
  - The top rank answers to no one, and no vote can bind a change to who may
    do what ([#160](https://github.com/leifriksheim/weave/issues/160)).

_Source: 03 §4, §5, §6.5, §6.6; 02 §4.10. Tests: `packages/core/tests/access-convergence.test.ts`, `packages/core/tests/roles.test.ts`, `packages/core/tests/writer-logs.test.ts`, `packages/core/tests/warrants.test.ts`._

### 3.3 Former member

- **Holds.**
  - What it writes claiming to have seen its removal does not count. What it
    writes claiming not to have seen it is withdrawn, unless the removal kept
    it (03 §5.1).
  - A space key made after its removal is not boxed to it, and members that
    can read the member list don't sync with it (03 §9, 04 §6.3).
- **Does not hold yet.**
  - It can rejoin through any open role invite it saw: removal closes none
    ([#170](https://github.com/leifriksheim/weave/issues/170)).
  - A key change is only a SHOULD, and only a member with `manage` can make
    one. In a space with no manager left, it reads everything new
    ([#170](https://github.com/leifriksheim/weave/issues/170)).
  - Hosts and carriers can't read the member list, so they keep syncing with
    it until the key changes
    ([#170](https://github.com/leifriksheim/weave/issues/170)).
  - A client that never says who it is can reach peers until the key changes
    ([#120](https://github.com/leifriksheim/weave/issues/120)).
  - It can keep adding to the history every peer must store and replay
    ([#161](https://github.com/leifriksheim/weave/issues/161)).
  - Its removal withdraws what it wrote before, unless the remover's node held
    it and kept it ([#166](https://github.com/leifriksheim/weave/issues/166)).

_Source: 03 §5.1, §6.3, §9; 04 §6.3. Tests: `packages/core/tests/space-access.test.ts`, `packages/core/tests/key-change.test.ts`, `packages/core/tests/attacks.test.ts`._

### 3.4 Key thief

- **Holds.**
  - Signing alongside the owner forks the key's log. Once proven, the
    ordinary records the key signed from the proven place on stop counting
    (02 §4.10, 03 §6.5).
  - Once the owner revokes the key's note in a space, the ordinary records
    the key signed there stop counting, unless kept (03 §6.4).
- **Does not hold yet.**
  - Neither a revoke nor a fork proof stops its **access changes**: it can
    still add members, change roles or change the key
    ([#167](https://github.com/leifriksheim/weave/issues/167)).
  - It can revoke the owner's other notes first, with an empty `keep`, and the
    first revoke wins ([#168](https://github.com/leifriksheim/weave/issues/168)).
  - A fork it makes at the start of the key's log withdraws everything the
    owner's device wrote ([#166](https://github.com/leifriksheim/weave/issues/166)).
  - It can keep signing versions dated inside the note's old validity window,
    and a revocation does not reach spaces created after it
    ([#165](https://github.com/leifriksheim/weave/issues/165)).

_Source: 02 §4.10; 03 §6.4, §6.5. Tests: `packages/core/tests/writer-logs.test.ts`, `packages/core/tests/space-access.test.ts`._

### 3.5 Root thief

- **Does not hold.** The seed is the account. Whoever holds it:
  - is the account for good: there is no rotation and no recovery
    ([#9](https://github.com/leifriksheim/weave/issues/9));
  - controls every space where the account ranks highest, and no member can
    remove it ([#160](https://github.com/leifriksheim/weave/issues/160));
  - derives the vault key, and from it every member key, so it reads every
    private space the account was, is or will be a reader of, and the
    account's data at rest (01 §10, 03 §9.1, 05 §15).

### 3.6 App or agent

- **Holds.** Its writes count only where its note covers them (01 §8, 06 §2).
- **Does not hold yet.**
  - A records-only grant can write the account's `sys.profile` and
    `sys.memberkey`, and so have contact requests and new space keys sealed
    to itself ([#169](https://github.com/leifriksheim/weave/issues/169)).
  - `scope: account` hands over the vault key, and `scope: spaces` member
    keys, neither of which ever rotates. It reads what those keys open after
    its grant expires ([#165](https://github.com/leifriksheim/weave/issues/165),
    [#169](https://github.com/leifriksheim/weave/issues/169)).
  - Everything a key thief can do in §3.4, with its own key: backdating,
    revoking the account's other notes
    ([#165](https://github.com/leifriksheim/weave/issues/165),
    [#168](https://github.com/leifriksheim/weave/issues/168)).

_Source: 01 §8; 06 §2. Tests: `packages/core/tests/auth.test.ts`, `packages/core/tests/agents.test.ts`, `packages/core/tests/ucan.test.ts`._

### 3.7 Relay

- **Holds.** It cannot forge or read what peers send each other: sync and
  live messages are signed and travel end to end over channels the relay only
  introduces (04 §1, §6.2). It can drop and delay.
- **Does not hold yet.**
  - It learns who meets whom: IP addresses, session DIDs and rooms together
    ([#162](https://github.com/leifriksheim/weave/issues/162)).
  - Joiners don't prove they hold their DID's key, so anyone can take a
    victim's place in a room ([#162](https://github.com/leifriksheim/weave/issues/162)).
  - Its door mailbox can be flooded
    ([#23](https://github.com/leifriksheim/weave/issues/23)).

_Source: 04 §1, §6; 07 §5. Tests: `packages/core/tests/signaling.test.ts`, `packages/core/tests/relay-refusal.test.ts`, `packages/core/tests/network-manager.test.ts`._

### 3.8 Host or carrier

- **Holds.**
  - It cannot read the bodies of a private space's stored records without the
    space key (03 §8).
  - It cannot alter or forge what it serves (02 §3).
  - What it holds back from the middle of a writer's line is detectable: each
    version names its place in its writer's line for the collection
    (02 §4.10), and the reference node marks a query whose result has a gap
    incomplete (`packages/core/docs/node.md`).
- **Does not hold yet.**
  - Live messages, such as typing, presence and call signalling, reach it in
    plaintext ([#171](https://github.com/leifriksheim/weave/issues/171)).
  - A host asked for a bot receives a lasting role invite carrying the space
    key ([#171](https://github.com/leifriksheim/weave/issues/171)).
  - A removed carrier keeps proving read until the key changes
    ([#171](https://github.com/leifriksheim/weave/issues/171)).
  - It sees envelopes: authors, collections, record keys, timing, and the
    member list (03 §8.6).
  - It can hold back a writer's newest versions from a node that syncs with
    nobody else: nothing marks a line's end.

_Source: 03 §8; 02 §4.10; 06 §4. Tests: `packages/core/tests/carrier.test.ts`, `packages/core/tests/mirror.test.ts`, `packages/core/tests/sync.test.ts`._

### 3.9 Network attacker

- **Holds.**
  - Mesh connections are authenticated by both session DIDs, with fresh
    nonces and the channel's fingerprints signed, so a replayed or relayed
    handshake fails (04 §6.2).
  - A connection to a node is authenticated by the node's session DID, and
    bound to an expected node only when its DID is pinned (04 §5.2, §6.1).
  - A node URL must be `wss://`, or `ws://` only to the same machine (04 §5.2).
- **Does not hold yet.**
  - An unpinned connection to a node accepts whichever node answers.
  - Group keys give no forward secrecy: whoever later obtains a space key
    reads everything sealed under it and every earlier key
    ([#24](https://github.com/leifriksheim/weave/issues/24),
    [#164](https://github.com/leifriksheim/weave/issues/164)).

_Source: 04 §5, §6. Tests: `packages/core/tests/ws-transport.test.ts`, `packages/core/tests/connect.test.ts`, `packages/core/tests/remote.test.ts`._

### 3.10 Raised, not yet confirmed

Raised by a review and traced in the spec and code, but not yet run. Each
needs a test that confirms it or rules it out, and then a place above.

- An account that left can still apply a change that takes something away,
  by making it tie with its own leave and choosing its `createdAt` until it
  sorts first (03 §4.3) ([#170](https://github.com/leifriksheim/weave/issues/170)).
- Only the first `a=fingerprint` line of a session description is bound
  (04 §5.1). A relay that adds lines may go unnoticed.

## 4. Non-goals

- **Hiding membership** from those who hold a space. Members, and carriers of
  a space, know who is in it.
- **Anonymity** toward relays and the network.
- **Availability against every peer colluding.** A node that syncs only with
  peers that withhold from it cannot learn what they hold back.
- **Protecting a device that is already compromised** while it runs. Keeping
  keys from being exported is up to each implementation (see
  `packages/core/docs/node.md`).

## 5. Reviewing a change against this page

Every change to the protocol is reviewed adversarially before it merges (see
`CLAUDE.md` and `.claude/agents/protocol-reviewer.md`). This is the one list
of questions. For each adversary in §2, the review asks:

1. **What's new.** What can it now do that it could not before? Can it reach
   a gap in §3, or widen one?
2. **Who writes.** Who may write each new record, field or message, and its
   next version, a delete of it, or a rival to it? Try the person it
   concerns, a stranger, a former member and an app.
3. **Slots.** Is there one record per subject? Can someone fill it first, or
   can the subject replace it?
4. **Unknowns.** What does a peer that doesn't know this kind, rule or field
   do, and can an attacker choose that path to escape a check?
5. **Turned on the honest.** Can a mechanism meant to punish, flag, withdraw
   or prove misconduct be aimed at an honest party, or be made to fire on
   their own honest action?
6. **Every mechanism, every record.** Does every withdrawal (revoke, fork,
   removal, rule change) apply to every kind of record, access changes
   included? Does the new thing respect each of them?
7. **Same account, other key.** What can another key of the same account, or
   an app it granted, do to this one?
8. **Coming back.** Can a removed or revoked party regain what was taken,
   through anything it still holds?
9. **Scope and lifetime.** Does any authority or secret outlive its grant,
   reach spaces created later, or survive a key change?
10. **Peers disagreeing.** Does any verdict depend on a peer's clock, its
    keys, what it holds, or the order things arrived or ran in?
11. **Erasing history.** Does anything make honest versions stop counting?
    Who decides how many, and from what?
12. **Costs.** Can someone make others store, replay, sync or compute without
    bound?
13. **Secrets.** Does a key, seed or secret reach a party that shouldn't hold
    it?
14. **Consistency.** Are every list, table and key format in the spec updated
    where the change touches them, and do they match the code?
15. **This page.** Is every "Holds" claim the change touches still true? Does
    any guarantee or gap change? Then this page changes in the same PR.
