/**
 * Access replay is consensus: two peers that place changes differently
 * disagree for good about who may write. This generates random access
 * histories — several authors holding different roles, concurrent role
 * definitions, assignments and removals, revoked notes, key changes, `seen`
 * drawn from causal cuts — and
 * checks that:
 *
 * - every arrival order gives the same history: state, statuses, `at()`
 *   and `judge()`.
 *
 * What a correct replay must do is in access-properties.test.ts.
 *
 * A failure prints its seed; `ACCESS_SEED=<n>` runs that seed first.
 * `ACCESS_RUNS=<n>` changes how many histories run.
 */
import { test, describe } from 'node:test';
import type { SpaceGrant as Grant } from '../src/types.js';
import assert from 'node:assert/strict';

import {
  isMember,
  may,
  replayAccess,
  type AccessEvent,
  type AccessGenesis,
  type AccessHistory,
  type AccessState,
  type EventStatus,
  type Keeper,
  type Needs,
} from '../src/space/roles.js';
import {
  COLLECTION_DEFINE,
  KEY_CHANGE,
  MEMBER_REMOVE,
  RECORD_DELETE,
  RECORD_WRITE,
  ROLE_ASSIGN,
  ROLE_DEFINE,
  ROLE_UNASSIGN,
  SPACE_KEEPERS,
  SPACE_RELAYS,
  type FoundingRole,
} from '../src/space/grants.js';

/** What every peer must agree on: everything a history answers but `extend` and `headsFor`, which only serve a writer */
type ReferenceHistory = Omit<AccessHistory, 'extend' | 'headsFor'>;

function random(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => Math.floor(next() * n);
  const pick = <T>(list: ReadonlyArray<T>): T => list[int(list.length)]!;
  const chance = (p: number) => next() < p;
  const shuffle = <T>(list: ReadonlyArray<T>): T[] => {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i--) {
      const j = int(i + 1);
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  };
  return { int, pick, chance, shuffle };
}
type Random = ReturnType<typeof random>;

const notAdmin = ['not', ['any', '.roles', ['==', '.', 'admin']]] as const;
/** Grants a definition may hold, drawn at random */
const POOL: ReadonlyArray<Grant> = [
  { cmd: '/record', pol: [] },
  { cmd: RECORD_WRITE, pol: [['==', '.byCreator', true]] },
  { cmd: RECORD_DELETE, pol: [['==', '.collection', 'app.x']] },
  { cmd: ROLE_ASSIGN, pol: [['==', '.role', 'member']] },
  { cmd: ROLE_ASSIGN, pol: [['==', '.self', false]] },
  { cmd: ROLE_UNASSIGN, pol: [notAdmin] },
  { cmd: MEMBER_REMOVE, pol: [notAdmin] },
  { cmd: MEMBER_REMOVE, pol: [] },
  { cmd: ROLE_DEFINE, pol: [['!=', '.role', 'admin']] },
  { cmd: ROLE_DEFINE, pol: [['==', '.role', 'helper']] },
  { cmd: COLLECTION_DEFINE, pol: [] },
  { cmd: KEY_CHANGE, pol: [] },
  { cmd: SPACE_RELAYS, pol: [] },
  { cmd: SPACE_KEEPERS, pol: [] },
];
const ROLES: ReadonlyArray<FoundingRole> = [
  {
    name: 'admin',
    grants: [
      { cmd: '/record', pol: [] },
      { cmd: ROLE_ASSIGN, pol: [] },
      { cmd: ROLE_UNASSIGN, pol: [notAdmin] },
      { cmd: MEMBER_REMOVE, pol: [notAdmin] },
      { cmd: ROLE_DEFINE, pol: [['!=', '.role', 'admin']] },
      { cmd: COLLECTION_DEFINE, pol: [] },
      { cmd: KEY_CHANGE, pol: [] },
      { cmd: SPACE_RELAYS, pol: [] },
      { cmd: SPACE_KEEPERS, pol: [] },
    ],
  },
  {
    name: 'mod',
    grants: [
      { cmd: RECORD_DELETE, pol: [] },
      { cmd: ROLE_ASSIGN, pol: [['==', '.role', 'member']] },
      { cmd: MEMBER_REMOVE, pol: [['==', '.self', false], notAdmin] },
      { cmd: ROLE_DEFINE, pol: [['==', '.role', 'helper']] },
    ],
  },
  {
    name: 'helper',
    grants: [{ cmd: RECORD_WRITE, pol: [['==', '.collection', 'app.x']] }],
    nests: ['member'],
  },
  { name: 'member', grants: [{ cmd: RECORD_WRITE, pol: [['==', '.byCreator', true]] }] },
];
const ROLE_NAMES = ['admin', 'mod', 'helper', 'member', 'extra'];
const PEOPLE = ['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'];
const WRITERS = ['w1', 'w2'];
const COLLECTIONS = ['app.x', 'app.y'];
const INVITES = ['i1', 'i2', 'i3'];
const RECORDS = 16;

