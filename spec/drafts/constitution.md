# Draft: a space's constitution

Status: exploring, October 2026. Not normative. The fixed tiers below are one candidate; the authority model is open, see [four ways to say who may do what](authority-models.md). It restructures the core along
the line below, replaces numeric ranks with a small ladder of tiers, and
makes who holds power in a space something the space decides for itself.

## The idea

A space is a group of people. Every group has rules: who is in, who decides,
what counts. Today Weave builds one answer into every peer: roles with
numeric ranks, and per-collection rules and checks, all enforced at the
door. This note splits that in two.

- **What every peer must enforce, at the door, stays in the core.** It is
  about people, and cheap to check: whether you are in, whether your role
  may write to this collection at all, how much you may store, who gets the
  key.
- **What a group decides for itself becomes its own.** How power changes
  hands is the space's **constitution**. What a record means (a legal move,
  a counted vote, a reached goal) is the collection's **rulebook**.

A person joining a space can read its constitution before joining, in plain
words: "Moderators can remove members. Changing these rules takes two thirds
of the members." The default constitution is a ladder of tiers, which is
what most apps need. A group that wants founders not to own the space for
ever, elections, or an assembly, writes a constitution that says so.

## The line

Ask of every rule: would a peer that has never heard of it still sync, store
and judge every record the same way? If a peer must enforce it to keep a
space working at all (storage, secrecy, who is in), it is at the door.
Otherwise it belongs to the group.

| At the door: every peer enforces                                 | Rulebook: every reader applies the same way                      |
| ---------------------------------------------------------------- | ---------------------------------------------------------------- |
| Signatures, writer logs, forks                                   | Who may edit or delete a given record (its creator, a moderator) |
| Membership: who is in                                            | `onePer` (one vote each), `fixed` fields, `final`                |
| Whether a member's role may write to a collection at all         | Checks: a decision proven by ballots, a goal reached by pledges  |
| A per-member size limit                                          | A game's legal moves, a ledger's balances                        |
| Who gets the space's key                                         | What a record means and how an app shows it                      |
| Whether a change to who holds power counts: the **constitution** |                                                                  |

