# Draft: a convergent access history

Status: accepted and built, October 2026 (03 §4). It follows
[one judging rule](one-judging-rule.md), whose rules 2 and 3 are built.

Today a change to who may do what is placed in one global order: take-away
first, then by rank, then by id. Whether it applies depends on that order.
This causes three problems:

- an author can grind its id to win a tie (#137, and #170's tied leave);
- a change made later can reorder earlier ones (#137);
- the order needs a page of spec that every implementation must reproduce
  exactly.

This note replaces the order with structure.

## What it can and cannot promise

- **It promises convergence without an order.** Peers that hold the same
  changes reach the same state and the same verdicts, whatever order the
  changes arrived in, and no change's id decides anything except as a last
  resort between two equal writes.
- **It does not promise finality.** A removal signed offline can arrive at any
  time and take power away from what already counted. That is what a removal
  is for. Without a witness or a quorum, no design can do better; finality
  is the witnessing layer's job (see the one-judging-rule note).

## The rules

**1. Allowed in its own view.** A change is **allowed** when its author had
the power for it in its own view: the allowed changes it saw, merged (rule 4).
That depends only on its past, so it never changes. Validity then cascades: a
change stays valid only if the valid changes it saw still give its author the
power, so a struck grant gives nothing downstream. (Review showed that judging
only by a change's own view let a removed member's backdated grant to a sock
give the sock power for good.)

**2. Unseen reductions.** A change `e` by account `a` is **struck** when a
valid reduction of `a` exists that `e` had not seen and whose cutoff does not
cover `e`. This is the same rule ordinary records follow (03 §5.1). It
includes revokes of `e`'s key and proven forks of it (#167).

**3. Concurrent reductions all apply.** Rule 2 can loop. Alice demotes Bob
while Bob demotes Alice, each unseen by the other, so each would strike the
other. The loop is broken without an order: reductions that strike each
other, directly or through a cycle, all stand, as Ink & Switch's Keyhive does
with concurrent revocations. Both lose what each took.

Formally: draw an edge `r → e` when reduction `r` would strike `e` by rule 2,
and take the strongly connected components. Visit components in topological
order. A change is **valid** when it is allowed (rule 1), and no valid
reduction outside its own component strikes it. Within a component, edges
don't count. Every peer computes the same components from the same changes,
whatever order they arrived in.

**4. Merge, not order.** The current state is a merge of the valid changes,
with a rule per kind of record for valid changes that hadn't seen each other:

| Record                                        | Concurrent valid changes resolve to                                                                   |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `sys.member`                                  | the least power: no role, then the lowest rank, then the fewest permissions, then the lowest id       |
| `sys.role`                                    | the least power, in the same order                                                                    |
| `sys.invite`                                  | closed beats open                                                                                     |
| `sys.key`                                     | all keys stand; the current key is the one with the lowest id, and readers are boxed every key (#164) |
| `sys.collection`, `sys.relays`, `sys.keepers` | the lowest id                                                                                         |
| `sys.revoke`, `sys.fork`                      | all stand: they only add up                                                                           |

Least power wins, so racing to grant something never beats a concurrent
restriction, and an id decides only between two equally restrictive writes,
where either outcome is safe.

## What it fixes, and what it doesn't

- **Fixes:**
  - #137: no order, so nothing can be reordered;
  - #170: a removed member's change tied with its own leave is struck by the leave's cutoff;
  - #167: access changes are struck by revokes and forks too;
  - #164: concurrent key changes keep every key.
- **Partly fixes #10.** Convergence becomes a property the harness checks.
- **Doesn't fix:**
  - #184, where a colluding citer counts a backdated vote: citations still use the citer's view;
  - #166's fork at 0, and #175, which need witnesses;
  - #165, #168, #169, which are about keys.

## The harness, before any of this is built

`packages/core/tests/access-properties.test.ts` generates thousands of random
histories and checks properties of the replay, not equality with a second
implementation that could share its bugs:

- **Order:** any arrival order, or any split into deliveries, gives the same
  state and verdicts.
- **Ids:** renaming every change's id, keeping its content, changes nothing
  but ties between equally restrictive writes.
- **Safety:** no change applies whose author lacked the power in its own
  view; no change by a removed account past the removal's cutoff applies.
- **Liveness:** an honest change made after seeing everything always applies.

Properties today's replay fails are marked `todo`, with the issue each
shows. The new replay must pass them all.
