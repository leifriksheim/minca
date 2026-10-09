# Draft: one judging rule

Status: accepted, October 2026. Rules 2 and 3 are built (protocol 11); rule 1, a convergent access history, is next, behind a model-checking harness.

Today a version can stand, be withdrawn, be refused or wait. It is judged as
of `at(seen)` from a global replay, plus a pile of special cases:

- keep lists;
- "within" for citations;
- reductions it had not seen;
- rule changes it had not seen;
- revokes, forks;
- the warrants' own view.

Every review found a hole in some combination of these: #137, #166, #167,
#168, #173, #174, #179, #183, #184. This note replaces all of them with three
rules.

## The three rules

**1. Every change to who may do what is valid or not in its own view, for
good.** Its own view is the access changes its `seen` names, and their
ancestors, replayed alone. A change is valid when its author had the power for
it there. No change outside that view can alter the verdict, whether a rival,
a later change or a late arrival. Validity is final and the same on every
peer.

The current state (who holds which role now) is a deterministic merge of the
valid changes. Rivals on one record are decided by the replay order, as
today. That order decides only what the state is now, never whether a change
was valid. #137 then only reorders the current state, which is what a CRDT
does.

**2. Every version is judged in its own view, plus the reductions of its
author that it hadn't seen.** A reduction is a removal, a demotion, a revoke
of one of its author's notes, or a proven fork of its key. A version counts
when its author was allowed both:

- in its own view;
- in its own view merged with every valid reduction of its author that it had
  not seen and that does not cover it (rule 3).

Rule changes are judged the same way: one that the version hadn't seen
applies only through a reduction that saw it. So #179 (a narrowed rule plus a
demotion) is caught, because the demotion's view includes the narrowing.

A version that cites another counts it if the cited version stands in the
citer's own view. That is the same rule, applied to a different view, and
replaces "within".

**3. A reduction keeps what its author had seen, per key.** A reduction names,
for each key of the account it reduces, the head of that key's log its author
had seen: `cutoff: { <key DID>: <version id> }`. Versions on that chain, up to
and including that head, are covered: the reduction does not apply to them.
Everything else by that account is judged with the reduction:

- later versions;
- another branch;
- versions on a key the reduction's author never saw.

This replaces keep lists. A cutoff is exact, small (one entry per key of one
account, not up to 10,000 ids), and doesn't depend on which records the
reducer's node happened to hold. Several reductions each apply, and a version
must pass all of them. So "the first revoke wins" (#168) goes, and a thief's
own revoke can't shield what it signed in advance: the owner's revoke has its
own cutoff.

## What a writer may claim

- **`seen` may name any subset of the heads, up to 64.** Naming less is safe:
  a reduction the writer left out still applies, through rule 2. This fixes
  #183, the freeze.
- **Dropped by implementation: "`seen` only grows along a key's log".** An
  account can mint a fresh key whenever it likes, and the new key's log is
  empty, so the rule bound nothing an attacker couldn't step around. Only a
  reduction of the author, with its cutoff, binds a write it hadn't seen.

## What it gives up, on purpose

A version that names an old `seen`, and that no reduction of its author
covers, is indistinguishable from one written offline back then. Rule 2
accepts it if its author could have written it then. Today's rule withdraws
an honest offline writer's work whenever the rules narrowed meanwhile, unless
a keep list saved it. The new rule doesn't punish being offline. The price:
a narrowed rule binds a member only from the point they saw it, or from a
reduction of that member that saw it. A space that wants a narrowing to bind
everyone at once pairs it with demotions, which is what "narrow" means for
people anyway.

## What it removes from the spec

- keep lists (03 §6.3);
- the 10,000-id limit;
- `within`;
- the citation special cases of checks (since moved out of the protocol, to
  `packages/core/docs/checks.md`);
- 03 §5.2 step 10;
- `at(seen)` as a judging input;
- the warrants' separate own view;
- the "withdrawn but counts when cited" status;
- "first revoke wins".

Verdicts become two: a version **stands**, or it **does not** (with "not yet"
while what its view needs hasn't arrived).

Status: accepted, October 2026.

## Later: witnesses

Without someone other than the writer, nobody can tell a backdated version
from an offline one. Holochain doesn't solve this either: validation reads
only hash-referenced data, and its agent activity authorities witness chain
heads. Planned as one optional layer: members sign each other's log heads
("I saw K at H"). Then:

- a reduction's cutoff is the latest witnessed head, not what its author
  happened to see;
- a fork below a witnessed head withdraws only the unwitnessed branch
  (#166, #175);
- witnessed heads mark where a line ends (#176).

Finality (a quorum-signed checkpoint) can follow for governance (#137, #160).

## Rules in CEL

Built (protocol 12): a check's condition, a subscription's `where` and a
rule's `holds` are CEL, a subset of it pinned to a commit of the CEL spec and
tested against its conformance suite. `who`, `onePer`, `fixed` and `final`
stay declarative: they are short, and a peer reads them for more than a
verdict (`onePer` makes a key).

Since protocol 15, checks are not protocol: peers keep a definition's `check`
and every version that fails it, and the library counts only versions that
pass. The CEL subset, citations and limits moved from 02 §7.6 to
`packages/core/docs/checks.md`.

## Warrants leave the protocol

A `sys.warrant` stands like any record its author may write. Each peer checks
its proof only to decide whether to show a flag. A peer that has never heard
of warrants syncs and stores the same, so warrants are a standard collection
(`packages/core/docs`), not protocol. No counter-warrants.

## What stays open

- **Forks at the start of a log (#166, #175):** a thief who forks a key at 0
  still erases the device's history. Rule 3 helps only where a reduction
  names a cutoff. The real fix is members witnessing each other's heads, as
  its own Planned section.
- **Governance (#160) and secrets (#165, #169, #182)** are untouched.

## Cost

- One replay per distinct own view, cached by the set of heads, which is what
  warrants already do.
- A merge with the author's unseen reductions only when there are some. That
  is rare, and cached the same way.
- Admission no longer depends on the global order.
