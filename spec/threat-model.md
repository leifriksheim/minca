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
| **Relay**            | Minca or Nostr: the sealed blobs under the topics it serves, and what it keeps for inboxes and short links         |
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
    Passing an invite on, it can't change who invited, nor the relays and
    nodes it names: an invitation is signed by the inviter's key under a note
    that lets it invite to that space, and one edited, or signed again by a
    key of its own, doesn't check out or names it as the inviter (03 §7.4;
    `packages/core/tests/invitation.test.ts`, "relays and nodes changed by
    whoever passed it on are refused when joining", "a key whose note is
    about another space may not invite to this one").
  - It can't knock as an account: a knock is signed under a note that grants
    `/account/write` for the whole account, wherever it is left (07 §6;
    `packages/core/tests/inbox.test.ts`, "needs a note that grants
    /account/write…"). A knock it copies into a record of its own opens as nothing
    (`packages/core/tests/attacks.test.ts`, "a knock re-posted by someone
    else…"), and one sealed to one inbox doesn't open when re-sealed to
    another (`inbox.test.ts`, "sealed to one key, naming another…").
    Holding a short link, it can seal other blobs under its secret and leave
    them under its topic, but a joiner takes only the blob whose hash is the
    link's pin, so it can't change what a given link gives anyone, nor clear it:
    no key hashes to a link's topic (03 §7.7; `invite-link.test.ts`, "a link
    holder's own blob…", "nobody can clear it…").
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
    A short link is as good as a long one for as long as anyone who holds its
    sealed invite leaves it in a mailbox: its `until` stops only the
    account's own copies (03 §7.7). Whoever passes a link on can make a new
    one under the same secret, joining the same role, with relays and nodes
    it chose, but only in an invitation it signed itself, which names it as
    the inviter (03 §7.4).
  - The nodes an invite names are dialled by whoever joins with it, so a
    node named by whoever signed it learns the joiner's address and when it
    is online, until the space names keepers that leave it out. They are
    never passed on in the joiner's own invites (03 §7.4).
  - A knock's invite that reaches anyone but the person it was for, passed
    on by them, taken from a device of theirs, or opened by an app they gave
    the contact key to, lets whoever joins first be taken for them: joining
    is the answer, and the knocker closes the invite only once it sees
    someone join (07 §8). The door answer had to be signed with a key derived
    from the contact key, so it stopped a passed-on invite but not a holder
    of that key. Accepted for a passed-on invite, which the person could as
    well forward the knock; the app case is
    [#313](https://github.com/leifriksheim/minca/issues/313) (§3.6).
  - A role link's invite is closed after a key change only once a device of
    the inviter's account that may close it comes online; meanwhile someone
    removed who kept the link can join with it again
    ([#170](https://github.com/leifriksheim/minca/issues/170)).
  - What it sends must be checked, stored or refused, with few limits
    ([#33](https://github.com/leifriksheim/minca/issues/33)). That includes knocks, in an inbox or a shared
    space (07), and an inbox's mailbox can be flooded ([#162](https://github.com/leifriksheim/minca/issues/162)).
  - Knowing any room a peer is in (from a space id, or a channel's secret),
    it can say hello there: the peer offers to it and it learns the peer's
    addresses, as anyone in a room always could. It can't say anything
    through relays under another's DID: every message is signed, every field
    of it, by the key its `from` names (04 §2). Under DIDs of keys it makes, it can fill the room's 64 places,
    so nobody new is heard there, and it can fill a topic's watchers on a
    Minca relay ([#162](https://github.com/leifriksheim/minca/issues/162)).
  - Text it writes on GitHub, an issue on a public repository a connected bot
    reads, reaches the model in a run that may write on GitHub. It is marked
    as data, but only the model keeps to that. Accepted, as for any chat bot
    with an integration: the bot only ever reaches the repositories its
    connection was made with, each result checked by its own repository
    (`packages/cli/tests/github.test.ts`,
    `packages/cli/tests/github-search-scope.test.ts`), and never sees a token.
  - Where a space lets it in, as an open community does, it can ask a
    connected bot what is in the connected repositories, and set off what the
    community's automations do on GitHub (`packages/core/docs/bots.md`).
  - Sent a configurer's unused connect link, an admin of another GitHub
    organisation who opens it connects the bot to their own repositories: the
    link is a bearer link for ten minutes, as most such links are (08 §3.1).
  - Any page can open the account home at a connect link it made (06 §3),
    and ask for a records-only note, in the whole account (every private
    space included), for a key it holds, under any name. Where an app shows
    its real origin, a program shows only a name it chose. The home says a
    program on a computer opened it, and to allow it only if something they
    started just now asks for its code; that is the only defence. The check
    doesn't help here: the note is sent on Allow. This is weaker than a
    device-code sign-in (`gh auth login`), where a page must also get the
    person to type its code at the real site; here the link carries the
    code, and one click is enough. By design: the code a person types guards
    the program they started, which is the case a person can't see for
    themselves.
  - A page that takes over an app's tab while the account home waits for the
    app's request (up to 10 minutes in the reference home) can send its own
    request, in the window the person opened from the app. The home shows
    that page's origin and grants nothing under the app's; the person
    reading the origin is the only defence (06 §2.3). By design.
  - A pairing link it makes puts the device that opens it in its account:
    it is the offering side, so it confirms the codes itself, and the code
    check proves only that the two screens are one exchange, not that the
    computer is the person's. Any page can deliver the link, by opening the
    account home with it. A tab with no session takes it in one tap: after a
    warning where the device keeps an account (01 §15.3), with none where it
    keeps no account. A tab that opens with a kept sign-in asks once the
    account has arrived: add it, or switch to it if the device keeps it
    already; the account signed in stays filed either way
    (`packages/core/tests/take-up.test.ts`, "a pairing link opened where a
    sign-in is kept"). "Not now", even once the code shows, leaves the
    exchange before the account arrives (same file, "… while the code shows
    stops the pairing, even if the computer confirms after"). Those warnings and that question are the only defence. By
    design, as with any "scan to log in" link. Once added, its account can
    look like the person's own: its name follows its profile, and an avatar
    is for recognition only, since a look-alike takes seconds to find.
  - A host with limits carries for anyone, and an account is only a key, so
    a stranger can take any number of accounts' free room. The reference
    host makes at most 5 subscriptions a day for one address (an IPv6 /64
    counting as one), whichever call makes them, which slows a stranger with
    many addresses and stops none; one with a /48 of IPv6 holds 65 536 of
    them (08 §1.1;
    `packages/cli/tests/host.test.ts`, "asking to pay first makes no
    subscription past the limit either"). Behind one shared address, as a
    proxy without its header set or carrier-grade NAT, a stranger can spend
    the day's 5 for everyone there. The free line counts accounts, which
    members may share, so a community writing as a few accounts stays under
    it. A host whose disk is new counts a large space's history again if it
    takes longer than the first minutes to come back. A community can also move to a successor space (03), which the line
    counts from nothing, with a whole grace. One account's room is
    bounded in bytes after a notice that neither a new key nor a dip under
    resets: past it the host stops carrying its largest spaces for it until
    the rest fit, and an account over by its carry space alone is carried for
    no more until it pays; past its free room an account's balance, and a
    community's fund, pay for its size while they have money (08 §1,
    §1.1, Room, §2;
    `packages/core/tests/host-limits.test.ts`, "over its room…", "the notice
    is the account's…", "a carry space over its room by itself…";
    `packages/cli/tests/host.test.ts`, "past its notice, the host holds back
    an account's largest space…"). Every space a member names counts against
    their room, so one member's writing in a shared space fills every
    member's; the host then holds back each such member's largest spaces,
    which may be their own rather than the shared one, and keeps carrying a
    held space for any member with room. A held space's bucket copy goes
    after `keepDays`, and goes back whole once it is carried again
    (`packages/core/tests/host-limits.test.ts`, "a space held back for
    keepDays…"; `packages/core/tests/mirror.test.ts`, "taken out of the
    store and mirrored again…", "a mirror that only ever read…", "a host
    that only read its space back…"). A writer also drains a community's fund,
    or a member's balance, as fast as they make a space grow. Paying makes
    an account's room unbounded, bounded only by how fast its balance
    drains, and every paying member who names a shared space pays for its
    whole size. A grace is lent, in money: the balance goes below zero
    through it until it owes as much as the largest payment ever made into
    it, and the next payment pays that first, so a little money now and then keeps
    nothing carried, the least payment into a large space (or one grown
    after paying) buys what that payment buys at its size, no payment
    shortens a grace (anyone may pay into a fund, so one could otherwise
    cut it), and nothing more is owed once the grace is over
    (`packages/cli/tests/fund.test.ts`, "its grace is lent…", "a grace lends
    what the payment before it was…", "paid while small, grown…", "no
    payment shortens a grace…", "a payment that leaves it owing…", "once its
    grace is over…"), even on a host that came back from its bucket on a
    new disk (`packages/cli/tests/fund.test.ts`, "a fund comes back from
    the bucket…"). A fund is drawn on from its first payment, at one GB,
    and never past its grace. A balance is charged by the size last
    measured, every hour or so, so growth between measures goes uncharged:
    the host's cost. Whoever brings a lapsed fund back starts a grace that
    lends only what their payment left above zero, so a stranger paying off
    the rest of a debt can't put it back on the members (`packages/cli/tests/fund.test.ts`,
    "whoever brings a fund back…"). Time the host was down is charged to
    nobody ("a gap longer than an hour…"). A card payment disputed
    later still counts as the largest payment a grace lends: the host's
    cost, as the chargeback is. An
    account at a host with limits is lent nothing: its room's notice is its
    grace. One payment keeps an account whose spaces fit its free room
    `"paid"` for good, so never dropped for being idle: accepted, as that is
    at most `accountBytes` for each such account. Whoever
    pays into a fund nobody else has can so leave its community owing at
    most what they paid, should it fund itself later; accepted. Still open
    ([#289](https://github.com/leifriksheim/minca/issues/289)): an account
    with two subscriptions on one carry space is held and refused by the
    smaller room, and at a host without limits one that changes keys leaves
    its grace's debt behind.
    Accepted otherwise: it is the host's cost.
  - Anyone holding an invite link that is still open can push a community
    over a host's free line by joining more accounts and writing from them,
    and join again with new keys as fast as they are removed, so a community
    with an open link may have to close it, or pay (08 §1.1). Paying a
    little into its fund, which anyone may, hides the notice from members
    while it pays, so their carrying can stop when it lapses with no notice
    after. Accepted: it costs the stranger money, and the fund's status says
    when it runs out. Letting go of
    a space for an hour does not reset its line
    (`packages/core/tests/host-limits.test.ts`, "a space nobody names for a
    while keeps its line").
  - Anyone who knows a space's id learns from the host's open status
    whether it carries the space, how many wrote and read there, and, asking
    again and again, when its members are online (08 §1.1).
  - A free subscription none of whose devices calls for `idleDays` is
    dropped, and with it the host's copy of the spaces only it named.
    Someone who lost every device and comes back with the recovery code
    after that finds the host's copy gone (08 §1.1). Accepted: the devices
    hold the spaces, and the host is a convenience on top.

_Source: 03 §1.2, §2.7, §3.4, §4.4, §5.2; 02 §3; 01 §7, §15.3. Tests: `packages/core/tests/constitution.test.ts` ("what a constitution may say"), `packages/core/tests/space-access.test.ts`, `packages/core/tests/space.test.ts` ("a personal space refuses a stranger"), `packages/core/tests/ucan.test.ts`, `packages/core/tests/validation.test.ts`._

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
  - A bot connected to GitHub works like a chat app a workspace installs:
    any member whose record sets off an automation can ask it what is in the
    connected repositories, private ones included, and what they write steers
    what it does there, though it reaches the model marked as data. An
    automation acts on GitHub only when someone who may configure the bot
    made it, as its current words say; one rewritten by someone who may not
    instruct the bot isn't run, and no bot counts as configuring it: not
    itself, nor another its host runs, and apps give bots no role that may
    instruct bots (`runAutomations` in `packages/cli/src/bot-runner.ts`;
    `packages/cli/tests/agent-automations.test.ts`, "writes outside the space
    for an automation someone who may configure it made";
    `packages/cli/tests/bot-provenance.test.ts`, `packages/cli/tests/two-bots.test.ts`).
    A bot run elsewhere, given such a role by hand, still counts. The bar is what common chat
    apps give their integrations, no more: connect only what every member
    may read. Not protocol: a bot run by other code does as it likes.
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
  - A member can name up to 16 files of up to 2³¹ bytes in every version,
    and a keeper fetches and holds each while that version is kept whole:
    for good where it is retained, a first version under `onePer`, or under
    `history: "all"`. It can also name another member's deleted file in a
    version of its own, keeping its ciphertext held, though nobody without
    the old body can open it. `size` is the writer's word until the bytes
    arrive. And any peer it serves can ask for up to four chunks (1 MiB) per
    `want-file`, as often as it likes, and a member naming ids nobody holds
    has every keeper ask its peers and list its mirrors for each, one id at
    a time, again every ten minutes, which delays its fetching the files
    that exist: nothing bounds bytes served per peer
    (05 §16.6; [#33](https://github.com/leifriksheim/minca/issues/33)).
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
  - A host's free line counts the members who write in a space, so a member
    who may invite can push it over by inviting more accounts of their own
    and writing from them (a stranger holding an open invite link can too:
    §3.1). Removing
    them more than 7 days before `until` undoes it, as only members count and
    a space under the line through its last days is not stopped; removing
    someone for an hour as the date passes does not ("removing a member for
    an hour as the date passes buys nothing…")
    (`packages/core/tests/host-limits.test.ts`, "a member removed no longer
    counts as a writer", "pushed over by joiners removed within the hour…");
    after `until` it is stopped, and is free again only through its fund or
    once the host forgets it. A space whose grace is spent gets only 7 days'
    notice when pushed over again, which is the time its members have to
    remove whoever did it. Handing a shared space over as a carry space
    neither escapes the line nor hides its notice from the other members who
    use the host, nor drops the host's copy: a host with limits refuses one
    it carries or others name ("a shared space handed over as someone's
    carry space is refused"). One no other member uses the host for is
    refused only once its members are known, at the next look, and a member
    without a role is not seen as sharing it. Any member can also put a space several write
    in over on bytes, and removing them leaves what they wrote. After `graceDays` only the space's fund
    keeps it at that host. Readers never put a space over, as they cost
    nothing to make up ("readers alone never put a space over the line"),
    and backdating writes does not keep one under: they count by when they
    arrive ("…after that, a backdated write counts as any"). Accepted: the
    line is the host's policy, and a community can pay, or move host (08
    §1.1).

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
    revokes the key, however long ago its note ran out; only live use (live
    messages, connecting) ends with the note (01 §7.6). A knock is judged at
    the time it says it was signed, so whoever has the key, even after its
    note ran out, can date knocks into the note's life and leave them, in a
    mailbox or a space the account shares with someone, until 14 days after
    it ran out: no relay's time anchors a knock (07 §6, §8,
    [#165](https://github.com/leifriksheim/minca/issues/165)). Signing out
    writes a revoke of the session key, and the device forgets the key
    before it does. With a peer online it waits briefly for one to take the
    revokes in; otherwise they go when that device next syncs, and never if
    its data is deleted first, so a copy of the key taken earlier keeps
    signing. A device lost while signed in has to be
    revoked from another device, which needs a list of the account's session
    keys. A revocation does not reach spaces created after it
    ([#165](https://github.com/leifriksheim/minca/issues/165)).
  - An invitation is judged by the time it says it was signed, and no space's
    history is consulted (03 §7.4), so a stolen key whose note let it invite
    can go on signing invitations dated while the note was good, after it ran
    out or was revoked. With a space's constitution, and its key for a private
    one, it can hand out invites that name the account as the inviter and
    relays and nodes of its choosing, which joiners then dial. It can't open a
    role: that needs an invite record in the space, which a revoked key can't
    write ([#165](https://github.com/leifriksheim/minca/issues/165)).

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
- **By design.** Whoever reads a copy of an account's vault becomes its root
  thief once it guesses a passphrase wrap's password offline, at the cost of
  its PBKDF2 rounds per guess (01 §11.3). That is anyone who copies a pod
  (a synced drive, a backup, an old copy of the folder) and any app or site
  the person opens their pod in (§3.6). The reference library takes any
  password but an empty one and only warns when it is weak
  (`packages/core/docs/sign-in.md`). The person chooses, but the cost is
  shared: co-members of every space that names the account are exposed to
  the thief, without being told. Changing the password later protects no copy
  already taken, and a pod merged with an older copy keeps the older wraps
  (01 §11.4); the seed never rotates
  ([#9](https://github.com/leifriksheim/minca/issues/9)), so a vault copied
  under a weak password is lost for good.

### 3.6 App or program

- **Holds.**
  - Its writes count only where its note covers them, and a home grants an
    app only the spaces chosen for it (01 §8, 06 §2). It can be given a note
    only for a key it shows it holds, never the home's own or another
    connection's, nor one a connection replaced, so disconnecting it revokes
    nobody else (06 §2.5, §2.10; `packages/core/tests/connect.test.ts`, "a key
    a connection replaced is not granted again for anything else").
  - Given some spaces, or records only, it never changes the account's own
    place in any space: every peer ignores its account joining, leaving,
    being assigned or unassigned a role, stepping down, or publishing a
    member key or profile, and its revoke of any key but its own. Nor does it write the account's own spaces or
    knock as the account: those need a note about the whole account, which
    every peer checks (01 §8; what it can do with the contact key, if it was
    given it, is below;
    `packages/core/tests/records-only.test.ts`, "an app given a space never
    changes the account's own place there…"; `connect.test.ts`, "it lists
    them and opens requests sent to the account…").
  - Given the whole account and disconnected, its key is revoked wherever the
    account writes, carry spaces included, so it no longer changes what a
    carrier keeps (06 §2.10; `connect.test.ts`, "disconnecting a
    whole-account app revokes it in the carry spaces too…").
  - Given the whole account, it can't keep the person from pausing or
    removing their own automations: they are `sys.automation`, which nothing
    defines, so no definition it writes applies to them (03 §13.2;
    `packages/core/tests/own-automations.test.ts`). Disconnecting it removes
    every automation it proposed and every one its own key, or a key it
    replaced, wrote, whichever app that one names (06 §2.10;
    `packages/core/tests/connect.test.ts`, "disconnecting a whole-account app
    removes what its own key wrote…", "disconnecting removes the automations
    a replaced key wrote…").
  - Given the whole account, it holds the account key, not the local key, so
    it can't open the registry store's sealed entries, and of those it gets
    nothing else it lacks but invite secrets waiting to be used and the CLI's
    writer keys (01 §11.1, 05 §15). The account key does yield every space key
    the account's registry lists.
  - Where it can write the account's vault, a wrap of another account it
    plants, or a passphrase wrap it edits to fewer rounds, does not open as
    the account (01 §11.3).
  - Where it can write the account's data folder, it can't change which
    version another app or device holds as current, nor have one take a
    version a peer would refuse, nor make one drop a version it has read: no
    client takes another's space entries from the folder, nor any store of
    its own (a store writer id, a key's places), every version in a
    segment is judged like a peer's, and a segment deleted takes nothing from
    a client that read it (05 §14.4, §14.5;
    `packages/core/tests/folder-adapter.test.ts`, "two nodes of one account
    on one folder", "deleting segments from the folder takes nothing from an
    app that read them", "no store but a space is ever read from the
    folder", "a name no key could make, planted in the folder, stops no
    pull"). Clients keep their own stores outside the folder: the CLI keeps
    an account's stores and its writer keys with their places outside its
    home, and reads no slot from it, so rolling one back, or putting an old
    one back, can't fork a key (`packages/cli/tests/cli.test.ts`, "keep
    what this computer holds, and its writer keys, outside the home"). It
    can hide versions from a client that hasn't read
    them yet, which only a peer can then bring.
  - A program connected by code gets records only, in the whole account,
    never more: the home makes its request itself and grants nothing else,
    and no app can send a request for a program's key. The whole account
    includes the account key, so it reads every private space, and the
    person can't narrow it to some spaces. Its proof can't be
    used for an app's connection, nor for more than records, nor at another
    home; and an app's own proof can't be passed off as a program's (06
    §2.4, §3). A request with `recordsOnly` never gets the contact key (06
    §2.8).
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
  - Given the contacts under a grant for some spaces, it holds the contact
    key, and with it the inbox keys (06 §2.8, 07 §1): it can open every
    knock on the account's inbox, join a space for two first under its
    operator's own account and be taken for the account, clear the inbox,
    and sign a code for it naming mailboxes of its own. The library refuses
    those calls on such a node; no peer can tell
    ([#313](https://github.com/leifriksheim/minca/issues/313)).
  - An app or site the person opens their pod in reads the vault, and can
    guess its password offline; a weak one makes it the root thief (§3.5,
    By design).
  - Where it can write a data folder, it can leave segments as large and as
    many as it likes, and every client of the folder reads each one whole;
    and a file where a space's directory belongs stops every client pushing
    or pulling that space through the folder, until it is removed (05 §14.5,
    §16.4; [#33](https://github.com/leifriksheim/minca/issues/33)).
  - `minca agent` keeps its key, grant and stores together in the CLI home
    (`<home>/agent`). Where the home is a data folder others write, rolling
    back the stores' `writers.log` has the agent sign at a place it used
    before, and its key forks; a copy of the home on a second computer runs
    the same key. Its stores' entries are its own, unjudged, though what it
    reads is still judged when shown (`packages/cli/src/agent.ts`, `startWithKey`;
    [#287](https://github.com/leifriksheim/minca/issues/287)).
  - Given a space and `/access/change` there, it can still redefine or
    delete a role its own account holds, if that role may define itself: the
    account keeps the role by name and loses what it gave (01 §8) _(traced)_.
  - `scope: account` hands over the account key, and `scope: spaces` member
    keys, neither of which ever rotates. It reads what those keys open after
    its grant expires ([#165](https://github.com/leifriksheim/minca/issues/165)).
  - A key whose note grants everything about the account (`/`, no policy),
    an app granted write to every space included, can pose as the account's
    node to a client that pinned the account, and a pin checks no revoke. A
    narrower note can't (04 §5.2)
    ([#165](https://github.com/leifriksheim/minca/issues/165)) _(traced)_.
  - Its records count until the person disconnects it, not until
    `expiresAt`, and so do those of a key it replaced by connecting again: no
    home revokes an app's key on its own, since a revoke from a home's view
    withdraws whatever of the app's honest writes the home hadn't seen. A
    copied app key keeps writing until the person notices and disconnects
    the app, as a stolen session token does in any app (§3.4); for a
    whole-account app that includes changing access and revoking the
    account's other keys. The date chosen at the grant bounds only live use,
    and the home says so where the person grants and lists apps. Only the
    home that granted it can disconnect it, and only while it keeps its
    record of the connection: site data cleared there leaves the app's keys,
    and those it replaced, never to be revoked (06 §2.9, §2.10,
    [#165](https://github.com/leifriksheim/minca/issues/165)). By design.
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

_Source: 01 §7.5, §8, §11; 06 §2, §3; 05 §14, §15; 02 §4.1. Tests: `packages/core/tests/live.test.ts` ("a records-only key cannot shed its label by passing its note on"), `packages/core/tests/inbox.test.ts` ("opens only with its inbox…"), `packages/core/tests/record-keys.test.ts` ("a key in another collection"), `packages/core/tests/connect.test.ts` ("an app can only ask for a key it holds, and none the home already uses for something else", "a request with a field it does not know is refused…"), `packages/core/tests/records-only.test.ts`, `packages/core/tests/connect-code.test.ts`, `packages/core/tests/ucan.test.ts`, `packages/core/tests/account-vault.test.ts` ("the account key does not open the registry store's sealed entries", "a wrap from another account does not open as this one", "a passphrase wrap edited to fewer rounds, another salt or another id does not open")._

### 3.7 Relay

A Minca relay, a Nostr relay, or anyone else watching a topic on one: all see
the same sealed blobs.

- **Holds.** It can always drop and delay. Beyond that:
  - A relay that doesn't know the room learns no session DID: neither who is
    in a room nor who meets whom by name. A room's topic is a
    hash of the room, and every hello, offer and answer is sealed under a key
    derived from the room, which only those who know the room hold (04 §1.3,
    §2; `packages/core/tests/rendezvous.test.ts`, "a relay, or anyone on the
    topic, sees neither who meets nor their addresses").
  - It can't read a peer's addresses unless it knows the room: an offer or
    answer is sealed again to the box of the one peer it is for, so others
    in the room don't read it either, and one re-wrapped with another box
    opens nothing (04 §2; "a third peer in the room hears the offer pass but
    cannot open it", "an offer re-wrapped with another box opens nothing").
    Anyone who knows the room can still say hello and be offered to (§2).
  - Under made-up names it can have a peer dialling at most 64 peers a room
    at a time, and it can't get a peer cut off from a relay by making it say
    hello back: a node says hello back once a room every 10 s, and paces what
    it sends below a Minca relay's budget (04 §2, §2.1; "hellos under 90
    made-up names start no more than 64 connections", "a node in 60 rooms
    keeps its relay…", "a node in 16 rooms of 12 members each keeps its
    relay").
  - It can't say anything through relays in a peer's name, nor can anyone
    who knows the room: every hello, offer and answer is signed by the
    session key its `from` names, sealed description included, so nobody can
    pose as a peer there to keep two peers apart or to take the offers meant
    for one. Nor through introductions: a signal passed on is signed by its
    origin and stays in its room (04 §2, §8; "a signal passed on in someone
    else’s name is ignored, and a genuine one is acted on once", "a signal
    stays in its room: not taken from a peer who isn’t there, nor passed to
    one"; "an offer whose sealed description someone else put in,
    under its sender’s signature, is ignored", "a hello naming B but signed by another key is ignored",
    "someone in only a public room cannot pose there as B to keep A and B
    apart in a private one").
  - It can't make a peer act twice on one message, by replaying it or by
    passing it through several relays: a peer acts once on each time a sender
    signed, in that room, within 2 minutes of it, in whatever order messages
    come; nothing anyone else says pushes that out (04 §2; "a replayed hello counts once", "a replayed
    offer is not acted on again, however much else was said since", "a blob
    that does not open under the room key, or is stale, or comes again, is
    ignored").
  - It can't read or change what two sides say on a channel, pairing or
    connecting by code: each direction has its own key from the secret and an
    ephemeral exchange, and each message is bound to its type and place, so
    one sent back to its sender, relabelled, repeated or reordered does not
    open (01 §15.2, 06 §3). The room's name is a hash of the secret, so it
    never learns the secret itself.
  - Someone who records a channel's room and learns its secret later still
    opens nothing (01 §15.2).
  - On the home's side a connect code serves one program: once one has
    asked, the home answers nobody else (06 §3).
  - Someone else who holds the code can answer the program first, saying they
    are the home it opened, with a note from their own account; but the
    program keeps a note only once the person gives it the check their own
    home showed, which only that exchange gives, so it keeps nothing. Nobody
    between the two can steer both exchanges to one check: each side runs one
    exchange, and fixes its point before it sees the other's, so one guess in
    a million is left (06 §3). The program also keeps the home it opened,
    whatever an answer names. The check protects the program, not the
    account: the home sends the note when the person allows it. In an AI the
    check comes back through the model, so someone who can read and write
    the model's context can give the check of their own exchange.
  - A connect code travels from the program to the browser it opens, in the
    link's fragment, so the relay never sees it, and no request to the
    home's server carries it. It can stay in the browser's history, and the
    link is printed, or handed to the model, when no browser opens.
- **Does not hold yet.**
  - That it can't answer in peers' place: they talk over DTLS channels whose
    fingerprints both sign in the mesh proof (04 §5.1, §6.2), so a relay, or
    anyone in the room, that answers for one should fail the proof. No test
    shows it ([#162](https://github.com/leifriksheim/minca/issues/162)).
  - It learns which addresses watch and publish to which topics, and when:
    enough to tell that some sockets share a room, though not which room
    ([#162](https://github.com/leifriksheim/minca/issues/162)). On a public
    Nostr relay anyone at all can watch every topic, and see each blob's
    size and time, though each event's key is fresh, so it ties no two rooms
    together.
  - One socket watching a topic can have a Minca relay send each blob it
    publishes to the topic's 63 other watchers. Its budget (50 messages a
    second) and the 32 sockets an address may hold bound it, not the relay's
    traffic: one address flooding a topic can push its honest watchers past
    the relay's send buffer, which cuts them off until they redial
    ([#162](https://github.com/leifriksheim/minca/issues/162)).
  - A relay that knows a space's id, as a host's relay does for the spaces it
    keeps, reads its hellos like anyone who knows the room: which session
    DIDs are there, when, and from which address
    ([#162](https://github.com/leifriksheim/minca/issues/162)).
  - A member who passes an introduction on reads the descriptions in it, as
    it could learn those members' addresses by meeting them, and can drop
    it; where two peers share no relay, a member on every path between them
    keeps them apart (04 §8, [#162](https://github.com/leifriksheim/minca/issues/162)).
  - A relay that cuts a peer's socket over and over makes it say hello in
    every room each time it reconnects; through three relays a room's peers
    share, that can pass the 256 messages in 2 minutes a receiver acts on
    from one peer, and the peer isn't heard there, on any relay, until they
    age out (04 §2, [#162](https://github.com/leifriksheim/minca/issues/162)).
  - A signed hello is proof that can be shown to others: whoever knows a
    room and logs it holds a session DID's signature over the room's topic
    and a time, which anyone else who learns the room can check
    ([#162](https://github.com/leifriksheim/minca/issues/162)).
  - Under DIDs of keys it makes, 64 hellos every 5 minutes through any one
    relay fill a room's places on every relay, where it once took 64 sockets
    on each ([#162](https://github.com/leifriksheim/minca/issues/162)).
  - Peers meet through relays only if their clocks are within 2 minutes:
    messages outside that are taken for replays (04 §2,
    [#162](https://github.com/leifriksheim/minca/issues/162)).
  - Anyone who knows a space's id, a former member or someone who saw an
    invite, can derive its room key and read its hellos: which session DIDs
    are in the room, and when (04 §2,
    [#162](https://github.com/leifriksheim/minca/issues/162)). An offer or
    answer stays in its room, so knowing one room shows nothing of another
    ("someone posing as a peer in another room, or in this one, opens no
    answer meant for it").
  - An inbox's mailbox can be flooded ([#162](https://github.com/leifriksheim/minca/issues/162)).
    So can a short link's topic: 64 blobs fill it, and a drop of the link's
    blob after its copy expired is then refused. Joiners read every page, so
    junk can't hide a copy that is there, and a host's copy is not in the
    relay's queue. A Nostr relay can't be purged, and a fetch reads its
    newest 500 blobs: 500 drops bury an inbox's earlier knocks there, or a
    short link's invite (04 §1.5, 07 §5).
  - Of a short link it learns the topic, the sealed invite's size, and when
    and from which address it is fetched; a relay also serving the space's
    room can tie a fetch to the topic watched a moment later
    ([#162](https://github.com/leifriksheim/minca/issues/162)).
  - Someone who holds a connect code can take the home's one exchange, or
    the program's, before the other side arrives, so the program is never
    answered and has to connect again. A relay can't, since it knows only
    the room's topic, not the room.
  - Someone else who holds the code can also ask before the program does,
    posing as it. The person sees only the name it gives itself, and may
    allow a note for its key; the real program is then never answered.

_Source: 04 §1, §2, §5.1, §6.2; 07 §5, §6; 01 §15.2; 06 §3. Tests: `packages/core/tests/rendezvous.test.ts`, `packages/core/tests/relay-nostr.test.ts`, `packages/core/tests/relay-socket.test.ts`, `packages/core/tests/pairing.test.ts` ("a message sent back to the side that sealed it does not open there", "someone who learns the secret later cannot open a recording of the exchange"), `packages/core/tests/connect-code.test.ts` ("a relay that relabels or repeats messages changes nothing", "a recording of the room, and the code learned later, open nothing", "a code works for one program: a second with the same code is not answered", "the program asks only the home it opened, and keeps that home, whatever the answer names", "the program keeps its note only once the person gives the code the home shows; a point that breaks its commitment is ignored")._

### 3.8 Host or carrier

- **Holds.**
  - It cannot read the bodies of a private space's records outside the
    collections 03 §8.2 keeps in the clear, without the space key.
  - It cannot alter or forge what it serves (02 §3).
  - Without the space key, it can't compute or test a private space's
    `onePer` keys, so it can't check a guess of who voted on which poll, or
    how (02 §7.3, 03 §8.6).
  - It can't read a file it keeps or serves without a body that names it:
    each is sealed under a key only bodies hold, so in a private space it
    reads none, and a deleted file is ciphertext to anyone who never had its
    body; nor pass off
    other bytes as one,
    since every chunk is checked against the id a signed version names
    (05 §16.6; `packages/core/tests/files.test.ts`, "a chunk that is not the
    one its list names is dropped…", "a list of inner hashes, or of the wrong
    length, is refused").
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
  - A host with limits that stops carrying a space over its free line takes
    nothing from its members: their copies, and their syncing with each
    other, are as before, and an account's subscription still names the
    space (08 §1.1; `packages/core/tests/host-limits.test.ts`, "past until,
    members' subscriptions no longer carry it; members keep what they hold").
    What it stops is being there for them: members meet only when two are
    online, wakes for the space stop, and after `keepDays` its copy goes.
- **Does not hold yet.**
  - Live messages, such as typing, presence and call signalling, reach it in
    plaintext ([#170](https://github.com/leifriksheim/minca/issues/170)) _(traced)_.
  - A host asked for a bot receives a lasting role invite carrying the space
    key ([#170](https://github.com/leifriksheim/minca/issues/170)) _(traced)_.
  - It learns which account keeps which short link, until when, and who
    fetches it from its relay (06 §4.2). It serves only sealed invites, and
    only under the topic each one's own hash gives, so it can withhold a link
    but not change it.
  - A host whose bot is connected to a service (08 §3.1) can act there as
    the community, within what the service granted it: for GitHub, the App's
    permissions on the repositories an admin of the account chose. Each host
    writes its own connectors, and no peer checks what a bot does outside the
    space; only the host's code does, and a dishonest host need not run it.
    Revoking the grant at the service, where it lets one be revoked, ends it
    whatever the host does. The
    reference host keeps what each connection reached when it was made and
    only narrows it, and drops a connection when the bot leaves the space or
    whoever connected it may no longer configure it (`usable` in
    `packages/cli/src/host-connect.ts`; `packages/cli/tests/host-connect.test.ts`,
    "a connection stands only while…").
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
    Unlike `links`, a version's `files` stays outside a private body: how
    many files each names, how big, and that versions naming one id share a
    file, in one space or across the spaces it holds (05 §16.6). A host with limits also keeps, for its window, which
    accounts wrote in each space on each day, as hashes salted with a salt
    on the same disk, which hides nothing from the host or whoever holds its
    disk, since every writer is in the space's envelopes anyway, and tells
    anyone with the space id how many wrote and read; asked again and again,
    that says when the members are online (08 §1.1).
  - What it says it charges is its word. No peer can check the model its
    bots think with, what a reply cost, or the size it bills by, and its
    `botTypical` and fund `lines` are words for people (08 §2). A device
    keeps a fund only when its numbers are dollars (a host that is not free
    and whose fund it drops shows as taking no payments, not as free), and
    of its fund's lines at most eight short ones with no control or format
    characters; the host's own `name`, `price` and `terms`, and bot names,
    are not held to that
    (`fundShown` and `fundLines` in `packages/core/src/session/hosting.ts`;
    `packages/core/tests/fund-lines.test.ts`), and the reference app shows
    them as text beside the `perGb` rate it bills by, never in its place
    (`FundPaysFor` in `apps/shared/src/SpaceHosting.tsx`). Accepted: a host is chosen and
    paid as a provider is, and left as one.
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
  [#215](https://github.com/leifriksheim/minca/issues/215)); so can the
  vault's wraps. A space's records can't be rolled back this way on a client
  whose own stores are outside the folder: what it read stays with it (05
  §14.5). Nor can a client's own stores, by the same token, wherever they are
  kept; rollback there is the device's own (a backup restored), which this
  page doesn't cover.
- **Protecting a device that is already compromised** while it runs. Keeping
  keys from being exported is up to each implementation (see
  `packages/core/docs/node.md`). The desktop app keeps its app's key and grant
  at rest in a long-running process's folder, sealed under a key in the
  system's keychain: a copy of the folder yields no key, grant or private
  body, and shows what a carrier sees (§3.8). A program running as the person
  can still ask the keychain, as it can read a browser profile.
- **Stopping someone at a device that is signed in.** The reference home asks
  for the password, a passkey or the recovery code, given in the last five
  minutes for this account, before it does these: show the recovery
  code, offer the account to a phone, change how the account signs in
  outside first setup, or give an app, or a carrier asking
  through the connect page, any access at all
  (`packages/core/tests/auth.test.ts`,
  "reading the recovery code or offering the account to a phone takes proof
  it is you", "changing how the account signs in takes proof it is you, once
  it is set up", "no call steps back into setup to skip the proof";
  `packages/core/tests/connect.test.ts`, "an app or a carrier is given access
  only just after proof it is you"). For giving access, signing in with one
  of those in the last five minutes is the proof; for the rest it is not.
  Making the account counts as that proof too, as does a passkey sign-in
  only when the passkey's own check ran. Anything else at an open page,
  such as disconnecting an app or keeping what an app already connected
  suggests, needs only the sign-in, and so do inviting an account into a
  space, making an invite link and starting to use a host: someone at an
  open page can still give another account of theirs, or a host they run,
  what the gate refuses an app or a carrier. A passkey's proof is whatever the platform takes for it,
  which may be the device's own login. And the seed is in the page's memory,
  so developer tools or a script in the home's origin read it whatever was
  asked.

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
