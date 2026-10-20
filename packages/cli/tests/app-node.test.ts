/**
 * `minca app-node`: the desktop app's node, in a process of its own. These
 * play the shell and the account home over its lines, as the desktop does,
 * with a node that stays offline.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  base64UrlDecode,
  base64UrlEncode,
  createIdentityManager,
  createLocalRootSigner,
  createNode,
  deriveAccountKey,
  directoryStores,
  generateSeed,
  remoteNode,
  type P2PNode,
} from '@minca/core';
import { GRANT_VERSION, grantTerms, type Grant } from '@minca/core/session';
import {
  decodeWire,
  DESKTOP_GRANT_DAYS,
  encodeWire,
  runAppNode,
  type AppNodeOut,
  type StartParams,
} from '../src/app-node.js';
import { openFsDirectory } from '../src/fs-directory.js';
import { isRecord } from '../src/json.js';

const ORIGIN = 'http://127.0.0.1:47830';
const HOME = 'https://home.example/connect';

/** A line queue the test writes and the node reads */
function lineQueue() {
  const queued: string[] = [];
  let wake: (() => void) | null = null;
  let ended = false;
  return {
    push(message: unknown) {
      queued.push(JSON.stringify(message));
      wake?.();
    },
    end() {
      ended = true;
      wake?.();
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        const next = queued.shift();
        if (next !== undefined) yield next;
        else if (ended) return;
        else await new Promise<void>((resolve) => (wake = resolve));
      }
    },
  };
}

/** Every node started, newest last, and those closed since */
const started: P2PNode[] = [];
const closed = new Set<P2PNode>();

/** Offline, from the folder the node was given, sealed as the real one is */
const offline = async (params: StartParams) => {
  const node = await createNode({
    signer: params.signer,
    sessionKey: params.key.keys,
    stores: directoryStores(await openFsDirectory(params.stores), { localKey: params.seal }),
    watchIntervalMs: 0,
    ...(params.grant.accountKey ? { accountKey: base64UrlDecode(params.grant.accountKey) } : {}),
  });
  const tracked: P2PNode = Object.freeze({
    ...node,
    async close() {
      closed.add(tracked);
      await node.close();
    },
  });
  started.push(tracked);
  return tracked;
};

const latest = () => {
  const node = started.at(-1);
  if (!node) throw new Error('no node started');
  return node;
};

async function account() {
  const seed = generateSeed();
  const manager = createIdentityManager();
  const me = await manager.fromSeed(seed);
  return { seed, me, signer: createLocalRootSigner(me, manager.getProvider()) };
}

function run(data: string, sealKey: Uint8Array) {
  const lines = lineQueue();
  const said: AppNodeOut[] = [];
  const waiting = new Set<() => void>();
  const done = runAppNode({
    data,
    lines,
    send: (message) => {
      said.push(message);
      for (const check of waiting) check();
    },
    log: () => {},
    start: offline,
  });
  /** The first thing said, from now on or already, that matches */
  const next = (match: (message: AppNodeOut) => boolean, from = 0): Promise<AppNodeOut> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('nothing said in time')), 5000);
      const check = () => {
        const found = said.slice(from).find(match);
        if (!found) return;
        clearTimeout(timer);
        waiting.delete(check);
        resolve(found);
      };
      waiting.add(check);
      check();
    });
  lines.push({ t: 'init', sealKey: base64UrlEncode(sealKey), origin: ORIGIN });
  return { lines, said, next, done };
}

const isState = (status: string) => (message: AppNodeOut) =>
  message.t === 'state' && message.status === status;

/** Plays the account home: answers the request with a grant from `who`, made out to the key that asked */
async function grantFrom(
  node: ReturnType<typeof run>,
  who: Awaited<ReturnType<typeof account>>,
  expiresIn = 3600,
  /** Where in what the node said this connection starts */
  from = 0,
): Promise<{ request: Record<string, unknown>; grant: Grant }> {
  await node.next((message) => message.t === 'home-open', from);
  node.lines.push({ t: 'home-message', data: { type: 'minca:hello' }, origin: 'https://home.example' });
  const posted = await node.next((message) => message.t === 'home-post', from);
  const data = posted.t === 'home-post' ? posted.data : null;
  const request = isRecord(data) && isRecord(data.request) ? data.request : {};
  const expiresAt = Math.floor(Date.now() / 1000) + expiresIn;
  const note = await who.signer.delegate({
    audience: String(request.audience),
    ...grantTerms('write', 'all'),
    expiration: expiresAt,
  });
  const grant: Grant = {
    v: GRANT_VERSION,
    did: who.me.did,
    name: 'Ada',
    note,
    access: 'write',
    scope: 'account',
    spaces: [],
    accountKey: base64UrlEncode(await deriveAccountKey(who.seed)),
    expiresAt,
    home: HOME,
  };
  node.lines.push({
    t: 'home-message',
    data: { type: 'minca:grant', grant },
    origin: 'https://home.example',
  });
  return { request, grant };
}

