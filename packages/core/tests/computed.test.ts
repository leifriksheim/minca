/**
 * Computed fields: values a definition derives from what links to its
 * records, the same way in every app. A view of what a node holds, not a
 * verdict (packages/core/docs/computed.md).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as z from 'zod';

import { checkComputed, checkComputedTypes } from '../src/query/computed.js';
import { checkQuery, fieldValue, matches } from '../src/query/filter.js';
import { checkContracts } from '../src/records/contracts.js';
import { storedComputed } from '../src/records/contract-builder.js';
import { collection } from '../src/schema/collection-def.js';
import { createFakeHub } from './helpers/fake-transport.js';
import { joined } from './helpers/joined.js';
import { hold } from './helpers/hold.js';
import { until } from './helpers/until.js';
import { person } from './helpers/person.js';
import { team } from '../src/space/presets.js';
import { automation, automationRun, runAutomations } from '../src/schemas/automations.js';
import { linkedWakes, wakeFor, wakes } from '../src/space/own-automations.js';

const reaction = collection({
  name: 'app.reaction',
  schema: z.object({ emoji: z.string() }),
  links: { on: { to: ['app.todo'], cardinality: 'one' } },
});

const comment = collection({
  name: 'app.comment',
  schema: z.object({ text: z.string() }),
  links: { about: { to: '*', cardinality: 'one' } },
});

/** A todo is done once two different people have reacted 👍 to it */
const todo = collection({
  name: 'app.todo',
  schema: z.object({ text: z.string() }),
  computed: ({ linked }) => {
    const thumbs = linked(reaction, 'on')
      .where((r) => r.body.emoji.eq('👍'))
      .map((r) => r.author)
      .distinct()
      .count();
    return {
      thumbs,
      reactions: linked(reaction, 'on').count(),
      comments: linked(comment, 'about').count(),
      done: thumbs.gte(2),
    };
  },
});

