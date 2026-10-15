/**
 * The attacks on connecting a bot to GitHub (spec/08-hosting.md §3.1), against
 * `createBotConnect` with a bot's node stood in for: what it reads of the
 * space is set by each test.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { NodeRecord, P2PNode } from '@minca/core';
import { createBotConnect, verifierOf } from '../src/host-connect.js';
import type { GitHubApp } from '../src/connectors/github.js';
import { memoryStores } from '../../core/tests/helpers/memory-stores.js';

const BOT = 'did:key:zBot';
const ADMIN = 'did:key:zAdmin';
const SPACE = 'bspace';
const SECRET = 'a'.repeat(43);

/** A space as the bot sees it: who holds which role, who may instruct bots, and the records it holds */
function botView() {
  const state = {
    members: new Map<string, string[]>([
      [BOT, ['member']],
      [ADMIN, ['admin']],
    ]),
    instructors: new Set([ADMIN]),
    records: new Map<string, NodeRecord>(),
    deleted: new Array<string>(),
    /** Reading the space fails, for a moment */
    unreadable: false,
  };
  const node = {
    spaces: {
      list: async () => [{ id: SPACE }],
      access: async () => {
        if (state.unreadable) throw new Error('Not readable now');
        return {
          members: [...state.members].map(([did, roles]) => ({ did, roles })),
        };
      },
      may: async (_space: string, _cmd: string, _args: unknown, who: string) => state.instructors.has(who),
      holdsRole: async (_space: string, role: string, who: string) =>
        role === 'member' ? state.members.has(who) : (state.members.get(who) ?? []).includes(role),
    },
    records: {
      get: async (_space: string, key: string) => state.records.get(key) ?? null,
      list: async () => [...state.records.values()],
      put: async (_space: string, collection: { name: string } | string, body: unknown) => {
        const name = typeof collection === 'string' ? collection : collection.name;
        const record = request(`said-${state.records.size}`, BOT, body, name);
        state.records.set(record.key, record);
        return record;
      },
      delete: async (_space: string, key: string) => {
        state.deleted.push(key);
        state.records.delete(key);
      },
    },
  };
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- a stand-in for the few calls the host makes of a bot's node
  return { state, node: node as unknown as P2PNode };
}

function request(key: string, writer: string, body: unknown, collection = 'std.connect'): NodeRecord {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- only the fields the host reads
  return {
    key,
    collection,
    space: SPACE,
    seq: 0,
    verified: true,
    root: writer,
    createdBy: writer,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    body,
    links: [],
  } as unknown as NodeRecord;
}

const github: GitHubApp = {
  installUrl: (state) => `https://github.com/apps/minca/installations/new?state=${state}`,
  confirm: async (code, installation) =>
    code === 'good' && installation === 42 ? { account: 'acme' } : null,
  repos: async () => ['acme/site'],
  token: async () => 'ghs',
  hooks: false,
  signed: () => false,
};

async function setUp(bots: ReadonlyArray<string> = [BOT]) {
  const view = botView();
  const connect = createBotConnect({
    store: await memoryStores()('host-connect'),
    botNode: async (did) => (did === BOT ? view.node : null),
    isBot: async (did) => bots.includes(did),
    github,
    waitMs: 0,
    log: () => {},
  });
  const ask = async (key: string, over: Record<string, unknown> = {}) => {
    view.state.records.set(
      key,
      request(key, ADMIN, {
        bot: BOT,
        kind: 'github',
        verifier: await verifierOf(SECRET),
        expires: new Date(Date.now() + 300_000).toISOString(),
        ...over,
      }),
    );
    return { space: SPACE, request: key, secret: SECRET };
  };
  return { ...view, connect, ask };
}

