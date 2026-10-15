# Threat model

What Minca defends, against whom, and where it does not yet. It is
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
and fork proofs (§3.2 to §3.4, [#166](https://github.com/leifriksheim/minca/issues/166)),
and metadata through relays and hosts (§3.7, §3.8).

## 2. Adversaries

| Adversary            | Holds                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **Stranger**         | Network access; any number of keys and accounts of its own; a space's id, or a leaked invite string                |
| **Member**           | Roles in the space and their grants, its own keys, the space key of a private space; a modified client             |
| **Former member**    | Everything it held while a member: old keys, space keys, notes, invite secrets, its copy of the space              |
| **Key thief**        | One of an account's delegated keys (session, writer or app key), with its note                                     |
| **Root thief**       | The account's seed or recovery code                                                                                |
| **App or program**   | A grant from the account, by popup or by code: a note, and perhaps the account, contact or member keys (06 §2, §3) |
| **Relay**            | The signaling traffic of the rooms it serves, and the door mailbox it keeps                                        |
| **Host or carrier**  | Every version of the spaces it keeps and their envelopes, a pass's read seed, a connection to members              |
| **Network attacker** | Can watch, delay, drop and replay traffic between peers                                                            |

A key thief is answered by revoking the key, not by detecting the copy (§3.4).

Peers are assumed to run arbitrary code. Nothing relies on a peer running the
reference implementation, or any implementation, honestly.

## 3. What holds, and what does not yet

### 3.1 Stranger

- **Holds.**
  - Without an invite secret, nothing it signs in a space counts: a version
    needs its author to be a member, and to hold a grant for what it does, as
    of its `seen` (03 §5.2), and its access changes are never applied (03 §4.4,
    §4.5).
  - It cannot forge a version, a note or an invite (02 §3, 01 §7, 03 §7).
  - It cannot give someone's note a second id, nor make one of its own count
    for an account: a token has one form (low-S signatures only, one
    spelling, exact fields), and a note is one token signed by the account's
    root key, so a chain of tokens is refused (01 §7.1, §7.5).
  - It can't change anything a space's constitution says, its name and
    founders included, without changing the space's id (03 §1.2). A space it
    makes whose constitution says it succeeds another is a copy, not a
    successor, unless a succeed that stands in that space names it (03 §2.7).
    It can found a space naming anyone as a founder; that space gives them
    power, and takes nothing from them.
- **Does not hold yet.**
  - A leaked view-only invite carries the space key, can't be closed, and
    never causes a key change, so whoever holds it reads everything new
    ([#170](https://github.com/leifriksheim/minca/issues/170)).
  - A leaked role invite lets it join, as often as it likes ([#170](https://github.com/leifriksheim/minca/issues/170)).
  - What it sends must be checked, stored or refused, with few limits
    ([#33](https://github.com/leifriksheim/minca/issues/33)). That includes knocks on doors and contact requests (07),
    whose mailbox can be flooded ([#162](https://github.com/leifriksheim/minca/issues/162)).
  - It can squat a session DID in a relay room, or fill a room ([#162](https://github.com/leifriksheim/minca/issues/162)).
  - A page that takes over an app's tab while the account home waits for the
    app's request (up to 10 minutes in the reference home) can send its own
    request, in the window the person opened from the app. The home shows
    that page's origin and grants nothing under the app's; the person
    reading the origin is the only defence (06 §2.3). By design.

_Source: 03 §1.2, §2.7, §3.4, §4.4, §5.2; 02 §3; 01 §7. Tests: `packages/core/tests/constitution.test.ts` ("what a constitution may say"), `packages/core/tests/space-access.test.ts`, `packages/core/tests/space.test.ts` ("a personal space refuses a stranger"), `packages/core/tests/ucan.test.ts`, `packages/core/tests/validation.test.ts`._

### 3.2 Member

- **Holds.**
  - An ordinary record it writes counts only if a role it held granted it, as
    of what the version says it saw. Claiming to have seen less does not
    escape a removal of it it had not seen, nor the loss of any of its roles:
    past the change's cutoff, it is judged with them (03 §5.1, §6.3). Nor
    does citing a change struck since give it anything: a record is judged
    counting only the changes that stand (03 §5.1 step 5; `roles.test.ts`,
    "… (Q1)"; `access-attacks.test.ts`, "a record citing a struck
    definition…").
  - An unassignment, like a removal, strikes everything its account did that
    hadn't seen it, past its cutoff, whatever that needed. So a demoted
    member's backdated actions don't count: not by assigning itself another
    role, defining one it keeps, or because another role it lost at the same
    time would also have allowed it (03 §4.3; `access-attacks.test.ts`,
    "backdating past an unassignment"). What it can still do, by a backdated
    reduction of whoever demoted it, is below.
  - A join through an invite is judged as the assignment its opener makes, to
    whoever joins: an opener whose grant says `.self == false` can't join its
    own invite, and its `.roles` policy reads the joiner's roles (03 §4.5;
    `access-attacks.test.ts`, "an invite is the assignment its opener
    makes…").
  - Sending a stub ahead of its version gets nothing past a reader: a verdict
    on a stub, judged without its body, never stands for the whole version,
    and a reader holds a stub whose grant reads its body as not yet judged
    (03 §5.2; `attacks.test.ts`, "a stub sent ahead of its body").
  - Under `top: { founders }`, it can't remove a founder, take a role from
    one, assign one a role or make one step down, whatever its grants, and
    neither can another founder. A founder is a founder in every view until
    it steps down or leaves, so naming an older view, or acting
    concurrently, doesn't help: every peer refuses the change (03 §2.1,
    §4.5; `constitution.test.ts`, "top: founders", "a removal of a founder,
    even backdated, is refused by every peer").
  - A founder that steps down can't go on using founder power by naming a
    view from before it: stepping down is a reduction of its account, and
    strikes everything it did that hadn't seen it, records included (03 §2.5,
    §4.3; `constitution.test.ts`, "stepping down strikes what the founder did
    that had not seen it…"). Founder status is never given back: nothing strikes
    a stepping down, so neither the owner of the key that signed it, nor a
    thief, nor a fork found by accident undoes it (03 §4.3;
    `constitution.test.ts`, "stepping down is for good…";
    `access-fuzz.test.ts`).
  - A successor it names changes nothing in the old space: no one loses a
    role there and no record stops counting. It can't hide or replace another
    member's successor: every succeed that stands is listed, and none is first
    (03 §2.7; `constitution.test.ts`, "/space/succeed").
  - It can hand no power to another key or account: only the constitution and
    a role's definition issue grants, and only to roles, so whatever it holds
    goes when its roles do, and a grant to anything but its role is no
    grant (03 §2.2, §2.5; `packages/core/tests/access-attacks.test.ts`, "a fresh
    key outliving its issuer…", "a referee unassigned keeps nothing…").
  - It can't put a role inside another by assigning one (refused), and
    nesting is defining: through a nesting, a role holds only what the
    nesting's author could do as of it (03 §2.4, §2.5; `access-attacks.test.ts`,
    "`self` through a role…", "`self` through nesting…", "a nesting holds only
    what its writer could do…").
  - A definition holds only what its author could do as of it. Rival
    definitions written apart hold only the grants they all hold, so a rival
    can weaken a role but never strengthen it, and no id decides between them
    (03 §2.4, §4.4; `access-attacks.test.ts`, "a rival definition can only
    narrow…", "no id decides between accounts…"; `roles.test.ts`, "rival
    definitions hold only the grants they share…").
  - A definition, or anything else, it writes concurrently with losing any
    of its roles is struck, and what rests on it falls with it, changes and
    records alike, whether or not they cite the loss (03 §4.3, §5.1;
    `roles.test.ts`, "a definition concurrent with its author’s unassignment
    gives neither her nor anyone its grants (Q1)", "a former definer's
    backdated rival definition is struck…").
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
  - Ciphertexts sealed under a space key or to a member key are bound to
    their place: a record body copied into another record, collection or
    space, or a box presented for another space, key or recipient, does not
    open there (01 §9, 03 §8.3, §9.4). Holding the key, it can still seal
    whatever it likes; what it can't do is pass off someone else's
    ciphertext as being about something else (01 §9).
  - It can't write a first version at another account's key, however low
    an id it grinds: every peer refuses one whose root doesn't own the key,
    whichever version reaches it first. So it can't become the creator of
    another's record, for the `creator` rule or `@createdBy`, nor write
    another's `onePer` vote for them (02 §4.1, §4.5, §7.3). Nor can it
    become a collection's first definer by a rival definition or a delete
    with a lower id, put its own rules in force by one, or write without rules while
    rivals that differ stand: no id decides between
    accounts that may not each change it, and a contested collection takes
    no writes until someone granted `/collection/define` for it settles it (02 §6.3).
- **Does not hold yet.**
  - A narrowed rule, or a role written again with fewer grants, binds only
    what saw it: a version naming an older point counts if its author could
    have written it then, since nobody can tell it from one written offline.
    Taking the role from its holder, or removing them, binds it (03 §4.3,
    §5.1). That includes a definition by a holder whose power to define the
    narrowing took: only unassigning or removing the holder strikes it.
  - `.roles` protects only against a remover whose view includes the
    target's role. It is read as of the invoker's own view, which the
    invoker chooses by what it names as seen (03 §2.3, §3.2): one that names
    a view before the target's promotion, or acts concurrently with it,
    isn't stopped. So `community` admins can remove or demote each other
    (`roles.test.ts`, "`.roles` protects admins from moderators; it reads the
    view of the one acting", "`community` admins can remove each other…").
    The same limit as the ranks before it.
  - It can make every peer store revokes of keys that never wrote here, and
    other changes it may make, without limit. Revokes are never heads; changes
    it has the power for can outnumber what `seen` holds, and a writer then
    names first heads that saw the latest change to its own place, role and
    collection
    ([#33](https://github.com/leifriksheim/minca/issues/33)).
  - Each warrant costs every member's node a replay of the offending
    version's own view, once; nothing bounds how many warrants a member
    writes, true or false ([#33](https://github.com/leifriksheim/minca/issues/33)).
  - Someone who may define a collection can give it computed fields that
    every member's device works out for each record a query filters or
    sorts on them, and that grow with every record a member links to it.
    Each automation of an account's own that names one makes up to four more
    wakes for its carriers to check, in the spaces whose definition reads
    them. A `computed` member that is malformed, too large or named like a
    field of the body's schema is read as having none, however it arrived;
    one that misreads the schemas, which `define` also refuses, is used, and
    gives null
    (`packages/core/docs/computed.md`; `packages/core/tests/computed.test.ts`,
    "computed: what review found")
    ([#33](https://github.com/leifriksheim/minca/issues/33)).
  - What made a record hold, for an automation on a computed field, is told
    by the writers' clocks, which no peer checks: of two members whose
    records together made it hold, either can date theirs to have been the
    last, and so be the one its `from` and `others` judge. Neither can make
    a record that held before it fire, nor one their records didn't help
    make hold (`causeOf` in `packages/core/src/query/computed.ts`;
    `packages/core/tests/computed.test.ts`, "what made it hold sets it off,
    not whatever came after", `scenarios/tests/chores.test.ts`). By design,
    as times are the writer's everywhere else.
  - Which changes a peer holds can differ for good, and verdicts depend on a
    peer's keys, or the order it runs checks in ([#10](https://github.com/leifriksheim/minca/issues/10)).
  - A removal or unassignment signed offline can arrive at any time and withdraw
    what its cutoff doesn't cover: peers converge, but no verdict is final
    until members witness each other's heads
    ([#166](https://github.com/leifriksheim/minca/issues/166)).
  - Whoever was allowed to reduce another as of an old view can do so at any
    time later. It names a view in which it held the grant and the target
    held the role, leaves out the cutoff, and strikes everything the target
    did since. A `.roles` policy doesn't stop it, since it is read in that
    old view, and having been demoted or removed since doesn't either: its
    reduction and the one that took its power strike each other, and both
    stand, whatever their kinds. So a demoted admin can remove whoever
    demoted it, and stays demoted; a removed member can take a role from its
    remover, and stays removed. Without consensus a backdate can't be told
    from a delay, so no rule settles it; a founder or someone who may assign
    does, after it, by re-adding or assigning again (03 §4.3;
    `access-attacks.test.ts`, "reductions of each other";
    [#166](https://github.com/leifriksheim/minca/issues/166)).
  - An invite outlives its opener's demotion or removal for a joiner who names
    a view from before it: the join is judged there, where the opener still
    held the grant. To stop an invite, close it: a close strikes joins that
    hadn't seen it (03 §4.3, §4.5; `access-attacks.test.ts`, "an invite
    outlives its opener’s demotion…";
    [#170](https://github.com/leifriksheim/minca/issues/170)).
  - Only three kinds of misconduct earn a warrant, and a peer that
    can't read the rules flags no one. More kinds are planned after v1 ([#148](https://github.com/leifriksheim/minca/issues/148)).
  - A warrant is withdrawn like any record: an accused who may remove every
    witness removes them with a cutoff below their warrants, and a writer can withdraw their own
    by revoking its key or forking their line in the warrants' collection,
    so their warrants stop counting ([#166](https://github.com/leifriksheim/minca/issues/166)).
  - Fork proofs don't reliably catch a copy of a key that writes where its
    other branch never reaches (§3.4): a fork counts once a member holding
    both versions writes `sys.fork` _(traced)_. A second version at a place a
    cutoff covers is always caught, since the remover holds that line (§3.3,
    03 §6.3).
  - It can disown its own history, withdrawing votes and agreements others
    relied on, by revoking its own key with a cutoff of 0, or forking its
    own line in a collection at 0, and nothing flags it ([#166](https://github.com/leifriksheim/minca/issues/166)).
    Leaving a role, or the space, is a reduction of its own account too: it
    strikes everything its other devices did concurrently that its cutoff
    doesn't cover, so an account can disown what its devices did while apart
    ([#166](https://github.com/leifriksheim/minca/issues/166); `roles.test.ts`,
    "it strikes what needed the role, and so does leaving the role on one’s
    own (#168)").
  - At a shared key (a `onePer` that doesn't name `@author`, such as one
    decision per proposal), anyone granted `/record/write` there can start a
    chain of their own, and outrank the first; `.byCreator` in a grant keeps
    others from editing a chain, not from replacing it. A collection that
    needs one writer per key limits who may write it (02 §7.1, §7.3). By design. Keys are
    unique in a space, not a collection, so it can also write first at a
    shared key of collection X from a collection Y it may write (one with
    a `onePer` without `@author`), and X's record for those parts can't be
    written (02 §4.1).
  - Granted `/collection/define`, it can write a rival first definition of a collection
    that names a point before the real one's, or a rival and its own delete
    of it, so that no one first defined it and, unless the rivals are the
    same definition, no definition of it is in force and nothing can be
    written in it until someone who may define it settles it, and again after, by backdating
    another (02 §6.3). It can stop a collection this way, but can't choose
    its rules or write without them. A rival with the same body leaves the
    collection in force but with no first definer, taking its definer's
    control away for good. Those who may define collections are trusted not
    to.
  - A collection's contract binds only readers that judge it: peers keep and
    sync a version that fails it, and readers leave it out of what they
    count, on every read path, along a record's chain, and without letting
    it hold a `onePer` key (09 §2, §4.1;
    `packages/core/tests/contracts-reads.test.ts`, `contracts-squat.test.ts`,
    `contracts-pending.test.ts`). An implementation that doesn't judge
    contracts shows it. Every such version costs every peer storage, like
    any record it may write
    ([#33](https://github.com/leifriksheim/minca/issues/33)).
  - A contract judges the versions a claim cites, not whether they are
    current (09 §6.2): a reaction withdrawn before or after a claim doesn't
    un-fame it (`scenarios/tests/fame.test.ts`). By design.
  - In a line, a payer can double-spend a payment a payee has built on: both
    twins fail, and so does the payee's version that claimed one and
    everything after it in the payee's line, for good, since there are no
    corrections (09 §7.3, §7.5; `packages/core/tests/contracts-line.test.ts`,
    `scenarios/tests/credit.test.ts`). The payer's own line ends there too.
    Only waiting before building on a payment, or a witness, protects a
    payee.
  - A member can't write in another's line, or open a second line of its
    own: only versions at the author's own line key count (09 §7.2). A delete
    is a step of a line: one written as a payment's twin is a double spend,
    whether or not it carries `retain`, and nothing after a delete counts, so
    no account restarts its balance (09 §7.3, §7.5;
    `packages/core/tests/contracts-line.test.ts`, "the line rule: deletes").
    As with any narrowed rule, a version whose `seen` is from before the
    `line` declaration escapes the line rule (09 §7.5).
  - An honest account whose two devices write in one line while apart kills
    that line for good, like a double spend (09 §7.5). Apps keep a line on
    one device at a time.
  - A newer contract or line declaration with a key an older reader doesn't
    know leaves that collection, and what cites it, unjudged by that reader:
    old and new readers' counts split until the old one updates, but never
    silently (09 §1, §2, §7.1).
  - A grant of `/member/remove` or `/role/unassign` without a policy on
    `.roles` reaches everyone but the founders. The space chose that by
    writing the grant (03 §2.3).
  - Founders answer to no one but themselves: nobody else, another founder
    included, can remove one or change its roles, and no vote can bind a
    change to who may do what
    ([#160](https://github.com/leifriksheim/minca/issues/160)). A founder
    who turns against the others can't be stopped there; they can only leave
    or move to a successor (03 §2.1, §2.7).
  - A space can end headless: its founders have stepped down or left, or it
    has `top: "none"`, and no member holds what it takes to change roles or
    the key. Members keep what their roles allow, and the way on is a
    successor (03 §2.1, §2.7; `constitution.test.ts`, "the last founder steps
    down…").
- **By design.**
  - Whoever may define roles is trusted to. A definer can write power into a
    role it keeps, or nest it in a role it defines, and keep it after losing
    the role that let it define; two definers can define roles for each
    other. It lasts until someone with `/role/define` writes the role again
    (03 §2.6; `roles.test.ts`, "whoever may define roles is trusted to…";
    `access-attacks.test.ts`, "parking power in a role the definer keeps…").
  - A role keeps its grants when its definer is later demoted or removed:
    each definition is judged where it was written, until the role is written
    again (03 §2.4; `roles.test.ts`, "a role keeps its grants when its definer
    is later demoted").
  - A definer can weaken a role, even empty it, by writing a rival
    definition apart from the others, until a definition that saw them all is
    written. It fails closed, never open. Where a role holds `/role/define`
    for itself, rivals can drop that grant, and then nobody in the role can
    end the rivalry: a founder repairs it, and without one it takes a
    successor space. The library's templates give `/role/define` for a role to another
    role (03 §2.4; `roles.test.ts`, "rivals can lock a role that defines
    itself; a founder repairs it").
  - A member with two accounts sidesteps `.self`: the second must be a member
    assigned the role, visible and unassignable like any other (03 §2.6).
  - Under `top: "none"` there are no founders: anyone may be removed by
    whoever holds the grant, the creator included, and two holders who remove
    each other apart both stand removed, so a co-op can lose every steward
    (03 §2.1, §4.3; `constitution.test.ts`, "top: none"). The constitution
    chose it.
  - Who may name a successor is judged in the writer's own view, like every
    change: where no member holds `/space/succeed`, any member may, and a
    member can name a view from before anyone held it. A successor binds no
    one, so this gives nothing but a name in a list; a member tells a
    successor from a copy by the succeed here and the successor's own
    `succeeds` together. Rival successors have no order: an app that ranked
    them would hand the choice to whoever grinds the lowest id (03 §2.7).
    Nothing bounds how many succeed records a member writes, each one
    stored and replayed by every peer
    ([#33](https://github.com/leifriksheim/minca/issues/33)). A succeed that
    stands stays named after its namer is removed, since the removal saw it;
    an app shows whether each namer is still a member.
  - Whoever may take any role from an account strikes everything it did that
    hadn't seen that, as a removal does: unassigning a minor role strikes the
    target's concurrent actions, not only what needed it (03 §4.3).
    "Concurrent" means unseen: honest nodes sync, and the unassigner's cutoff
    covers what it holds (03 §6.3).
  - A member the arguments lack reads as `null`, as in UCAN, so a negated
    statement (`!=`, `not`) holds where an argument is missing: a grant of
    `/` with `["!=", ".role", "admin"]` also lets its holder remove an admin,
    since `/member/remove` has no `role`. A space gets what its policies say;
    the spec says to write what is allowed (01 §7.4, 03 §2.2; `roles.test.ts`,
    "a missing argument reads as null…").

_Source: 03 §2, §4, §5, §8.3, §9; 02 §4.1, §6.3, §7.3; 01 §9; `packages/core/docs/warrants.md`. Tests: `packages/core/tests/constitution.test.ts`, `packages/core/tests/record-keys.test.ts` ("a first version at someone else’s key, ground to a lower id"; "rival first definitions by two accounts name no one…"; "a backdated rival with a ground-low id does not put its rules in force"), `packages/core/tests/attacks.test.ts` ("a sealed body copied into another record, or another collection, reads as unreadable"), `packages/core/tests/space.test.ts` ("a sealed body moved to another record, collection or space does not open"), `packages/core/tests/envelope.test.ts` ("a box opened with the wrong bound, label or key opens nothing"), `packages/core/tests/rules.test.ts`, `packages/core/tests/roles.test.ts`, `packages/core/tests/access-attacks.test.ts` ("attacks on grants"), `packages/core/tests/space-access.test.ts`, `packages/core/tests/access-convergence.test.ts`, `packages/core/tests/warrants.test.ts`._

### 3.3 Former member

- **Holds.**
  - Its power was its roles' grants, and nothing else. Removal takes all of
    it, and ends every role assigned to it that hadn't seen the removal, one
    assigned concurrently with it included; after a re-add, only assignments
    that saw the removal count (03 §2.5, §4.4; `access-attacks.test.ts`,
    "removal against re-add…"). Unassigning takes that role and, like
    removal, strikes everything it did that hadn't seen it (03 §4.3;
    `access-attacks.test.ts`, "taking one role strikes every concurrent
    action…", "backdating past an unassignment"). Nothing it handed a key
    survives, because it could hand nothing.
  - What it writes claiming to have seen its removal does not count, a
    revoke included, since a revoke needs a place. Ordinary records it writes claiming not
    to have seen it are withdrawn, unless the removal's cutoff covers them (03 §5.1, §6.3).
  - It can't make its own actions count again: its removal stands. But a
    reduction of its remover it was allowed in a view it names, backdated,
    stands too, and strikes the remover's work since that view (§3.2; 03
    §4.3; `access-attacks.test.ts`, "a removed member’s backdated
    unassignment of its remover…"; [#166](https://github.com/leifriksheim/minca/issues/166)).
  - An assignment or definition it makes concurrently with its removal, or
    with the loss of any role, or backdates, is struck, and gives no power to
    anything resting on it, a record citing it included, whether or not that
    cites the removal (03 §4.3, §5.1; `packages/core/tests/access-attacks.test.ts`).
- **Does not hold yet.**
  - A reduction that rests on a change struck since is dropped, but still
    strikes what its target did concurrently: strikes are settled before
    validity cascades (03 §4.3). It needs no sock: a definition it backdated
    is struck, a member who saw that definition removes someone, and the
    removal is dropped while the target's concurrent changes stay struck.
    Disruption, not power: nothing is granted
    ([#170](https://github.com/leifriksheim/minca/issues/170), item #191).
  - What it wrote into roles while it held `/role/define`, its own roles
    included, survives it until someone writes the role again (§3.2, by
    design).
  - A version it backdates is withdrawn, but a colluding member can still cite
    it as evidence in a version under a contract, and readers count it,
    since they judge a cited version as of what the citer saw
    ([#170](https://github.com/leifriksheim/minca/issues/170), 09 §6.2).
    This is a gap in what readers count, not in what peers store.
  - It can rejoin through any open role invite it saw: removal closes none
    ([#170](https://github.com/leifriksheim/minca/issues/170)) _(traced)_.
  - A key change is only a SHOULD, and only a member granted `/key/change`
    can make one. In a space where nobody holds it, it reads everything new
    ([#170](https://github.com/leifriksheim/minca/issues/170)) _(traced)_.
  - Hosts and carriers can't read the member list, so they keep syncing with
    it until the key changes ([#170](https://github.com/leifriksheim/minca/issues/170)) _(traced)_. A peer that never says who it is
    is never let go ([#170](https://github.com/leifriksheim/minca/issues/170)).
  - A key change made at the same moment as its removal is boxed to it. The
    change stays due, so the next key leaves it out, but until then it reads
    ([#170](https://github.com/leifriksheim/minca/issues/170)).
  - It can keep adding to the history every peer must store and replay
    ([#170](https://github.com/leifriksheim/minca/issues/170)).
  - Its removal withdraws what it wrote before that the removal's cutoff
    doesn't cover: the remover's node covers only the lines it holds unbroken,
    in the collections it holds, up to 1024 places (03 §6.3). Peers don't
    check how a cutoff was built, so a remover may leave the removed account's lines out
    ([#166](https://github.com/leifriksheim/minca/issues/166)).
  - It keeps a private space's first key, from which `onePer` keys are
    derived, so it can test guesses of who voted on what in envelopes that
    reach it later (02 §7.3, 03 §8.6).

_Source: 03 §5.1, §6.3, §9; 04 §6.3. Tests: `packages/core/tests/space-access.test.ts` ("a removed member cannot write"), `packages/core/tests/roles.test.ts`, `packages/core/tests/key-change.test.ts`._

### 3.4 Key thief

**Principle.** It concerns a copy of a key its owner didn't make, and nothing
else. A stolen device key is treated like a stolen session token in
an ordinary app: what it signed before it was revoked stands, and that is on
whoever held it. The defence is revocation, and expiry where peers can judge
it (live use, 01 §7.6). Minca does not try to detect a copied key: a fork
proof (02 §4.10) withdraws a copy's writes only where it happens to be
proven, and nothing relies on catching a copy. Reviews measure this section
against that, not against catching the copy. It does not extend to removal
and revocation: a second version at a place a cutoff covers must be caught
and withdrawn (03 §6.3), and is, because the remover's node holds the covered
line. That is relied on, by members (§3.2) and former members (§3.3).

- **Holds.**
  - Once the owner revokes the key, what it signed past what the owner had
    seen of it stops counting, records and changes to who may do what alike, under every note to that key. A
    revoke the thief writes first, covering what it signed in advance, doesn't
    shield it: every revoke applies (03 §6.4).
  - It can't pass its power on: a note is one link from the account's root
    key, and a token it signs for another key is a note from itself, which
    acts for no account but its own (01 §7.5). So the revoke of the key is
    the whole of the answer: from then on, with the revoke's cutoff, nothing
    the key signs counts, and no other key holds anything through it.
  - Once a fork of the key's line in a collection is proven, what it signed
    in that collection from the proven place on stops counting, records and
    changes to who may do what alike (02 §4.10, 03 §4.3, §6.5).
- **Does not hold yet.**
  - It can sign a twin in any of the account's lines (09 §7) in a space its
    note reaches, a double spend that ends that line for good: there are no
    corrections, and a revoke doesn't bring back a line (09 §7.5).
  - It can revoke the owner's other keys, with a cutoff of its choosing: a key
    whose note grants `/` is the account while it lasts
    ([#165](https://github.com/leifriksheim/minca/issues/165)).
  - A fork it makes at the start of a line withdraws everything the owner's
    device wrote in that collection ([#166](https://github.com/leifriksheim/minca/issues/166)).
  - Under a note granting `/access/change`, it can make a founder's account
    step down, even with the key already revoked, and nothing gives founder
    status back: a stepping down is never struck. That is all a revoked key
    can do: one its revoke or a fork proof reaches strikes nothing and
    withdraws nothing, and a leaving or anything else it signs is struck as
    usual (03 §4.3; 01 §8; `constitution.test.ts`, "a revoked key stepping
    down ends founder status, and does nothing else", "a revoke stops the
    key…").
- **By design** (the principle above).
  - What it signed before the revoke stands. The revoke stops the key from
    then on, but for one thing: it can still end its account's founder
    status (above), and its cutoff keeps what the revoking node held of the key's
    lines, so a copy's record or access change that reached that node first,
    an assignment in `sys.assign` say, keeps counting.
  - Only a fork proven in the same collection withdraws it. Lines are kept
    per collection and nothing orders a key's writes across them (02 §4.10),
    so a copy that writes only where the owner's device doesn't is never
    caught, and a fork proven in one collection leaves the key's writes in
    the others standing.
  - Records are judged with no time, so what it signs counts until the owner
    revokes the key, however long ago its note ran out; only live use (knocks,
    live messages, connecting) ends with the note (01 §7.6). Signing out
    writes a revoke of the session key, delivered when that device next
    syncs, but a device lost while signed in has to be
    revoked from another device, which needs a list of the account's session
    keys. A revocation does not reach spaces created after it
    ([#165](https://github.com/leifriksheim/minca/issues/165)).

_Source: 02 §4.10; 03 §6.4, §6.5; 01 §7.5. Tests: `packages/core/tests/writer-logs.test.ts`, `packages/core/tests/space-access.test.ts` ("a revoked note…", "a key cannot pass its note on: a two-link proof counts for no peer"), `packages/core/tests/validation.test.ts` ("a note is one link…"), `packages/core/tests/roles.test.ts` ("a revoked key: what it signed stands up to the cutoff"), `packages/core/tests/access-attacks.test.ts` ("a revoke or a fork proof undoes a thief’s change to who may do what…")._

### 3.5 Root thief

- **Does not hold.** The seed is the account. Whoever holds it:
  - is the account for good: there is no rotation and no recovery ([#9](https://github.com/leifriksheim/minca/issues/9));
  - is a founder of every space whose constitution names the account: it
    holds every command there, and nobody else, another founder included,
    can remove it. The owner can step down or leave, which takes founder
    power from the account, the thief's copy included, for good, and strikes
    what the thief did that hadn't seen it; so can the thief, first. Nothing
    undoes a stepping down; a leaving is undone by revoking the key that
    signed it, and made again (03 §4.3). The
    others' way out is a successor space (03 §2.1, §2.5, §2.7;
    [#160](https://github.com/leifriksheim/minca/issues/160));
  - derives the account key, and from it every member key, so it reads every
    private space the account was, is or will be a reader of; and the local
    key, so it reads the account's data at rest (01 §11.1, 03 §9.1, 05 §15).

### 3.6 App or program

- **Holds.**
  - Its writes count only where its note covers them, and a home grants an
    app only the spaces chosen for it (01 §8, 06 §2). It can be given a note
    only for a key it shows it holds, never the home's own or another
    connection's, so disconnecting it revokes nobody else (06 §2.5).
  - Given the whole account, it can't keep the person from pausing or
    removing their own automations: they are `sys.automation`, which nothing
    defines, so no definition it writes applies to them (03 §13.2;
    `packages/core/tests/own-automations.test.ts`). Disconnecting it removes
    every automation it proposed and every one its own key wrote, whichever
    app that one names (06 §2.10; `packages/core/tests/connect.test.ts`,
    "disconnecting a whole-account app removes what its own key wrote…").
  - Given the whole account, it holds the account key, not the local key, so
    it can't open the registry store's sealed entries, and of those it gets
    nothing else it lacks but invite secrets waiting to be used and the CLI's
    writer keys (01 §11.1, 05 §15). The account key does yield every space key
    the account's registry lists.
  - Where it can write the account's vault, a wrap of another account it
    plants, or a passphrase wrap it edits to fewer rounds, does not open as
    the account (01 §11.3).
  - A program connected by code gets what the app it connects through asks
    for and the person allows, never more than its key signed for: the app
    can't use its proof for the app's own connection, nor ask for more than
    records when it asked for records only, nor use it from another origin;
    and an app's own proof can't be passed off as a program's (06 §2.4, §3).
    What the program asks for is only a request: the app chooses the terms,
    and the home shows the person a warning when a request by code asks for
    more than records. A request with `recordsOnly` never gets the contact
    key (06 §2.8).
  - The note carries no label a peer reads: what a version, a live message or
    a knock may do is what its note grants, whatever its `meta` says (01 §8).
  - A policy on its note (a limit to some collections, say) binds it at
    every peer, and it can't escape its note by signing one for another key
    of its own: that note acts for no account, so a records-only key can't
    shed the label others show it with, nor knock or pin as the account
    (01 §7.4, §7.5).
  - It can't take the account's `onePer` key in one collection with a record
    of another: every peer that reads the definition refuses a first version
    at a key of a `onePer` key's form outside a `onePer` that gives it
    (02 §4.1).
- **Does not hold yet.**
  - A records-only grant can write the account's `sys.profile`, and so have
    contact requests sealed to itself; and `sys.memberkey`, to have new space
    keys sealed to itself _(traced)_ ([#165](https://github.com/leifriksheim/minca/issues/165)).
  - `scope: account` hands over the account key, and `scope: spaces` member
    keys, neither of which ever rotates. It reads what those keys open after
    its grant expires ([#165](https://github.com/leifriksheim/minca/issues/165)).
  - A key whose note grants everything about the account (`/`, no policy),
    an app granted write to every space included, can pose as the account's
    node to a client that pinned the account, and a pin checks no revoke. A
    narrower note can't (04 §5.2)
    ([#165](https://github.com/leifriksheim/minca/issues/165)) _(traced)_.
  - Its records count until its key is revoked, not until `expiresAt`: only
    the home that granted it revokes it, while signed in there (06 §2.9,
    [#165](https://github.com/leifriksheim/minca/issues/165)).
  - Everything a key thief can do in §3.4, with its own key ([#165](https://github.com/leifriksheim/minca/issues/165)).
  - A version it writes in one of the account's own spaces (the registry,
    contacts, carry spaces) without `/account/write` is refused by the
    account's devices, but a carrier, host or mirror reader that can't tell
    the space is the account's own lets it stand, so they disagree (03 §5.2,
    [#10](https://github.com/leifriksheim/minca/issues/10)) _(traced)_.
  - An account's chosen key is the same in every collection, so with a
    records grant it can write a record at a chosen name another app of the
    account's uses in another collection, and that app can't write its record
    there. Only the account's own keys and apps can; apps should choose names
    that include their collection (02 §4.1). By design.

_Source: 01 §7.5, §8, §11; 06 §2, §3; 05 §15; 02 §4.1. Tests: `packages/core/tests/live.test.ts` ("a records-only key cannot shed its label by passing its note on"), `packages/core/tests/doors.test.ts` ("opens only with its door…"), `packages/core/tests/record-keys.test.ts` ("a key in another collection"), `packages/core/tests/connect.test.ts` ("an app can only ask for a key it holds, and none the home already uses for something else", "a request with a field it does not know is refused…"), `packages/core/tests/records-only.test.ts`, `packages/core/tests/connect-code.test.ts`, `packages/core/tests/ucan.test.ts`, `packages/core/tests/account-vault.test.ts` ("the account key does not open the registry store's sealed entries", "a wrap from another account does not open as this one", "a passphrase wrap edited to fewer rounds, another salt or another id does not open")._

### 3.7 Relay

- **Holds.** It can always drop and delay. Beyond that:
  - It can't read or change what two sides say on a channel, pairing or
    connecting by code: each direction has its own key from the secret and an
    ephemeral exchange, and each message is bound to its type and place, so
    one sent back to its sender, relabelled, repeated or reordered does not
    open (01 §15.2, 06 §3). The room's name is a hash of the secret, so it
    never learns the secret itself.
  - Someone who records a channel's room and learns its secret later still
    opens nothing (01 §15.2).
  - On the app's side a connect code serves one program: once one has asked,
    the app answers nobody else (06 §3).
  - Someone else who holds the code (it is on a screen, and pasted) can
    answer the program first and pose as the app, but the program takes a
    note only from the account the code names (its fingerprint, 06 §3), which
    they can't sign. Posing gets them the program's proof, which names the
    origin they claimed and so works only from there, and denies the program
    its connection.
- **Does not hold yet.**
  - That it can't answer in peers' place: they talk over DTLS channels whose
    fingerprints both sign in the mesh proof (04 §5.1, §6.2), so a relay that
    answers for one should fail the proof. No test shows it ([#162](https://github.com/leifriksheim/minca/issues/162)).
  - It learns who meets whom: IP addresses, session DIDs and rooms together
    ([#162](https://github.com/leifriksheim/minca/issues/162)).
  - Joiners don't prove they hold their DID's key, so anyone can take a
    victim's place in a room ([#162](https://github.com/leifriksheim/minca/issues/162)).
  - Its door mailbox can be flooded ([#162](https://github.com/leifriksheim/minca/issues/162)).
  - It can fill the 32 exchanges an app offering a code runs before the right
    program arrives, with peers that say hello, so the program is never
    answered. Denial of service only: none of them holds the code, so none
    can ask.
  - Someone else who holds the code can also ask before the program does,
    posing as it. The person sees only the name it gives itself, and may
    allow a note for its key; the real program is then never answered.

_Source: 04 §1, §5.1, §6.2; 07 §5; 01 §15.2; 06 §3. Tests: `packages/core/tests/signaling.test.ts`, `packages/core/tests/relay-refusal.test.ts`, `packages/core/tests/pairing.test.ts` ("a message sent back to the side that sealed it does not open there", "someone who learns the secret later cannot open a recording of the exchange"), `packages/core/tests/connect-code.test.ts` ("a relay that relabels or repeats messages changes nothing", "a recording of the room, and the code learned later, open nothing", "a code works for one program: a second with the same code is not answered", "someone else holding the code who answers first, with a note from their own account, is refused")._

### 3.8 Host or carrier

- **Holds.**
  - It cannot read the bodies of a private space's records outside the
    collections 03 §8.2 keeps in the clear, without the space key.
  - It cannot alter or forge what it serves (02 §3).
  - Without the space key, it can't compute or test a private space's
    `onePer` keys, so it can't check a guess of who voted on which poll, or
    how (02 §7.3, 03 §8.6).
  - From the account's wakes it learns a collection, spaces, topic tags,
    whether only others' records wake, since when, whether paused, and which
    app's address a click leads to; for a `where` on a computed field, also
    the collections that field reads, in the spaces whose definition reads
    them, untagged, and from the keys (`wake:<id>:<collection>`) that they
    belong to one automation (`packages/core/tests/computed.test.ts`, "a
    wake for a filter on a computed field also wakes on what that field
    reads"); never the values behind a private
    space's tags nor the person's words for what they want to hear about
    (03 §15; `packages/core/tests/carrier.test.ts`, "a carrier gets tags,
    never the values it matches"). Any `where` condition on a field declared
    a topic becomes tags. In a public space a tag can be worked out from the
    space id, so a guessed value can be checked against it (02 §8.2).
- **Does not hold yet.**
  - Live messages, such as typing, presence and call signalling, reach it in
    plaintext ([#170](https://github.com/leifriksheim/minca/issues/170)) _(traced)_.
  - A host asked for a bot receives a lasting role invite carrying the space
    key ([#170](https://github.com/leifriksheim/minca/issues/170)) _(traced)_.
  - A bot acts with its own role's grants on what members ask, so someone
    who may instruct it can reach past their own grants through it. The
    library narrows this: the dialog that adds a bot offers only roles whose
    every grant the adder holds (`AddBotDialog` in
    `apps/shared/src/CommunitySetup.tsx`), and `minca agent` follows what a
    record asks only when its writer holds every grant of the bot's roles
    (`writerInstructs` in `packages/cli/src/agent-automations.ts`;
    `packages/cli/tests/agent-automations.test.ts`, "takes instructions only from
    someone holding every grant of its roles"). Neither is protocol: a bot run
    by other code, or a role redefined after the bot was added, can still act
    for someone with more than they hold, and an automation's own words are
    its maker's ([#170](https://github.com/leifriksheim/minca/issues/170)).
  - A removed carrier keeps proving read until the key changes ([#170](https://github.com/leifriksheim/minca/issues/170)) _(traced)_.
  - It sees envelopes: authors, collections, record keys, timing, and the
    member list. `profile:` keys and collection names say whose and what
    (03 §8.6, [#223](https://github.com/leifriksheim/minca/issues/223)).
  - It can hold back what it likes from a node that syncs with nobody else.
    Only a node holding part of a space notices a gap, and only in ordinary
    collections ([#166](https://github.com/leifriksheim/minca/issues/166)) _(traced)_.

_Source: 03 §8; 02 §3, §7.3; 06 §4. Tests: `packages/core/tests/record-keys.test.ts` ("in a private space, nobody without its key can compute or test one (#87)"), `packages/core/tests/carrier.test.ts`, `packages/core/tests/caches.test.ts`, `packages/core/tests/sync.test.ts`._

### 3.9 Network attacker

- **Holds.**
  - A connection to a node is authenticated by the node's session DID, and
    bound to an expected node when its DID or account is pinned: a node
    answering in its own name at a pinned address is refused (04 §5.2, §6.1).
    Nothing binds the handshake to the connection, so one that relays the
    real node's handshake is kept out only by TLS.
  - A node URL must be `wss://`, or `ws://` only to the same machine (04 §5.2).
  - In pairing, each direction has its own key and each message its type and
    count, so a message sent back to its sender, relabelled, replayed or
    reordered does not open (01 §15.2).
- **Does not hold yet.**
  - An unpinned connection to a node accepts whichever node answers, and an
    account pin accepts any key whose note grants everything about the
    account, and checks no revoke ([#165](https://github.com/leifriksheim/minca/issues/165)) _(traced)_.
  - Whoever later obtains a space key reads everything sealed under it and
    every earlier key it carries. Keys change when a reader leaves, or when a
    member granted `/key/change` changes them; never on a schedule, and not
    at all in a space where nobody holds `/key/change` ([#170](https://github.com/leifriksheim/minca/issues/170)).

_Source: 04 §5, §6.1; 01 §15.2. Tests: `packages/core/tests/ws-transport.test.ts` ("only a note for everything about the account pins…"), `packages/core/tests/pairing.test.ts` ("a message sent back to the side that sealed it does not open there", "a message relabelled as another type does not open", "a message replayed, or delivered out of order, does not open")._

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
- **Per-message forward secrecy.** A space key opens everything sealed under
  it. Changing keys bounds what a later key opens; ratcheting group keys (MLS,
  say) are not a goal before v1.
- **Rollback of a data folder** by whoever can write it (a pod in a synced
  drive, say). Sealing at rest binds an entry's name, not its version, so an
  older sealed registry entry, such as a space key from before a key change,
  still opens, and an entry can be deleted (05 §15,
  [#215](https://github.com/leifriksheim/minca/issues/215)).
- **Protecting a device that is already compromised** while it runs. Keeping
  keys from being exported is up to each implementation (see
  `packages/core/docs/node.md`). The desktop app keeps its app's key and grant
  at rest in a long-running process's folder, sealed under a key in the
  system's keychain: a copy of the folder yields no key, grant or private
  body, and shows what a carrier sees (§3.8). A program running as the person
  can still ask the keychain, as it can read a browser profile.

## 5. Reviewing a change against this page

Every change to the protocol is reviewed adversarially before it merges (see
`CLAUDE.md`, and the protocol reviewer's instructions under `.claude/`). This is the one list
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
