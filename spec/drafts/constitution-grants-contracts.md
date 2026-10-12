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

The language was chosen by writing five communities in two candidates, CEL
and Datalog ([the comparison](contracts-comparison.md)). **Decided**
(2026-10-12): contracts are CEL; grants are UCAN 1.0 delegations with
standard UCAN policies and no extension; Datalog is parked, as a possible
query layer in the library later, never protocol. The five communities are
now Weave's scenario suite, in `scenarios/`.

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
space, under _which_ conditions (**Decided**). Conditions are standard UCAN
policies, with no extension: a policy compares one invocation's arguments
with literals, and nothing else.

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

- **Abilities** are command paths (the table below). A grant of `/record`
  covers everything under it.
- **Scope** is the policy: which collections, whose records, which field
  values. One language, UCAN's, for every condition on a single invocation.
- **A role** is a named bundle of grants that the space defines (Moderator,
  Treasurer, Referee). Members are assigned roles; a role can itself be
  assigned a role, so a sub-team is a role holding its parent team's role,
  and its members hold both through the delegation chain.
- **Collection rules about people merge into grants** (Decided). Today a
  definition says `delete: can:moderate` and a role holds
  `app.poll/moderate`. After: "Moderator may `/record/delete` in `app.poll`"
  is one grant, and "the creator may delete" is a policy on `.byCreator`.
  Definitions keep only what isn't about people: `onePer`, `fixed`, `final`.

### What each command's policy sees

"Who" in a policy needs no extension to UCAN (**Decided**). Each command
defines the arguments the host fills in before a policy runs, and those
include the few facts about the invoker a policy needs, as booleans. A
policy reads only these; a selector naming anything else finds nothing, and
the policy fails.

| Command              | Arguments                         | Filled in from                                                                                                          |
| -------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `/record/read`       | `collection`                      | The collection read                                                                                                     |
| `/record/write`      | `collection`, `byCreator`, `body` | `byCreator`: whether the writer's account made the record's first version (true for a new record); `body`: the new body |
| `/record/delete`     | `collection`, `byCreator`         | As for `/record/write`                                                                                                  |
| `/collection/define` | `collection`                      | The collection defined                                                                                                  |
| `/member/add`        | (none)                            |                                                                                                                         |
| `/member/remove`     | `self`                            | Whether the member removed is the invoker (leaving)                                                                     |
| `/role/define`       | `role`                            | The role whose grants are written                                                                                       |
| `/role/assign`       | `role`, `self`                    | `self`: whether the assignee is the invoker's account (false when the assignee is a role)                               |
| `/role/unassign`     | `role`, `self`                    | As for `/role/assign`                                                                                                   |
| `/key/change`        | (none)                            |                                                                                                                         |

So:

- "Members may delete their own moves" is
  `{ cmd: "/record/delete", pol: [["==", ".collection", "app.chess"], ["==", ".byCreator", true]] }`.
- "Admins assign Treasurer, not to themselves" is
  `{ cmd: "/role/assign", pol: [["==", ".role", "treasurer"], ["==", ".self", false]] }`.
- "Members may leave" is `{ cmd: "/member/remove", pol: [["==", ".self", true]] }`.

`byCreator` compares accounts, not devices: any device of the creator's
account counts. When the record's first version isn't held, the invocation
waits, as anything missing does. `self` doesn't close a second account of
the invoker's own: an admin who may assign `hr` can assign it to an account
she also controls. No language closes that; "manages hr but can't read it"
holds only if someone else manages hr's membership (the company scenario
says so).

### Assigning a role is not granting

A role's grants come from the space: the founding roles in the
constitution, and later roles written by whoever holds `/role/define`. A
role definition is a set of delegations whose issuer is the definer, so it
holds only what the definer holds, as UCAN's attenuation requires; the
constitution's roles are issued by the space itself, the root of every
chain.

Assigning someone to a role is the command `/role/assign`, an invocation,
not a delegation. It gives the assignee nothing the role didn't already
have, so the assigner needn't hold the role's grants, only `/role/assign`
for that role. A policy limits which roles may be handed out (and, with
`.self`, to whom). That keeps UCAN's rule that you can only grant what you
hold: the grants were delegated once, by the role's definer; assignments
only say who is in the role.

