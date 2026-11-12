/**
 * An app showing its own notifications (`watchNotifications`): every record a
 * kept subscription comes to ask about, once, whatever else changes at the
 * same time — by being written, or by what its computed fields read.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { watchNotifications, type ActivityMatch, type NotifyMatch } from '@minca/std';
import type { NodeEvent, NodeRecord, OwnAutomationView, P2PNode } from '../src/node/types.js';
import type { Query } from '../src/query/types.js';
import type { OwnQuery } from '../src/space/own-automations.js';
import { until } from './helpers/until.js';
import { isRecord } from '../src/utils/guards.js';

const ME = 'did:key:zMe';
const ORIGIN = 'https://chat.test';

const BO = 'did:key:zBo';

/** A record in the club, written now, or `ago` ms before */
const written = (
  key: string,
  collection: string,
  body: unknown,
  { by = BO, links = [], ago = 0 }: { by?: string; links?: NodeRecord['links']; ago?: number } = {},
): NodeRecord => ({
  key,
  version: `v-${key}`,
  seq: 0,
  space: 'club',
  collection,
  author: by,
  root: by,
  createdBy: by,
  createdAt: new Date(Date.now() - ago).toISOString(),
  updatedAt: new Date(Date.now() - ago).toISOString(),
  body,
  links,
  encrypted: true,
  verified: true,
  conforms: true,
});

/** A message to me, from someone else */
const dm = (key: string, ago = 0) => written(key, 'std.direct', { to: [ME] }, { ago });

const DM: { readonly query: OwnQuery } = {
  query: { collection: 'std.direct', where: { to: { $contains: '$me' } } },
};
/** A chore is done once it has two nods */
const DONE: { readonly query: OwnQuery } = { query: { collection: 'app.chore', where: { done: true } } };