describe('computed: built in TypeScript', () => {
  test('stores CEL, with linked() naming the collection and role', () => {
    const stored = storedComputed(todo);
    assert.equal(
      stored?.thumbs,
      'linked("app.reaction", "on").filter(x0, x0.body.emoji == "👍").map(x0, x0.author).distinct().size()',
    );
    assert.equal(stored?.done, `${stored?.thumbs} >= 2`);
    assert.equal(checkComputed(stored), null);
  });

  test('a link role the collection lacks, or one that points elsewhere, is a type error, and refused when built', () => {
    const like = collection({
      name: 'app.like',
      schema: z.object({}),
      links: { on: { to: ['app.post'] } },
    });
    const wrongRole = collection({
      name: 'app.todo',
      schema: z.object({}),
      // @ts-expect-error -- "about" is not a link role of app.reaction
      computed: ({ linked }) => ({ n: linked(reaction, 'about').count() }),
    });
    const elsewhere = collection({
      name: 'app.todo',
      schema: z.object({}),
      // @ts-expect-error -- app.like's "on" points at app.post, not app.todo
      computed: ({ linked }) => ({ n: linked(like, 'on').count() }),
    });
    /* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- these lines are type errors on purpose */
    const misread = collection({
      name: 'app.todo',
      schema: z.object({}),
      computed: ({ linked }) => {
        const reactions = linked(reaction, 'on');
        // @ts-expect-error -- a reaction's body has no field emojii
        const typo = reactions.where((r) => r.body.emojii.eq('👍'));
        return { n: typo.count() };
      },
    });
    /* eslint-enable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */
    assert.throws(() => storedComputed(wrongRole), /declares no link role "about"; it declares "on"/);
    assert.throws(() => storedComputed(elsewhere), /app.like's "on" links point at app.post, not app.todo/);
    assert.ok(misread);
  });
});

describe('computed: a definition as data', () => {
  test('refuses what it could not compute', () => {
    const refused: Array<[unknown, RegExp]> = [
      [[], /must be an object/],
      [{ Done: 'true' }, /lower camel case/],
      [{ n: 1 }, /CEL expression/],
      [{ n: 'size(' }, /^computed\.n: /],
      [{ n: 'versions(body.ids).size()' }, /asks the space/],
      [{ n: 'prev == null' }, /"prev" is not something it can read/],
      [{ n: 'linked(body.c, "on").size()' }, /literal collection name/],
      [{ n: 'linked("Bad", "on").size()' }, /"Bad" is not one/],
      [Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`f${i}`, 'true'])), /at most 16/],
    ];
    for (const [fields, why] of refused) assert.match(checkComputed(fields) ?? '', why);
  });

  test('a contract may not call linked(): it cites instead', () => {
    assert.match(
      checkContracts([{ that: 'linked("app.reaction", "on").size() > 1', else: 'x' }]) ?? '',
      /only a computed field may/,
    );
  });

  test('read against the schemas of what they link to', () => {
    const defs: Record<string, { schema: unknown; links?: Record<string, { to: '*' | string[] }> }> = {
      'app.reaction': {
        schema: { type: 'object', properties: { emoji: { type: 'string' } } },
        links: { on: { to: ['app.todo'] } },
      },
    };
    const check = (fields: Record<string, string>) =>
      checkComputedTypes(
        'app.todo',
        fields,
        { type: 'object', properties: { text: { type: 'string' } } },
        (n) => (Object.hasOwn(defs, n) ? defs[n]! : null),
      );
    assert.equal(check({ n: 'linked("app.reaction", "on").filter(r, r.body.emoji == "👍").size()' }), null);
    assert.match(
      check({ n: 'linked("app.reaction", "on").filter(r, r.body.emojii == "👍").size()' }) ?? '',
      /emojii/,
    );
    assert.match(
      check({ n: 'linked("app.reaction", "about").size()' }) ?? '',
      /declares no link role "about"/,
    );
    assert.match(check({ n: 'linked("app.reactoin", "on").size()' }) ?? '', /not defined in this space/);
    assert.match(check({ n: 'body.txt' }) ?? '', /txt/);
    // A std.* collection the space doesn't define is read untyped.
    assert.equal(check({ n: 'linked("std.reaction", "about").size()' }), null);
  });

  test('a query names a computed field bare, as a body field, and reads it, never the body', () => {
    assert.equal(
      checkQuery({ collection: 'app.todo', where: { done: true }, sort: { thumbs: 'desc' } }),
      null,
    );
    const subject = {
      key: 'k',
      collection: 'app.todo',
      // Written by its author: a body can't stand in for what the node works out.
      body: { text: 'Dishes', done: true, thumbs: { n: 9 } },
      links: [],
      createdBy: null,
      createdAt: '2026-01-01T00:00:00Z',
      computed: { done: false, thumbs: null },
    };
    assert.equal(fieldValue(subject, 'done'), false);
    assert.equal(fieldValue(subject, 'thumbs.n'), undefined);
    assert.equal(fieldValue(subject, 'text'), 'Dishes');
    assert.equal(matches(subject, { done: true }), false);
    // A record of a collection without computed fields reads its body.
    assert.equal(fieldValue({ ...subject, computed: {} }, 'done'), true);
  });

  test("a computed field may not share a body field's name", () => {
    assert.match(
      checkComputedTypes(
        'app.todo',
        { text: 'size(body.text)' },
        { type: 'object', properties: { text: { type: 'string' } } },
        () => null,
      ) ?? '',
      /computed\.text: the body has a field "text" too/,
    );
    collection({
      name: 'app.note',
      schema: z.object({ text: z.string() }),
      // @ts-expect-error — "text" is a body field too
      computed: ({ body }) => ({ text: body.text.size() }),
    });
  });
});

async function todoSpace() {
  const hub = createFakeHub({ latencyMs: 1 });
  const alice = await person(hub);
  const bob = await person(hub);
  const { id: space } = await alice.node.spaces.create({ name: 'Chores', ...team, visibility: 'private' });
  await bob.node.spaces.join(await alice.node.spaces.invite(space));
  await alice.node.collections.define(space, reaction);
  await alice.node.collections.define(space, comment);
  await alice.node.collections.define(space, todo);
  await hold(alice.node, space);
  await hold(bob.node, space);
  await joined(bob.node, space);
  await until(
    async () => (await bob.node.collections.list(space)).filter((c) => c.version !== null).length === 3,
    4000,
    'definitions to reach Bob',
  );
  const dishes = await alice.node.records.put(space, todo, { text: 'Do the dishes' });
  await until(async () => (await bob.node.records.get(space, dishes.key)) !== null, 4000, 'the todo');
  const react = (who: typeof alice, emoji: string, on = dishes.key) =>
    who.node.records.put(space, reaction, { emoji }, { links: [{ rel: 'on', to: on }] });
  const read = async (who: typeof alice) =>
    (await who.node.records.query(space, { collection: todo, where: { '@key': dishes.key } })).records[0]
      ?.computed;
  return { alice, bob, space, dishes, react, read };
}

