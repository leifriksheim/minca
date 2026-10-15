/**
 * 6. A household's chores. A chore is done once two people have nodded 👍
 * at it: a computed field, which every app works out from the nods its node
 * holds, and which turns back when a nod is withdrawn. Whoever wants it to
 * stay done, for a payout or a streak, promotes it: a completion claim that
 * cites the nods, judged the same by every reader and fixed by what it
 * cites (spec 09; packages/core/docs/computed.md).
 */
import * as z from 'zod';
import { collection } from '../../packages/core/src/schema/collection-def.js';
import {
  automation,
  automationRun,
  matching,
  runAutomations,
} from '../../packages/core/src/schemas/automations.js';
import type { Version } from '../../packages/core/src/types.js';
import { communityNode } from '../../packages/core/tests/helpers/community.js';
import type { Person } from '../../packages/core/tests/helpers/person.js';
import { isRecord } from '../../packages/core/src/utils/guards.js';

// -- The household: one rule, as a view and as a verdict ---------------------------

const nod = collection({
  name: 'app.nod',
  schema: z.object({ emoji: z.string() }),
  links: { on: { to: ['app.chore'], cardinality: 'one' } },
});

/** Done once two different people nod 👍: worked out by each node, from what it holds */
const chore = collection({
  name: 'app.chore',
  schema: z.object({ text: z.string() }),
  computed: ({ linked }) => {
    const thumbs = linked(nod, 'on')
      .where((n) => n.body.emoji.eq('👍'))
      .map((n) => n.author)
      .distinct()
      .count();
    return { thumbs, done: thumbs.gte(2) };
  },
});

const NEEDS = 'A chore is complete with two different people’s 👍 on it';

/** The same rule over the nods a claim cites: the same on every node, and final */
const completion = collection({
  name: 'app.completion',
  schema: z.object({ nods: z.array(z.string()) }),
  links: { chore: { to: ['app.chore'], cardinality: 'one' } },
  contract: {
    check: ({ body, cited, link }) => ({
      [NEEDS]: cited(body.nods, nod)
        .where((n) => n.link('on').eq(link('chore')).and(n.body.emoji.eq('👍')))
        .map((n) => n.author)
        .distinct()
        .count()
        .gte(2),
    }),
  },
});

// -- The story ---------------------------------------------------------------------

/** Alice runs the household; m1–m3 live there. Alice writes the dishes and the laundry. */
export async function story() {
  const c = await communityNode(3, [nod, chore, completion, automation, automationRun]);
  const alice = c.founder;
  const m = (i: number): Person => c.members[i - 1]!;
  const dishes = await c.sign(alice, { collection: chore.name, body: { text: 'Dishes' } });
  const laundry = await c.sign(alice, { collection: chore.name, body: { text: 'Laundry' } });
  /** A nod by anyone: a 👍 on the dishes unless said otherwise */
  const nodBy = (who: Person, on: Version = dishes, emoji = '👍') =>
    c.sign(who, { collection: nod.name, body: { emoji }, links: [{ rel: 'on', to: on.key }] });
  /** A nod by member `i` */
  const nodAt = (i: number, on: Version = dishes, emoji = '👍') => nodBy(m(i), on, emoji);
  /** A claim that a chore is complete, citing nods: Alice's unless someone else's is given */
  const claim = (on: Version, nods: ReadonlyArray<Version>, who: Person = alice) =>
    c.sign(who, {
      collection: completion.name,
      body: { nods: nods.map((n) => n.id) },
      links: [{ rel: 'chore', to: on.key }],
    });
  /** A nod withdrawn: its author's delete */
  const withdraw = (n: Version, i: number) =>
    c.sign(m(i), {
      collection: nod.name,
      body: null,
      deleted: true,
      retain: false,
      version: { key: n.key, seq: 1, prev: n.id, genesis: n.id },
    });
  /** What Alice's node works out for a chore now */
  const view = async (of: Version) =>
    (await alice.node.records.query(c.space, { collection: chore, where: { '@key': of.key } })).records[0]
      ?.computed;
  /** The chores an automation on `{ done: true }` finds on Alice's node */
  const done = async () =>
    (
      await matching(
        alice.node,
        c.space,
        { query: { collection: chore.name, where: { done: true } } },
        alice.me.did,
      )
    ).map((found) => found.record.key);
  /**
   * Promotes what the view says into a verdict: a claim citing the 👍s Alice's
   * node holds on the chore, as an app would write when it sees it done.
   */
  const promote = async (of: Version) => {
    const held = await alice.node.records.linked(c.space, of.key, { rel: 'on', collection: nod.name });
    const thumbs = held.filter((n) => isRecord(n.body) && n.body.emoji === '👍');
    return c.sign(alice, {
      collection: completion.name,
      body: { nods: thumbs.map((n) => n.version) },
      links: [{ rel: 'chore', to: of.key }],
    });
  };
  /**
   * An automation of Alice's on `{ done: true }`, from now, with `when` added:
   * `from: ['admin']` for one only the household's admins set off. Its runs
   * give what it said so far.
   */
  const automate = async (when: Record<string, unknown> = {}) => {
    // Clocks count milliseconds: what came before must not share one with `since`.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await alice.node.records.put(c.space, automation.name, {
      name: 'Done',
      when: { query: { collection: chore.name, where: { done: true } }, ...when },
      then: { kind: 'notify', text: '{title} is done' },
      since: new Date().toISOString(),
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const told: string[] = [];
    return async () => {
      await runAutomations(alice.node, c.space, alice.me.did, {
        notify: (_name, text) => (told.push(text), true),
      });
      return [...told];
    };
  };
  return { c, alice, m, dishes, laundry, nodAt, nodBy, claim, withdraw, view, done, promote, automate };
}
