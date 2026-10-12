# Draft: constitutions, grants and contracts

Status: the plan, October 2026. Not normative. It replaces
[four ways to say who may do what](authority-models.md) and
[a space's constitution](constitution.md), which led here. Decisions made with
the owner on 2026-10-12 are marked **Decided**; the rest is open. An
adversarial review of the plan on 2026-10-12 found flaws; its fixes are
adopted below, and each attack it showed is a scenario test in `scenarios/`
that shows it refused, or a skipped test naming what it waits for. A second,
narrower review the same day found that delegations to accounts outlived
their issuer; the fix (only roles hold grants, §2) and its other findings
are adopted too. A third review's fixes (rival definitions as an
intersection, scoped strikes, removal against re-add, closed line keys)
are adopted (scoped strikes later replaced, §4), and corrections in a line are deferred from v1 (§3); so is
the fourth's (every role grant but the constitution's lives inside a
definition). Their attempts to stop a definer parking power in a role she
keeps (a `mine` argument, then nest-only permissions) each opened a new
hole, and are **dropped** (Decided, 2026-10-12): under the owner's
principle of no more security than ordinary apps, whoever may define
roles is trusted to, as in Discord or Slack (§2). Grants and the resolver
(step 4), the constitution (step 5) and contracts (step 6) are built, and
their text has moved into the specification (§1, §2, §3, §4); what is left
here is the rest of the plan: democracy and quorum, corrections in a line,
and witnesses.

## In one paragraph

A space is founded with a **constitution**: who the founders are, how
conflicts between people resolve, and what the space starts with. Who may do
what is a set of **grants**, written as UCAN-shaped delegations (a JSON
profile of UCAN 1.0), with conditions in UCAN's policy language. Roles are
named bundles of grants that a community defines. What a group's records
_mean_ (a vote passed, a hall of fame, a balance) is decided by
**contracts**: small CEL rules that every device runs over the same records
and gets the same result. No server, no global order, no blockchain.

The language was chosen by writing five communities in two candidates, CEL
and Datalog ([the comparison](contracts-comparison.md)). **Decided**
(2026-10-12): contracts are CEL; grants are UCAN-shaped delegations with
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
- **Grants** take UCAN 1.0's fields, policy language and semantics: a format
  with a spec, implementations and a policy language, used for the account's
  own keys already.
- **The v1 resolver** is "strong removal", which p2panda ships and Weave's
  replay already does (03 §4); the literature calls it eventually consistent
  access control (Jacob & Hartenstein, CODASPY 2025).
- **Contracts** follow the CALM theorem (Hellerstein): results that only grow
  as records arrive need no coordination. Limits on one person's own
  spending use that person's own line, as Holochain's mutual credit does.

## 1. The constitution