describe('computed: between peers', () => {
  test('done once two people react 👍: each node derives it from what it holds, and they agree once synced', async () => {
    const { alice, bob, react, read } = await todoSpace();
    await react(alice, '👍');
    await react(alice, '👍');
    await react(alice, '🎉');
    // Three reactions, one person: distinct counts people.
    assert.deepEqual(await read(alice), { thumbs: 1, reactions: 3, comments: 0, done: false });

    const theirs = await react(bob, '👍');
    // A view, not a verdict: Bob already reads done, Alice not until his reaction arrives.
    assert.equal((await read(bob))?.done, true);
    assert.equal((await read(alice))?.done, false);
    await until(
      async () => (await alice.node.records.get(theirs.space, theirs.key)) !== null,
      4000,
      'Bob’s 👍',
    );
    assert.deepEqual(await read(alice), { thumbs: 2, reactions: 4, comments: 0, done: true });
    assert.deepEqual(await read(bob), await read(alice));
  });

  test('a withdrawn reaction turns it back', async () => {
    const { alice, bob, space, react, read } = await todoSpace();
    await react(alice, '👍');
    const theirs = await react(bob, '👍');
    await until(async () => (await read(alice))?.done === true, 4000, 'done');
    await bob.node.records.delete(space, theirs.key);
    await until(async () => (await read(alice))?.done === false, 4000, 'not done again');
  });
});

describe('computed: defining and querying', () => {
  test('filter and sort on computed fields; results carry them, typed', async () => {
    const { alice, space, dishes, react } = await todoSpace();
    const laundry = await alice.node.records.put(space, todo, { text: 'Laundry' });
    await react(alice, '👍');
    await react(alice, '🎉', laundry.key);
    await react(alice, '🎉', laundry.key);

    const byReactions = await alice.node.records.query(space, {
      collection: todo,
      sort: { reactions: 'desc' },
    });
    assert.deepEqual(
      byReactions.records.map((r) => [r.body.text, r.computed.reactions]),
      [
        ['Laundry', 2],
        ['Do the dishes', 1],
      ],
    );
    const thumbed = await alice.node.records.query(space, {
      collection: todo,
      where: { thumbs: { $gte: 1 } },
    });
    assert.deepEqual(
      thumbed.records.map((r) => r.key),
      [dishes.key],
    );
    // Typed from the builder: a count is a number, a comparison a bool, either null where it can't be worked out.
    const done: boolean | null = thumbed.records[0]!.computed.done;
    const thumbs: number | null = thumbed.records[0]!.computed.thumbs;
    assert.deepEqual([done, thumbs], [false, 1]);
  });

  test('included records carry their own computed fields', async () => {
    const { alice, space, dishes, react } = await todoSpace();
    await react(alice, '👍');
    const note = await alice.node.records.put(
      space,
      comment,
      { text: 'I did them' },
      { links: [{ rel: 'about', to: dishes.key }] },
    );
    const result = await alice.node.records.query(space, {
      collection: comment,
      where: { '@key': note.key },
      include: { todo: { rel: 'about', direction: 'out', from: todo } },
    });
    const [target] = result.records[0]!.included.todo;
    const thumbs: number | null | undefined = target?.computed.thumbs;
    assert.equal(thumbs, 1);
    assert.deepEqual(result.records[0]!.computed, {});
  });

  test("an include's where reads the computed fields of what it finds", async () => {
    const { alice, space, dishes, react } = await todoSpace();
    await react(alice, '👍');
    const note = await alice.node.records.put(
      space,
      comment,
      { text: 'I did them' },
      { links: [{ rel: 'about', to: dishes.key }] },
    );
    const about = (thumbs: number) =>
      alice.node.records.query(space, {
        collection: comment,
        where: { '@key': note.key },
        include: { todo: { rel: 'about', direction: 'out', from: todo, where: { thumbs } } },
      });
    assert.equal((await about(1)).records[0]!.included.todo.length, 1);
    assert.equal((await about(2)).records[0]!.included.todo.length, 0);
  });

  test('define stores the CEL, and refuses fields that misread what they link to', async () => {
    const { alice, space } = await todoSpace();
    const listed = (await alice.node.collections.list(space)).find((c) => c.name === 'app.todo');
    assert.deepEqual(Object.keys(listed?.computed ?? {}), ['thumbs', 'reactions', 'comments', 'done']);
    await assert.rejects(
      alice.node.collections.define(space, {
        name: 'app.chore',
        schema: { type: 'object' },
        computed: { n: 'linked("app.reaction", "on").size()' },
      }),
      /app.reaction's "on" links point at app.todo, not app.chore/,
    );
    await assert.rejects(
      alice.node.collections.define(space, {
        name: 'app.todo',
        schema: { type: 'object' },
        computed: { n: 'linked("app.reaction", "on").filter(r, r.body.emojii == "👍").size()' },
      }),
      /emojii/,
    );
  });
});

