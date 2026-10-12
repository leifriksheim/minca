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
roles is trusted to, as in Discord or Slack (§2).

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

A grant is a delegation to a role: _which role_ may do _what_, on _which_
part of the space, under _which_ conditions. Conditions are standard UCAN
policies, with no extension: a policy compares one invocation's arguments
with literals, and nothing else.

**Who issues grants, and to whom** (Decided, from the second review):

- **Only the constitution and `/role/define` issue grants, and only to
  roles.** An account gets power in a space only through `/role/assign`,
  which `/role/unassign` or removal undoes. A grant whose `aud` is not a
  role is refused.
- **No member delegates to another key or account in a space.** Otherwise
  a referee would hand `/record/delete` to a fresh key before being
  unassigned, and the key would keep it for good, since nobody can unassign
  a key that holds no role; and an admin limited by `.self` would hand
  `/role/assign` to a fresh key that then assigns her.
- **The account's own notes are separate** (01 §8: account to its own
  device, app or program keys). They pass on only what the account holds
  now, as of the note's use: a device key acts for its account, judged by
  the account's roles as of the action's view, and falls away with them.
  A note is not a grant in the space, and can't be used to give power to
  another account.
- **Only members may invoke.** An account with no role (and no place in
  `top`) may invoke nothing, whatever it was handed.

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

### The format: UCAN-shaped (Decided)

Grants use **a JSON profile of UCAN 1.0**: UCAN 1.0's fields (`iss`, `aud`,
`sub`, `cmd`, `pol`, `nonce`, `meta`), its policy language and its
semantics (attenuation, command paths, chains back to the subject), carried
in Weave's canonical JSON and signed as Weave signs everything, not
DAG-CBOR with a varsig envelope.

It is **not byte-compatible** with other UCAN tools, and says so: a Weave
grant can't be handed to a UCAN library, nor a UCAN token to a Weave peer.
Three things would not survive the trip anyway:

- **Role audiences.** `aud` is `role:<name>`, a role of the space, which is
  not a DID. In a space, it is never anything else.
- **`space:` subjects.** `sub` is a space, `space:<id>`, whose root is its
  constitution, not a key.
- **No expiry.** Time decides nothing in Weave (02 §4.3: `createdAt` orders
  nothing), so `exp` and `nbf` **must be absent**; a grant with either is
  refused. A grant ends by revocation or removal, judged by the replay.