/** Just enough of a node: one space, its records, a chore's computed field, and events to send by hand */
function fakeNode(when = DM, others = false) {
  const records: NodeRecord[] = [];
  const listeners = new Set<(event: NodeEvent) => void>();
  const subscription: OwnAutomationView = {
    id: 'own1',
    name: 'Heard',
    when: { query: when.query, ...(others ? { others } : {}) },
    then: { kind: 'notify', text: 'Heard' },
    spaces: 'all',
    app: { origin: ORIGIN },
    since: new Date(Date.now() - 60_000).toISOString(),
  };
  const linked = async (_space: string, key: string) =>
    records.filter((r) => r.links.some((l) => l.to === key));
  const node = {
    did: ME,
    subscribe: (listener: (event: NodeEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    automations: { list: async () => [subscription] },
    spaces: { list: async () => [{ id: 'club' }] },
    collections: {
      list: async () => [{ name: 'app.chore', computed: { done: 'linked("app.nod", "on").size() >= 2' } }],
    },
    records: {
      list: async (_space: string, { collection }: { collection: string }) =>
        records.filter((r) => r.collection === collection).reverse(),
      linked,
      query: async (_space: string, query: Query) => {
        // The watcher asks only by key.
        const asked = query.where?.['@key'];
        const keys: unknown[] = isRecord(asked) && Array.isArray(asked.$in) ? asked.$in : [];
        const found = records.filter((r) => r.collection === query.collection && keys.includes(r.key));
        return {
          records: await Promise.all(
            found.map(async (r) => ({
              ...r,
              included: {},
              computed:
                r.collection === 'app.chore' ? { done: (await linked('club', r.key)).length >= 2 } : {},
            })),
          ),
        };
      },
    },
  };
  return {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- a fake with only the members the watcher reaches
    node: node as unknown as P2PNode,
    add: (record: NodeRecord) => records.push(record),
    /** Its next version: the same record, another body */
    edit: (key: string, body: unknown) => {
      const at = records.findIndex((r) => r.key === key);
      const was = records[at]!;
      records[at] = {
        ...was,
        seq: was.seq + 1,
        version: `${was.version}+`,
        body,
        updatedAt: new Date().toISOString(),
      };
    },
    emit: (event: NodeEvent) => listeners.forEach((listener) => listener(event)),
  };
}

describe('an app showing its own notifications', () => {
  test('a record arriving as the account changes is still news', async () => {
    const { node, add, emit } = fakeNode();
    add(dm('before'));
    const heard: NotifyMatch[] = [];
    const stop = watchNotifications(node, { origin: ORIGIN, onNotify: (match) => heard.push(match) });
    await new Promise((resolve) => setTimeout(resolve, 20));

    // The message and an account change (another device, a setting) land together.
    add(dm('hello'));
    emit({ type: 'account' });
    emit({ type: 'records', space: 'club' });
    await until(() => heard.length > 0, 1000, 'the message');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(
      heard.map((match) => match.record.key),
      ['hello'],
      'once, and never what was there before',
    );
    stop();
  });

  test('an app hears only its own automations; one watching for every app hears another app’s too', async () => {
    const { node, add, emit } = fakeNode();
    const heardBy = (origin: string | null) => {
      const heard: string[] = [];
      const stop = watchNotifications(node, { origin, onNotify: (match) => heard.push(match.record.key) });
      return { heard, stop };
    };
    const otherApp = heardBy('https://other.test');
    const everyApp = heardBy(null);
    await new Promise((resolve) => setTimeout(resolve, 20));

    add(dm('hello'));
    emit({ type: 'records', space: 'club' });
    await until(() => everyApp.heard.length > 0, 1000, 'the message');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(everyApp.heard, ['hello']);
    assert.deepEqual(otherApp.heard, [], 'chat.test proposed it, not other.test');
    otherApp.stop();
    everyApp.stop();
  });

  test('a record that comes to match by what its computed fields read is news, once', async () => {
    const { node, add, emit } = fakeNode(DONE);
    const nodOn = (key: string, chore: string, by = BO) =>
      written(key, 'app.nod', {}, { by, links: [{ rel: 'on', to: chore }] });
    add(written('laundry', 'app.chore', { text: 'Laundry' }));
    add(nodOn('n1', 'laundry'));
    add(nodOn('n2', 'laundry'));
    add(written('dishes', 'app.chore', { text: 'Dishes' }));
    const heard: string[] = [];
    const stop = watchNotifications(node, {
      origin: ORIGIN,
      onNotify: (match) => heard.push(match.record.key),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    add(nodOn('n3', 'dishes'));
    emit({ type: 'records', space: 'club' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(heard, [], 'one nod is not done');
    // The chore is old; the nod that makes it done is new.
    add(nodOn('n4', 'dishes'));
    emit({ type: 'records', space: 'club' });
    await until(() => heard.length > 0, 1000, 'dishes done');
    add(nodOn('n5', 'dishes'));
    emit({ type: 'records', space: 'club' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(heard, ['dishes'], 'once, and never Laundry, done before it started');
    stop();
  });

  test('with others, a record made to match by my own writing is not news', async () => {
    const { node, add, emit } = fakeNode(DONE, true);
    add(written('dishes', 'app.chore', { text: 'Dishes' }));
    add(written('n1', 'app.nod', {}, { links: [{ rel: 'on', to: 'dishes' }] }));
    const heard: string[] = [];
    const stop = watchNotifications(node, {
      origin: ORIGIN,
      onNotify: (match) => heard.push(match.record.key),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    add(written('n2', 'app.nod', {}, { by: ME, links: [{ rel: 'on', to: 'dishes' }] }));
    emit({ type: 'records', space: 'club' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(heard, []);
    stop();
  });

  test('a record edited out of matching and back in is news once', async () => {
    const { node, add, emit, edit } = fakeNode();
    const heard: string[] = [];
    const stop = watchNotifications(node, {
      origin: ORIGIN,
      onNotify: (match) => heard.push(match.record.key),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    add(dm('hello'));
    emit({ type: 'records', space: 'club' });
    await until(() => heard.length > 0, 1000, 'the message');
    for (let i = 0; i < 3; i++) {
      for (const to of [[], [ME]]) {
        edit('hello', { to });
        emit({ type: 'records', space: 'club' });
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    assert.deepEqual(heard, ['hello']);
    stop();
  });

  test('the activity lists what matches, already or newly, newest first, from when the automation began', async () => {
    const { node, add, emit } = fakeNode();
    add(dm('older', 50_000));
    add(dm('old', 30_000));
    // Before the automation was kept: never listed
    add(dm('before', 120_000));
    let listed: ReadonlyArray<ActivityMatch> = [];
    const stop = watchNotifications(node, {
      origin: ORIGIN,
      onNotify: () => {},
      onActivity: (matches) => (listed = matches),
    });
    await until(() => listed.length > 0, 1000, 'the list');
    assert.deepEqual(
      listed.map((match) => match.record.key),
      ['old', 'older'],
    );

    add(dm('new'));
    emit({ type: 'records', space: 'club' });
    await until(() => listed.length === 3, 1000, 'the new message');
    assert.deepEqual(
      listed.map((match) => match.record.key),
      ['new', 'old', 'older'],
    );
    stop();
  });

  test('the activity dates a match by what set it off, and with others leaves out what I set off', async () => {
    const { node, add } = fakeNode(DONE, true);
    const nod = (key: string, chore: string, ago: number, by = BO) =>
      written(key, 'app.nod', {}, { by, ago, links: [{ rel: 'on', to: chore }] });
    add(written('dishes', 'app.chore', { text: 'Dishes' }, { ago: 50_000 }));
    add(nod('n1', 'dishes', 40_000));
    add(nod('n2', 'dishes', 10_000));
    // Done by my own nod: nothing to tell me
    add(written('laundry', 'app.chore', { text: 'Laundry' }, { ago: 50_000 }));
    add(nod('n3', 'laundry', 40_000));
    add(nod('n4', 'laundry', 20_000, ME));
    let listed: ReadonlyArray<ActivityMatch> | null = null;
    const stop = watchNotifications(node, {
      origin: ORIGIN,
      onNotify: () => {},
      onActivity: (matches) => (listed = matches),
    });
    await until(() => listed !== null, 1000, 'the list');
    const found: ReadonlyArray<ActivityMatch> = listed ?? [];
    assert.deepEqual(
      found.map((match) => match.record.key),
      ['dishes'],
    );
    const second = found[0];
    assert.ok(second);
    assert.ok(Date.now() - Date.parse(second.at) < 15_000, 'dated by the second nod, not the chore');
    stop();
  });

  test('a match dated ahead of now is not listed, so it can neither top the activity nor stay new for good', async () => {
    const { node, add } = fakeNode();
    // Mallory's clock, or her claim, a year ahead
    add(dm('ahead', -365 * 24 * 60 * 60 * 1000));
    add(dm('bo', 10_000));
    let listed: ReadonlyArray<ActivityMatch> = [];
    const stop = watchNotifications(node, {
      origin: ORIGIN,
      onNotify: () => {},
      onActivity: (matches) => (listed = matches),
    });
    await until(() => listed.length > 0, 1000, 'the list');
    assert.deepEqual(
      listed.map((match) => match.record.key),
      ['bo'],
    );
    stop();
  });
});
