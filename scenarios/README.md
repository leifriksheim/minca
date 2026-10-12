# Scenarios

A scenario is a kind of community, written as tests: who founds it, which
roles and grants it has, what its contracts decide, and a story of records
with the hard cases (a removal racing an action, a reaction withdrawn, a
double spend from two devices). Each one says, in code, what Weave must let
that community do and what it must refuse.

| Scenario      | What it tests                                                                                                                                                                                                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Chess club    | Roles, a referee, "only your own move" (`.byCreator`), moderators who can't remove admins (`.roles`), unassigning and what it strikes, removal against re-add, rival definitions, struck definitions, definers trusted (by design), roles only to accounts, a contract on turn order |
| Co-op         | `top: "none"`: no founder, the constitution assigns the founding members; any member may name a successor; removal by a majority counted as of the proposal; padding and backdating, skipped until quorum                                                                            |
| Company team  | Teams and a nested sub-team, an admin who can't write in hr or assign herself (`.self`), nor nest or assign hr to her own role. Not reading: `/record/read` keeps no one out (spec 03 §2.3)                                                                                          |
| Hall of fame  | A claim citing evidence; withdrawals and removals before and after it                                                                                                                                                                                                                |
| Mutual credit | An account's line of payments, a credit limit, double spends from two devices, griefing and second lines refused, no corrections in v1 (a stated limit), closed line keys                                                                                                            |

A skipped test is an attack the stand-ins can't refuse yet, named for what
it waits for ("needs quorum"). It asserts what that work must
do, and runs when it lands; it never passes by asserting the attack works.

## Running them

```bash
npm run scenarios                    # from the root
npm test -w @weaveprotocol/scenarios # the scenarios and the parked Datalog
```

They also run with `npm test`, since they take well under a second, and in
CI whenever `spec/`, `packages/core/` or `scenarios/` change.

## Layout

- `communities/`: each community's grants (UCAN 1.0 delegations with UCAN
  policies), its CEL contracts, and its story.
- `tests/`: the scenarios themselves, one file per community.
- `host/`: grants are the real library's. `host/library.ts` turns a story
  (entries placed in one linear history, each with what it had seen) into a
  space's constitution and access history and asks the library's replay
  (`packages/core/src/space/roles.ts`) every question. The hall of fame and
  mutual credit run on a real node (`packages/core/tests/helpers/community.ts`):
  every member signs their own versions, handed to a founder's node in the
  order a test says, and the verdicts are the library's contracts
  ([spec 09](../spec/09-contracts.md)). The chess club's and co-op's
  contracts still run on a small stand-in for what a peer does around them
  (`host/cel-host.ts`: chains, pending, membership as of a version), since
  the co-op reads a count the subset doesn't have; its CEL and UCAN policies
  (`host/ucan-policy.ts`) are the real evaluators from `packages/core`.
- `parked-datalog/`: the chess club, co-op and company team in Datalog, from
  [the comparison](../spec/drafts/contracts-comparison.md). Datalog is parked
  as a possible library query layer, not protocol. It runs with `npm test`
  but is not part of `npm run scenarios`; if a scenario change breaks it, fix
  it or delete it.

## A new kind of community gets a scenario

When a change lets Weave serve a community the scenarios don't cover, or
when a design question is "can Weave do X?", write the community here first:
its grants and contracts in `communities/`, and tests in `tests/` that show
it working and show each attack on it refused. What it can't express
simply is a finding for the spec, not something to work around in a test.

The design behind them is
[the plan](../spec/drafts/constitution-grants-contracts.md).
