# Threat model

What Weave defends, against whom, and where it does not yet. It is
descriptive: it adds no rules of its own. Every part of the spec answers to
it. A change that weakens a guarantee here, or gives an adversary something
new, says so and changes this page in the same PR.

Guarantees are stated as they hold **today**, and each names the spec
sections that give it and the tests that show a peer refusing the attack. A
"Holds" claim with no such test is a claim nobody has checked: either write
the test or move the claim to "Does not hold yet". Where a guarantee does not
hold, the gap is listed with its issue rather than left out, and the issue
links back here.

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

§3 goes by adversary. History is threatened mostly through removals, revokes
and fork proofs (§3.2 to §3.4, [#166](https://github.com/leifriksheim/weave/issues/166)),
and metadata through relays and hosts (§3.7, §3.8).

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
  - Without an invite secret, nothing it signs in a space counts: a version
    needs a role as of its `seen` (03 §5.2), and its access changes are never
    applied (03 §4.4, §4.5).
  - It cannot forge a version, a note or an invite (02 §3, 01 §7, 03 §7).
- **Does not hold yet.**
  - A leaked view-only invite carries the space key, can't be closed, and
    never causes a key change, so whoever holds it reads everything new
    ([#172](https://github.com/leifriksheim/weave/issues/172)).
  - A leaked role invite lets it join, as often as it likes ([#161](https://github.com/leifriksheim/weave/issues/161)).
  - What it sends must be checked, stored or refused, with few limits
    ([#33](https://github.com/leifriksheim/weave/issues/33)). That includes knocks on doors and contact requests (07),
    whose mailbox can be flooded ([#23](https://github.com/leifriksheim/weave/issues/23)).
  - It can squat a session DID in a relay room, or fill a room ([#162](https://github.com/leifriksheim/weave/issues/162)).

_Source: 03 §3.4, §4.4, §5.2; 02 §3; 01 §7. Tests: `packages/core/tests/space-access.test.ts`, `packages/core/tests/space.test.ts` ("a personal space refuses a stranger"), `packages/core/tests/ucan.test.ts`, `packages/core/tests/validation.test.ts`._

### 3.2 Member

- **Holds.**
  - An ordinary record it writes counts only if its role allowed it, as of
    what the version says it saw. Claiming to have seen less does not escape a
    removal or demotion of it it had not seen, nor the rules that change had
    seen: past the change's cutoff, it is judged with them (03 §5.1, §6.3).
  - Peers that hold the same access changes replay them to the same state:
    no order decides anything: whether a change counts follows from what
    saw what, and the same changes give the same result in any arrival order
    (03 §4).
  - What it signs that every peer refuses, and no honest client signs, can
    be shown to every member as proof each checks for itself, judged in the
    offending version's own view: no rival or later change, and no copy with
    another envelope or body, turns an honest write into proof against its
    writer. Warrants are a standard collection, not protocol
    ([warrants](../packages/core/docs/warrants.md)).
- **Does not hold yet.**
  - A narrowed rule alone binds only what saw it: a version naming an older
    point counts if its author could have written it then, since nobody can
    tell it from one written offline. Pairing the narrowing with a demotion
    binds it (03 §5.1).
  - It can make every peer store revokes of keys that never wrote here, and
    other changes it may make, without limit. Revokes are never heads; changes
    it has the power for can outnumber what `seen` holds, and a writer then
    names first heads that saw the latest change to its own place, role and
    collection
    ([#33](https://github.com/leifriksheim/weave/issues/33)).
  - Each warrant costs every member's node a replay of the offending
    version's own view, once; nothing bounds how many warrants a member
    writes, true or false ([#33](https://github.com/leifriksheim/weave/issues/33)).
  - Which changes a peer holds can differ for good, and verdicts depend on a
    peer's keys, or the order it runs checks in ([#163](https://github.com/leifriksheim/weave/issues/163)).
  - A removal or demotion signed offline can arrive at any time and withdraw
    what its cutoff doesn't cover: peers converge, but no verdict is final
    until members witness each other's heads
    ([#166](https://github.com/leifriksheim/weave/issues/166)).
  - Only three kinds of misconduct earn a warrant, and a peer that
    can't read the rules flags no one. More kinds are planned ([#148](https://github.com/leifriksheim/weave/issues/148)).
  - A warrant is withdrawn like any record: an accused who outranks every
    witness removes them with a cutoff below their warrants, and a writer can withdraw their own
    by revoking its key or forking their log ([#168](https://github.com/leifriksheim/weave/issues/168)),
    so their warrants stop counting ([#166](https://github.com/leifriksheim/weave/issues/166)).
  - Fork proofs deter, but don't catch: a fork counts once a member holding
    both versions writes `sys.fork`, and a key can sign where its other branch
    never reaches ([#175](https://github.com/leifriksheim/weave/issues/175)) _(traced)_.
  - It can disown its own history, withdrawing votes and agreements others
    relied on, by revoking its own key with a cutoff of 0, or forking its
    own log at 0, and nothing flags it ([#168](https://github.com/leifriksheim/weave/issues/168)).
  - A `seq 0` for someone else's key can take over "creator" ([#72](https://github.com/leifriksheim/weave/issues/72)).
  - A collection's checks bind only readers that judge them: peers keep and
    sync a version that fails them, and only the library leaves it out of
    what it counts, on every read path, along a record's chain, and without
    letting it hold a `onePer` key ([checks](../packages/core/docs/checks.md);
    `packages/core/tests/checks-reads.test.ts`, `checks-squat.test.ts`,
    `checks-pending.test.ts`). Another
    implementation that doesn't judge checks shows it. Every such version
    costs every peer storage, like any record it may write
    ([#33](https://github.com/leifriksheim/weave/issues/33)).
  - The top rank answers to no one, and no vote can bind a change to who may
    do what ([#160](https://github.com/leifriksheim/weave/issues/160)).

_Source: 03 §4, §5; `packages/core/docs/warrants.md`. Tests: `packages/core/tests/rules.test.ts`, `packages/core/tests/roles.test.ts` (a demoted moderator), `packages/core/tests/space-access.test.ts`, `packages/core/tests/access-convergence.test.ts`, `packages/core/tests/warrants.test.ts`._

### 3.3 Former member

- **Holds.**
  - What it writes claiming to have seen its removal does not count, a
    revoke included, since a revoke needs a role. Ordinary records it writes claiming not
    to have seen it are withdrawn, unless the removal's cutoff covers them (03 §5.1, §6.3).
  - A grant it makes concurrently with its removal, or backdates, is struck,
    and gives no power to anything resting on it, whether or not that cites
    the removal (03 §4.3; `packages/core/tests/access-attacks.test.ts`).
- **Does not hold yet.**
  - A change by a sock it granted, though dropped, still strikes changes made
    concurrently by those the sock outranked
    ([#191](https://github.com/leifriksheim/weave/issues/191)).
  - A version it backdates is withdrawn, but a colluding member can still cite
    it as evidence in a version under checks, and the library's checks count
    it, since they judge a cited version as of what the citer saw
    ([#184](https://github.com/leifriksheim/weave/issues/184),
    [checks](../packages/core/docs/checks.md#citing-a-version)). Checks are
    not protocol, so this is a gap in what readers count, not in what peers
    store.
  - It can rejoin through any open role invite it saw: removal closes none
    ([#170](https://github.com/leifriksheim/weave/issues/170)) _(traced)_.
  - A key change is only a SHOULD, and only a member with `manage` can make
    one. In a space with no manager left, it reads everything new
    ([#170](https://github.com/leifriksheim/weave/issues/170)) _(traced)_.
  - Hosts and carriers can't read the member list, so they keep syncing with
    it until the key changes ([#170](https://github.com/leifriksheim/weave/issues/170)) _(traced)_. A peer that never says who it is
    is never let go ([#173](https://github.com/leifriksheim/weave/issues/173)).
  - A key change made at the same moment as its removal is boxed to it. The
    change stays due, so the next key leaves it out, but until then it reads
    ([#173](https://github.com/leifriksheim/weave/issues/173)).
  - It can keep adding to the history every peer must store and replay
    ([#161](https://github.com/leifriksheim/weave/issues/161)).
  - Its removal withdraws what it wrote before that the removal's cutoff
    doesn't cover: the remover's node covers only the lines it holds unbroken,
    in the collections it holds, up to 1024 places (03 §6.3) ([#166](https://github.com/leifriksheim/weave/issues/166)).

_Source: 03 §5.1, §6.3, §9; 04 §6.3. Tests: `packages/core/tests/space-access.test.ts` ("a removed member cannot write"), `packages/core/tests/roles.test.ts`, `packages/core/tests/key-change.test.ts`._

### 3.4 Key thief

- **Holds.**
  - Once a fork of the key's log is proven, what it signed from the proven
    place on stops counting, records and changes to who may do what alike
    (02 §4.10, 03 §4.3, §6.5).
  - Once the owner revokes the key, what it signed past what the owner had
    seen of it stops counting, records and changes to who may do what alike, under every note to that key. A
    revoke the thief writes first, covering what it signed in advance, doesn't
    shield it: every revoke applies (03 §6.4).
- **Does not hold yet.**
  - It can revoke the owner's other keys, with a cutoff of its choosing: a key
    whose note grants `*` is the account while it lasts
    ([#168](https://github.com/leifriksheim/weave/issues/168)).
  - It decides whether it forks the owner's line at all ([#175](https://github.com/leifriksheim/weave/issues/175)) _(traced)_. And a fork
    it makes at the start of the line withdraws everything the owner's device
    wrote ([#166](https://github.com/leifriksheim/weave/issues/166)).
  - Records are judged with no time, so what it signs counts until the owner
    revokes the key, however long ago its note ran out; only live use (knocks,
    live messages, connecting) ends with the note (01 §7.4). Signing out
    writes a revoke of the session key, delivered when that device next
    syncs, but a device lost while signed in has to be
    revoked from another device, which needs a list of the account's session
    keys ([#26](https://github.com/leifriksheim/weave/issues/26)). A revocation does not reach spaces created after it
    ([#165](https://github.com/leifriksheim/weave/issues/165)).

_Source: 02 §4.10; 03 §6.4, §6.5. Tests: `packages/core/tests/writer-logs.test.ts`, `packages/core/tests/space-access.test.ts` ("a revoked note…"), `packages/core/tests/roles.test.ts` ("a revoked key…")._

### 3.5 Root thief

- **Does not hold.** The seed is the account. Whoever holds it:
  - is the account for good: there is no rotation and no recovery ([#9](https://github.com/leifriksheim/weave/issues/9));
  - controls every space where the account ranks highest, and no member can
    remove it ([#160](https://github.com/leifriksheim/weave/issues/160));
  - derives the vault key, and from it every member key, so it reads every
    private space the account was, is or will be a reader of, and the
    account's data at rest (01 §10, 03 §9.1, 05 §15).

### 3.6 App or agent

- **Holds.** Its writes count only where its note covers them, and a home
  grants an app only the spaces chosen for it (01 §8, 06 §2). It can be given
  a note only for a key it shows it holds, never the home's own or another
  connection's, so disconnecting it revokes nobody else (06 §2.5).
- **Does not hold yet.**
  - A records-only grant can write the account's `sys.profile`, and so have
    contact requests sealed to itself; and `sys.memberkey`, to have new space
    keys sealed to itself _(traced)_ ([#169](https://github.com/leifriksheim/weave/issues/169)).
  - `scope: account` hands over the vault key, and `scope: spaces` member
    keys, neither of which ever rotates. It reads what those keys open after
    its grant expires ([#165](https://github.com/leifriksheim/weave/issues/165), [#169](https://github.com/leifriksheim/weave/issues/169)).
  - Any key the account granted can pose as the account's node to a client
    that pinned the account ([#177](https://github.com/leifriksheim/weave/issues/177)) _(traced)_.
  - Its records count until its key is revoked, not until `expiresAt`: only
    the home that granted it revokes it, while signed in there (06 §2.9,
    [#26](https://github.com/leifriksheim/weave/issues/26)).
  - Everything a key thief can do in §3.4, with its own key ([#165](https://github.com/leifriksheim/weave/issues/165),
    [#168](https://github.com/leifriksheim/weave/issues/168)).

_Source: 01 §8; 06 §2. Tests: `packages/core/tests/connect.test.ts`, `packages/core/tests/agents.test.ts`, `packages/core/tests/ucan.test.ts`._

### 3.7 Relay

- **Holds.** Nothing a test shows yet. It can always drop and delay.
- **Does not hold yet.**
  - That it can't answer in peers' place: they talk over DTLS channels whose
    fingerprints both sign in the mesh proof (04 §5.1, §6.2), so a relay that
    answers for one should fail the proof. No test shows it ([#181](https://github.com/leifriksheim/weave/issues/181)).
  - It learns who meets whom: IP addresses, session DIDs and rooms together
    ([#162](https://github.com/leifriksheim/weave/issues/162)).
  - Joiners don't prove they hold their DID's key, so anyone can take a
    victim's place in a room ([#162](https://github.com/leifriksheim/weave/issues/162)).
  - Its door mailbox can be flooded ([#23](https://github.com/leifriksheim/weave/issues/23)).

_Source: 04 §1, §5.1, §6.2; 07 §5. Tests: `packages/core/tests/signaling.test.ts`, `packages/core/tests/relay-refusal.test.ts`._

### 3.8 Host or carrier

- **Holds.**
  - It cannot read the bodies of a private space's records outside the
    collections 03 §8.2 keeps in the clear, without the space key.
  - It cannot alter or forge what it serves (02 §3).
- **Does not hold yet.**
  - Live messages, such as typing, presence and call signalling, reach it in
    plaintext ([#171](https://github.com/leifriksheim/weave/issues/171)) _(traced)_.
  - A host asked for a bot receives a lasting role invite carrying the space
    key ([#171](https://github.com/leifriksheim/weave/issues/171)) _(traced)_.
  - A removed carrier keeps proving read until the key changes ([#171](https://github.com/leifriksheim/weave/issues/171)) _(traced)_.
  - It sees envelopes: authors, collections, record keys, timing, and the
    member list. `onePer` keys hash body fields, so it can guess low-entropy
    values such as votes (03 §8.6).
  - It can hold back what it likes from a node that syncs with nobody else.
    Only a node holding part of a space notices a gap, and only in ordinary
    collections ([#176](https://github.com/leifriksheim/weave/issues/176)) _(traced)_.

_Source: 03 §8; 02 §3; 06 §4. Tests: `packages/core/tests/carrier.test.ts`, `packages/core/tests/caches.test.ts`, `packages/core/tests/sync.test.ts`._

### 3.9 Network attacker

- **Holds.**
  - A connection to a node is authenticated by the node's session DID, and
    bound to an expected node when its DID or account is pinned: a node
    answering in its own name at a pinned address is refused (04 §5.2, §6.1).
    Nothing binds the handshake to the connection, so one that relays the
    real node's handshake is kept out only by TLS.
  - A node URL must be `wss://`, or `ws://` only to the same machine (04 §5.2).
- **Does not hold yet.**
  - An unpinned connection to a node accepts whichever node answers, and an
    account pin accepts any key the account granted ([#177](https://github.com/leifriksheim/weave/issues/177)) _(traced)_.
  - Group keys give no forward secrecy: whoever later obtains a space key
    reads everything sealed under it and every earlier key ([#182](https://github.com/leifriksheim/weave/issues/182)).

_Source: 04 §5, §6.1. Tests: `packages/core/tests/ws-transport.test.ts`._

### 3.10 Raised, not yet confirmed

Gaps above marked _(traced)_ were found by reading the spec and the code,
not by running them; each needs a test that confirms it. What follows was
raised but has no place above until a test confirms or rules it out.

- Only the first `a=fingerprint` line of a session description is bound
  (04 §5.1). With node-datachannel an added line fails DTLS, which a probe
  confirmed; browsers are untested.

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