describe('connecting a bot: what a host refuses', () => {
  test('GitHub’s return in another browser: someone sent the install link to an admin of another org', async () => {
    const { connect, ask } = await setUp();
    const step = await connect.start(BOT, await ask('r1'));
    assert.ok(step.ok);
    const state = new URL(step.to).searchParams.get('state') ?? '';
    // The admin who was sent the link comes back with their own sign-in, and none of the starter's cookie.
    const done = await connect.finish({ state, code: 'good', installation: 42, cookies: {} });
    assert.equal(done.ok, false);
    assert.match(done.ok ? '' : done.said, /started in another browser/);
    const forged = await connect.finish({
      state,
      code: 'good',
      installation: 42,
      cookies: { [step.cookie.name]: 'b'.repeat(43) },
    });
    assert.equal(forged.ok, false, 'and the state is spent');
  });

  test('the same browser comes back, and the bot says what it is connected to', async () => {
    const { connect, ask, state: space } = await setUp();
    const step = await connect.start(BOT, await ask('r1'));
    assert.ok(step.ok);
    const state = new URL(step.to).searchParams.get('state') ?? '';
    const done = await connect.finish({
      state,
      code: 'good',
      installation: 42,
      cookies: { [step.cookie.name]: step.cookie.value },
    });
    assert.ok(done.ok);
    assert.ok([...space.records.values()].some((r) => r.collection === 'std.connector'));
  });

  test('a request another bot wrote: the host refuses it, as no integration installs another', async () => {
    // The admin's account here is another bot this host runs, which holds every grant it needs.
    const { connect, ask } = await setUp([BOT, ADMIN]);
    const step = await connect.start(BOT, await ask('r1'));
    assert.equal(step.ok, false);
  });

  test('one link used twice at once: only one call passes', async () => {
    const { connect, ask } = await setUp();
    const params = await ask('r1');
    const both = await Promise.all([connect.start(BOT, params), connect.start(BOT, params)]);
    assert.deepEqual(both.map((step) => step.ok).sort(), [false, true]);
  });

  test('whoever connected it lost the grant at GitHub: the callback asks again', async () => {
    const { connect, ask, state: space } = await setUp();
    const step = await connect.start(BOT, await ask('r1'));
    assert.ok(step.ok);
    space.instructors.delete(ADMIN);
    const done = await connect.finish({
      state: new URL(step.to).searchParams.get('state') ?? '',
      code: 'good',
      installation: 42,
      cookies: { [step.cookie.name]: step.cookie.value },
    });
    assert.equal(done.ok, false);
  });

  test('a read of the space that fails gives no tools for now, and forgets nothing', async () => {
    const { connect, ask, state: space } = await setUp();
    const step = await connect.start(BOT, await ask('r1'));
    assert.ok(step.ok);
    await connect.finish({
      state: new URL(step.to).searchParams.get('state') ?? '',
      code: 'good',
      installation: 42,
      cookies: { [step.cookie.name]: step.cookie.value },
    });
    space.unreadable = true;
    assert.equal(await connect.usable(BOT, SPACE), null);
    assert.ok(await connect.connection(BOT, SPACE), 'kept');
    space.unreadable = false;
    assert.ok(await connect.usable(BOT, SPACE));
  });

  test('a connection stands only while the bot is in the space and whoever connected it still may', async () => {
    for (const lose of ['the bot leaves', 'the admin loses the grant'] as const) {
      const { connect, ask, state: space } = await setUp();
      const step = await connect.start(BOT, await ask('r1'));
      assert.ok(step.ok);
      await connect.finish({
        state: new URL(step.to).searchParams.get('state') ?? '',
        code: 'good',
        installation: 42,
        cookies: { [step.cookie.name]: step.cookie.value },
      });
      assert.ok(await connect.usable(BOT, SPACE), lose);
      if (lose === 'the bot leaves') space.members.delete(BOT);
      else space.instructors.delete(ADMIN);
      assert.equal(await connect.usable(BOT, SPACE), null, lose);
      assert.equal(await connect.connection(BOT, SPACE), null, `${lose}: forgotten`);
    }
  });
});