The account's own notes (account to device, app, program) use the same
profile, so there is one delegation format (01 §7, #19).

### Abilities, scope, roles

- **Abilities** are command paths (the table below). A grant of `/record`
  covers everything under it.
- **Scope** is the policy: which collections, whose records, which field
  values. One language, UCAN's, for every condition on a single invocation.
- **A role** is a named bundle of grants that the space defines (Moderator,
  Treasurer, Referee). Accounts are assigned roles.
- **Collection rules about people merge into grants** (Decided). Today a
  definition says `delete: can:moderate` and a role holds
  `app.poll/moderate`. After: "Moderator may `/record/delete` in `app.poll`"
  is one grant, and "the creator may delete" is a policy on `.byCreator`.
  Definitions keep only what isn't about people: `onePer`, `fixed`, `final`.

### What each command's policy sees

"Who" in a policy needs no extension to UCAN (**Decided**). Each command
defines the arguments the host fills in before a policy runs, and those
include the few facts about the invoker and the target a policy needs. A
policy reads only these; a selector naming anything else finds nothing, and
the policy fails.

| Command              | Arguments                         | Filled in from                                                                                                                         |
| -------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `/record/read`       | `collection`                      | The collection read                                                                                                                    |
| `/record/write`      | `collection`, `byCreator`, `body` | `byCreator`: whether the writer's account made the record's first version (true for a new record); `body`: the new body                |
| `/record/delete`     | `collection`, `byCreator`         | As for `/record/write`                                                                                                                 |
| `/collection/define` | `collection`                      | The collection defined                                                                                                                 |
| `/member/add`        | (none)                            |                                                                                                                                        |
| `/member/remove`     | `self`, `roles`                   | `self`: whether the member removed is the invoker (leaving); `roles`: the target's roles as of the invocation's view, sorted names     |
| `/role/define`       | `role`                            | The role whose definition (its delegations and nestings) is written                                                                    |
| `/role/assign`       | `role`, `self`, `roles`           | `self`: whether the assignee is the invoker's account; `roles`: the assignee's roles as of the view. The assignee is always an account |
| `/role/unassign`     | `role`, `self`, `roles`           | As for `/role/assign`                                                                                                                  |
| `/key/change`        | (none)                            |                                                                                                                                        |
| `/space/succeed`     | (none)                            | The successor's constitution is the payload, not an argument                                                                           |

So:

- "Members may delete their own moves" is
  `{ cmd: "/record/delete", pol: [["==", ".collection", "app.chess"], ["==", ".byCreator", true]] }`.
- "Admins assign Treasurer, not to themselves" is
  `{ cmd: "/role/assign", pol: [["==", ".role", "treasurer"], ["==", ".self", false]] }`.
- "Members may leave" is `{ cmd: "/member/remove", pol: [["==", ".self", true]] }`.
- "Moderators may remove members but not admins" is
  `{ cmd: "/member/remove", pol: [["==", ".self", false], ["not", ["any", ".roles", ["==", ".", "admin"]]]] }`.

`byCreator` compares accounts, not devices: any device of the creator's
account counts. When the record's first version isn't held, the invocation
waits, as anything missing does. It is 02 §7.1's `creator`, which keys that
belong to their creator (#72, 02 §4.1) made order-independent: at an owned
key it is the key's owner, and at a shared `one:` key (a `onePer` without
`@author`) it is whoever wrote the first version the invocation's chain
starts from, so anyone allowed to create there can start a rival chain.

`self` doesn't close a second account of the invoker's own: an admin who may
assign `hr` can assign it to another account she controls. Since only roles
hold grants, that account must be a member assigned `hr`, visible as one
and unassignable like any other; it is no longer just a fresh key. No
language closes the rest; "manages hr but can't read it" holds only if
someone else manages hr's membership (the company scenario says so).

**`roles` protects ranks that aren't founders.** Numeric ranks go (§6), and
with them the rule that you can't act on someone at or above your own rank.
Without a replacement, a moderator an admin appointed could remove that
admin. The `roles` argument gives a policy the target's roles, so "may
remove members but not admins" is plain UCAN, and so is "may assign referee
only to someone who is not an admin". A space that grants `/member/remove`
without such a policy has chosen to let it reach everyone but founders.

**A limit:** `roles` is read as of the invoker's view. It protects a target
only from an invoker whose view includes the target's role. A moderator
appointed before Fred became an admin can remove Fred by naming a view
before the promotion, or by acting concurrently with it; nobody can tell
that from an action written offline. This is the same limit ranks have
today (a demotion's own view decides it), and no new strike rule is added
for it.

_Source:_ `scenarios/host/grants.ts` (`may`, `argsFor`);
`scenarios/tests/chess.test.ts` ("a moderator can't remove the admin who
appointed them", "a limit of `.roles`").

### Assigning a role is not granting

A role's grants come from the space: the founding roles in the
constitution, and later roles written by whoever holds `/role/define`.
**Every role grant but the constitution's lives inside a definition**: a
`/role/define` record that holds the role's delegations and nestings. The
constitution's own grants for a role are its first definition (§1), and a
later definition supersedes them. Any other delegation or nesting outside a
definition counts for nothing, a founder's later one included, so
rewriting a role replaces what it held, and the rule for rival definitions
(below) can't be sidestepped by adding grants one at a time. A role
definition is a set of delegations whose issuer is the definer, so it holds
only what the definer held, as of the definition, as UCAN's
attenuation requires; the constitution's roles are issued by the space
itself, the root of every chain. A definition stands when its author held
`/role/define` for that role as of its view, as for any access event.

**Whoever may define roles is trusted to** (Decided; a stated limit, as in
Discord or Slack). A definer can write power into a role she holds herself
(say `member`), or nest it in a role she defines, and that power stays
with the role, hers and everyone's in it, after she is unassigned from the
role that let her define: **her unassignment takes only that role
assignment; what she wrote stays until someone rewrites the role.**
Earlier drafts tried to stop this (an argument saying whether the definer
holds the role, then permissions to nest and nothing else); each opened a
new hole, so a space that doesn't trust someone to define roles doesn't
grant them `/role/define`.

_Source:_ `scenarios/host/grants.ts` (`stands`, `heads`, `holderMay`);
`scenarios/tests/chess.test.ts` ("whoever may define roles is trusted to
(by design)": the power stays, another admin's rewrite undoes it, a grant
outside any definition counts for nothing).

Assigning an account to a role is the command `/role/assign`, an
invocation, not a delegation. It gives the assignee nothing the role didn't
already have, so the assigner needn't hold the role's grants, only
`/role/assign` for that role. A policy limits which roles may be handed out
(and, with `.self` and `.roles`, to whom). That keeps UCAN's rule that you
can only grant what you hold: the grants were delegated once, by the role's
definer; assignments only say who is in the role.

**Nesting a role in another role is granting, not assigning.** A sub-team
(every member of `web` also holds `eng`) gives a whole role new grants, so
it is part of the inner role's definition, written by whoever holds
`/role/define` for `web` (in the company scenario, the CEO), and is
attenuated like a delegation: through the nesting, a member of `web` may do
only what the nester could do themselves, as of the nesting. `/role/assign`
to a role (an assignee of the form `role:<name>`) is refused. Without this,
an admin who may assign `hr` but can't read it would assign `hr` to
`role:admin` (where `self` is false) and read it, and an admin who may
assign `referee` would assign it to `role:member`, making every member a
referee.

_Source:_ `scenarios/host/grants.ts` (`Nesting`, `holderMay`, `issued`);
`scenarios/tests/company.test.ts` ("assigning hr to the role admin is
refused", "nesting hr in admin is granting");
`scenarios/tests/chess.test.ts` ("roles go to accounts, not roles", "grants
go only to roles, so losing a role loses its power").

**Unassigning is its own command** (Decided): `/role/unassign`, with the
same arguments as `/role/assign`. **Leaving a role on one's own is built
in**: an account may always unassign itself, whatever the policy says, as a
founder may always step down. Either is a reduction of the author's own
account, so it strikes the author's own actions concurrent with it that
needed the role (below, and §9).

A peer judging an action checks both: the assignment (its author held
`/role/assign` with a policy the arguments meet, as of what it had seen),
and the role's delegations and nestings (each issuer held what it delegated,
back to the space).

### When a role's definer loses power (Decided)

**A role keeps its grants when its definer is later removed or demoted.**
Role delegations are access events, judged in their own view, as 03 §4.3
judges every access event: a definition that was allowed when it was made
stays allowed. Only a reduction concurrent with the definition (one the
definition hadn't seen, and that hadn't seen it) strikes it, as
`strong-remove/1` strikes anything concurrent with a removal. So a
demotion doesn't take a whole role's grants from its members at once; to
take them, someone with `/role/define` rewrites the role. This is not
UCAN's chain semantics, where a delegation lives only as long as its
issuer's proof; it is Weave's, and it is safe only because its audience is
a role, which someone with `/role/define` can rewrite.

**An account's power, by contrast, is its current assignments as of the
action's view**: unassigning or removing it takes everything, since no
grant ever names the account.

- **What an unassignment strikes.** Unassigning a role, or leaving it on
  one's own (#168), strikes only the account's concurrent actions that its
  own view allowed and would refuse with that role taken **from the
  action author's holdings at that view only**, not all of its concurrent
  actions: unassigning `greeter` doesn't strike what its holder did as an
  admin meanwhile. Definitions stay judged at their own views, unaffected
  unless they are themselves concurrent with the reduction: an admin's
  concurrent delete through `member`, which her own earlier definition of
  `member` gave, is not struck by unassigning her from admin. A removal
  strikes all of them, as today.
- **Removal and assignments.** A removal ends every assignment of the
  removed account that hadn't seen it, an assignment concurrent with the
  removal included. After a re-add, only assignments that had seen the
  removal count.

_Source:_ `scenarios/host/grants.ts` (`rolesIn`, `strikes`);
`scenarios/tests/chess.test.ts` ("a role keeps its grants when its definer
is demoted", "what an unassignment strikes", "a removal ends the
assignments that had not seen it"). The scenario host has one linear
history with views, and doesn't replay strikes; `strikes` states the rule,
and the replay is tested when grants land (§8 step 4).

### Which definition is current

**Decided**: "which version wins" (02 §4.3) also decides which version is
current among rivals, wherever the protocol or a contract asks for the
current version of a record.

**Rival role definitions** (Decided, from the third review). While
definitions of one role are rivals (none saw the others), the role holds
only **the delegations found in every rival**, compared as the canonical
JSON of `{cmd, pol}` (ignoring `iss`, `nonce` and `meta`). A delegation
counts only if it is validly issued in each rival, and a nesting only if
every rival has it. The rivalry ends when a definition that saw all the
rivals is written. An empty intersection leaves the role empty, which
fails closed. A rival only needs its author to have held `/role/define`
for the role as of its view; one whose author didn't is no rival, or
anyone could empty a role. No lowest id decides anything (an id can be
ground), and no peer tries to decide whether one policy implies another.

**The intersection can lock a role that defines itself.** If admins hold
`/role/define` for `admin`, two admins' concurrent edits that disagree on
that grant (one narrows its policy, say) leave `admin` without it, and
then no admin can write the definition that ends the rivalry. A founder
can repair it; in a headless or `top: "none"` space it takes a successor
space. So templates should give `/role/define` for a role to a role other
than itself: founders, or a separate `steward` role, define `admin`.

_Source:_ `scenarios/host/grants.ts` (`heads`, `holderMay`);
`scenarios/tests/chess.test.ts` ("rivals can lock a role that defines
itself", "rival definitions of a role hold only
what they share").

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

What Weave's replay does today, restated over grants:

- A change is judged by the grants its author held as of what it had seen:
  the grants of the roles assigned to it, as of the change's own view. An
  account holds nothing else (§2).
- Role definitions and nestings are access events, judged in their own view,
  like the rest: a role keeps its grants when its definer later loses power
  (§2). The constitution's grants for a role are its first definition,
  superseded by a later one (§1). Rival definitions hold their intersection
  (§2). Assignments are judged in their own view too, and end when
  unassigned, or when a removal they hadn't seen ends them.
- Unassigning or leaving a role strikes only the concurrent actions that
  needed that role; removing an account strikes all of its concurrent
  actions (§2).
- Removing someone strikes what they did concurrently with it. Unassigning
  a role strikes only what needed that role (§2).
- Mutual removals both stand; no one else can remove a founder under
  `top`, so a space with founders has someone in charge until the last one
  steps down by their own choice (§1).
- Revocations and removals carry cutoffs; a second version at a covered place
  is a fork, and is withdrawn.
- Rivals resolve toward less power: rival role definitions hold only what
  they share (§2).

The replay machinery (strikes, cutoffs, `least`, the two-pass cascade) stays.
What goes is numeric ranks, and with them every rank comparison; the
`roles` argument (§2) is what replaces "can't act on an equal or higher
rank".

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

To settle at implementation, each with a test:

- **Policies on `.body` a peer can't read.** A sealed body is unreadable to
  a peer without the space key. Whether such a peer treats the invocation
  as waiting, as refused, or leaves the judgement to readers, and how that
  keeps peers agreeing on access.
- **Int against float equality**, under canonical JSON: whether `1` and
  `1.0` are one value in a policy's `==`, as they are one number in JSON.
- **Whether membership is a role.** `/member/add` and `/role/assign member`
  must be one thing, not two paths with different policies.
- **Create versus edit.** An argument to tell `/record/write` of a new
  record from an edit, so a policy can allow one and not the other
  (`byCreator` is true for both today).
- **The default policy for `/record/write`.** Without `byCreator`, a grant
  of `/record/write` lets members edit each other's records. Constitution
  templates must say which they mean, explicitly.

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
4. **Grants and the resolver.** Prototype `strong-remove/1` over grants, run
   it through the existing convergence and attack suites, then replace ranks
   in 03 and the code. The command arguments (§2) land here, with `roles`,
   nesting under attenuation, rival definitions as an intersection,
   `/role/unassign` and leaving built in, scoped strikes, and the
   scenarios move to the real library's grants. The replay's tests include
   a former definer's backdated rival definition (written after losing
   `/role/define`, naming a view from before), struck by the concurrent
   reduction. Implementation notes from the reviews:
   - a delegation or nesting in a definition is judged at its definition
     (its place and view), not at a place of its own;
   - there is no "no place" path for anyone but the constitution: a
     definition, delegation or nesting by a non-founder without a place in
     the history counts for nothing.
   - a struck definition or nesting is dropped before anything that rests on
     it is judged: a definition concurrent with its author's unassignment
     gives neither her nor anyone else its grants (the final review's Q1,
     kept as a scenario checked after replay).

   The threat model changes in §9.

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

## 9. Threat model changes

For when grants are built (§8 step 4), to change in `spec/threat-model.md`
in the same PR:

- **Member (§3.2).** "Can't act on an equal or higher rank" goes: a member
  with `/member/remove` or `/role/unassign` reaches everyone but founders,
  unless its grant's policy reads `.roles`. Restate the Holds claims in
  grants. New Holds claims, with the company and chess scenarios as their
  tests: nesting a role is attenuated; assigning to a role is refused; only
  the constitution and `/role/define` issue grants, only to roles, so a
  member can hand no power to another key or account. "The top rank answers
  to no one" becomes "founders answer to no one but themselves".
- **`.roles` is as of the invoker's view** (§2). It protects a target only
  from an invoker whose view includes the target's role: an invoker who
  names a view before the target's promotion, or acts concurrently with it,
  isn't stopped. The same limit as ranks today; a Does-not-hold-yet line.
- **Former member (§3.3), and the unassigned.** Restate in grants: an
  account's power was its roles' grants. Removal takes all of it, and ends
  every assignment that hadn't seen the removal, one concurrent with it
  included; after a re-add, only assignments that saw the removal count.
  Unassignment takes that role, and strikes only the concurrent actions that
  needed it. Nothing it handed a key survives, because it could hand
  nothing. What does survive is what it wrote into roles while it held
  `/role/define` (§2), its own roles included, until someone rewrites the
  role. Unassignment takes only the role assignment, and strikes the
  concurrent actions that needed it. That replaces "a grant it makes
  concurrently with its removal is struck" for roles, which still holds for
  definitions concurrent with the removal. The sock gap (#191) becomes a
  sock it _assigned_ a role, which is visible and unassignable.
- **Top rank.** Founders replace the top rank. A founder can't be removed
  by anyone else, but can step down; a space can become headless.
- **Root thief (§3.5).** A thief of a founder's account seed is a founder:
  it controls every space the account founded, for good, and can't be
  removed. The only way out is a successor space. "Ranks highest" becomes
  "is a founder".
- **Leaving is a reduction.** Leaving a role on one's own, or a founder
  stepping down, is a reduction of the author's own account, so it strikes
  the author's own concurrent actions that needed what it gave up (a
  founder stepping down: all of them): an account can disown what
  its other devices did while apart, as revoking its own key or forking
  its own line already can
  ([#168](https://github.com/leifriksheim/weave/issues/168)). Add it to that
  line.
- **Successors.** A `/space/succeed` changes nothing in the old space, so
  it can't be used to strip anyone of anything there. Rival successors are
  shown in no order, since a lowest id can be ground; a member who follows
  a successor chooses it.
- **New gaps.**
  - Roles outlive their definer's demotion (§2): a definer who is removed
    leaves behind what they defined until someone rewrites the role.
  - **Whoever may define roles is trusted to** (a stated limit, by design,
    as in Discord or Slack). A definer can write power into a role she
    keeps, or nest it in one she defines, and keep it after losing the
    role that let her define; two definers can define roles for each
    other. It lasts until someone with `/role/define` rewrites the role
    (§2; `scenarios/tests/chess.test.ts`, "whoever may define roles is
    trusted to").
  - **Rival definitions** hold their intersection (§2): a definer can
    weaken a role, even empty it, by writing a rival definition apart from
    the others, until a definition that saw both is written. It fails
    closed, never open. Where the role defines itself, rivals can drop
    `/role/define` from it, and then nobody in it can end the rivalry: a
    founder repairs it, and in a headless or `top: "none"` space it takes a
    successor space. Templates give `/role/define` for a role to another
    role (§2; `scenarios/tests/chess.test.ts`, "rivals can lock a role that
    defines itself").
  - A member with two accounts sidesteps `.self` (§2). With only roles
    holding grants, the second account must be a member assigned the role,
    visible and unassignable; it is no longer just a fresh key.
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
  - Until quorum lands, a co-op's votes can be padded and backdated (§5);
    after, an old majority can still outvote members it hasn't seen.
