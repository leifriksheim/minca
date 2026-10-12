/**
 * Properties of the access replay, checked on thousands of random histories
 * (spec/03-spaces.md §4). Unlike access-convergence.test.ts,
 * which compares the replay with a frozen copy of itself, these say what any
 * correct replay must do, so they can't share its bugs.
 *
 * A property today's replay breaks is marked `todo` with the issue it shows:
 * it reports, but doesn't fail the suite. The convergent replay must pass
 * every one. A failure prints its seed; `ACCESS_SEED=<n>` runs it again, and
 * `ACCESS_RUNS=<n>` changes how many histories run.
 */
import { test, describe } from 'node:test';
import type { SpaceGrant as Grant } from '../src/types.js';
import assert from 'node:assert/strict';

import {
  isMember,
  refusal,
  replayAccess,
  rolesOf,
  type AccessEvent,
  type AccessGenesis,
  type AccessHistory,
} from '../src/space/roles.js';
import {
  MEMBER_REMOVE,
  RECORD_WRITE,
  ROLE_ASSIGN,
  ROLE_DEFINE,
  ROLE_UNASSIGN,
  type FoundingRole,
} from '../src/space/grants.js';

const notOwner = ['not', ['any', '.roles', ['==', '.', 'owner']]] as const;
const ROLES: ReadonlyArray<FoundingRole> = [
  {
    name: 'owner',
    grants: [
      { cmd: ROLE_ASSIGN, pol: [] },
      { cmd: ROLE_UNASSIGN, pol: [notOwner] },
      { cmd: MEMBER_REMOVE, pol: [notOwner] },
      { cmd: ROLE_DEFINE, pol: [['!=', '.role', 'owner']] },
    ],
  },
  {
    name: 'admin',
    grants: [
      { cmd: ROLE_ASSIGN, pol: [['!=', '.role', 'owner']] },
      { cmd: ROLE_UNASSIGN, pol: [notOwner] },
      { cmd: MEMBER_REMOVE, pol: [notOwner] },
      { cmd: ROLE_DEFINE, pol: [['==', '.role', 'member']] },
    ],
  },
  {
    name: 'mod',
    grants: [
      { cmd: ROLE_ASSIGN, pol: [['==', '.role', 'member']] },
      { cmd: MEMBER_REMOVE, pol: [] },
    ],
  },
  { name: 'member', grants: [{ cmd: RECORD_WRITE, pol: [] }] },
];
const POOL: ReadonlyArray<Grant> = [
  { cmd: RECORD_WRITE, pol: [] },
  { cmd: ROLE_ASSIGN, pol: [['==', '.role', 'member']] },
  { cmd: MEMBER_REMOVE, pol: [] },
  { cmd: ROLE_UNASSIGN, pol: [] },
  { cmd: ROLE_DEFINE, pol: [['==', '.role', 'member']] },
];
const PEOPLE = ['p0', 'p1', 'p2', 'p3', 'p4', 'p5'];
const genesis: AccessGenesis = { id: 'space', creator: 'p0', roles: ROLES };