async function filesUnder(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true }))
    if (entry.isFile()) found.push(path.join(entry.parentPath, entry.name));
  return found;
}

test('bytes cross as tagged text and come back as bytes', () => {
  const value = {
    memberKey: new Uint8Array([1, 2, 255]),
    list: [new Uint8Array([7])],
    text: 'a',
    none: null,
  };
  const crossed: unknown = decodeWire(JSON.parse(JSON.stringify(encodeWire(value))));
  assert.deepEqual(crossed, value);
});

test('connecting asks the home from the app’s origin for a 30-day note, and the folder alone yields no key, grant or private body', async () => {
  const data = path.join(await mkdtemp(path.join(tmpdir(), 'minca-app-node-')), 'node');
  const sealKey = crypto.getRandomValues(new Uint8Array(32));
  const who = await account();
  const node = run(data, sealKey);
  await node.next(isState('disconnected'));

  node.lines.push({
    t: 'connect',
    home: HOME,
    // A window asking to be a carrier, or for longer, gets the app's own connection for the shell's term.
    request: { name: 'Minca', access: 'carry', scope: 'account', days: 365, via: 'code' },
  });
  const { request, grant } = await grantFrom(node, who);
  assert.equal(request.access, 'write');
  assert.equal(request.days, DESKTOP_GRANT_DAYS);
  assert.equal(request.via, undefined);
  assert.equal(request.scope, 'account');

  const ready = await node.next(isState('ready'));
  assert.ok(ready.t === 'state' && ready.grant);
  assert.equal(ready.grant.did, who.me.did);
  // The window is shown who is connected, and never the keys the grant carries.
  assert.equal(ready.grant.accountKey, undefined);

  // Nothing in the folder holds the account key, the app's key, or the grant in the clear.
  const accountKey = grant.accountKey ?? '';
  for (const file of await filesUnder(data)) {
    const text = await readFile(file, 'utf8');
    assert.ok(!text.includes(accountKey), `${file} holds the account key`);
    assert.ok(!text.includes('"d":'), `${file} holds a private key`);
    assert.ok(!text.includes(grant.note.sig), `${file} holds the grant`);
  }
  assert.equal((await stat(path.join(data, 'grant.sealed'))).mode & 0o077, 0);

  node.lines.end();
  await node.done;
});

test('the window uses the node over its port; one that loads again gets a session of its own', async () => {
  const data = path.join(await mkdtemp(path.join(tmpdir(), 'minca-app-node-')), 'node');
  const who = await account();
  const node = run(data, crypto.getRandomValues(new Uint8Array(32)));
  await node.next(isState('disconnected'));
  node.lines.push({ t: 'connect', home: HOME, request: { access: 'write', scope: 'account' } });
  await grantFrom(node, who);
  await node.next(isState('ready'));

  /** The window's end of the port, over the node's lines */
  const attach = async () => {
    const from = node.said.length;
    node.lines.push({ t: 'attach' });
    const state = await node.next(
      (message) => message.t === 'state' && message.status === 'ready' && message.session > 0,
      from,
    );
    const session = state.t === 'state' ? state.session : -1;
    const listeners = new Set<(event: MessageEvent) => void>();
    let seen = from;
    const pump = setInterval(() => {
      for (; seen < node.said.length; seen += 1) {
        const message = node.said[seen];
        if (message?.t === 'port' && message.session === session) {
          const event = new MessageEvent('message', { data: decodeWire(message.data) });
          for (const listener of listeners) listener(event);
        }
      }
    }, 5);
    const port = {
      postMessage: (message: unknown) => node.lines.push({ t: 'port', session, data: encodeWire(message) }),
      addEventListener: (_type: 'message', listener: (event: MessageEvent) => void) =>
        void listeners.add(listener),
      removeEventListener: (_type: 'message', listener: (event: MessageEvent) => void) =>
        void listeners.delete(listener),
    };
    return { session, remote: await remoteNode(port), stop: () => clearInterval(pump) };
  };

  const first = await attach();
  assert.equal(first.remote.did, who.me.did);
  const made = await first.remote.spaces.create({ name: 'Garden', visibility: 'private' });
  // Its key is in the registry sealed under the keychain's key, never in the clear (spec 05 §15).
  const stores = path.join(data, 'store', who.me.did.replace(/[^A-Za-z0-9]/g, '_'));
  const sealedKey = await readFile(path.join(stores, 'registry', 'kv', `spacekey%3A${made.id}`));
  assert.equal(sealedKey[0], 1, 'an envelope, by its version byte');
  assert.throws(() => JSON.parse(sealedKey.toString('utf8')));
  const second = await attach();
  assert.notEqual(second.session, first.session);
  assert.ok((await second.remote.spaces.list()).some((space) => space.id === made.id));
  // Closing the window's view lets go of it, and leaves the node for the menu bar.
  await second.remote.close();
  const third = await attach();
  assert.ok((await third.remote.spaces.list()).some((space) => space.id === made.id));
  for (const each of [first, second, third]) each.stop();

  node.lines.end();
  await node.done;
});

