# Scenarios

A scenario is a kind of community, written as tests: who founds it, which
roles and grants it has, what its contracts decide, and a story of records
with the hard cases (a removal racing an action, a reaction withdrawn, a
double spend from two devices). Each one says, in code, what Weave must let
that community do and what it must refuse.

| Scenario      | What it tests                                                                   |
| ------------- | ------------------------------------------------------------------------------- |
| Chess club    | Roles, a referee, "only your own move" (`.byCreator`), a contract on turn order |
| Co-op         | No fixed top; removal by a majority counted as of the proposal                  |
| Company team  | Teams and a sub-team, an admin who can't read hr or assign herself (`.self`)    |
| Hall of fame  | A claim citing evidence; withdrawals and removals before and after it           |
| Mutual credit | An account's line of payments, a credit limit, double spends from two devices   |

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
- `host/`: a small stand-in for what a peer does around the contracts
  (chains, pending, membership as of a version) and for grants. The CEL
  itself is the real evaluator from `packages/core`. The plan is to point
  the scenarios at the library as each part lands, and delete the stand-ins.
- `parked-datalog/`: the same communities in Datalog, from
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
