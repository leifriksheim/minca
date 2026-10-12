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
are adopted, and corrections in a line are deferred from v1 (§3); so is
the fourth's (every role grant but the constitution's lives inside a
definition). Their attempts to stop a definer parking power in a role she
keeps (a `mine` argument, then nest-only permissions) each opened a new
hole, and are **dropped** (Decided, 2026-10-12): under the owner's
principle of no more security than ordinary apps, whoever may define
roles is trusted to, as in Discord or Slack (§2). Grants and the resolver
(step 4) are built, and their text has moved into the specification (§2, §4);
what is left here is the rest of the plan.

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

- **`top`** (Decided). Who can't be removed by anyone else:
  - `{"founders": [...]}`, **the default**: no one else can remove or demote
    the listed people. Matrix arrived at this in 2025 after years of admins
    locking each other out.
  - `"none"`: anyone may be removed, so a space can end up with no admin.
    Members keep what their roles allow; once no role holds a command
    (changing roles or the key, say), nobody can run it. The way out is a
    successor space (below).
  - Later: a group at the top ("any 3 of these 5"), the first step to
    democracy.
- **A founder may step down** (Decided). Leaving is always their own choice:
  a founder's `/member/remove` of themselves (`self: true`) is built in, and
  so is leaving `top`. So a space with founders can lose its last one and
  become **headless**, like a `top: "none"` space with no admin.
- **`resolver`**: a name from a fixed list in the spec, never code. A peer that
  doesn't know a space's resolver doesn't judge that space. v1 has one:
  `strong-remove/1` (§4).