test('it starts again from the folder with the keychain’s key, and opens nothing with another', async () => {
  const data = path.join(await mkdtemp(path.join(tmpdir(), 'minca-app-node-')), 'node');
  const sealKey = crypto.getRandomValues(new Uint8Array(32));
  const who = await account();
  const one = run(data, sealKey);
  await one.next(isState('disconnected'));
  one.lines.push({ t: 'connect', home: HOME, request: { access: 'write' } });
  await grantFrom(one, who);
  await one.next(isState('ready'));
  one.lines.end();
  await one.done;

  const again = run(data, sealKey);
  const ready = await again.next(isState('ready'));
  assert.ok(ready.t === 'state' && ready.grant?.did === who.me.did);
  again.lines.end();
  await again.done;

  // The keychain lost its key: nothing here opens, so it is set aside and starts again, never bricked.
  const other = run(data, crypto.getRandomValues(new Uint8Array(32)));
  const fresh = await other.next(isState('disconnected'));
  assert.ok(fresh.t === 'state' && fresh.grant === null);
  const aside = (await readdir(path.dirname(data))).filter((name) => name.startsWith('node.unreadable-'));
  assert.equal(aside.length, 1);
  other.lines.end();
  await other.done;
});

test('a note that ran out says expired, and renewing from the menu bar asks for what the window asked last', async () => {
  const data = path.join(await mkdtemp(path.join(tmpdir(), 'minca-app-node-')), 'node');
  const sealKey = crypto.getRandomValues(new Uint8Array(32));
  const who = await account();
  const node = run(data, sealKey);
  await node.next(isState('disconnected'));
  node.lines.push({
    t: 'connect',
    home: HOME,
    request: { name: 'Minca', access: 'write', scope: 'account' },
  });
  await grantFrom(node, who, 1);
  await node.next(isState('ready'));
  const running = latest();
  await node.next(isState('expired'));
  // Nothing runs on a note that ran out: the menu bar says automations are off, and they are.
  assert.ok(closed.has(running));

  // The menu bar names no request: the node asks for the window's last one again.
  const from = node.said.length;
  node.lines.push({ t: 'connect', home: HOME });
  const { request } = await grantFrom(node, who, 3600, from);
  assert.equal(request.scope, 'account');
  assert.equal(request.name, 'Minca');
  await node.next(isState('ready'), from);

  node.lines.push({ t: 'disconnect' });
  await node.next(isState('disconnected'), from);
  await assert.rejects(stat(path.join(data, 'grant.sealed')));
  node.lines.end();
  await node.done;
});

test('two at once from one folder: the second refuses, so one key never signs in two places', async () => {
  const data = path.join(await mkdtemp(path.join(tmpdir(), 'minca-app-node-')), 'node');
  const sealKey = crypto.getRandomValues(new Uint8Array(32));
  const one = run(data, sealKey);
  await one.next(isState('disconnected'));
  const two = run(data, sealKey);
  await assert.rejects(two.done, /Another app node/);
  one.lines.end();
  await one.done;
});