interface History {
  readonly genesis: AccessGenesis;
  /** In the order they were made: each after everything it saw */
  readonly events: ReadonlyArray<AccessEvent>;
  readonly cuts: ReadonlyArray<ReadonlyArray<string>>;
  readonly records: ReadonlyArray<{
    readonly id: string;
    readonly root: string;
    readonly seen: ReadonlyArray<string>;
    readonly note?: string;
    readonly within?: ReadonlyArray<string>;
  }>;
}

function generate(seed: number): History {
  const r = random(seed);
  const genesis: AccessGenesis = {
    id: 'genesis',
    creator: 'p0',
    roles: ROLES,
    ...(r.chance(0.8) ? { key: { keyId: 'k0', readKey: 'r0' } } : {}),
  };
  const events: AccessEvent[] = [];
  const ancestors = new Map<string, Set<string>>();
  const ids = new Set<string>();
  const newId = () => {
    let id: string;
    do id = r.int(0xffffffff).toString(16).padStart(8, '0');
    while (ids.has(id));
    ids.add(id);
    return id;
  };
  const heads = () => {
    const parents = new Set(events.flatMap((event) => event.seen));
    return events.map((event) => event.id).filter((id) => !parents.has(id));
  };
  /** What a change made now might have seen: some changes, none of them before another */
  const someSeen = (): string[] => {
    if (events.length === 0 || r.chance(0.05)) return r.chance(0.5) ? [genesis.id] : [];
    if (r.chance(0.4)) return heads();
    const picked = new Set<string>();
    const recent = r.chance(0.6) ? Math.min(events.length, 4) : events.length;
    for (let k = 1 + r.int(3); k > 0; k--) picked.add(events[events.length - 1 - r.int(recent)]!.id);
    const seen = [...picked].filter((id) => ![...picked].some((other) => ancestors.get(other)!.has(id)));
    if (r.chance(0.05)) seen.push(genesis.id);
    return seen;
  };
  const powerful = new Set(['p0']);
  const author = () => (r.chance(0.75) ? r.pick([...powerful]) : r.pick(PEOPLE));

  const length = 5 + r.int(56);
  for (let n = 0; n < length; n++) {
    let seen = someSeen();
    // Now and then a change that saw something that never arrives: it, and all after it, wait.
    if (r.chance(0.03)) seen = [...seen, `missing-${r.int(3)}`];
    const roll = r.int(100);
    // Changes that take power away leave places more often: that is where cutoffs matter.
    const cutoff = new Map(
      roll < 72 && r.chance(0.6)
        ? Array.from(
            { length: 1 + r.int(3) },
            () => [r.pick(WRITERS), new Map([[r.pick(COLLECTIONS), r.int(6)]])] as const,
          )
        : [],
    );
    const base = { id: newId(), root: author(), author: r.pick(WRITERS), seen, cutoff, line: r.int(6) };
    let event: AccessEvent;
    if (roll < 40) {
      const did = r.pick(PEOPLE);
      const opened = events.filter((e) => e.kind === 'invite' && e.open);
      const viaInvite = opened.length > 0 && r.chance(0.2) ? r.pick(opened) : null;
      const role = r.pick(ROLE_NAMES);
      const key = `assign:${did}|${role}`;
      if (viaInvite?.kind === 'invite') {
        const joined = r.chance(0.85) ? viaInvite.role : role;
        event = {
          ...base,
          root: did,
          kind: 'assign',
          key: `assign:${did}|${joined}`,
          did,
          role: joined,
          assigned: true,
          viaInvite: viaInvite.inviteKey,
        };
      } else if (r.chance(0.2)) {
        // Removed, or leaving.
        event = {
          ...base,
          ...(r.chance(0.3) ? { root: did } : {}),
          kind: 'remove',
          key: `remove:${did}`,
          did,
        };
      } else {
        const leaving = r.chance(0.1);
        event = {
          ...base,
          ...(leaving ? { root: did } : {}),
          kind: 'assign',
          key,
          did,
          role,
          assigned: !leaving && r.chance(0.75),
        };
      }
      if (event.kind === 'assign' && event.assigned && r.chance(0.7)) powerful.add(event.did);
    } else if (roll < 55) {
      const name = r.pick(['mod', 'helper', 'member', 'extra', 'admin']);
      const grants = [...new Set(Array.from({ length: r.int(4) }, () => r.pick(POOL)))];
      const nests = r.chance(0.2) ? [r.pick(ROLE_NAMES.filter((n) => n !== name))] : [];
      event = { ...base, kind: 'role', key: `role:${name}`, name, grants, nests };
    } else if (roll < 67) {
      const inviteKey = r.pick(INVITES);
      const role = r.pick(ROLE_NAMES);
      event = { ...base, kind: 'invite', key: `invite:${inviteKey}`, inviteKey, role, open: r.chance(0.7) };
    } else if (roll < 72) {
      const key = r.pick(WRITERS);
      event = { ...base, kind: 'revoke', key: `revoke:${key}|${base.root}`, target: key };
    } else if (roll < 75) {
      const writer = r.pick(WRITERS);
      const collection = r.pick([...COLLECTIONS, 'sys.assign', 'sys.role']);
      event = { ...base, kind: 'fork', key: `fork:${writer}`, writer, collection, from: r.int(5) };
    } else if (roll < 83) {
      const name = r.pick(['app.x', 'app.y']);
      event = { ...base, kind: 'definition', key: `collection:${name}`, name, deleted: r.chance(0.15) };
    } else if (roll < 91) {
      const k = r.int(6);
      event = {
        ...base,
        kind: 'key',
        key: 'key',
        keyId: `k${k}`,
        readKey: `r${r.chance(0.9) ? k : r.int(6)}`,
      };
    } else if (roll < 96) {
      const relays = r.pick([
        ['wss://a.example'],
        ['wss://b.example', 'wss://a.example'],
        ['http://bad'],
        [],
      ]);
      event = { ...base, kind: 'relays', key: 'relays', relays };
    } else {
      const keepers: Keeper[] = r.pick([
        [{ did: 'did:key:zA', name: 'A' }],
        [
          { did: 'did:key:zA', name: 'A' },
          { did: 'did:key:zB', name: 'B' },
        ],
        [{ did: 'not-a-did', name: 'X' }],
      ]);
      event = { ...base, kind: 'keepers', key: 'keepers', keepers, copies: r.pick([null, 1, 2, 99]) };
    }
    const mine = new Set<string>();
    for (const parent of seen) {
      mine.add(parent);
      for (const above of ancestors.get(parent) ?? []) mine.add(above);
    }
    ancestors.set(event.id, mine);
    events.push(event);
  }

  const cuts = [[], [genesis.id], heads(), ['missing-0'], ...Array.from({ length: 10 }, () => someSeen())];
  const records = Array.from({ length: RECORDS }, (_, i) => ({
    id: `rec-${i}`,
    root: r.chance(0.8) ? r.pick([...powerful]) : r.pick(PEOPLE),
    seen: someSeen(),
    ...(r.chance(0.5) ? { writer: r.pick(WRITERS), collection: r.pick(COLLECTIONS), line: r.int(6) } : {}),
    ...(r.chance(0.3) ? { within: someSeen() } : {}),
  }));
  return { genesis, events, cuts, records };
}

