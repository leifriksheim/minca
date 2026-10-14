# Draft: four ways to say who may do what

Status: exploring, October 2026. Not normative, and no decision. A plain
comparison, to find the model that is generic, convergent and easy to
explain. See also [constitution](constitution.md).

What every candidate must give:

1. **Explainable in a paragraph.** If a developer can't say who can remove
   whom, nobody builds on it.
2. **No fixed roles in the spec.** Communities name their own roles and
   decide what each may do in their own collections.
3. **Every peer agrees** on who is in, who may write where, and who gets the
   key, from the same changes in any order, with no clock.

Two example communities run through each: a **chess club** (an organiser,
referees who rule on disputed games and may remove cheaters, players), and a
**co-op** whose board is elected, and which can remove anyone, founders
included.

## 1. Fixed tiers

**In a paragraph.** The spec defines a short ladder: owner, admin, moderator,
member. You can change people only in tiers below yours. A role is a name the
community picks, placed on one tier, with permissions on its collections.

- **Chess club.** Organiser is an owner; Referee a moderator role with
  `app.chess/judge`; Player a member. Referees remove players, not the
  organiser. Works well.
- **Co-op.** The founder is an owner and can't be removed by anyone. An
  elected board needs something beyond tiers.

**For:** simplest to explain and to get right. **Against:** the spec fixes
roles; democracy needs a second mechanism.

## 2. Ranks with a threshold per action (Matrix)

**In a paragraph.** Every role has a number. Every action has a threshold:
"removing a member takes 50", "changing the rules takes 100". You can change
only people ranked below you, and never set a rank above your own.

- **Chess club.** Organiser 100, Referee 50 with `kick: 50`, Player 0. Works.
- **Co-op.** Same problem as tiers: the highest rank can't be removed.

**For:** generic, and familiar from Discord and Matrix. **Against:** numbers
invite ties and arbitrary orderings, which cost Matrix years of bugs and, in
2025, a retreat to creators with "infinite" power. It is what Minca has
today, with ranks.

## 3. An authority graph (Keyhive's "Keyline" design)

**In a paragraph.** Everything is a key in one graph: the space, people,
their devices, roles, and groups. A role is a key others are made members of,
holding some authority. You may do something if a signed path from the
space's root reaches you. You can remove people only below nodes you govern,
so "referees remove players, not the organiser" is where the nodes sit, not a
number. The root can be a group that acts only with enough of its members'
signatures.

- **Chess club.** A Referees node governs the Players node; the organiser
  sits above both. Works, with no numbers.
- **Co-op.** The root is a Board node that acts with 3 of 5 signatures. The
  founder signs the first edge to it and keeps nothing. Works, as an elected
  council with fixed seats.

**For:** generic, one model for people, devices, apps and groups, no
tiebreaks. **Against:** hardest to explain; a removed admin keeps some power
until their role is moved to a new key; members of the root can lock each
other out; it is unmerged research, and Keyhive itself still ships fixed
levels.

## 4. Grants, and who granted them (a hybrid)

**In a paragraph.** The spec knows only grants: "this account may do these
things here", given by someone who holds them, never more than they hold.
You can take away what you granted, or what anyone below you granted. A role
is a named set of abilities a community defines; giving someone a role is a
grant. The root holder is named at the space's start: one account, or a group
that acts with enough signatures.

- **Chess club.** The organiser grants Referee to two members, including the
  ability to grant and remove Player. Referees can remove the players they or
  other referees admitted, not the organiser. Works.
- **Co-op.** The root is the Board group, 3 of 5. It grants everything else,
  and can take any of it back, founders' included. Works.

**For:** close to what Minca already does for devices and apps (notes), so one
model for both; easier to explain than a graph ("you can take back what came
through you"); no numbers. **Against:** "who granted what" must be tracked
and replayed; removing someone with two grants from different branches takes
both; a group root still needs fixed seats, as in 3.

## What none of them escapes

- **Democracy without a clock** works as a body with fixed seats (3 of 5),
  not "a majority of whoever is a member now", because membership changes
  concurrently and nothing orders it. Changing the seats is itself a vote.
- **Two people removing each other at once** must be settled by a rule every
  peer applies: both removals stand (simplest), or one wins by a structural
  tiebreak.
- **The top can lock itself.** Forking a space, keeping its shared history,
  is the exit no rule can take away.

## Where this leaves us

1 is simplest but fixes roles. 2 is today, and its numbers are its weakness.
3 is the most general and the least proven. 4 may be the sweet spot: generic,
explainable, and built on grants Minca already has. Worth a closer look:
whether 4's "take back what came through you" settles the concurrent cases as
cleanly as 3, and how much of today's replay it can reuse.