- **What changes in place, and what can't** (Decided). Roles, grants,
  members and collections change in place, as the rules allow; no migration
  is needed to add a role. **The constitution's grants for a role are that
  role's first definition**: a later definition that stands (and so saw
  them, as every placed record saw the founding state) supersedes them, so
  founding roles change in place like any other. After the founding,
  founders grant through `/role/define` like anyone. The resolver and
  `top` can't change: to change them, or to leave a headless space,
  members move to a **successor space** (Matrix's room upgrade).

### Successor spaces

**Decided**: a successor is started by a recorded command in the old space,
`/space/succeed`, naming the new space's constitution, and judged by the
replay like any change of power. The new constitution names the old space,
so a member can tell a successor from a copy. **A succeed record changes
nothing in the old space**: no one loses a role, no record stops counting,
and the old space carries on for whoever stays. It only says where a
successor is. The rest is proposed:

- **Who may run it.** A founder, or a role the constitution or a later
  `/role/define` grants `/space/succeed` to; a `top: "none"` space can grant
  it to a role in its constitution like any command. Where no role holds it
  (a headless space, or one whose constitution never granted it), the
  proposal is that **any member** may run it, and a quorum (§5) once there
  is one. Any member is safe enough because a successor binds no one: each
  member chooses whether to follow.
- **Rival successors.** Two `/space/succeed` that neither saw can both
  stand. Both are shown, **in no order**: a lowest id can be ground (a
  writer tries nonces until theirs sorts first), so it must not decide
  which looks like the real one. An app must not pick one silently, since
  which community a member joins is theirs to choose.

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
     "that": "versions(body.reactions).filter(r, r.collection == 'app.reaction' && !r.deleted && r.link('on') == link('on') && r.body.emoji == '🙂').map(r, r.author).distinct().size() >= 5",
     "else": "A comment enters the hall of fame with 5 different people's 🙂"
   }]
   ```

   **Withdrawals don't un-fame a claim once it has passed**, and a claim
   may cite a version that has since been withdrawn. A contract judges the
   versions a claim cites, not whether they are still current. An earlier
   draft required "a cited version must be current as of the claim's past",
   but a record's `seen` is whatever its writer says: records have no
   causal past a peer can check, so a claim that left the withdrawal out of
   what it names passed anyway. The rule is dropped rather than kept as a
   promise it can't keep. A community that wants withdrawals to count
   writes the claim later, or counts with a query rather than a claim.

   _Source:_ `scenarios/tests/fame.test.ts` ("before the claim: passes,
   citing the version before the withdrawal, whatever the claim had seen").

2. **Limits on one person's own actions** need that person's own order.
   Mutual credit: each payment names the payer's previous payment and carries
   the running balance; the contract checks
   `balance == previous.balance - amount && balance >= -limit`. That works
   across an account's devices, because the line is the account's payments,
   not a device's log.

   **Lines are a built-in rule**, not a contract. A collection definition
   declares itself a line (`"line": { "once": [...] }`). **Its keys are
   closed**: a peer that finds a key it doesn't know in a line declaration
   doesn't judge that collection, as it doesn't judge a space with a
   resolver it doesn't know.

   - **One line per account per collection, at a key derived from the
     author**: `lineKey(account, collection)`, an owned key (02 §4.1,
     `packages/core/src/records/key.ts`), so only that account's own signed
     versions can be in its line, or be twins.
     Without it, anyone could write a first version at someone else's line
     key, or a next version after their payment, and kill the line; and an
     account could open a second line and claim each payment once in each.
   - **Double spends.** Two versions of a line naming the same previous
     one (or two first versions) are a double spend: neither counts, nor
     anything after either, whichever devices wrote them. CEL can't express
     this, since a version never cites its twin, so every reader applies it
     while judging the chain, as it already requires the whole line before a
     version counts. It is not fixed by citation: a payment counts until its
     twin arrives (the comparison, §2.5). A payee who waits before building
     on a payment, or a witness, is the only cure.
   - **No corrections in v1** (Decided). A payee who claims a payment that
     is later double-spent loses that version and everything after it in
     that line: any version after their last counted one is a twin of the
     failed one, so the line ends there.
   - **Claiming each payment once.** The line declaration names the fields
     whose citations may appear only once along the line
     (`"once": ["received"]`), indexed per account per collection
     (**Decided**: `once` applies only to lines). "Along the line" means
     the **counted chain**, a version's `prev` back to the start. The
     reader already holds the whole line, so it checks this with an index,
     and the body carries nothing extra. The prototype's `body.claimed`, a
     list re-read on every payment, goes.
   - **A known limit: an honest account's offline devices.** Two devices of
     one account that pay in the same collection while apart write twins,
     and the line is dead for good. Apps must keep a line on one device at
     a time, or sync before paying.

   **Later: corrections.** A way back for a payee, deferred from v1. The
   starting point is the narrow trigger: a correction is allowed after the
   payee's last counted version only when a version it cites is one of a
   double-spent pair, a structural check with no second run of the
   contract. The second review's rule stays: a correction restates the
   failed versions' outgoing payments in order, dropping only the failed
   citations, so it can't unpay anyone. The third review found that a
   broad trigger ("would pass if what it cited stood") let a correction
   revive a version that failed for its own reasons, and that a payee
   restating can't claim the correction that repaid them. A restart record
   for an honest account's forked devices belongs to the same later work.

   _Source:_ `scenarios/host/cel-host.ts` (`lineKey`, `judgeOne`,
   `onceAlong`); `scenarios/tests/credit.test.ts` ("a line is its account's
   own", "a payee who built on a double spend", "line declarations have
   closed keys"). The host derives the key with the library's `lineKey`.

   **`sum` of an empty list** (Decided). Today `sum([])` is the int `0`,
   and an int plus a double is an error, so a payment that claims nothing
   fails unless the sum is padded with `[0.0]`. Every number read from a
   body is a double. `sum` is Weave's function, not CEL's, so it changes:
   **`sum([])` returns `0.0`**. There is no `sum(l, zero)`.

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

**Built** (step 4): now the specification, in
[03 §4](../03-spaces.md#4-replaying-the-access-history-strong-remove1) and
§5. The convergent replay stays; ranks go; a removal strikes everything its
account did concurrently, and an unassignment only what needed the role.

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
- ~~**Headless spaces**~~, in part: founders may step down, so any space
  can become headless; the way out is `/space/succeed` (§1).

Open:

1. **Quorum: built-in rule, or a contract?** A built-in `quorum` is simple to
   implement identically. A constitution contract in CEL is more general, but
   puts CEL in what peers enforce. Either way it meets the requirements in
   §5.
2. **Successors.** Who may run `/space/succeed` where no role holds it
   (any member now, a quorum later, as proposed). What an app shows in a
   headless space, and how it shows rival successors in no order.
3. **Corrections, later.** The narrow trigger (a cited version is one of a
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
   (`scenarios/host/library.ts`). Sync and segment versions went to 6. The
   space's creator stands in for the founders until step 5.

5. **The constitution record**, with `top`, founders stepping down, the
   resolver name and `/space/succeed`.
6. **Contracts in the spec.** The CEL subset as a spec part with its
   conformance suite; checks renamed; the line rule with `once` and closed
   keys (corrections later); `sum([])` as `0.0`; the hall of fame and
   mutual credit scenarios against the real library.
7. **Later: democracy.** Quorum clauses (question 1) meeting §5's
   requirements, which un-skips the co-op's "needs quorum" scenarios; then
   witnesses for deadlines.

Related: #19 (UCAN 1.0), #72 (keys that belong to their creator), #160
(governance), #166 and #175 (witnessing), #197 (checks), #198 (equal
ranks), #201 (simpler roles).

## 9. Threat model changes still to make

The changes for grants (step 4) are made in
[the threat model](../threat-model.md). What is left comes with later
steps:

- **Successors** (step 5). A `/space/succeed` changes nothing in the old
  space, so it can't be used to strip anyone of anything there. Rival
  successors are shown in no order, since a lowest id can be ground; a
  member who follows a successor chooses it. Several founders, and `top:
"none"`, change §3.2's line on founders.
- **Contracts** (step 6).
  - Contracts judge versions cited, not current ones (§3): a withdrawal
    doesn't un-fame a claim, before or after it.
  - A payer can double-spend a payment a payee built on; the payee loses
    that version and everything after it in that line, for good, since v1
    has no corrections (§3).
  - An honest account whose two offline devices pay in one line kills that
    line for good (§3).
  - **Closed line keys.** A line declaration with a key a peer doesn't
    know leaves that collection unjudged by it, so a newer declaration
    splits old and new peers' verdicts on that collection until they
    update; they never disagree silently.
- **Democracy** (step 7). Until quorum lands, a co-op's votes can be padded
  and backdated (§5); after, an old majority can still outvote members it
  hasn't seen.