// ─── What two replays must agree on ────────────────────────────────────

/** What a record by `root` asks, three ways */
const NEEDS: ReadonlyArray<(root: string) => Needs> = [
  (root) => (state) => isMember(state, root),
  (root) => (state, without) =>
    may(state, root, RECORD_DELETE, { collection: 'app.x', byCreator: false }, without ? { without } : {}),
  (root) => (state, without) =>
    may(state, root, COLLECTION_DEFINE, { collection: 'app.x' }, without ? { without } : {}) &&
    state.definitions.has('app.x'),
];

/** Questions to ask of a state about each person: what a role's grants, judged where defined, give */
const ASKED: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
  [RECORD_WRITE, { collection: 'app.x', byCreator: false }],
  [RECORD_DELETE, { collection: 'app.y', byCreator: true }],
  [ROLE_ASSIGN, { role: 'member', self: false, roles: [] }],
  [MEMBER_REMOVE, { self: false, roles: ['mod'] }],
  [ROLE_DEFINE, { role: 'helper' }],
  [KEY_CHANGE, {}],
];

const byKey = <T>(map: ReadonlyMap<string, T>) => [...map].sort((a, b) => (a[0] < b[0] ? -1 : 1));

function stateShape(state: AccessState | null): string {
  if (!state) return 'null';
  return JSON.stringify({
    founders: [...state.founders].sort(),
    roles: byKey(state.roles).map(([name, definitions]) => [
      name,
      definitions.map(({ event, by, grants, nests }) => ({ event, by, grants, nests })),
    ]),
    assigned: byKey(state.assigned).map(([did, roles]) => [did, byKey(roles)]),
    invites: byKey(state.invites),
    definitions: byKey(state.definitions),
    contested: byKey(state.contested),
    keys: state.keys,
    keyDue: state.keyDue,
    relays: state.relays,
    keepers: state.keepers,
    copies: state.copies,
    may: PEOPLE.map((did) => ASKED.map(([cmd, args]) => (may(state, did, cmd, args) ? 1 : 0)).join('')),
  });
}