/** Connects as `who`, from where the node's lines have got to */
async function connectAs(node: ReturnType<typeof run>, who: Awaited<ReturnType<typeof account>>) {
  const from = node.said.length;
  node.lines.push({ t: 'connect', home: HOME, request: { access: 'write', scope: 'account' } });
  const answered = await grantFrom(node, who, 3600, from);
  await node.next(isState('ready'), from);
  return answered;
}

test('once the home revokes the app’s key, connecting again asks with a new key: a revoked one stays revoked', async () => {
  const data = path.join(await mkdtemp(path.join(tmpdir(), 'minca-app-node-')), 'node');
  const node = run(data, crypto.getRandomValues(new Uint8Array(32)));
  await node.next(isState('disconnected'));
  const ada = await account();
  const first = await connectAs(node, ada);
  const from = node.said.length;
  // The account revokes the app's key, as its home does when the person disconnects it there.
  await latest().account.revoke(String(first.request.audience));
  const gone = await node.next(isState('disconnected'), from);
  assert.ok(gone.t === 'state' && gone.error?.includes('disconnected'));

  const second = await connectAs(node, ada);
  assert.notEqual(second.request.audience, first.request.audience);
  node.lines.end();
  await node.done;
});

test('disconnecting from the app forgets its key too, as a page forgets its own', async () => {
  const data = path.join(await mkdtemp(path.join(tmpdir(), 'minca-app-node-')), 'node');
  const node = run(data, crypto.getRandomValues(new Uint8Array(32)));
  await node.next(isState('disconnected'));
  const ada = await account();
  const first = await connectAs(node, ada);
  const from = node.said.length;
  node.lines.push({ t: 'disconnect' });
  await node.next(isState('disconnected'), from);
  const second = await connectAs(node, ada);
  assert.notEqual(second.request.audience, first.request.audience);
  node.lines.end();
  await node.done;
});

test('a disconnect while the home is open stands: the home answering afterwards changes nothing', async () => {
  const data = path.join(await mkdtemp(path.join(tmpdir(), 'minca-app-node-')), 'node');
  const node = run(data, crypto.getRandomValues(new Uint8Array(32)));
  await node.next(isState('disconnected'));
  const ada = await account();
  let from = node.said.length;
  node.lines.push({ t: 'connect', home: HOME, request: { access: 'write', scope: 'account' } });
  await node.next((message) => message.t === 'home-open', from);
  from = node.said.length;
  node.lines.push({ t: 'disconnect' });
  await node.next(isState('disconnected'), from);
  from = node.said.length;
  const startedBefore = started.length;
  await grantFrom(node, ada, 3600, 0);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.ok(!node.said.slice(from).some(isState('ready')));
  assert.equal(started.length, startedBefore);
  node.lines.end();
  await node.done;
});

test('renewing keeps the key, so the home revokes nothing the app wrote that it hadn’t seen yet', async () => {
  const data = path.join(await mkdtemp(path.join(tmpdir(), 'minca-app-node-')), 'node');
  const node = run(data, crypto.getRandomValues(new Uint8Array(32)));
  await node.next(isState('disconnected'));
  const ada = await account();
  const first = await connectAs(node, ada);
  const renewed = await connectAs(node, ada);
  assert.equal(renewed.request.audience, first.request.audience);
  node.lines.end();
  await node.done;
});

test('a home answering as another account is not used: the app leaves the last one, and asks again with a new key', async () => {
  const data = path.join(await mkdtemp(path.join(tmpdir(), 'minca-app-node-')), 'node');
  const node = run(data, crypto.getRandomValues(new Uint8Array(32)));
  await node.next(isState('disconnected'));
  const ada = await account();
  const bo = await account();
  const asAda = await connectAs(node, ada);
  const diary = await latest().spaces.create({ name: 'Ada’s diary', visibility: 'private' });

  const from = node.said.length;
  node.lines.push({ t: 'connect', home: HOME, request: { access: 'write', scope: 'account' } });
  await grantFrom(node, bo, 3600, from);
  const left = await node.next(isState('disconnected'), from);
  assert.ok(left.t === 'state' && left.error?.includes('Connect again'));
  await assert.rejects(stat(path.join(data, 'store')));

  const asBo = await connectAs(node, bo);
  assert.notEqual(asBo.request.audience, asAda.request.audience);
  assert.equal(latest().did, bo.me.did);
  assert.equal(latest().sessionDid, asBo.request.audience);
  assert.ok(!(await latest().spaces.list()).some((space) => space.id === diary.id));
  node.lines.end();
  await node.done;
});
