/**
 * The attacks on connecting a bot to GitHub (spec/08-hosting.md §3.1), against
 * `createBotConnect` with a bot's node stood in for: what it reads of the
 * space is set by each test.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { NodeRecord, P2PNode } from '@minca/core';
import { createBotConnect, verifierOf, type ConnectStep } from '../src/host-connect.js';
import { githubConnector } from '../src/connectors/github-connector.js';
import type { GitHubApp } from '../src/connectors/github.js';
import type { HostConnector } from '../src/connectors/connector.js';
import { memoryStores } from '../../core/tests/helpers/memory-stores.js';

const BOT = 'did:key:zBot';
const ADMIN = 'did:key:zAdmin';
const SPACE = 'bspace';
const SECRET = 'a'.repeat(43);
const CALLBACK = 'https://host.example/host/connect/github/callback';

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
    connectors: [githubConnector(github)],
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
  const start = async (params: Awaited<ReturnType<typeof ask>>) =>
    connect.start(BOT, 'github', params, CALLBACK);
  /** GitHub's return, with `cookies` the browser brings, or the ones `step` gave it */
  const back = (step: ConnectStep, options: { code?: string; cookies?: Record<string, string> } = {}) => {
    assert.ok(step.ok);
    const query = new URLSearchParams({
      state: new URL(step.to).searchParams.get('state') ?? '',
      code: options.code ?? 'good',
      installation_id: '42',
    });
    return connect.finish(
      'github',
      query,
      options.cookies ?? { [step.cookie.name]: step.cookie.value },
      CALLBACK,
    );
  };
  return { ...view, connect, ask, start, back };
}

describe('connecting a bot: what a host refuses', () => {
  test('GitHub’s return in another browser: someone sent the install link to an admin of another org', async () => {
    const { ask, start, back } = await setUp();
    const step = await start(await ask('r1'));
    assert.ok(step.ok);
    // The admin who was sent the link comes back with their own sign-in, and none of the starter's cookie.
    const done = await back(step, { cookies: {} });
    assert.equal(done.ok, false);
    assert.match(done.ok ? '' : done.said, /started in another browser/);
    const forged = await back(step, { cookies: { [step.cookie.name]: 'b'.repeat(43) } });
    assert.equal(forged.ok, false, 'and the state is spent');
  });

  test('the same browser comes back, and the bot says what it is connected to', async () => {
    const { ask, start, back, state: space } = await setUp();
    const step = await start(await ask('r1'));
    assert.ok(step.ok);
    const done = await back(step);
    assert.ok(done.ok);
    assert.ok([...space.records.values()].some((r) => r.collection === 'std.connector'));
  });

  test('a request another bot wrote: the host refuses it, as no integration installs another', async () => {
    // The admin's account here is another bot this host runs, which holds every grant it needs.
    const { ask, start } = await setUp([BOT, ADMIN]);
    const step = await start(await ask('r1'));
    assert.equal(step.ok, false);
  });

  test('one link used twice at once: only one call passes', async () => {
    const { ask, start } = await setUp();
    const params = await ask('r1');
    const both = await Promise.all([start(params), start(params)]);
    assert.deepEqual(both.map((step) => step.ok).sort(), [false, true]);
  });

  test('whoever connected it lost the grant at GitHub: the callback asks again', async () => {
    const { ask, start, back, state: space } = await setUp();
    const step = await start(await ask('r1'));
    assert.ok(step.ok);
    space.instructors.delete(ADMIN);
    const done = await back(step);
    assert.equal(done.ok, false);
  });

  test('a read of the space that fails gives no tools for now, and forgets nothing', async () => {
    const { connect, ask, start, back, state: space } = await setUp();
    const step = await start(await ask('r1'));
    assert.ok(step.ok);
    await back(step);
    space.unreadable = true;
    assert.deepEqual(await connect.usable(BOT, SPACE), []);
    assert.ok(await connect.connection(BOT, SPACE, 'github'), 'kept');
    space.unreadable = false;
    assert.equal((await connect.usable(BOT, SPACE)).length, 1);
  });

  test('a connection stands only while the bot is in the space and whoever connected it still may', async () => {
    for (const lose of ['the bot leaves', 'the admin loses the grant'] as const) {
      const { connect, ask, start, back, state: space } = await setUp();
      const step = await start(await ask('r1'));
      assert.ok(step.ok);
      await back(step);
      assert.equal((await connect.usable(BOT, SPACE)).length, 1, lose);
      if (lose === 'the bot leaves') space.members.delete(BOT);
      else space.instructors.delete(ADMIN);
      assert.deepEqual(await connect.usable(BOT, SPACE), [], lose);
      assert.equal(await connect.connection(BOT, SPACE, 'github'), null, `${lose}: forgotten`);
    }
  });
});