/** Everything a replay answers, as text — one entry per question, so a difference says where it is */
function shape(history: ReferenceHistory, h: History): Record<string, string> {
  const status = (s: EventStatus | null) =>
    !s
      ? 'none'
      : s.status === 'applied'
        ? `applied@${s.index}`
        : s.status === 'dropped'
          ? `dropped: ${s.reason}`
          : s.status;
  const out: Record<string, string> = {
    current: stateShape(history.current),
    heads: JSON.stringify(history.heads()),
  };
  for (const event of h.events) out[`status ${event.id}`] = status(history.status(event.id));
  h.cuts.forEach((cut, i) => (out[`at #${i} [${cut.join(',')}]`] = stateShape(history.at(cut))));
  for (const record of h.records) {
    NEEDS.forEach((needs, i) => {
      out[`judge ${record.id} needs#${i}`] = JSON.stringify(
        history.judge(record, needs(record.root), record.within),
      );
    });
  }
  for (const writer of WRITERS)
    for (const did of PEOPLE) out[`revoked ${writer} ${did}`] = JSON.stringify(history.revoked(writer, did));
  for (const writer of WRITERS)
    for (const collection of [...COLLECTIONS, 'sys.assign', 'sys.role'])
      out[`forked ${writer} ${collection}`] = JSON.stringify(history.forked(writer, collection));
  out.forks = JSON.stringify(
    [...history.forks()].sort(
      (a, b) => a.writer.localeCompare(b.writer) || a.collection.localeCompare(b.collection),
    ),
  );
  for (const did of PEOPLE) out[`named ${did}`] = String(history.named(did));
  for (const key of INVITES) out[`knownInvite ${key}`] = String(history.knownInvite(key));
  return out;
}

