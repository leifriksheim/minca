# Plan: fast first sync ("shallow holding") and a host that one space can't slow

Written 2026-11-11 for an executing agent. Repo: `~/apps/minca` (branch from `origin/main`,
which includes PR #433). Read `CLAUDE.md` first; its rules apply (spec before code, show the
size of `packages/core/src spec` diffs, no `any`, no type assertions).

## 0. Why

A fresh node (new phone, cleared browser, every MCP session) must take in **every kept
version of every record**, stubs included, before it is level and may act. Cost follows
edits ever made, not data that exists. Measured cases:

- `spec/drafts/stub-checkpoints.md` §1: 100 records settle in 0.05 s with 0 edits each,
  0.9–3.1 s with 50 edits each.
- Production, 9–10 Nov 2026: one account's registry held ~160 current records but 19,743
  versions (a `minca.seen` write loop). Fresh MCP session nodes never became level;
  after PR #433 they do, but take minutes. The single-threaded host served the re-asks
  and slowed for every space.

Two goals:

1. **A fresh node is usable after syncing current state only.** Time to "level enough to
   act" is flat in edits per record.
2. **One space's work cannot slow another space on a host**, whether from a bug or on purpose.

## 1. Design decisions (made; do not reopen without a failing test or a spec conflict)

### 1.1 Shallow holding, not checkpoints

The stub-checkpoints draft drops stubs for everyone and needs a new `sys.*` collection,
trusted signers and fences. This plan does less: **nothing is dropped anywhere**. A node
may _choose_ to hold a collection **shallow**, like a git shallow clone: a local cut,
trusted because the node trusts the space's keepers to hold and check the rest. Keepers
and existing devices are unchanged. Checkpoints stay a draft; shallow holding does not
block them.

### 1.2 The shallow set

For one collection, the **shallow set** is every kept version that is any of:

- the current version of its record (a stub awaiting its body included);
- a first version (`seq 0`), whole or stub;
- retained (`retain: true`).

That is: everything except unretained stubs with `seq > 0`. Consequences that make this
safe with today's checks:

- `sys.*` is all retained, so the access history is always whole.
- Collections with a `contract`, `history: "all"`, and first versions under
  `onePer`/`fixed` are retained, so every check that reads an earlier _body_ still has it.
- Only the link check (02 §4.7, `chainStanding`) and writers' lines (02 §4.10) lose
  their inputs. §1.4 and §1.5 handle those.

### 1.3 Wire: additive, no version bump

`SYNC_PROTOCOL_VERSION` stays 8 (`isSyncMessage` refuses any other `v`, so a bump cuts off
every old client at once). Two optional `hello` fields, ignored by old peers:

- `can: ['shallow']`: this peer can serve shallow sets. Sent by every upgraded node that
  holds a space whole.
- `shallow: true`: the `sums` in this hello are over shallow sets, and sessions this
  peer starts or answers compare shallow sets.

And one on `reconcile`: `shallow: true`, so the responder picks the item set per
message rather than from remembered state.

A node uses shallow **only with a peer that (a) is one of the space's named keepers
(`sys.keepers`) and (b) said `can: ['shallow']`**. With anyone else it behaves as today.
Deploy order therefore: host first, then MCP, then apps.

### 1.4 Admission on a shallow node

In `chainStanding` (`packages/core/src/node/space-standing.ts`): when `prev` is not held,
today the version waits (`later`). New rule: **if the node holds this collection shallow
and the version came from a keeper, the link is taken on the keeper's word and the
version stands**, provided its first version is held and `firstOf` passes (unchanged).
From any non-keeper peer the old rule holds (wait; a live `push-update` on top of the
held current version checks normally because its `prev` is the held current).

What a shallow node gives up: it cannot itself detect a `seq` skip below what it holds.
A keeper that lies can make a shallow node show a version a whole node would refuse.
It cannot forge a signature, a membership or a body. Put exactly this in
`spec/threat-model.md`.

### 1.5 Writers' lines and cutoffs on a shallow node

- `noteGap` / `cacheState.missing` (`space-holding.ts`, `space-lines.ts`): a shallow
  collection has gaps by design. Do not record or ask for them while shallow.
