# Draft: constitutions, grants and contracts

Status: the plan, October 2026. Not normative. It replaces
[four ways to say who may do what](authority-models.md) and
[a space's constitution](constitution.md), which led here. Decisions made with
the owner on 2026-10-12 are marked **Decided**; the rest is open.

## In one paragraph

A space is founded with a **constitution**: who the founders are, how
conflicts between people resolve, and what the space starts with. Who may do
what is a set of **grants**, written as UCAN 1.0 delegations, with conditions
in UCAN's policy language. Roles are named bundles of grants that a community
defines. What a group's records _mean_ (a vote passed, a hall of fame, a
balance) is decided by **contracts**: small CEL rules that every device runs
over the same records and gets the same result. No server, no global order,
no blockchain.

## Why this shape

Proven by others, not invented:

- **The constitution** is Matrix's room versions (the rules are fixed in the
  creation event, and the room's ID is its hash) and Holochain's DNA. The
  conflict policy is a named algorithm, as in p2panda's `Resolver` and the
  "decentralised group membership function" of DCGKA (Weidner, Kleppmann
  et al., CCS 2021).
- **Grants** are UCAN 1.0 delegations: a format with a spec, implementations
  and a policy language, used for the account's own keys already.
- **The v1 resolver** is "strong removal", which p2panda ships and Weave's
  replay already does (03 §4); the literature calls it eventually consistent
  access control (Jacob & Hartenstein, CODASPY 2025).
- **Contracts** follow the CALM theorem (Hellerstein): results that only grow
  as records arrive need no coordination. Limits on one person's own
  spending use that person's own line, as Holochain's mutual credit does.

## 1. The constitution

The first record of a space. The space's ID is the hash of it, so it can't be
changed or swapped.

```json
{
  "weave": "constitution/1",
  "name": "Chess club",
  "resolver": "strong-remove/1",
  "top": { "founders": ["did:key:zAlice", "did:key:zBob"] },
  "roles": { "...": "the founding roles, as in §2" },
  "clauses": { "...": "optional, later: what a change of power needs (§5)" }
}
```

- **`top`** (Decided). Who can't be removed:
  - `{"founders": [...]}`, **the default**: the listed people can never be
    removed or demoted. Matrix arrived at this in 2025 after years of admins
    locking each other out.
  - `"none"`: anyone may be removed, so a space can end up with no admin.
    Members keep what their grants allow; nobody can change roles or the key.
    The way out is a successor space (below).
  - Later: a group at the top ("any 3 of these 5"), the first step to
    democracy.
- **`resolver`**: a name from a fixed list in the spec, never code. A peer that
  doesn't know a space's resolver doesn't judge that space. v1 has one:
  `strong-remove/1` (§4).