function same(actual: Record<string, string>, expected: Record<string, string>, what: string): void {
  for (const key of Object.keys(expected)) {
    if (actual[key] !== expected[key])
      assert.fail(`${what}: ${key}\n  expected ${expected[key]}\n  actual   ${actual[key]}`);
  }
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), what);
}

const RUNS = Number(process.env.ACCESS_RUNS ?? 500);
const first = process.env.ACCESS_SEED ? Number(process.env.ACCESS_SEED) : (Date.now() * 7919) >>> 0;

/** Runs `check` on RUNS histories, naming the seed of the first that fails */
function forHistories(check: (h: History, r: Random) => void): void {
  for (let run = 0; run < RUNS; run++) {
    const seed = (first + run) >>> 0;
    try {
      check(generate(seed), random(seed ^ 0x9e3779b9));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      assert.fail(`seed ${seed} (ACCESS_SEED=${seed} to run it again)\n${message}`);
    }
  }
}

describe('access replay converges', () => {
  test('every arrival order gives the same history', () => {
    forHistories((h, r) => {
      const expected = shape(replayAccess(h.genesis, h.events), h);
      for (let p = 0; p < 3; p++) {
        const order = r.shuffle(h.events);
        // Duplicates are ignored, wherever they fall.
        if (p === 2 && order.length > 0) order.splice(r.int(order.length), 0, r.pick(order));
        same(shape(replayAccess(h.genesis, order), h), expected, `arrival order ${p}`);
      }
    });
  });

  test('extending one change at a time gives what replaying whole does', () => {
    let extendedOnce = 0;
    forHistories((h) => {
      let history = replayAccess(h.genesis, []);
      const held: AccessEvent[] = [];
      for (const event of h.events) {
        held.push(event);
        const next = history.extend(event);
        if (next) extendedOnce++;
        history = next ?? replayAccess(h.genesis, held);
      }
      same(shape(history, h), shape(replayAccess(h.genesis, h.events), h), 'extended against whole');
    });
    assert.ok(extendedOnce > RUNS, `extended ${extendedOnce} times`);
  });

  test('the histories are not trivial', () => {
    // A generator that only ever makes dropped changes, or never concurrent ones, would prove nothing.
    let applied = 0;
    let dropped = 0;
    let waiting = 0;
    let concurrent = 0;
    let refused = 0;
    let rivals = 0;
    let struck = 0;
    let struckDefinitions = 0;
    forHistories((h) => {
      const history = replayAccess(h.genesis, h.events);
      for (const event of h.events) {
        const status = history.status(event.id)?.status;
        if (status === 'applied') applied++;
        else if (status === 'dropped') dropped++;
        else waiting++;
      }
      const parents = new Set(h.events.flatMap((event) => event.seen));
      if (h.events.filter((event) => !parents.has(event.id)).length > 1) concurrent++;
      for (const record of h.records) if (!history.judge(record, NEEDS[0]!(record.root)).ok) refused++;
      for (const definitions of history.current.roles.values()) if (definitions.length > 1) rivals++;
      for (const event of h.events) {
        const status = history.status(event.id);
        if (status?.status === 'dropped' && status.reason.startsWith("Its author's power was taken")) {
          struck++;
          if (event.kind === 'role') struckDefinitions++;
        }
      }
    });
    assert.ok(applied > RUNS * 3, `applied ${applied}`);
    assert.ok(dropped > RUNS, `dropped ${dropped}`);
    assert.ok(waiting > 0, `waiting ${waiting}`);
    assert.ok(concurrent > RUNS / 4, `concurrent ${concurrent}`);
    assert.ok(refused > RUNS, `refused ${refused}`);
    assert.ok(rivals > RUNS / 200, `rival definitions ${rivals}`);
    assert.ok(struck > RUNS / 10, `struck ${struck}`);
    assert.ok(struckDefinitions > 0, `struck definitions ${struckDefinitions}`);
  });
});