/** A chore is done once it has two nods: what each test below watches for */
const nod = collection({
  name: 'app.nod',
  schema: z.object({}),
  links: { on: { to: ['app.chore'], cardinality: 'one' } },
});
const chore = collection({
  name: 'app.chore',
  schema: z.object({ text: z.string() }),
  computed: ({ linked }) => {
    const nods = linked(nod, 'on').count();
    return { nods, done: nods.gte(2) };
  },
});

describe('computed: what watches a filter on them', () => {
  test('an automation sets off when what a computed field reads makes a record hold, once, and not for what held before', async () => {
    const alice = await person(createFakeHub({ latencyMs: 1 }));
    const { id: space } = await alice.node.spaces.create({ name: 'Home', ...team, visibility: 'private' });
    for (const definition of [nod, chore, automation, automationRun])
      await alice.node.collections.define(space, definition);
    const nodAt = (key: string) =>
      alice.node.records.put(space, nod, {}, { links: [{ rel: 'on', to: key }] });
    const already = await alice.node.records.put(space, chore, { text: 'Laundry' });
    await nodAt(already.key);
    await nodAt(already.key);
    const dishes = await alice.node.records.put(space, chore, { text: 'Dishes' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await alice.node.records.put(space, automation.name, {
      name: 'Done',
      when: { query: { collection: chore.name, where: { done: true } } },
      then: { kind: 'notify', text: '{title} is done' },
      since: new Date().toISOString(),
    });
    const told: string[] = [];
    const run = () =>
      runAutomations(alice.node, space, alice.me.did, {
        notify: (_name, text) => (told.push(text), true),
      });

    await nodAt(dishes.key);
    await run();
    assert.deepEqual(told, []);
    // The todo was written before the automation; the nod that made it done, after.
    await nodAt(dishes.key);
    await run();
    await nodAt(dishes.key);
    await run();
    assert.deepEqual(told, ['Dishes is done'], 'once, and never Laundry, done before it was made');
  });

  test('a wake for a filter on a computed field also wakes on what that field reads', async () => {
    const own = {
      name: 'Done',
      when: { query: { collection: 'app.chore', where: { done: true } } },
      then: { kind: 'notify' as const, text: 'Done' },
      spaces: 'all' as const,
      since: new Date().toISOString(),
    };
    const computed = (name: string) => (name === 'app.chore' ? storedComputed(chore) : undefined);
    const spaces = [
      { id: 'home', key: null, visibility: 'public' as const, topics: () => [], computed },
      { id: 'locked', key: null, visibility: 'private' as const, topics: () => [], computed },
    ];
    const wake = await wakeFor(own, spaces, 'did:key:zMe');
    const [also, ...more] = linkedWakes(own, wake, spaces);
    assert.equal(more.length, 0);
    assert.equal(also?.collection, 'app.nod');
    assert.deepEqual(also?.tags, { locked: [] }, 'still quiet where this device has no key');
    const version = {
      id: 'x',
      author: 'did:key:zAnna',
      collection: 'app.nod',
      createdAt: new Date().toISOString(),
      body: {},
      key: 'k',
      seq: 0,
      signature: 's',
    };
    assert.equal(wakes(also, 'home', version, 'did:key:zMe'), true, 'a new nod wakes the app, which judges');
    assert.equal(wakes(also, 'locked', version, 'did:key:zMe'), false);
    assert.deepEqual(
      linkedWakes(
        { ...own, when: { query: { collection: 'app.chore', where: { text: 'x' } } } },
        wake,
        spaces,
      ),
      [],
      'a filter on the body alone needs no more',
    );
  });
});