**Built** (step 5, October 2026): now the specification, in
[03 §1](../03-spaces.md#1-the-space-and-its-id) (the constitution, its
format and id, and a constitution a peer can't read, which it doesn't
judge), [§2.1](../03-spaces.md#21-the-top-founders-and-founding-roles)
(`top`, founders, `top: "none"`, headless spaces),
[§2.5](../03-spaces.md#25-assignments-and-removals) (stepping down),
[§2.7](../03-spaces.md#27-successor-spaces) (successor spaces) and §4 (the
replay). The library's side, presets as constitution templates, stepping
down, successors and what an app shows, is in
[the library's docs](../../packages/core/docs/spaces.md#presets). Its
threat-model changes are in [the threat model](../threat-model.md) §3.1,
§3.2 and §3.5.

What step 5 settled at implementation, each with a test
(`packages/core/tests/constitution.test.ts`):

- **Stepping down** is offered both ways: leaving (`sys.remove` of oneself)
  and staying without founder status (`sys.stepdown`). Stepping down is a
  reduction, so founder power used afterwards by naming an older view is
  struck.
- **Several founders are equals**: none can remove, demote or step down
  another; what each does to others resolves as anyone's does.
- **`top: "none"`**: the constitution assigns the creator its roles
  (`assigned`), and those assignments end like any other.
- **Who may run `/space/succeed`**: a founder, a role granted it, or any
  member where no member holds it. A succeed carries only the successor's
  id; every one stands, and none replaces another.
- **The name** is part of the constitution, so part of the id.
- **The co-op template** (`coop`) is `top: "none"`, with stewards whom
  nobody may define.

Still open, later:

- **A group at the top** ("any 3 of these 5"), the first step to democracy
  (§5).
- **Who may run `/space/succeed`** where no one holds it: any member now, a
  quorum (§5) once there is one.

## 2. Grants and roles

**Built** (step 4, October 2026): now the specification, in
[03 §2](../03-spaces.md#2-roles-and-grants) (grants, their format, the
commands and their arguments, definitions, rivals, assignments and removals,
what definers are trusted with) and [02 §7](../02-records.md#7-rules) (rules
keep only what isn't about people). Its threat-model changes are in
[the threat model](../threat-model.md) §3.2–§3.5. What the reviews found is
tested against the real library: `packages/core/tests/roles.test.ts`,
`packages/core/tests/access-attacks.test.ts` ("attacks on grants") and the
scenarios (`scenarios/tests/chess.test.ts`, `company.test.ts`), which ask the
library through `scenarios/host/library.ts`.

What step 4 settled at implementation, each with a test:

- **Policies on `.body` a peer can't read**: left to readers (03 §2.2), as
  `onePer` and `fixed` are.
- **Int against float equality**: one JSON number, one value (03 §2.2).
- **Whether membership is a role**: it is. There is no `/member/add`: an
  account is a member once a role is assigned to it, by `/role/assign` or an
  invite (03 §2.5).
- **The default policy for `/record/write`**: the library's templates say
  explicitly whether members may change each other's records
  (`packages/core/src/space/presets.ts`).

Still open: an argument that tells a new record from an edit (03 §17).

## 3. Contracts

Built in step 6: contracts, their CEL subset, citations, verdicts and the
line rule are now [09 — Contracts](../09-contracts.md). What is left here is
later work:

- **Corrections in a line** (09 §7.5, Planned). The starting point is the
  narrow trigger: a correction is allowed after the payee's last counted
  version only when a version it cites is one of a double-spent pair, a
  structural check with no second run of the contract. The second review's
  rule stays: a correction restates the failed versions' outgoing payments
  in order, dropping only the failed citations, so it can't unpay anyone.
  The third review found that a broad trigger ("would pass if what it cited
  stood") let a correction revive a version that failed for its own
  reasons, and that a payee restating can't claim the correction that
  repaid them. A restart record for an honest account's forked devices
  belongs to the same later work.
- **Results that need one global order** ("the first 10 get a ticket", "the
  highest bid by Friday") need a witness, a separate planned layer (§5).

## 4. Resolving conflicts: `strong-remove/1`

**Built** (step 4): now the specification, in
[03 §4](../03-spaces.md#4-replaying-the-access-history-strong-remove1) and
§5. The convergent replay stays; ranks go; a removal or an unassignment
strikes everything its account did concurrently. (An unassignment first
struck only what needed the role; a review showed a demoted member could
hide the need by backdating, since the need was judged in a view she
chose, so it strikes all of it now.) A record counts only the changes of
its own view that stand, and a join is judged as its invite's opener's
assignment.

## 5. Democracy, later

A constitution clause makes a change of power need a quorum instead of one
person:

```json
"clauses": {
  "/member/remove": { "quorum": { "role": "member", "atLeast": "1/2" } }
}
```

The change cites signed ballots. The count comes from the replay of the
history, never from a list the proposer writes (**Decided**): in the
comparison's co-op the proposer listed the members and a contract checked
the list, which works only while the check is perfect. These clauses are
enforced by every peer, since they change who holds power. Whether quorum
is a built-in rule or a constitution contract in CEL is open (§7). Deadlines
need witnesses.

**Requirements**, from the review. The co-op scenario's padding and
backdating attacks are skipped tests labelled "needs quorum" until these
land:

- **Clauses are keyed by command plus policy**, not command only. A clause
  on `/member/remove` alone leaves membership growth free: one member adds
  three accounts of their own, then four of seven vote someone out. So a
  clause can cover `/role/assign` with `role: member` (or `/member/add`),
  and whatever a quorum guards, the growth of its electorate falls under a
  clause too.
- **The electorate** is counted as of the proposal **plus every member
  addition that any cited ballot or the enacting change had seen**. "As of
  the proposal" alone can be backdated: a proposal naming an older point,
  with ballots and an enactment that had seen three new members, would
  count four members instead of seven. A contract that counts reads it
  through `memberCountAt` and `memberAt` over that union, not the proposal's
  view alone.
- **Ballots are unencrypted access records** (`sys.*`), not ordinary
  records: every peer that judges the change must read them, whatever keys
  it holds, and they are judged by the replay like other access events.
- **One rule for removed voters**: a ballot counts when its author is a
  member in the electorate's view (above), whether or not they were removed
  since. Stated once, for every clause.
- **Concurrent proposals that remove each other's sponsors both stand**,
  as mutual removals do (§4). The spec says so; it is not a bug to fix.
- **The remaining gap**, stated plainly: an old majority can still act
  without the members added since its ballots were cast, by voting before
  it sees them. Only witnesses close that.

## 6. What goes, what stays

| Goes                                                 | Stays                                                 |
| ---------------------------------------------------- | ----------------------------------------------------- |
| Numeric ranks and rank comparisons                   | The convergent replay (03 §4), cutoffs, forks         |
| Role permissions `<collection>/<p>` and `can:<p>`    | Rules not about people: `onePer`, `fixed`, `final`    |
| `create`/`edit`/`delete` rules naming people         | Writer logs and fork detection                        |
| UCAN 0.10 notes                                      | Notes, in the UCAN-shaped profile                     |
| "Checks" in the library docs                         | CEL, as contracts in the spec                         |
| Fixed role presets in the protocol                   | Presets, as constitution templates in the library     |
| The `creator` rule in definitions                    | "Only the creator", as `.byCreator` in a policy (#72) |
| `body.claimed`-style running lists in contracts      | The line rule, with `once` fields                     |
| "A cited version must be current" (an earlier draft) | Contracts judge the versions cited                    |
| "Can't act on an equal or higher rank"               | A policy on `.roles`                                  |
| Datalog (the comparison's prototype)                 | Parked, as a possible library query layer             |

## 7. Open questions

Resolved on 2026-10-12, kept for the record:

- ~~**Grants on records a member created**~~: a policy on `.byCreator`, an
  argument the host fills in (§2), after #72. No built-in.
- ~~**Mutual credit's line across devices**~~: a built-in line rule (§3),
  over the account's line, not a device's log.
- ~~**"Not to yourself"**~~ (from the comparison): a policy on `.self` (§2).
- ~~**How `/role/assign` relates to attenuation**~~ (from the comparison):
  assigning is not granting; nesting is (§2).
- ~~**Datalog for grants or contracts**~~: neither; parked as a library query
  layer.
- ~~**UCAN 1.0's encoding**~~: a JSON profile, UCAN-shaped, not
  byte-compatible, with no `exp` or `nbf` (§2).
- ~~**A role's definer loses power**~~: the role keeps its grants; only a
  concurrent reduction strikes them (§2).
- ~~**Unassigning**~~: its own command, `/role/unassign`; leaving a role
  on one's own is built in (§2).
- ~~**"Current" with concurrent versions**~~: which version wins also
  decides which is current (§2). The rule that a cited version must be
  current is dropped (§3).
- ~~**`sum`'s shape**~~: `sum([])` returns `0.0` (§3).
- ~~**`once` along a line, or a watermark**~~: `once`, only on lines,
  indexed per account per collection (§3).
- ~~**Rival role definitions**~~: their intersection while they are
  rivals, never a lowest id (§2).
- ~~**Parking power in a role the definer keeps**~~: by design; whoever may
  define roles is trusted to (§2). `mine` and nest-only permissions are
  dropped.
- ~~**Corrections in a line**~~: deferred from v1; a payee who built on a
  double spend loses that line from there (§3).
- ~~**Headless spaces**~~: founders may step down, so any space can become
  headless; the way out is `/space/succeed` (§1, built in step 5).
- ~~**Successors**~~: any member may run `/space/succeed` where no member
  holds it; an app shows every successor in no order, and a headless space
  plainly (§1, built in step 5). A quorum for it comes with §5.

Open:

1. **Quorum: built-in rule, or a contract?** A built-in `quorum` is simple to
   implement identically. A constitution contract in CEL is more general, but
   puts CEL in what peers enforce. Either way it meets the requirements in
   §5.
2. **Corrections, later.** The narrow trigger (a cited version is one of a
   double-spent pair), restating, and a restart record for an honest
   account's forked devices (§3).

Settled at implementation in step 4, with tests: policies on a body a peer
can't read, int against float equality, membership as a role, and the
templates' default for `/record/write` (§2). Still open: create versus edit
(03 §17).

## 8. Plan

Each step is its own PR with an adversarial review.

1. **Examples first** (done). The chess club, a co-op, a company team, the
   hall of fame and mutual credit, in CEL and in Datalog
   ([the comparison](contracts-comparison.md)). They are now Weave's
   scenario suite (`scenarios/`), run with `npm run scenarios`; the
   evaluators there are stand-ins until they point at the library.
2. **Keys that belong to their creator** (#72), first: `byCreator` and the
   line rule both depend on it. Done: 02 §4.1, §7.3.
3. **The UCAN-shaped profile** for notes (#19). Done: 01 §7–§8. Notes are
   one delegation each (a command, a subject, a policy on `.space` for
   several spaces), a proof is one note from the account, never a chain
   (a key can't pass its note on), and the
   scenarios' policy evaluator is the library's
   (`packages/core/src/identity/policy.ts`). Grants reuse the token as it
   is: `aud` a role, no `exp` or `nbf`, checked by a grant's own rules.
4. **Grants and the resolver.** Done: 03 §2–§6 and 02 §7, with the
   convergence and attack suites over grants
   (`packages/core/tests/access-*.test.ts`, `roles.test.ts`) and the chess
   club, company team and co-op scenarios asking the real library
   (`scenarios/host/library.ts`). Sync and segment versions went to 6.

5. **The constitution record.** Done: 03 §1, §2.1, §2.5, §2.7 and §4, with
   `top`, several founders or none, stepping down, the resolver's name
   (a peer that doesn't know it doesn't judge the space) and
   `/space/succeed`; presets are constitution templates, with a co-op
   (`top: "none"`). Sync and segment versions went to 7.
6. **Contracts in the spec.** Done: [09 — Contracts](../09-contracts.md),
   with CEL's conformance suite as the language's tests; checks renamed
   contracts (the definition's field stays `check`); the line rule with
   `once` and closed keys in the library
   (`packages/core/tests/contracts-line.test.ts`); `sum([])` is `0.0`; the
   hall of fame and mutual credit scenarios run on the library.
   Corrections are later (09 §7.5).
7. **Later: democracy.** Quorum clauses (question 1) meeting §5's
   requirements, which un-skips the co-op's "needs quorum" scenarios; then
   witnesses for deadlines.

Related: #19 (UCAN 1.0), #72 (keys that belong to their creator), #160
(governance), #166 and #175 (witnessing), #197 (checks), #198 (equal
ranks), #201 (simpler roles).

## 9. Threat model changes still to make

The changes for grants (step 4), the constitution (step 5) and contracts
(step 6) are made in [the threat model](../threat-model.md). What is left comes with later
steps:

- **Democracy** (step 7). Until quorum lands, a co-op's votes can be padded
  and backdated (§5); after, an old majority can still outvote members it
  hasn't seen.
