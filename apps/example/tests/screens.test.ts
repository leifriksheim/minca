/**
 * Screens: a made app's own UI, run sealed. The script in front of it, the
 * policy it runs under, and the bridge that answers it as the person looking.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { compileFunction } from 'node:vm';
import * as z from 'zod';

import {
  checkScreenNetwork,
  createScreenBridge,
  SCREEN_CLIENT,
  screenDocument,
  screenPolicy,
} from '../src/components/apps/screens';
import { setup, waitFor } from './helpers';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Runs the script put in front of a screen, compiled as a function of the globals it reads so a test can hand it fakes. */
function runScreenClient(window: unknown, addEventListener: unknown, document: unknown): void {
  const script = compileFunction(SCREEN_CLIENT, ['window', 'addEventListener', 'document']);
  Reflect.apply(script, undefined, [window, addEventListener, document]);
}

describe('screens', () => {
  test('the script in front of a screen sets up weave, with me readable both ways', () => {
    const port: { postMessage: () => void; onmessage: unknown } = { postMessage: () => {}, onmessage: null };
    const window: Record<string, unknown> = {
      __weave: { port, me: { did: 'did:key:zMe', name: 'Anna' }, collections: ['app.chess.game'] },
    };
    runScreenClient(window, () => {}, {});
    const weave = window.weave;
    assert.ok(isRecord(weave));
    const { me } = weave;
    assert.ok(typeof me === 'function' && 'did' in me);
    assert.equal(window.__weave, undefined, 'the port is not left lying around');
    assert.equal(me.did, 'did:key:zMe');
    assert.equal(me.name, 'Anna');
    assert.deepEqual(Reflect.apply(me, undefined, []), { did: 'did:key:zMe', name: 'Anna' });
    assert.deepEqual(weave.collections, ['app.chess.game']);
  });

  test("the script in front of a screen shows the screen's own errors, not those of a browser extension in its frame", () => {
    const listeners: Record<string, (event: unknown) => void> = {};
    const shown: string[] = [];
    const bar = {
      id: '',
      style: {},
      setAttribute: () => {},
      set textContent(text: string) {
        shown.push(text);
      },
    };
    const document = {
      getElementById: () => null,
      createElement: () => bar,
      body: { appendChild: () => {} },
    };
    const window: Record<string, unknown> = {
      __weave: { port: { postMessage: () => {} }, me: { did: 'did:key:zMe', name: 'Anna' }, collections: [] },
    };
    runScreenClient(
      window,
      (type: string, listener: (event: unknown) => void) => (listeners[type] = listener),
      document,
    );

    const metamask = new Error('Failed to connect to MetaMask');
    metamask.stack =
      'Error: Failed to connect to MetaMask\n    at Object.connect (chrome-extension://nkbihfbeogaeaoehlefnkodbefgpgknn/scripts/inpage.js:1:21277)';
    listeners.unhandledrejection!({ reason: metamask });
    listeners.error!({
      message: 'Uncaught TypeError: x is undefined',
      filename: 'moz-extension://abc/content.js',
      error: null,
    });
    assert.deepEqual(shown, [], "an extension's failures are not the screen's");

    listeners.error!({
      message: 'Uncaught ReferenceError: draw is not defined',
      filename: 'about:srcdoc',
      error: new ReferenceError('draw is not defined'),
    });
    listeners.unhandledrejection!({ reason: new Error('Only whoever added a ride can change it') });
    assert.deepEqual(shown, [
      'This screen hit an error: Uncaught ReferenceError: draw is not defined',
      'This screen hit an error: Only whoever added a ride can change it',
    ]);
  });

  test('a screen reaches only the exact origins its app names', () => {
    assert.equal(
      checkScreenNetwork(['https://api.open-meteo.com', 'wss://feed.example.com:8443'], true),
      null,
    );
    for (const wrong of [
      ['*'],
      ['https:'],
      ['http://api.example.com'],
      ['https://api.example.com/v1'],
      ['https://API.example.com'],
      ['https://localhost'],
      ['https://a.example.com; connect-src *'],
      ['https://a.example.com', 'https://a.example.com'],
      Array.from({ length: 9 }, (_, i) => `https://h${i}.example.com`),
      'https://api.example.com',
    ]) {
      assert.notEqual(checkScreenNetwork(wrong, true), null, `refuses ${JSON.stringify(wrong)}`);
    }
    assert.match(checkScreenNetwork(['https://api.example.com'], false) ?? '', /no screen/);

    // The policy written in front of the screen: nothing, or exactly those origins, never more, even if handed junk.
    assert.match(screenPolicy([]), /connect-src 'none'/);
    assert.match(
      screenPolicy(['https://api.open-meteo.com']),
      /img-src data: blob: https:\/\/api\.open-meteo\.com/,
    );
    assert.match(
      screenPolicy(['https://api.open-meteo.com']),
      /connect-src https:\/\/api\.open-meteo\.com(;|$)/,
    );
    assert.match(screenPolicy(['*']), /connect-src 'none'/);
    // Hosts allow forms in the frame only because every policy sends them nowhere.
    assert.match(screenPolicy([]), /form-action 'none'/);
    assert.match(screenPolicy(['https://api.open-meteo.com']), /form-action 'none'/);
    assert.ok(
      screenDocument('<p>Weather</p>', ['https://api.open-meteo.com']).startsWith(
        '<meta http-equiv="Content-Security-Policy"',
      ),
      'the policy comes before any script',
    );
  });

  test("the bridge answers for its app's collections only, as the person looking, under the rules", async () => {
    const { alice, bob, space } = await setup();
    // Editors here change only what they added: who may write is the space's grants.
    await alice.node.spaces.defineRole(space, {
      name: 'editor',
      grants: [
        { cmd: '/record/write', pol: [['==', '.byCreator', true]] },
        { cmd: '/collection/define', pol: [] },
      ],
    });
    await alice.node.collections.define(space, { name: 'app.chess.game', schema: { type: 'object' } });
    await alice.node.records.put(space, 'app.secret', { pin: 1234 });
    await waitFor(
      async () =>
        (await bob.node.collections.list(space)).some(
          (c) => c.name === 'app.chess.game' && c.version !== null,
        ),
      'the definition',
    );

    const channel = new MessageChannel();
    const bridge = createScreenBridge({
      node: bob.node,
      spaceId: space,
      // Handed the launcher's own collection too, which no screen may use.
      collections: ['app.chess.game', 'launcher.app'],
      port: channel.port1,
    });
    const Answer = z.object({ ok: z.boolean(), value: z.unknown().optional(), error: z.string().optional() });
    let next = 0;
    const call = (method: string, ...args: unknown[]) =>
      new Promise<z.infer<typeof Answer>>((resolve) => {
        const id = ++next;
        const listen = (event: MessageEvent<unknown>) => {
          if (!isRecord(event.data) || event.data.id !== id) return;
          channel.port2.removeEventListener('message', listen);
          resolve(Answer.parse(event.data));
        };
        channel.port2.addEventListener('message', listen);
        channel.port2.start();
        channel.port2.postMessage({ id, method, args });
      });
    try {
      const secret = await call('list', 'app.secret');
      assert.equal(secret.ok, false);
      assert.match(secret.error!, /can't use/);
      const launcher = await call('list', 'launcher.app');
      assert.equal(launcher.ok, false, "the launcher's own collection is off limits");

      const game = await call('put', 'app.chess.game', { white: 'bob' });
      assert.equal(game.ok, true);
      const written = z.object({ mine: z.boolean(), key: z.string() }).parse(game.value);
      assert.equal(written.mine, true);
      const created = await bob.node.records.get(space, written.key);
      assert.equal(created?.root, bob.node.did, 'written as the person looking');

      // Alice's game: Bob may not change it, and the screen hears why.
      const hers = await alice.node.records.put(space, 'app.chess.game', { white: 'alice' });
      await waitFor(async () => (await bob.node.records.get(space, hers.key)) !== null, "Alice's game");
      const refused = await call('update', hers.key, { white: 'bob' });
      assert.equal(refused.ok, false);
      assert.match(refused.error!, /no grant/);

      // Written by guessing: one object per call, a where, id and data. It works, and a wrong call says how to call it.
      const guessed = await call('put', { collection: 'app.chess.game', body: { status: 'open' } });
      assert.equal(guessed.ok, true);
      const listed = await call('list', { collection: 'app.chess.game', where: { status: 'open' } });
      const open = z
        .array(z.object({ id: z.string(), key: z.string(), data: z.object({ status: z.string() }) }))
        .parse(listed.value);
      assert.equal(open.length, 1);
      assert.equal(open[0]!.id, open[0]!.key);
      assert.equal(open[0]!.data.status, 'open');
      const wrong = await call('list', 42);
      assert.match(wrong.error!, /Name the collection as text, like weave\.list\("app\.chess\.game"\)/);
    } finally {
      bridge.close();
      channel.port2.close();
    }
  });
});
