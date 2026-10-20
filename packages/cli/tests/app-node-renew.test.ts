/**
 * Renewing the desktop app's connection against a real account home: the app
 * writes while the home can't see it, then renews from the menu bar. Asking
 * with a new key would have the home revoke the last, withdrawing that write
 * (03 §6.4); renewing keeps the key, so it stands.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { base64UrlDecode, base64UrlEncode, createNode, directoryStores, type P2PNode } from '@minca/core';
import { createMincaAuth } from '../../core/src/session/auth.js';
import { createFolderAccountStore } from '../../core/src/identity/account-store.js';
import { team } from '../../core/src/space/presets.js';
import { createMemoryDirectory } from '../../core/tests/helpers/memory-directory.js';
import { memoryStores } from '../../core/tests/helpers/memory-stores.js';
import { createFakeHub } from '../../core/tests/helpers/fake-transport.js';
import type { ConnectRequest } from '@minca/core/session';
import { runAppNode, type AppNodeOut, type StartParams } from '../src/app-node.js';
import { openFsDirectory } from '../src/fs-directory.js';
import { isRecord } from '../src/json.js';

const ORIGIN = 'http://127.0.0.1:47830';
const HOME = 'https://home.test/connect';

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

test('renewing from the menu bar keeps what the app wrote while the home could not see it', async () => {
  // The home meets peers on one hub; the app's first node is on another, so the home never sees its write.
  const hub = createFakeHub({ latencyMs: 1 });
  const away = createFakeHub({ latencyMs: 1 });
  const accounts = createFolderAccountStore(createMemoryDirectory().handle);
  const homeStores = memoryStores();
  const values = new Map<string, string>([['minca.stay-signed-in', '"never"']]);
  const auth = createMincaAuth({
    rpId: 'home.test',
    storage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      removeItem: (key: string) => void values.delete(key),
    },
    browser: { accounts: async () => accounts, stores: () => homeStores },
    network: { transports: (self: string, peer: string) => [hub.transport(peer, self)] },
  });
  await auth.start();
  await auth.createAccount('Ada');
  const code = auth.getState().freshCode;
  assert.ok(code);
  auth.codeSaved();
  // Giving an app access takes proof it is you, as the person at the home's connect page gives.
  assert.ok(await auth.confirm({ code }));
  const homeNode = auth.getState().session?.node;
  assert.ok(homeNode);
  const shared = await homeNode.spaces.create({ name: 'Team', ...team, visibility: 'private' });

  let onHub = away;
  const nodes: P2PNode[] = [];
  const start = async (params: StartParams) => {
    const which = onHub;
    const node = await createNode({
      signer: params.signer,
      sessionKey: params.key.keys,
      stores: directoryStores(await openFsDirectory(params.stores), { localKey: params.seal }),
      network: { transports: (self: string, peer: string) => [which.transport(peer, self)] },
    });
    for (const space of params.grant.spaces)
      await node.spaces
        .join(space.invite, space.memberKey ? { memberKey: base64UrlDecode(space.memberKey) } : {})
        .catch(() => {});
    nodes.push(node);
    return node;
  };

  const data = path.join(await mkdtemp(path.join(tmpdir(), 'minca-app-node-')), 'node');
  const lines = lineQueue();
  const said: AppNodeOut[] = [];
  const waiting = new Set<() => void>();
  // The home answers every request the node posts it, as the person allowing it would.
  const done = runAppNode({
    data,
    lines,
    log: () => {},
    start,
    send: (message) => {
      said.push(message);
      for (const check of waiting) check();
      if (message.t === 'home-open')
        lines.push({ t: 'home-message', data: { type: 'minca:hello' }, origin: 'https://home.test' });
      if (message.t === 'home-post' && isRecord(message.data) && message.data.type === 'minca:request')
        void auth
          .grant({
            origin: ORIGIN,
            // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the request as the node posted it; the home checks it
            request: Reflect.get(message.data, 'request') as ConnectRequest,
            spaceIds: [shared.id],
          })
          .then((grant) =>
            lines.push({
              t: 'home-message',
              data: { type: 'minca:grant', grant },
              origin: 'https://home.test',
            }),
          );
    },
  });
  const next = (match: (message: AppNodeOut) => boolean, from = 0) =>
    new Promise<AppNodeOut>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('nothing said in time')), 10_000);
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
  const ready = (message: AppNodeOut) => message.t === 'state' && message.status === 'ready';
  const audiences = (from: number) =>
    said
      .slice(from)
      .flatMap((message) =>
        message.t === 'home-post' && isRecord(message.data) && isRecord(message.data.request)
          ? [message.data.request.audience]
          : [],
      );

  lines.push({
    t: 'init',
    sealKey: base64UrlEncode(crypto.getRandomValues(new Uint8Array(32))),
    origin: ORIGIN,
  });
  await next((message) => message.t === 'state' && message.status === 'disconnected');
  lines.push({ t: 'connect', home: HOME, request: { access: 'write', scope: 'spaces' } });
  await next(ready);
  const first = nodes.at(-1);
  assert.ok(first);
  const written = await first.records.put(shared.id, 'app.todo.item', { text: 'while the home was closed' });
  const asked = audiences(0)[0];

  onHub = hub;
  const from = said.length;
  lines.push({ t: 'connect', home: HOME });
  await next(ready, from);
  assert.equal(audiences(from)[0], asked, 'renewing asks with the same key');
  const renewed = nodes.at(-1);
  assert.ok(renewed && renewed !== first);
  await new Promise((resolve) => setTimeout(resolve, 2000));
  assert.ok(await renewed.records.get(shared.id, written.key), 'the write made before renewing stands');

  lines.end();
  await done;
  await auth.signOut();
});
