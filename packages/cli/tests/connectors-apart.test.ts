/**
 * One service never touches another's connections, and revocation is per
 * connection: from the adversarial review of making connectors generic.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { NodeRecord, P2PNode } from '@minca/core';
import { createBotConnect, verifierOf } from '../src/host-connect.js';
import { githubConnector } from '../src/connectors/github-connector.js';
import type { GitHubApp } from '../src/connectors/github.js';
import type { HostConnector } from '../src/connectors/connector.js';
import { memoryStores } from '../../core/tests/helpers/memory-stores.js';

const BOT = 'did:key:zBot';
const ADMIN = 'did:key:zAdmin';
const OTHER = 'did:key:zOther';
const SPACE = 'bspace';
const SECRET = 'a'.repeat(43);
const botNodeOf = (v: { node: P2PNode }) => async (d: string) => (d === BOT ? v.node : null);

function rec(key: string, writer: string, body: unknown, collection = 'std.connect'): NodeRecord {
  const now = new Date().toISOString();
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- only the fields the host reads
  return {
    key,
    collection,
    space: SPACE,
    seq: 0,
    verified: true,
    root: writer,
    createdBy: writer,
    createdAt: now,
    updatedAt: now,
    body,
    links: [],
  } as unknown as NodeRecord;
}

function view() {
  const state = {
    members: new Map<string, string[]>([
      [BOT, ['member']],
      [ADMIN, ['admin']],
      [OTHER, ['admin']],
    ]),
    instructors: new Set([ADMIN, OTHER]),
    records: new Map<string, NodeRecord>(),
  };
  const node = {
    spaces: {
      list: async () => [{ id: SPACE }],
      access: async () => ({ members: [...state.members].map(([did, roles]) => ({ did, roles })) }),
      may: async (_s: string, _c: string, _a: unknown, who: string) => state.instructors.has(who),
      holdsRole: async (_s: string, role: string, who: string) =>
        role === 'member' ? state.members.has(who) : (state.members.get(who) ?? []).includes(role),
    },
    records: {
      get: async (_s: string, key: string) => state.records.get(key) ?? null,
      list: async () => [...state.records.values()],
      put: async (_s: string, c: { name: string }, body: unknown) => {
        const r = rec('said-' + state.records.size, BOT, body, c.name);
        state.records.set(r.key, r);
        return r;
      },
      delete: async (_s: string, key: string) => {
        state.records.delete(key);
      },
    },
  };
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- only the fields the host reads
  return { state, node: node as unknown as P2PNode };
}

const CONSENT = 'https:' + '//consent.example/';
const ghApp = {
  repos: async () => ['acme/site'],
  token: async () => 'ghs',
  hooks: false,
  signed: () => false,
  installUrl: (s: string) => CONSENT + 'install?state=' + s,
  confirm: async (code: string, inst: number) =>
    code === 'good' ? (inst === 42 ? { account: 'acme' } : null) : null,
} satisfies GitHubApp;

const calendar: HostConnector = {
  id: 'calendar',
  name: 'Calendar',
  consentUrl: (s) => CONSENT + 'cal?state=' + s,
  complete: async () => ({ account: 'team@x', reaches: ['Team'], data: { token: 't' } }),
  tools: () => [],
  hook: async (body) =>
    body === 'revoke'
      ? { kind: 'forget', which: () => true, said: 'revoked' }
      : { kind: 'reaches', which: () => true, reaches: [], said: 'narrow' },
};

async function setUp() {
  const v = view();
  const store = await memoryStores()('host-connect');
  const connect = createBotConnect({
    store,
    botNode: botNodeOf(v),
    connectors: [githubConnector(ghApp), calendar],
    waitMs: 0,
    log: () => {},
  });
  let n = 0;
  const ask = async (kind: string, by = ADMIN, disconnect = false) => {
    const key = 'r' + n++;
    const body = {
      bot: BOT,
      kind,
      verifier: await verifierOf(SECRET),
      expires: new Date(Date.now() + 300_000).toISOString(),
      ...(disconnect ? { disconnect: true } : {}),
    };
    v.state.records.set(key, rec(key, by, body));
    return { space: SPACE, request: key, secret: SECRET };
  };
  const connectTo = async (kind: string, by = ADMIN) => {
    const step = await connect.start(BOT, kind, await ask(kind, by), 'cb');
    assert.ok(step.ok);
    const state = new URL(step.to).searchParams.get('state') ?? '';
    const q = new URLSearchParams({ state, code: 'good', installation_id: '42' });
    return {
      step,
      state,
      done: await connect.finish(kind, q, { [step.cookie.name]: step.cookie.value }, 'cb'),
    };
  };
  return { v, store, connect, ask, connectTo };
}

test('a GitHub state finished at the calendar callback is refused, and spent', async () => {
  const { connect, ask } = await setUp();
  const step = await connect.start(BOT, 'github', await ask('github'), 'cb');
  assert.ok(step.ok);
  const state = new URL(step.to).searchParams.get('state') ?? '';
  const cookies = { [step.cookie.name]: step.cookie.value };
  const wrong = await connect.finish('calendar', new URLSearchParams({ state }), cookies, 'cb');
  assert.equal(wrong.ok, false);
  const right = await connect.finish(
    'github',
    new URLSearchParams({ state, code: 'good', installation_id: '42' }),
    cookies,
    'cb',
  );
  assert.equal(right.ok, false, 'spent by the wrong callback');
});

test('one service hook and disconnect never touch another service connection', async () => {
  const { v, connect, ask, connectTo } = await setUp();
  assert.ok((await connectTo('github')).done.ok);
  assert.ok((await connectTo('calendar')).done.ok);
  assert.equal((await connect.usable(BOT, SPACE)).length, 2);
  assert.equal(await connect.hook('calendar', 'narrow', {}), 'narrow: 1 connection(s) narrowed');
  assert.deepEqual((await connect.connection(BOT, SPACE, 'github'))?.reaches, ['acme/site']);
  assert.equal(await connect.hook('calendar', 'revoke', {}), 'revoked: 1 connection(s) gone');
  assert.ok(await connect.connection(BOT, SPACE, 'github'));
  assert.equal(await connect.connection(BOT, SPACE, 'calendar'), null);
  assert.equal(await connect.hook('github', '{}', {}), null, 'hooks off: refused');
  assert.ok((await connectTo('calendar')).done.ok);
  assert.ok((await connect.disconnect(BOT, 'calendar', await ask('calendar', ADMIN, true))).ok);
  assert.ok(await connect.connection(BOT, SPACE, 'github'));
  const said = [...v.state.records.values()].filter((r) => r.collection === 'std.connector');
  assert.deepEqual(
    said.map((r) => JSON.stringify(r.body).includes('"kind":"github"')),
    [true],
  );
});

test('losing the grant drops only the connections that person made', async () => {
  const { v, connect, connectTo } = await setUp();
  assert.ok((await connectTo('github', ADMIN)).done.ok);
  assert.ok((await connectTo('calendar', OTHER)).done.ok);
  v.state.instructors.delete(ADMIN);
  assert.deepEqual(
    (await connect.usable(BOT, SPACE)).map((c) => c.kind),
    ['calendar'],
  );
  assert.equal(await connect.connection(BOT, SPACE, 'github'), null);
});
