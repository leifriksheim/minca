# Threat model

What Weave defends, against whom, and where it does not yet. Every part of the
spec answers to this page: a change that weakens a guarantee here, or adds an
adversary's capability, says so, and changes this page in the same PR.

Guarantees are stated as they hold **today**. Where one does not hold yet, the
gap is listed with its issue rather than left out. A guarantee with no issue
against it and no rule in the spec that gives it is a bug in this page.

## 1. What is protected

| Asset               | Meaning                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Integrity**       | A version counts only if its author was allowed to write it, by rules every peer applies the same way        |
| **Convergence**     | Peers that hold the same versions reach the same verdicts and the same state, whatever order they arrived in |
| **Confidentiality** | Only readers of a private space read its records                                                             |
| **Accountability**  | Misconduct by a key is provable to everyone, by evidence nobody has to take on trust                         |
| **Availability**    | A member can sync with the space while one honest peer that holds it can be reached                          |
| **Account control** | Only the account's owner acts as the account                                                                 |
| **History**         | What a member wrote stays readable to those who could read it, unless it was meant to be taken back          |
| **Metadata**        | What each party learns beyond what it needs                                                                  |

## 2. Adversaries

| Adversary            | Holds                                                                                         |
| -------------------- | --------------------------------------------------------------------------------------------- |
| **Stranger**         | Network access; any number of keys and accounts of its own; a space's id if it learns it      |
| **Member**           | A role in the space, its own keys, the space key of a private space; a modified client        |
| **Former member**    | Everything it held while a member: old keys, old space keys, its notes, its copy of the space |
| **Key thief**        | One of an account's delegated keys (session, writer, app or agent key), with its note         |
| **Root thief**       | The account's seed or recovery code                                                           |
| **App or agent**     | A grant from the account: a note, perhaps the vault, contact or member keys (06 §2)           |
| **Relay**            | The signaling traffic of the rooms it serves                                                  |
| **Host or carrier**  | Every version of the spaces it keeps, encrypted where private, and their envelopes            |
| **Network attacker** | Can watch, delay, drop and replay traffic between peers                                       |

Peers are assumed to run arbitrary code. Nothing relies on a peer running the
reference implementation, or any implementation honestly.

## 3. What holds, and what does not yet

### 3.1 Stranger

- **Holds.** It cannot write anything that counts: every version needs a role
  as of its `seen` (03 §5.2). It cannot read a private space without a read key
  (04 §6.3, 03 §8). It cannot forge a version, a note or an invite (02 §3, 01 §7,
  03 §7).