describe('a host’s own connectors', () => {
  test('a service of its own, beside GitHub: the same exchange, its own consent, its own tools', async () => {
    const view = botView();
    // A calendar this host offers: its consent screen, what it keeps, and what the bot may do there.
    const calendar: HostConnector = {
      id: 'calendar',
      name: 'Calendar',
      consentUrl: (state, callback) =>
        `https://calendar.example/consent?state=${state}&back=${encodeURIComponent(callback)}`,
      complete: async (query) =>
        query.get('grant') === 'yes'
          ? { account: 'team@acme.example', reaches: ['Team'], data: { token: 'kept by the host' } }
          : { status: 403, said: 'Not granted.' },
      tools: (connection, { mayWrite }) => [
        {
          name: 'calendar_next',
          description: 'The next event',
          input: { type: 'object', properties: {} },
          run: async () => ({ text: `${connection.reaches.join()} · may write: ${mayWrite}` }),
        },
      ],
    };
    const connect = createBotConnect({
      store: await memoryStores()('host-connect'),
      botNode: async (did) => (did === BOT ? view.node : null),
      connectors: [githubConnector(github), calendar],
      waitMs: 0,
      log: () => {},
    });
    const ask = async (key: string, kind: string) => {
      view.state.records.set(
        key,
        request(key, ADMIN, {
          bot: BOT,
          kind,
          verifier: await verifierOf(SECRET),
          expires: new Date(Date.now() + 300_000).toISOString(),
        }),
      );
      return { space: SPACE, request: key, secret: SECRET };
    };
    const callback = 'https://host.example/host/connect/calendar/callback';

    // A request for GitHub opens no calendar, and a service the host doesn't offer is refused.
    assert.equal((await connect.start(BOT, 'calendar', await ask('r1', 'github'), callback)).ok, false);
    assert.equal((await connect.start(BOT, 'notion', await ask('r2', 'notion'), callback)).ok, false);

    const step = await connect.start(BOT, 'calendar', await ask('r3', 'calendar'), callback);
    assert.ok(step.ok);
    assert.match(step.to, /^https:\/\/calendar\.example\/consent\?state=/);
    const state = new URL(step.to).searchParams.get('state') ?? '';
    const done = await connect.finish(
      'calendar',
      new URLSearchParams({ state, grant: 'yes' }),
      { [step.cookie.name]: step.cookie.value },
      callback,
    );
    assert.ok(done.ok);
    assert.equal(done.name, 'Calendar');
    const said = [...view.state.records.values()].find((r) => r.collection === 'std.connector');
    // The bot says what it is connected to; what the host keeps to act on it stays with the host.
    assert.equal(
      JSON.stringify(said?.body),
      JSON.stringify({
        bot: BOT,
        kind: 'calendar',
        account: 'team@acme.example',
        reaches: ['Team'],
        by: ADMIN,
        since: done.connection.since,
      }),
    );
    const [standing] = await connect.usable(BOT, SPACE);
    assert.ok(standing);
    const [tool] = calendar.tools(standing, { mayWrite: false, budget: () => true });
    assert.equal((await tool?.run({}))?.text, 'Team · may write: false');
  });
});