/** A small seeded generator: the same seed, the same history */
function random(seed: number) {
  let s = seed >>> 0 || 1;
  const next = () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 0x100000000;
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

/** Each person writes with one key, its own DID here; its changes take the next place in that key's line */
interface Made {
  readonly events: ReadonlyArray<AccessEvent>;
  /** Event id → its place in its author's line */
  readonly place: ReadonlyMap<string, number>;
  /** Event id → every change it saw, directly or not */
  readonly saw: ReadonlyMap<string, ReadonlySet<string>>;
}

const LINES = ['sys.assign', 'sys.remove', 'sys.role'];

/**
 * Roles are assigned, taken, redefined, and accounts removed, by authors
 * holding different roles, each seeing a random causal cut of what came
 * before: so changes are often concurrent, and removals race what their
 * targets do. A change that takes power away carries a cutoff: the highest
 * place of the target's key its author had seen, in each line.
 */
function generate(seed: number): Made {
  const r = random(seed);
  const events: AccessEvent[] = [];
  const place = new Map<string, number>();
  const saw = new Map<string, ReadonlySet<string>>();
  const lineLength = new Map<string, number>();
  let counter = 0;
  const length = 6 + r.int(30);
  for (let n = 0; n < length; n++) {
    // A random causal cut: some earlier changes, and everything they saw.
    const named =
      events.length === 0
        ? []
        : r
            .shuffle(events)
            .slice(0, 1 + r.int(3))
            .map((e) => e.id);
    const cut = new Set<string>();
    for (const id of named) {
      cut.add(id);
      for (const above of saw.get(id) ?? []) cut.add(above);
    }
    const seen = named.length ? [...new Set(named)] : [genesis.id];
    const author = r.chance(0.3) ? 'p0' : r.pick(PEOPLE);
    const did = r.pick(PEOPLE.filter((p) => p !== 'p0'));
    const role = r.pick(ROLES.slice(1)).name;
    // What the author had seen of the target's key: its highest place among the cut.
    let cutoff = -1;
    for (const id of cut) {
      const event = events.find((e) => e.id === id)!;
      if (event.root === did) cutoff = Math.max(cutoff, place.get(id) ?? -1);
    }
    const id = `e${String(++counter).padStart(3, '0')}x${r.int(1e6)}`;
    const common = {
      id,
      root: author,
      author,
      seen,
      cutoff: cutoff >= 0 ? new Map([[did, new Map(LINES.map((line) => [line, cutoff]))]]) : new Map(),
      line: lineLength.get(author) ?? 0,
    };
    const roll = r.int(10);
    const event: AccessEvent =
      roll < 5
        ? { ...common, key: `assign:${did}|${role}`, kind: 'assign', did, role, assigned: true }
        : roll < 7
          ? {
              ...common,
              ...(r.chance(0.2) ? { root: did, author: did } : {}),
              key: `assign:${did}|${role}`,
              kind: 'assign',
              did,
              role,
              assigned: false,
            }
          : roll < 9
            ? {
                ...common,
                ...(r.chance(0.2) ? { root: did, author: did } : {}),
                key: `remove:${did}`,
                kind: 'remove',
                did,
              }
            : {
                ...common,
                key: `role:${role}`,
                kind: 'role',
                name: role,
                grants: [...new Set(Array.from({ length: r.int(3) }, () => r.pick(POOL)))],
                nests: [],
              };
    // Its place in its own author's line, whoever that turned out to be.
    const placed: AccessEvent = { ...event, line: lineLength.get(event.root) ?? 0 };
    events.push(placed);
    place.set(id, lineLength.get(event.root) ?? 0);
    lineLength.set(event.root, (lineLength.get(event.root) ?? 0) + 1);
    saw.set(id, cut);
  }
  return { events, place, saw };
}

const RUNS = Number(process.env.ACCESS_RUNS ?? 400);
const first = process.env.ACCESS_SEED ? Number(process.env.ACCESS_SEED) : (Date.now() * 7919) >>> 0;

/** Runs `check` on RUNS histories, naming the seed of the first that fails */
function forHistories(check: (made: Made, r: Random) => void): void {
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

const applied = (history: AccessHistory, id: string) => history.status(id)?.status === 'applied';
const members = (history: AccessHistory) =>
  JSON.stringify(PEOPLE.map((did) => [did, isMember(history.current, did), rolesOf(history.current, did)]));

describe('access replay: properties', () => {
  test('order: any arrival order gives the same state and verdicts', () => {
    forHistories(({ events }, r) => {
      const expected = replayAccess(genesis, events);
      const shuffled = replayAccess(genesis, r.shuffle(events));
      assert.equal(members(shuffled), members(expected));
      for (const event of events)
        assert.equal(applied(shuffled, event.id), applied(expected, event.id), event.id);
    });
  });

  test('safety: no change applies whose author lacked the power, given the valid changes it saw', () => {
    forHistories(({ events }) => {
      const history = replayAccess(genesis, events);
      const byId = new Map(events.map((event) => [event.id, event]));
      for (const event of events) {
        if (!applied(history, event.id)) continue;
        // Everything it saw, with what doesn't apply made powerless (kept, so nothing waits on
        // it): valid changes never strike each other but in turn, so this gives their merge.
        const ancestors = new Set<string>();
        const stack = [...event.seen];
        while (stack.length > 0) {
          const id = stack.pop()!;
          if (ancestors.has(id) || !byId.has(id)) continue;
          ancestors.add(id);
          stack.push(...byId.get(id)!.seen);
        }
        const view = replayAccess(
          genesis,
          events
            .filter((other) => ancestors.has(other.id))
            .map((other) =>
              applied(history, other.id) ? other : { ...other, root: 'nobody', author: 'nobody' },
            ),
        ).current;
        assert.equal(refusal(event, view), null, `${event.id} applied without the power for it`);
      }
    });
  });

  test('liveness: a change made after seeing everything, by someone with the power for it, applies', () => {
    forHistories(({ events }) => {
      const history = replayAccess(genesis, events);
      const owner = 'p0';
      if (!isMember(history.current, owner)) return;
      const next: AccessEvent = {
        id: 'zzz-last',
        key: 'assign:p5|member',
        kind: 'assign',
        root: owner,
        author: owner,
        did: 'p5',
        role: 'member',
        assigned: true,
        seen: history.heads().length ? [...history.heads()] : [genesis.id],
        cutoff: new Map(),
      };
      if (refusal(next, history.current) !== null) return;
      assert.ok(applied(replayAccess(genesis, [...events, next]), next.id));
    });
  });

  test('ids: renaming every change, keeping its content, changes no verdict', () => {
    forHistories(({ events }, r) => {
      const rename = new Map(events.map((e) => [e.id, `r${String(r.int(1e9)).padStart(9, '0')}`]));
      const renamed = events.map((e) => ({
        ...e,
        id: rename.get(e.id)!,
        seen: e.seen.map((id) => rename.get(id) ?? id),
      }));
      const before = replayAccess(genesis, events);
      const after = replayAccess(genesis, renamed);
      for (const event of events)
        assert.equal(applied(after, rename.get(event.id)!), applied(before, event.id), event.id);
    });
  });

  test('reductions: no change by an account past a removal’s cutoff, that the removal hadn’t seen, applies', () => {
    forHistories(({ events, place, saw }) => {
      const history = replayAccess(genesis, events);
      for (const removal of events) {
        if (removal.kind !== 'remove' || removal.root === removal.did) continue;
        if (!applied(history, removal.id)) continue;
        const cutoff = removal.cutoff.get(removal.did)?.get('sys.assign') ?? -1;
        for (const event of events) {
          if (event.root !== removal.did || !applied(history, event.id)) continue;
          if (saw.get(removal.id)?.has(event.id) || saw.get(event.id)?.has(removal.id)) continue;
          // A change by the removed account that itself reduces the remover strikes back:
          // reductions that strike each other all stand (03 §4.3 step 4).
          if (
            (event.kind === 'remove' || (event.kind === 'assign' && !event.assigned)) &&
            event.did === removal.root
          )
            continue;
          assert.ok(
            (place.get(event.id) ?? 0) <= cutoff,
            `${event.id} by ${event.root} applied past ${removal.id}'s cutoff`,
          );
        }
      }
    });
  });

  test('removal: an assignment counts only if it saw every applied removal of its account', () => {
    forHistories(({ events, saw }) => {
      const history = replayAccess(genesis, events);
      for (const [did, roles] of history.current.assigned)
        for (const id of roles.values())
          for (const removal of events)
            if (removal.kind === 'remove' && removal.did === did && applied(history, removal.id))
              assert.ok(saw.get(id)?.has(removal.id), `${id} counts without having seen ${removal.id}`);
    });
  });
});
