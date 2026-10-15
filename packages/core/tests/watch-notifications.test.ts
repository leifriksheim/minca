/**
 * An app showing its own notifications (`watchNotifications`): every record a
 * kept subscription comes to ask about, once, whatever else changes at the
 * same time — by being written, or by what its computed fields read.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { watchNotifications, type NotifyMatch } from '../src/node/watch-notifications.js';
import type { NodeEvent, NodeRecord, OwnAutomationView, P2PNode } from '../src/node/types.js';
import type { Query } from '../src/query/types.js';
import { until } from './helpers/until.js';
import { isRecord } from '../src/utils/guards.js';

const ME = 'did:key:zMe';
const ORIGIN = 'https://chat.test';

const BO = 'did:key:zBo';

/** A record in the club, written now */
const written = (
  key: string,
  collection: string,
  body: unknown,
  { by = BO, links = [] }: { by?: string; links?: NodeRecord['links'] } = {},
): NodeRecord => ({
  key,
  version: `v-${key}`,
  seq: 0,
  space: 'club',
  collection,
  author: by,
  root: by,
  createdBy: by,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  body,
  links,
  encrypted: true,
  verified: true,
  conforms: true,
});

/** A message to me, from someone else */
const dm = (key: string) => written(key, 'std.direct', { to: [ME] });

const DM: { readonly query: Query } = {
  query: { collection: 'std.direct', where: { to: { $contains: '$me' } } },
};
/** A chore is done once it has two nods */
const DONE: { readonly query: Query } = { query: { collection: 'app.chore', where: { done: true } } };

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
});