- **Does not hold yet.**
  - Costs it can impose on peers: what it sends must be checked, stored or
    refused, with few limits ([#33](https://github.com/leifriksheim/weave/issues/33)).
  - It can squat a session DID in a relay room, or fill a room
    ([#162](https://github.com/leifriksheim/weave/issues/162)).
  - A leaked role invite lets it join, as often as it likes
    ([#161](https://github.com/leifriksheim/weave/issues/161)).

### 3.2 Member

- **Holds.**
  - It can do only what its role allows, as of what its version says it saw.
    Whatever it claims about what it saw, a change it had not seen that took
    power away takes back what it wrote (03 §5.1, §5.2 step 10).
  - It cannot make the replay disagree between peers: the order is a function
    of the signed history alone (03 §4).
  - A key of its that signs two versions at one place in a log, or breaks a
    line, is proven to everyone (02 §4.10, 03 §6.5). What it signs that no
    honest client would is proof against its account (03 §6.6).
- **Does not hold yet.**
  - Verdicts that depend on a peer's clock, on which keys it holds, or on the
    order it runs checks in
    ([#121](https://github.com/leifriksheim/weave/issues/121),
    [#163](https://github.com/leifriksheim/weave/issues/163)).
  - A change made later can reorder earlier concurrent ones, so a past verdict
    can change: peers converge, but verdicts are not final
    ([#137](https://github.com/leifriksheim/weave/issues/137)).
  - A `seq 0` for someone else's key can take over "creator"
    ([#72](https://github.com/leifriksheim/weave/issues/72)).
  - The top rank answers to no one, and no vote can bind a change to who may
    do what ([#160](https://github.com/leifriksheim/weave/issues/160)).

### 3.3 Former member

- **Holds.**
  - What it writes after its removal does not count, whatever point in the
    history it claims (03 §5.1).
  - It reads nothing written after the space's key changes. Until the key
    changes, peers that know of the removal send it nothing (03 §9, 04 §6.3).
- **Does not hold yet.**
  - It can keep adding to the history every peer must store and replay
    ([#161](https://github.com/leifriksheim/weave/issues/161)).
  - Its removal withdraws what it wrote before, unless the remover's node held
    it and kept it ([#166](https://github.com/leifriksheim/weave/issues/166)).
  - A client that never says who it is can still reach peers until the key
    changes ([#120](https://github.com/leifriksheim/weave/issues/120)).

### 3.4 Key thief

- **Holds.**
  - Signing alongside the owner forks the key's log, which is proven to
    everyone, and what the key signs from there on stops counting (02 §4.10).
  - The owner can revoke the key's note in each space (03 §6.4).
  - A lasting key's private half cannot be extracted from a browser
    (02 §4.10).
- **Does not hold yet.**
  - It can keep signing versions dated inside the note's old validity window
    ([#165](https://github.com/leifriksheim/weave/issues/165)).
  - A revocation does not reach spaces created after it
    ([#165](https://github.com/leifriksheim/weave/issues/165)).
  - A fork it makes at the start of the key's log withdraws everything the
    owner's device wrote ([#166](https://github.com/leifriksheim/weave/issues/166)).

### 3.5 Root thief

- **Does not hold.** The seed is the account. Whoever holds it is the account
  for good: there is no rotation and no recovery
  ([#9](https://github.com/leifriksheim/weave/issues/9)). It controls every
  space where the account ranks highest, and no member can remove it
  ([#160](https://github.com/leifriksheim/weave/issues/160)).

### 3.6 App or agent

- **Holds.** What its note grants, and no more, in the spaces its note names
  (06 §2).
- **Does not hold yet.** An app given `scope: account` receives the vault key,
  which never rotates. It can read every private space the account joins,
  after its grant expires
  ([#165](https://github.com/leifriksheim/weave/issues/165)).

### 3.7 Relay

- **Holds.** It provides liveness only. Everything it relays is signed or
  sealed end to end, so it can drop and delay traffic, but cannot forge or read
  it (04 §1, §6).
- **Does not hold yet.** It learns who meets whom: IP addresses, session DIDs
  and rooms together ([#162](https://github.com/leifriksheim/weave/issues/162)).

### 3.8 Host or carrier

- **Holds.** It cannot read a private space it carries without the space key
  (03 §8). It cannot alter or forge what it serves. What it holds back from the
  middle of a writer's line shows as missing at a node holding part of the
  space (05 §9).
- **Does not hold yet.**
  - It sees envelopes: authors, collections, record keys, timing, and the
    member list (03 §8.6).
  - It can hold back a writer's newest versions from a node that syncs with
    nobody else (05 §9).

### 3.9 Network attacker

- **Holds.** Connections are authenticated at both ends (04 §6). A pinned node
  URL rejects any other node (04 §5.2). Plain `ws://` is refused except to the
  same machine. Replayed handshakes fail, since nonces and both identities are
  signed.
- **Does not hold yet.** Group keys give no forward secrecy: whoever later
  obtains a space key reads everything sealed under it and every earlier key
  ([#24](https://github.com/leifriksheim/weave/issues/24),
  [#164](https://github.com/leifriksheim/weave/issues/164)).

## 4. Non-goals

- **Hiding membership** from those who hold a space. Members, and carriers of
  a space, know who is in it.
- **Anonymity** toward relays and the network.
- **Availability against every peer colluding.** A node that syncs only with
  peers that withhold from it cannot learn what they hold back.
- **Protecting a device that is already compromised** while it runs. A lasting
  key can be used by malware while it is present, but not taken away.

## 5. Reviewing a change against this page

Every change to the protocol is reviewed adversarially before it merges (see
`CLAUDE.md`). The review asks, for each adversary in §2:

1. What can it now do that it could not before? Can it reach a gap in §3, or
   widen one?
2. Who may write each new record or field, and its next version? What happens
   when the writer is the person it concerns, or a stranger?
3. Does any new verdict depend on a peer's clock, its keys, what it holds, or
   the order things arrived or ran in?
4. Does a new mechanism meant to punish misconduct let someone turn it against
   an honest party?
5. Does anything erase, freeze or withdraw honest history, and who chooses how
   much?
6. Are every list, table and key format in the spec updated where the change
   touches them, and do they match the code?
7. Does any guarantee in §3 change? Then this page changes in the same PR.