- A cutoff (`space-lines.ts`, "what a change taking power from an account leaves
  standing") is computed from the unbroken lines this node holds. On a shallow node it
  would cover too little and withdraw honest writes. **A node holding any collection of
  the space shallow MUST NOT write an access change that carries a cutoff.** It deepens
  first (§1.6) and then writes; if it cannot, the write fails with a sentence saying why.
  MCP sessions are records-only and never write these.

### 1.6 Two ways to be shallow, one option

`NodeConfig.shallow?: 'first' | 'always'`, default `'first'`.

- `'first'` (apps, devices): a node that has never been level with a keeper in a space
  starts shallow, becomes usable, then **deepens in the background**: it sends a normal
  hello and reconciles whole sets, after which it is an ordinary whole node. A node
  already whole never goes shallow.
- `'always'` (MCP sessions, one-call CLI nodes): stays shallow.

A node named among the space's keepers is never shallow. A space with no keepers is
never held shallow (same condition `space-holding.ts` already uses for `cache`).

### 1.7 Start-up sequence of a fresh node in a space

1. Hello with `holds: []` (nothing besides `sys.*`). Reconcile `sys.*` whole. Now it
   knows the keepers.
2. If a connected peer is a keeper with `can: ['shallow']`: hello with `shallow: true`,
   its real `holds`, and shallow sums. Reconcile shallow sets. **Level here is "level
   enough to act"**: `syncedWith`/`reached`/`catchUp` need no change beyond this.
3. `'first'` only: hello without `shallow`; reconcile whole sets at low priority.
4. No such keeper within ~2 s of step 1 settling: proceed as today (whole).

### 1.8 Not doing (and why)

- **HTTP bulk snapshot / host-answered queries.** After shallow sets, a fresh sync is a
  few Negentropy rounds over ~the number of live records. Add nothing until the bench
  in §2 shows the round trips still dominate.
- **Persistent MCP session stores.** Would put users' space data at rest on the MCP
  service (threat-model change) to save a cold start that shallow makes small. Revisit
  only if §6 acceptance fails for MCP.
- **Dropping stubs / mutable records / checkpoints.** Separate, larger, still a draft.

## 2. Phase 0: benchmark and baseline (no behaviour change)

Files: `packages/core/tests/bench/churn.ts`, `common.ts`.

1. Read `churn.ts`. Add a mode that reports **time until the newcomer is level with the
   source** separately from "holds every version", for edits-per-record 0, 10, 50, 500,
   and one case of 1 record × 5,000 edits.
2. Add a "noisy neighbour" case to `packages/cli/tests/bench/host-load.ts`: host with two
   spaces; while a fresh node syncs space A (20,000 versions), measure p50/p99 of
   `/health` and of a 10-record sync of space B.
3. Record the numbers in the PR description. They are the "before".

## 3. Phase 1: spec (one PR, text only, marked Planned until Phase 2 lands with it)

Prefer landing this in the **same PR as Phase 2**; write it first so the code follows it.

- `spec/05-sync-and-storage.md`
  - §4 `hello`, `reconcile`: the optional fields of §1.3.
  - §5 "What a node holds": a node may hold a collection shallow; the shallow set (§1.2);
    when it may (§1.3 conditions, §1.6 exclusions); two peers in a shallow exchange
    compare shallow sets and send only versions in them.
  - §6.2/§6.3: which set sums and sessions use; start-up sequence (§1.7).
  - §8 "Taking in versions": the admission rule (§1.4).
  - §9: completeness for a shallow collection means level with a keeper on its shallow
    set; lines are not checked while shallow.
  - §9.1: note that #27's "hold subsets" is unaffected.
- `spec/02-records.md` §4.5 ("Nothing a peer has taken in is dropped" stays true; add
  that a peer may decline to _take in_ unretained stubs it was never sent), §4.7 (the
  exception), §4.10 (lines on a shallow node; the cutoff rule of §1.5).
- `spec/threat-model.md`: §1.4's last paragraph.
- `spec/drafts/stub-checkpoints.md` §7: one paragraph pointing here as the step taken first.
- `packages/core/docs/node.md` "holding part of a space": the `shallow` option.

## 4. Phase 2: shallow holding in core, then cli

Order matters; each step has its test before the next starts.

### 4.1 Storage: a second item set

File: `packages/core/src/storage/storage-provider.ts`.

- Today `i/<collection>/<time>/<id>` indexes every kept version; `loadKept` builds the
  `ItemSet`s and `totals` from it. Add a parallel index for the shallow set (suggested
  prefix `t/`, same key shape), written and removed in the same batch as `i/`:
  - added when a version is kept and is current, `seq 0`, or retained;
  - removed when a version is demoted to an unretained stub with `seq > 0`
    (`demote` / `keepSuperseded`), and in `removeVersion`.
- `items(collection, shallow?)` and `sums(shallow?)` (or two named methods; pick the
  shape that keeps call sites readable). Keep sums incremental as `totals` is today.
- **Existing stores have no `t/` entries.** Build them once per store, lazily, on first
  shallow read: walk `r/`, `g/`, `h/` pointers, load those versions, write `t/` entries
  and a marker entry. On the host this runs per space on first shallow hello; do it in
  chunks that yield (see §5.1) so a large space cannot block the loop.
- Tests (`packages/core/tests/versions.test.ts` or a new `shallow.test.ts`): after N edits
  the shallow set is {current, first}; a retained collection's shallow set equals its
  whole set; delete then rewrite; `removeVersion`; a store migrated from no index gives
  the same set as one built incrementally.

### 4.2 Sync engine

File: `packages/core/src/sync/sync-engine.ts`, `sync-messages.ts`.

- `SyncEngineConfig`: `shallowWith?: (peerId) => boolean` (the node's decision per §1.3)
  and `canServeShallow?: () => boolean`.
- `hello`: send `can` when serving; send `shallow: true` with shallow sums when
  `shallowWith(peer)`. `onHello`: if `theirs.shallow`, compare against our shallow sums
  and remember it on `PeerState` for sessions we start toward them.
- `begin` / responder path / `endSession`: use the shallow `ItemSet` when the exchange is
  shallow; `reconcile` carries `shallow: true`. `endSession` must send only versions in
  the shallow set (it sends `session.have`, which then only contains those).
- `serveWant`: unchanged (ids asked are served if held).
- A node deepening (§1.7 step 3) simply stops returning true from `shallowWith` and says
  hello again; `level.clear()` semantics already handle the rest.
- Tests (`packages/core/tests/sync.test.ts`): a newcomer shallow-syncing a 2,500-edit
  record ends holding exactly 2 versions of it and is level in a bounded number of
  messages (assert a count, not a time); a shallow hello to a peer without `can` falls
  back to whole; two whole peers are byte-for-byte unaffected (existing tests pass
  untouched).

### 4.3 Node: when to be shallow, admission, lines

Files: `packages/core/src/node/space-holding.ts` (owns the decision and its persisted
state next to `cacheState`), `space-peers.ts` (wires `shallowWith`, and passes **which
peer a version came from** into validation: today `validate(version)` has no sender),
`space-standing.ts` (`chainStanding`, §1.4), `space-lines.ts` (`noteGap`, cutoff guard,
§1.5), `types.ts` (`NodeConfig.shallow`).

- Persist per space: `shallow: boolean` and `deepened: boolean` so a restart resumes.
- `spaces.status()` gains what is needed to tell a person "history still arriving"
  (one field; do not add events).
- Queries: a shallow collection is complete when shallow-level with a keeper.
- Tests (`packages/core/tests/caches.test.ts`, `reconcile.test.ts`, new cases):
  - fresh node + keeper: usable (query returns every current record) before any stub
    arrives; then deepens to the keeper's exact fingerprint (`'first'`);
  - `'always'` never deepens;
  - no keeper named, or keeper without `can`: whole, as today;
  - a non-keeper peer cannot get a chain-less version admitted;
  - a keeper-sent version naming a first version of another record is refused;
  - writing `sys.remove` while shallow deepens first or fails with the reason;
  - contract and `onePer` collections behave identically shallow and whole.
- Run `npm run scenarios`; nothing there should change.

### 4.4 CLI and MCP

- `packages/cli/src/host.ts` / `serve.ts`: the host says `can: ['shallow']`. Nothing else.
- `packages/cli/src/agent.ts` (`startGrantedAgent`) and `remote-mcp/sessions.ts`: session
  nodes use `shallow: 'always'`. `level.ts` needs no change; verify with a test that
  `catchUp` returns once shallow-level.
- `packages/cli/src/remote-mcp/memory.ts`: the 32 MB session budget now bounds shallow
  sets; leave the number, fix the comment.

### 4.5 Apps

`apps/shared` / `packages/cli/src/app-node.ts` (where `cache: {}` is set): default
`'first'` needs no code. Add the one status line ("History is still arriving") where
sync state is already shown. Do not add settings.

## 5. Phase 3: a host no space can slow (cli only; no protocol)

Files: `packages/cli/src/host.ts`, `serve.ts`, `host-setup.ts`, `host-stats.ts`.

### 5.1 Yielding and fair scheduling

- Find every loop on the host that does synchronous SQLite per item without yielding:
  `measureAll`/`sweep`/`collectStats` (hourly; caused a 30 s health-check failure),
  `storage-provider` `load()`/`pointersUnder()`/`loadKept()` on big collections, and the
  `t/` index build of §4.1. Chunk them (≈200 rows) with a yield between chunks.
- Inbound sync messages are handled per peer in order (`inOrder` in `sync-engine.ts`).
  On the host, put a **per-space scheduler** in front of `handleMessage`: one queue per
  space, round-robin, a slice of ~8 ms of work per turn, then `setImmediate`. A space
  with a backlog waits behind its own queue only.

### 5.2 Work budgets

- Per space, token buckets for versions admitted per minute and versions served per
  minute (defaults generous: thousands). Over budget, that space's queue **pauses**
  until tokens return. Never drop or refuse: a paused peer just sees slower sync, so no
  protocol change and no data loss.
- Per connection: cap queued inbound bytes; past it stop reading the socket
  (backpressure), and close a peer that keeps a full queue for minutes.

### 5.3 Seeing it

- Per space, per minute: messages, versions in, versions out, milliseconds of work.
  Keep the top few in memory; **log one line when a space exceeds its budget and when
  it returns under**. `/host/stats` stays totals-only (it is public and must say nothing
  about one space).
- This is what would have named store 48 within the hour on 5 Nov.

### 5.4 Writer-side guard (core, library behaviour, not protocol)

`packages/core/src/node/space-writing.ts`: when one record key is written more than 30
times in 60 s by this node, `console.warn` once per key per minute with the collection
and key. No blocking, no new option. (The 5 Nov loop wrote one key ~5,900 times in an
hour; a warning in the console is what was missing.)

### 5.5 Tests

- The noisy-neighbour bench of §2 as a test with a loose bound.
- Budget pause and resume; nothing lost across a pause (fingerprints equal after).
- `packages/cli/tests/host-store.test.ts` still passes.

## 6. Acceptance

| Measure                                                                                | Before              | Target                                 |
| -------------------------------------------------------------------------------------- | ------------------- | -------------------------------------- |
| Churn bench, 100 records × 50 edits, time to level (newcomer)                          | 0.9–3.1 s           | within 1.5× of the 0-edit time         |
| 1 record × 5,000 edits, time to level                                                  | minutes             | under 1 s                              |
| MCP: first tool call of a fresh session on an account whose registry has ~20k versions | timed out / minutes | under 3 s                              |
| Host `/health` p99 while another space full-syncs 20k versions                         | spikes to 3.6 s     | under 300 ms                           |
| `git diff --shortstat main...HEAD -- packages/core/src spec`                           | –                   | stated in each PR, each addition named |

All of `npm run check`, `npm test`, `npm run scenarios` pass. Known flaky on main, not
to be "fixed" here: `carrier.test.ts` "never names its carry space" (intermittent) and
two `connect.test.ts` timeouts. Run test files with `--test-force-exit` or they hang.

## 7. Delivery

- **PR 1**: Phase 0 + Phase 1 + Phase 2 (§4.1–4.4). Stop and report to Leif after §4.2's
  tests pass, before §4.3, with the bench numbers so far.
- **PR 2**: Phase 3.
- **PR 3** (small): §4.5 status line, if not already in PR 1.
- Deploy after PR 1: `minca-host` first, then `minca-mcp`
  (`fly deploy . --config packages/cli/fly.toml`, then `fly.mcp.toml`). Leif runs host
  deploys himself. Check the MCP row of §6 against production before calling it done.

## 8. Stop and ask if

- Any check besides `chainStanding` and the line/gap logic turns out to need a
  superseded unretained stub (search for `getVersion(version.prev)` and
  `storage.history(`; `space-checks.ts:168` is contracts and is covered by retention).
- The account registry space does not name the host as a keeper (shallow would never
  apply to it). Check `spaces.access(registry).keepers` on a real account first; if it
  does not, the registry needs its carriers treated as keepers for this purpose, and
  that is a design question for Leif.
- Making sums incremental for the shallow set needs a storage adapter interface change
  (IndexedDB, folder and SQLite adapters all implement it).
- The size of the core diff passes ~600 added lines.

## 9. Housekeeping left from the incident (independent of this plan)

- Fly volume `host_data_rehearsal` (`vol_v3g30epw9elp8gl4`, app `minca-host`): delete
  once Leif confirms.
- Worktrees `~/apps/minca-sync-debug` (branch `debug/sync-level`, do not merge) and
  `~/apps/minca-ops` (branch `ops/drop-collection-history`, an uncommitted one-off
  script at `packages/cli/scripts/ops/drop-collection-history.ts`): remove, or commit
  the script if Leif wants it kept. With shallow holding the cleanup it does is no
  longer needed for sync speed.
- Leif's registry was re-filled with old `minca.seen` versions by a device that still
  held them. Harmless after this plan; no action.