A record that breaks a rulebook is kept and synced, and counts for no one
who reads with that rulebook, with a reason the app can show ("an illegal
move, not counted"). That is how a game at a table works: anyone can play
an illegal card, and the table calls it. The library never hands an app a
record that does not count unless the app asks for it.

## Tiers and roles

Authority between people is a fixed ladder:

| Tier          | Can change people in | Also, at the door                            |
| ------------- | -------------------- | -------------------------------------------- |
| **Owner**     | admin and below      | everything                                   |
| **Admin**     | moderator and below  | define collections and roles; change the key |
| **Moderator** | member               | remove and restore members                   |
| **Member**    | nobody               | write where its role's permissions allow     |

Under the default constitution you change people only in tiers strictly
below your own, so equals never touch each other (#198).

A **role** is a name, one tier, and a set of collection permissions the
community defines: `Treasurer` (member, `app.treasury/write`), `Referee`
(moderator, `app.chess/judge`), `Bot` (member, `app.notes/write` only). Tiers
decide who outranks whom; permissions decide which of the community's own
collections a role may touch. A reader with no write permissions is a
member whose role has none.

The ladder replaces arbitrary numeric ranks and permission patterns (#201).
Comparing two pieces of authority becomes comparing two tiers, which makes
the convergent replay (03 §4) much simpler to state and to check.

## The constitution

A constitution is a record in the space. It says, for each kind of change to
who holds power, what makes it count:

- adding a member, and with which roles;
- changing someone's role, or removing them;
- defining or changing roles and collections;
- changing the key;
- changing the constitution itself.

The core enforces one rule: **a change to who holds power counts only if
the constitution in force, as of what the change had seen, approves it,
given the evidence it cites.** Evidence is signed records the change names
by id: ballots, approvals, statements. Every peer verifies the same evidence
with the same constitution, so every peer agrees. Nobody executes anything
in a global order; there is nothing like a blockchain.

### The default constitution

The ladder above, as a constitution: a change counts when its author is in a
higher tier than everyone it changes. No evidence needed. This is today's
behaviour with ranks made into tiers, and what most spaces will run.

### A democratic constitution

```
To remove anyone, owners included: ballots from more than half the members.
To add a member: one moderator, or any two members.
To make someone an admin: ballots from two thirds of the members.
To change this constitution: ballots from two thirds of the members.
```

Written as clauses, each a condition over the evidence (CEL, as checks are
today), with a plain-language line beside it that apps show. A removal cites
the ballots; every peer counts them as of what the removal had seen. No
clock is needed: "more than half the members as of this point" is decided by
the history alone. Deadlines ("the vote closes Friday") need witnesses, the
layer still to come.

### Amendments

The constitution changes only as it says it may. A space that starts with
the default constitution and later adopts a democratic one does so with a
change the default approves (an owner's). From then on, the owner is bound
by the new one. Founders need not own a space for ever.

### The escape hatch

A constitution can lock a space: a rule nobody can meet, or a bug. So the
core keeps one exit that no constitution can amend away: members can **fork**
the space, starting a new one whose history begins with the old one's up to
a point, under a constitution they choose. The old space goes on for those
who stay. This is also the honest answer to a group that disagrees about its
rules: it can part ways and keep its shared past.

## Why evidence, and why not Wasm (yet)

Ethereum runs programs over shared state in one global order, kept by
consensus. Weave has no order, no clock and no consensus, and should not
grow them. What fits Weave is proof: a change brings its evidence, and every
peer checks it. That is already how checks work; the constitution applies it
to authority.

A constitution in CEL can express majorities, quorums, "any two founders",
"every member", and per-role rights. It is bounded, and readable by people
and agents. Wasm would allow any computation, but a constitution must be
judged identically by every peer, so its cost metering would have to match
exactly across implementations, and nobody can read a bytecode constitution
before joining. Start with CEL; add Wasm only if a real community needs what
CEL cannot say.

## What changes in the protocol

- **Leaves the core** (02 §7, into the library and its docs): `create`,
  `edit` and `delete` rules beyond the coarse write gate, `onePer`, `fixed`,
  `final`, and checks with their CEL subset and step and work meter. They
  become the rulebook format, read by every member's library.
- **Stays, simplified:** membership; roles as tier plus permissions; the
  coarse write gate (a role's permission to write to a collection); a
  per-member size limit; keys.
- **New:** the constitution record and the one rule above; the default
  constitution; forking a space.
- **03 §4, the access replay:** the authority check ("may this author change
  that person?") becomes "does the constitution approve this change, given
  its evidence?", with tiers in place of ranks. Convergence, strikes and
  cutoffs are unchanged.
- A clean break, with a sync version bump, before v1.

## Plan

1. **Core along the line, default constitution only.** Move collection rules
   and checks out; add the write gate and size limit; tiers in place of
   ranks; the replay calls a constitution function whose only form is the
   default. Apps see simple roles.
2. **Constitutions as records,** in CEL, with ballots as evidence, shown in
   plain words when joining. Democratic spaces become possible (#160).
3. **Forking a space.**
4. **Later, if needed:** witnessed deadlines; Wasm constitutions.

## Open questions

- **Plain words.** Is the plain-language line written by the space, or
  generated from a structured constitution (with CEL only for custom
  clauses)? Generated is honest by construction; written is more flexible.
- **Evidence and late arrivals.** A removal approved by a majority of members
  "as of what it had seen" can be raced by a member added concurrently. Is
  "as of its own view" enough, or must ballots witness the member list?
- **Concurrent amendments.** Two changes to the constitution, each approved
  by the old one, made apart. The least-power rule picks between rivals
  today; what is "less power" between two constitutions?
- **Key changes under a democratic constitution.** Who writes the new key
  when a removal counts by vote, and no single member holds the authority
  to (#170)?
- **The size limit.** Per member, per collection, or per space; and what a
  peer does with what is over it.
- **Forks and identity.** How a forked space names its origin, and whether
  members' records carry over or are re-signed.

Related: #160 (governance), #197 (checks out of the core), #198 (equal
ranks), #201 (simpler roles), #166 and #175 (witnessing).