A peer judging an action checks both: the assignment (its author held
`/role/assign` with a policy the arguments meet, as of what it had seen),
and the role's delegations (each issuer held what it delegated, back to the
space).

The account's own notes (account to device, app, program) move to UCAN 1.0
at the same time, so there is one delegation format (#19).

## 3. Contracts

A contract decides what a group's records mean: whether a record counts, and
what follows from it. Every device runs it over the same records and gets the
same answer. Contracts are written in a subset of **CEL** (**Decided**),
stored as strings inside the collection definition.

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

   **A cited version must be current** as of what the claim had seen: if the
   claim's past holds a later version of a record it cites, the citation is
   refused and the contract fails. Without this, a claim that had seen a
   reaction withdrawn could cite the version before the withdrawal and still
   pass (the hall of fame's gap in the comparison, §2.4). Every reader
   checks it from the claim's own past, so it is fixed by the claim like the
   rest. A later version the claim hadn't seen doesn't matter: results that
   only grow stay true.

2. **Limits on one person's own actions** need that person's own order.
   Mutual credit: each payment names the payer's previous payment and carries
   the running balance; the contract checks
   `balance == previous.balance - amount && balance >= -limit`. That works
   across an account's devices, because the line is the account's payments,
   not a device's log.

   **Double spends are a built-in rule**, not a contract. A collection
   definition declares itself a line (`"line": true`): every record in it is
   one account's sequence. Two versions of a line naming the same previous
   one (or two first versions) are a double spend: neither counts, nor
   anything after either, whichever devices wrote them. CEL can't express
   this, since a version never cites its twin, so every reader applies it
   while judging the chain, as it already requires the whole line before a
   version counts. It is not fixed by citation: a payment counts until its
   twin arrives (the comparison, §2.5). A payee who waits before building on
   a payment, or a witness, is the only cure.

   **Claiming each payment once.** The prototype carries every claim so far
   in `body.claimed`, a list that grows with the account and is re-read on
   every payment. Instead, the line declaration names the fields whose
   citations may appear only once along the line
   (`"line": { "once": ["received"] }`). The reader already holds the whole
   line, so it checks this with an index, and the body carries nothing extra.
   Where a rule must stay in CEL, a watermark per payer (the highest `seq`
   claimed from each, claimed in order) is bounded by the number of
   counterparties instead of payments.

   **`sum` of an empty list.** Today `sum([])` is the int `0`, and an int
   plus a double is an error, so a payment that claims nothing fails unless
   the sum is padded with `[0.0]`. Every number read from a body is a double.
   `sum` is Weave's function, not CEL's, so it can change: `sum(l, zero)`
   adds onto `zero`, whose type is the result's, and `sum([])` with one
   argument is an error rather than a guess.

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
members added afterwards don't count. The count comes from the replay of
the proposal's past, never from a list the proposer writes (**Decided**):
in the comparison's co-op the proposer listed the members and a contract
checked the list, which works only while the check is perfect. A contract
that counts reads the same thing through two functions on a cited version:
`memberCountAt(p)`, the number of members as of `p`'s `seen`, and
`memberAt(p, did)`. A ballot counts when its author is a member as of the
proposal. These clauses are enforced by every
peer, since they change who holds power. Whether quorum is a built-in rule
or a constitution contract in CEL is open (§7). Deadlines need witnesses.

## 6. What goes, what stays

| Goes                                              | Stays                                              |
| ------------------------------------------------- | -------------------------------------------------- |
| Numeric ranks and rank comparisons                | The convergent replay (03 §4), cutoffs, forks      |
| Role permissions `<collection>/<p>` and `can:<p>` | Rules not about people: `onePer`, `fixed`, `final` |
| `create`/`edit`/`delete` rules naming people      | Writer logs and fork detection                     |
| UCAN 0.10 notes                                   | Notes, as UCAN 1.0                                 |
| "Checks" in the library docs                      | CEL, as contracts in the spec                      |
| Fixed role presets in the protocol                | Presets, as constitution templates in the library  |
| The `creator` rule in definitions                 | "Only the creator", as `.byCreator` in a policy    |
| `body.claimed`-style running lists in contracts   | The line rule, with `once` fields                  |
| Datalog (the comparison's prototype)              | Parked, as a possible library query layer          |

## 7. Open questions

Resolved on 2026-10-12, kept for the record:

- ~~**Grants on records a member created**~~: a policy on `.byCreator`, an
  argument the host fills in (§2). No built-in.
- ~~**Mutual credit's line across devices**~~: a built-in line rule (§3),
  over the account's line, not a device's log.
- ~~**"Not to yourself"**~~ (from the comparison): a policy on `.self` (§2).
- ~~**How `/role/assign` relates to attenuation**~~ (from the comparison):
  assigning is not granting (§2).
- ~~**Datalog for grants or contracts**~~: neither; parked as a library query
  layer.

Open:

1. **UCAN 1.0's encoding.** UCAN 1.0 is DAG-CBOR with a varsig envelope; Weave
   is canonical JSON everywhere. Do we carry the bytes as UCAN specifies (and
   implement DAG-CBOR and varsig), or a JSON profile of it (and lose
   interoperability with other UCAN tools)?
2. **Quorum: built-in rule, or a contract?** A built-in `quorum` is simple to
   implement identically. A constitution contract in CEL is more general, but
   puts CEL in what peers enforce. Either way the count comes from the
   history as of the proposal (§5); `memberCountAt` and `memberAt` are what a
   contract would need.
3. **Headless spaces** (`top: "none"`): what an app shows, and who may start
   the successor space.
4. **A role's definer loses power.** A role's grants are delegations from its
   definer (§2). When the definer is removed or demoted, does the role lose
   those grants (UCAN's chain says yes, and `strong-remove/1` strikes what
   depended on it concurrently), or do founding roles and later roles
   differ? Every member of the role loses them at once, so apps need to show
   it.
5. **Unassigning.** Is taking a role away its own command
   (`/role/unassign`, as in the table), or `/role/assign` with a flag, and
   may a member always leave a role on their own (`self: true`)?
6. **"Current" with concurrent versions.** A cited version must be current as
   of the claim's past (§3). If that past holds two rival versions of the
   record, which is current: the record's own conflict rule, or must the
   claim cite the winner of it?
7. **`sum`'s shape.** `sum(l, zero)` with `sum([])` an error, or `sum([])`
   as `0.0` because body numbers are doubles. The first is explicit; the
   second keeps one form but makes the type depend on emptiness for ints.
8. **`once` along a line, or a watermark.** The built-in `once` fields need
   a reader to index every citation along a line it already holds; the
   watermark stays in CEL but makes payees claim in order. Which, and is
   `once` worth having outside lines?

## 8. Plan

Each step is its own PR with an adversarial review.

1. **Examples first** (done). The chess club, a co-op, a company team, the
   hall of fame and mutual credit, in CEL and in Datalog
   ([the comparison](contracts-comparison.md)). They are now Weave's
   scenario suite (`scenarios/`), run with `npm run scenarios`; the
   evaluators there are stand-ins until they point at the library.
2. **UCAN 1.0** for notes (#19), deciding question 1.
3. **Grants and the resolver.** Prototype `strong-remove/1` over grants, run
   it through the existing convergence and attack suites, then replace ranks
   in 03 and the code. The command arguments (§2) land here, and the
   scenarios move to the real library's grants.
4. **The constitution record**, with `top`, the resolver name and successor
   spaces.
5. **Contracts in the spec.** The CEL subset as a spec part with its
   conformance suite; checks renamed; cited versions current; the line rule
   with `once`; `sum` fixed; the hall of fame and mutual credit scenarios
   against the real library.
6. **Later: democracy.** Quorum clauses (question 2), counted from the
   history, then witnesses for deadlines.

Related: #19 (UCAN 1.0), #160 (governance), #166 and #175 (witnessing),
#197 (checks), #198 (equal ranks), #201 (simpler roles).
