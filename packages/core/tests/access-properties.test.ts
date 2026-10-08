/**
 * Properties of the access replay, checked on thousands of random histories
 * (spec/drafts/convergent-access.md). Unlike access-convergence.test.ts,
 * which compares the replay with a frozen copy of itself, these say what any
 * correct replay must do, so they can't share its bugs.
 *
 * A property today's replay breaks is marked `todo` with the issue it shows:
 * it reports, but doesn't fail the suite. The convergent replay must pass
 * every one. A failure prints its seed; `ACCESS_SEED=<n>` runs it again, and
 * `ACCESS_RUNS=<n>` changes how many histories run.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  refusal,
  replayAccess,
  MANAGE,
  type AccessEvent,
  type AccessGenesis,
  type AccessHistory,
  type Role,
} from '../src/space/roles.js';

const ROLES: ReadonlyArray<Role> = [
  { name: 'owner', rank: 100, permissions: ['*'] },
  { name: 'admin', rank: 50, permissions: [MANAGE] },
  { name: 'mod', rank: 20, permissions: [MANAGE] },
  { name: 'member', rank: 10, permissions: [] },
];
const PEOPLE = ['p0', 'p1', 'p2', 'p3', 'p4', 'p5'];
const genesis: AccessGenesis = { id: 'space', creator: 'p0', roles: ROLES, creatorRole: 'owner' };

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
  /** Event id → its place in its key's line for `sys.member` */
  readonly place: ReadonlyMap<string, number>;
  /** Event id → every change it saw, directly or not */
  readonly saw: ReadonlyMap<string, ReadonlySet<string>>;
}

/**
 * Members join, are promoted, demoted and removed, by authors of different
 * ranks, each seeing a random causal cut of what came before: so changes are
 * often concurrent, and removals race what their targets do. A change that
 * takes power away carries a cutoff: the highest place of the target's key
 * its author had seen.
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
    const role = r.chance(0.3) ? null : r.pick(ROLES.slice(1)).name;
    // What the author had seen of the target's key: its highest place among the cut.
    let cutoff = -1;
    for (const id of cut) {
      const event = events.find((e) => e.id === id)!;
      if (event.root === did) cutoff = Math.max(cutoff, place.get(id) ?? -1);
    }
    const id = `e${String(++counter).padStart(3, '0')}x${r.int(1e6)}`;
    const event: AccessEvent = {
      id,
      key: `member:${did}`,
      kind: 'member',
      root: author,
      author,
      did,
      role,
      seen,
      cutoff: cutoff >= 0 ? new Map([[did, new Map([['sys.member', cutoff]])]]) : new Map(),
      at: lineLength.get(author) ?? 0,
      line: lineLength.get(author) ?? 0,
    };
    events.push(event);
    place.set(id, lineLength.get(author) ?? 0);
    lineLength.set(author, (lineLength.get(author) ?? 0) + 1);
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
  JSON.stringify([...history.current.members].sort((a, b) => (a[0] < b[0] ? -1 : 1)));

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
      if (!history.current.members.has(owner)) return;
      const next: AccessEvent = {
        id: 'zzz-last',
        key: 'member:p5',
        kind: 'member',
        root: owner,
        author: owner,
        did: 'p5',
        role: 'member',
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
        if (removal.kind !== 'member' || removal.role !== null || removal.root === removal.did) continue;
        if (!applied(history, removal.id)) continue;
        const cutoff = removal.cutoff.get(removal.did)?.get('sys.member') ?? -1;
        for (const event of events) {
          if (event.root !== removal.did || !applied(history, event.id)) continue;
          if (saw.get(removal.id)?.has(event.id) || saw.get(event.id)?.has(removal.id)) continue;
          // A change by the removed account that itself changes the remover strikes back:
          // reductions that strike each other all stand (03 §4.3 step 4).
          if (event.kind === 'member' && event.did === removal.root) continue;
          assert.ok(
            (place.get(event.id) ?? 0) <= cutoff,
            `${event.id} by ${event.root} applied past ${removal.id}'s cutoff`,
          );
        }
      }
    });
  });
});
