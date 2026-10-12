/**
 * A convergence fuzzer for `strong-remove/1` (spec 03 §4), from the
 * adversarial review of grants: random histories with nestings, invites,
 * people changing their own roles and rival definitions. Every arrival order
 * must give the same state, statuses, heads, judgements and views, and
 * extending one change at a time must give what replaying whole does.
 *
 * `RUNS` and `SEED` widen it: `RUNS=20000 node … tests/access-fuzz.test.ts`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  may,
  replayAccess,
  type AccessEvent,
  type AccessGenesis,
  type AccessHistory,
} from '../src/space/roles.js';
import { MEMBER_REMOVE, RECORD_WRITE, ROLE_ASSIGN, ROLE_DEFINE, ROLE_UNASSIGN } from '../src/space/grants.js';
import type { SpaceGrant as Grant } from '../src/types.js';

const ROLES = ['a', 'b', 'c', 'd'];
const POOL: ReadonlyArray<Grant> = [
  { cmd: RECORD_WRITE, pol: [] },
  { cmd: ROLE_ASSIGN, pol: [] },
  { cmd: ROLE_ASSIGN, pol: [['==', '.role', 'c']] },
  { cmd: ROLE_ASSIGN, pol: [['==', '.self', false]] },
  { cmd: ROLE_UNASSIGN, pol: [] },
  { cmd: MEMBER_REMOVE, pol: [['==', '.self', false]] },
  { cmd: MEMBER_REMOVE, pol: [] },
  { cmd: ROLE_DEFINE, pol: [] },
  { cmd: ROLE_DEFINE, pol: [['!=', '.role', 'a']] },
];
const PEOPLE = ['p0', 'p1', 'p2', 'p3', 'p4'];

/** A small seeded generator (mulberry32) */
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
  const shuffle = <T>(list: ReadonlyArray<T>): T[] => {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i--) {
      const j = int(i + 1);
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  };
  return { int, pick, shuffle, chance: (p: number) => next() < p };
}

function generate(seed: number) {
  const r = random(seed);
  const grants = () => [...new Set(Array.from({ length: r.int(4) }, () => r.pick(POOL)))];
  const nests = (role: string) => (r.chance(0.4) ? [r.pick(ROLES.filter((x) => x !== role))] : []);
  const genesis: AccessGenesis = {
    id: 'space',
    creator: 'p0',
    roles: ROLES.map((name) => ({ name, grants: grants(), nests: nests(name) })),
  };
  const events: AccessEvent[] = [];
  const n = 5 + r.int(22);
  for (let i = 0; i < n; i++) {
    const seen =
      events.length === 0 || r.chance(0.1)
        ? ['space']
        : [
            ...new Set(
              r
                .shuffle(events)
                .slice(0, 1 + r.int(2))
                .map((e) => e.id),
            ),
          ];
    const root = r.chance(0.25) ? 'p0' : r.pick(PEOPLE);
    const did = r.chance(0.2) ? root : r.pick(PEOPLE.filter((p) => p !== 'p0'));
    const role = r.pick(ROLES);
    const id = `e${String(i).padStart(3, '0')}${r.int(1000)}`;
    const base = { id, root, author: root, seen, cutoff: new Map(), line: i };
    const inviteKey = `k${r.int(2)}`;
    const k = r.int(12);
    const event: AccessEvent =
      k < 4
        ? { ...base, key: `assign:${did}|${role}`, kind: 'assign', did, role, assigned: true }
        : k < 6
          ? { ...base, key: `assign:${did}|${role}`, kind: 'assign', did, role, assigned: false }
          : k < 8
            ? { ...base, key: `remove:${did}`, kind: 'remove', did }
            : k < 10
              ? {
                  ...base,
                  key: `role:${role}`,
                  kind: 'role',
                  name: role,
                  grants: grants(),
                  nests: nests(role),
                }
              : k < 11
                ? {
                    ...base,
                    key: `invite:${inviteKey}`,
                    kind: 'invite',
                    inviteKey,
                    role,
                    open: r.chance(0.6),
                  }
                : {
                    ...base,
                    root: did,
                    author: did,
                    key: `assign:${did}|${role}`,
                    kind: 'assign',
                    did,
                    role,
                    assigned: true,
                    viaInvite: inviteKey,
                  };
    events.push(event);
  }
  return { genesis, events, r };
}

const writes = (did: string) => (state: Parameters<typeof may>[0]) =>
  may(state, did, RECORD_WRITE, { collection: 'x', byCreator: true });

const assignments = (state: Parameters<typeof may>[0] | null) =>
  state ? JSON.stringify([...state.assigned].map(([d, rs]) => [d, [...rs].sort()]).sort()) : null;

/** Everything two replays of one history must agree on */
function shape(h: AccessHistory, events: ReadonlyArray<AccessEvent>): string {
  const first = events.slice(0, 6);
  const last = events.slice(-3);
  return JSON.stringify({
    founders: [...h.current.founders].sort(),
    assigned: assignments(h.current),
    roles: [...h.current.roles].map(([n, ds]) => [n, ds.map((d) => d.event)]).sort(),
    invites: [...h.current.invites].sort(),
    status: events.map((e) => [e.id, h.status(e.id)?.status]),
    may: PEOPLE.flatMap((p) => [
      may(h.current, p, MEMBER_REMOVE, { self: false, roles: [] }),
      writes(p)(h.current),
    ]),
    heads: h.heads(),
    judge: first.flatMap((e) =>
      PEOPLE.map((p) => JSON.stringify(h.judge({ id: 'x', root: p, seen: [e.id] }, writes(p)))),
    ),
    within: first.flatMap((e) =>
      last.map((w) =>
        JSON.stringify(h.judge({ id: 'x', root: e.root, seen: [e.id] }, writes(e.root), [w.id])),
      ),
    ),
    at: last.map((e) => assignments(h.at([e.id]))),
    seenAs: last.map((e) => assignments(h.seenAs([e.id]))),
  });
}

const RUNS = Number(process.env.RUNS ?? 1000);

test('every arrival order, and extending one change at a time, gives what replaying whole does', () => {
  const base = Number(process.env.SEED ?? 12345);
  for (let seed = base; seed < base + RUNS; seed++) {
    const { genesis, events, r } = generate(seed);
    const whole = shape(replayAccess(genesis, events), events);
    for (let k = 0; k < 3; k++)
      assert.equal(shape(replayAccess(genesis, r.shuffle(events)), events), whole, `order, seed ${seed}`);
    let h: AccessHistory = replayAccess(genesis, []);
    const held: AccessEvent[] = [];
    for (const event of events) {
      const next = h.extend(event);
      held.push(event);
      const replayed = replayAccess(genesis, held);
      if (next)
        assert.equal(shape(next, held), shape(replayed, held), `extend, seed ${seed}, at ${event.id}`);
      h = replayed;
    }
  }
});