- **What changes in place, and what can't** (Decided). Roles, grants,
  members and collections change in place, as the rules allow; no migration
  is needed to add a role. The resolver and `top` can't change: to change
  them, a member with the power to starts a **successor space** that names
  the old one, and members move over (Matrix's room upgrade).

## 2. Grants and roles

A grant is a UCAN 1.0 delegation: _who_ may do _what_, on _which_ part of the
space, under _which_ conditions.

```json
{
  "iss": "did:key:zAlice",
  "aud": "role:treasurer",
  "sub": "space:<id>",
  "cmd": "/record/write",
  "pol": [
    ["==", ".collection", "app.ledger"],
    ["<", ".body.amount", 1000]
  ]
}
```

- **Abilities** are command paths: `/record/read`, `/record/write`,
  `/record/delete`, `/collection/define`, `/member/add`, `/member/remove`,
  `/role/assign`, `/key/change`. A grant of `/record` covers everything under
  it.
- **Scope** is the policy: which collections, which records (`creator`), which
  field values. One language, UCAN's, for every condition on a single record.
- **A role** is a named bundle of grants that the space defines (Moderator,
  Treasurer, Referee). Members are granted roles; a role, or a group, can
  itself hold a role, so sub-teams work.
- **Collection rules about people merge into grants** (Decided). Today a
  definition says `delete: can:moderate` and a role holds
  `app.poll/moderate`. After: "Moderator may `/record/delete` in `app.poll`"
  is one grant. Definitions keep only what isn't about people: `creator`
  (whoever made the record), `onePer`, `fixed`, `final`.
- **Who may grant what.** You can only grant what you hold, as UCAN requires
  (attenuation), and assigning roles is itself a grant (`/role/assign`,
  limited by policy to certain roles).

The account's own notes (account to device, app, program) move to UCAN 1.0
at the same time, so there is one delegation format (#19).

## 3. Contracts

A contract decides what a group's records mean: whether a record counts, and
what follows from it. Every device runs it over the same records and gets the
same answer. Contracts are written in a subset of **CEL**, stored as strings
inside the collection definition.

Three kinds of result, and what each needs:

1. **Results that only grow** need nothing more. "5 people reacted 🙂"
   only becomes truer. Someone writes a claim citing the evidence, and
   everyone checks it:

   ```json
   "contract": [{
     "that": "versions(body.reactions).filter(r, r.collection == 'app.reaction' && r.link('on') == link('on') && r.body.emoji == '🙂').map(r, r.author).distinct().size() >= 5",
     "else": "A comment enters the hall of fame with 5 different people's 🙂"
   }]
   ```

2. **Limits on one person's own actions** need that person's own order.
   Mutual credit: each payment names the payer's previous payment and carries
   the running balance; the contract checks
   `balance == previous.balance - amount && balance >= -limit`. Two payments
   naming the same previous payment are a double spend, and neither counts,
   whichever device wrote them. That works across an account's devices,
   because the line is the account's payments, not a device's log.

3. **Results that need one global order** ("the first 10 get a ticket", "the
   highest bid by Friday") are not possible without a witness, a separate
   planned layer. The docs say so plainly.

- **Who judges.** Every reader. A record that breaks its contract is kept and
  synced, and counts for no one (as checks work today). Agreement doesn't need
  peers to refuse it; it needs every reader to run the same contract the same
  way.
- **In the spec** (Decided). Communities must see the same results whichever
  implementation they use, so the contract language returns to the spec: a
  new part, with the CEL conformance suite as its tests. It is renamed from
  "checks" to contracts.
- **A strict subset of CEL.** Every expression Weave accepts means exactly what
  it means in standard CEL. What is left out (protobuf types, timestamps and
  durations, bytes) is listed, with a reason for each. Cost limits stay.

## 4. Resolving conflicts: `strong-remove/1`

What Weave's replay does today, restated over grants:

- A change is judged by the grants its author held as of what it had seen.
- Removing or demoting someone strikes what they did concurrently with it.
- Mutual removals both stand; founders under `top` can't be removed, so a
  space with founders always has someone in charge.
- Revocations and removals carry cutoffs; a second version at a covered place
  is a fork, and is withdrawn.
- Rivals resolve toward less power.

The replay machinery (strikes, cutoffs, `least`, the two-pass cascade) stays.
What goes is numeric ranks, and with them every rank comparison.

## 5. Democracy, later

A constitution clause makes a change of power need a quorum instead of one
person:

```json
"clauses": {
  "/member/remove": { "quorum": { "role": "member", "atLeast": "1/2" } }
}
```

The change cites signed ballots. Every peer counts them against the members
as of the proposal, which the history alone decides, so peers agree, and
members added afterwards don't count. These clauses are enforced by every
peer, since they change who holds power. Whether quorum is a built-in rule
or a constitution contract in CEL is open (§7). Deadlines need witnesses.

## 6. What goes, what stays

| Goes                                              | Stays                                                         |
| ------------------------------------------------- | ------------------------------------------------------------- |
| Numeric ranks and rank comparisons                | The convergent replay (03 §4), cutoffs, forks                 |
| Role permissions `<collection>/<p>` and `can:<p>` | Rules not about people: `creator`, `onePer`, `fixed`, `final` |
| `create`/`edit`/`delete` rules naming people      | Writer logs and fork detection                                |
| UCAN 0.10 notes                                   | Notes, as UCAN 1.0                                            |
| "Checks" in the library docs                      | CEL, as contracts in the spec                                 |
| Fixed role presets in the protocol                | Presets, as constitution templates in the library             |

## 7. Open questions

1. **UCAN 1.0's encoding.** UCAN 1.0 is DAG-CBOR with a varsig envelope; Weave
   is canonical JSON everywhere. Do we carry the bytes as UCAN specifies (and
   implement DAG-CBOR and varsig), or a JSON profile of it (and lose
   interoperability with other UCAN tools)?
2. **Quorum: built-in rule, or a contract?** A built-in `quorum` is simple to
   implement identically. A constitution contract in CEL is more general, but
   puts CEL in what peers enforce.
3. **Headless spaces** (`top: "none"`): what an app shows, and who may start
   the successor space.
4. **Grants on records a member created** (`creator`): a policy on the record's
   first author, or a built-in, as now.
5. **Mutual credit's line across devices**: confirm that a contract-level
   line (payments naming the previous payment) is enough, or whether it needs
   protocol support.

## 8. Plan

Each step is its own PR with an adversarial review.

1. **Examples first.** Write the chess club, a co-op, a company team, the
   hall of fame and mutual credit in this model, as tests against a small
   standalone evaluator. If any can't be expressed simply, revise this draft.
2. **UCAN 1.0** for notes (#19), deciding question 1.
3. **Grants and the resolver.** Prototype `strong-remove/1` over grants, run
   it through the existing convergence and attack suites, then replace ranks
   in 03 and the code.
4. **The constitution record**, with `top`, the resolver name and successor
   spaces.
5. **Contracts in the spec.** The CEL subset as a spec part with its
   conformance suite; checks renamed; the hall of fame and mutual credit as
   tests.
6. **Later: democracy.** Quorum clauses (question 2), then witnesses for
   deadlines.

Related: #19 (UCAN 1.0), #160 (governance), #166 and #175 (witnessing),
#197 (checks), #198 (equal ranks), #201 (simpler roles).
