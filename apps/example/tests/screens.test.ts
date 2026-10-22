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
  type ScreenHost,
} from '../src/components/apps/screens';
import type { P2PNode } from '@minca/core';
import { setup, waitFor } from './helpers';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Runs the script put in front of a screen, compiled as a function of the globals it reads so a test can hand it fakes. */
function runScreenClient(window: unknown, addEventListener: unknown, document: unknown): void {
  const script = compileFunction(SCREEN_CLIENT, ['window', 'addEventListener', 'document']);
  Reflect.apply(script, undefined, [window, addEventListener, document]);
}

describe('screens', () => {
  test('the script in front of a screen sets up minca, with me readable both ways', () => {
    const port: { postMessage: () => void; onmessage: unknown } = { postMessage: () => {}, onmessage: null };
    const window: Record<string, unknown> = {
      __minca: { port, me: { did: 'did:key:zMe', name: 'Anna' }, collections: ['app.chess.game'] },
    };
    runScreenClient(window, () => {}, {});
    const minca = window.minca;
    assert.ok(isRecord(minca));
    const { me } = minca;
    assert.ok(typeof me === 'function' && 'did' in me);
    assert.equal(window.__minca, undefined, 'the port is not left lying around');
    assert.equal(me.did, 'did:key:zMe');
    assert.equal(me.name, 'Anna');
    assert.deepEqual(Reflect.apply(me, undefined, []), { did: 'did:key:zMe', name: 'Anna' });
    assert.deepEqual(minca.collections, ['app.chess.game']);
  });

  test("the script in front of a screen passes a list's where on, so a screen gets only what it asked for", () => {
    const sent: unknown[] = [];
    const port = { postMessage: (message: unknown) => sent.push(message), onmessage: null };
    const window: Record<string, unknown> = {
      __minca: { port, me: { did: 'did:key:zMe', name: 'Anna' }, collections: ['std.comment'] },
    };
    runScreenClient(window, () => {}, {});
    const minca = window.minca;
    assert.ok(isRecord(minca) && typeof minca.list === 'function');
    void Reflect.apply(minca.list, undefined, ['std.comment', { where: { 'link:about': 'event-1' } }]);
    assert.deepEqual(sent, [
      { id: 1, method: 'list', args: ['std.comment', { where: { 'link:about': 'event-1' } }] },
    ]);
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
      __minca: { port: { postMessage: () => {} }, me: { did: 'did:key:zMe', name: 'Anna' }, collections: [] },
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

    // Handed the launcher's own collection too, which no screen may use.
    const { call, close } = bridgeFor(bob.node, space, ['app.chess.game', 'launcher.app']);
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

      // What a record that cites this one needs: its version, and the first one through its history.
      const cited = z.object({
        key: z.string(),
        version: z.string(),
        seq: z.number(),
        verified: z.boolean(),
      });
      const [opened] = z.array(cited).parse(listed.value);
      assert.ok(opened);
      assert.equal(opened.seq, 0);
      assert.equal(opened.verified, true);
      const updated = cited.parse((await call('update', opened.key, { status: 'closed' })).value);
      const history = z.array(cited).parse((await call('history', opened.key)).value);
      assert.equal(history[0]?.version, updated.version, 'newest first');
      assert.equal(
        (await call('history', hers.key)).ok,
        true,
        "another person's record of the app's, to read",
      );
      assert.equal((await call('history', 'nope')).ok, false);

      const wrong = await call('list', 42);
      assert.match(wrong.error!, /Name the collection as text, like minca\.list\("app\.chess\.game"\)/);
    } finally {
      close();
    }
  });

  test('a screen checks, shows faces and opens things only within its app and its space', async () => {
    const { alice, bob, space } = await setup();
    await alice.node.collections.define(space, { name: 'app.chess.game', schema: { type: 'object' } });
    await alice.node.records.put(space, 'app.secret', { pin: 1234 });
    const picture = new Uint8Array([82, 73, 70, 70, 1, 2, 3]);
    await alice.node.account.setAvatar({ bytes: picture, mime: 'image/webp' });
    await waitFor(
      async () => !!(await bob.node.spaces.profiles(space)).find((p) => p.did === alice.node.did)?.avatar,
      "Alice's picture",
    );
    const game = await alice.node.records.put(space, 'app.chess.game', { white: 'alice' });
    const secret = (await alice.node.records.list(space, { collection: 'app.secret' }))[0]!;
    await waitFor(async () => (await bob.node.records.get(space, secret.key)) !== null, 'the records');

    const { host, asked } = fakeHost();
    const { call, close } = bridgeFor(bob.node, space, ['app.chess.game'], host);
    try {
      assert.equal((await call('can', 'create', 'app.chess.game')).value, true);
      assert.equal((await call('can', 'create', 'app.secret')).ok, false, "not another app's collection");
      assert.equal((await call('can', 'define', 'app.chess.game')).ok, false);

      assert.equal(
        (await call('picture', alice.node.did)).value,
        `data:image/webp;base64,${Buffer.from(picture).toString('base64')}`,
      );
      assert.equal((await call('picture', 'did:key:zNobodyHere')).value, null);

      assert.equal((await call('open', { record: game.key })).ok, true);
      assert.equal((await call('open', { record: secret.key })).ok, false, "not a record of another app's");
      assert.equal((await call('open', { person: alice.node.did })).ok, true);
      assert.equal(
        (await call('open', { person: 'did:key:zNobodyHere' })).ok,
        false,
        'not someone elsewhere',
      );
      const opened = asked.filter(([what]) => what === 'open').map(([, target]) => target);
      assert.equal(opened.length, 2);
      assert.ok(isRecord(opened[0]) && isRecord(opened[0].record) && opened[0].record.key === game.key);
      assert.deepEqual(opened[1], { person: alice.node.did });
    } finally {
      close();
    }
  });

  test('what the page does for a screen, it does only as asked properly', async () => {
    const { alice, bob, space } = await setup();
    await alice.node.collections.define(space, { name: 'app.market.listing', schema: { type: 'object' } });
    const photo = await alice.node.records.addFile(space, new Uint8Array([1, 2, 3]), { mime: 'image/webp' });
    const manual = await alice.node.records.addFile(space, new Uint8Array([4, 5]), {
      mime: 'application/pdf',
    });
    const listing = await alice.node.records.put(space, 'app.market.listing', { images: [photo], manual });
    await waitFor(async () => (await bob.node.records.get(space, listing.key)) !== null, 'the listing');

    const { host, asked } = fakeHost();
    const { call, close } = bridgeFor(bob.node, space, ['app.market.listing'], host);
    try {
      // A picture comes from the record that refers to it, whatever the screen says it is.
      assert.equal(
        (await call('file', listing.key, { hash: photo.hash, mime: 'text/html' })).value,
        'data:image/webp;base64,AQID',
      );
      assert.equal((await call('file', listing.key, manual)).value, null, 'only pictures');
      assert.equal((await call('file', listing.key, 'not-a-file-of-its')).ok, false);

      assert.equal((await call('link', 'javascript:alert(1)')).ok, false);
      assert.equal((await call('link', 'https://example.com/a')).ok, true);
      assert.equal((await call('save', '../evil.sh', 'x')).ok, false);
      assert.equal((await call('save', 'trip.ics', 'BEGIN:VCALENDAR', 'text/html')).ok, false);
      assert.equal((await call('save', 'trip.ics', 'BEGIN:VCALENDAR', 'text/calendar')).ok, true);
      assert.equal((await call('remember', 'near', 'x'.repeat(9000))).ok, false, 'small things only');
      assert.equal((await call('remember', 'near', { km: 5 })).ok, true);
      assert.deepEqual((await call('recall', 'near')).value, { km: 5 });
      assert.equal((await call('searchPlaces', 'Oslo', { lat: 59.9, lon: 10.7 })).ok, true);

      // A file the screen adds is the space's, as the person looking; one a record refers to can be saved.
      assert.equal((await call('addFile', 'not bytes')).ok, false);
      const added = z
        .object({ hash: z.string(), mime: z.string() })
        .parse(
          (await call('addFile', new Uint8Array([9, 9]), { name: 'note.txt', mime: 'text/plain' })).value,
        );
      assert.equal(added.mime, 'text/plain');
      assert.equal((await call('download', listing.key, manual)).ok, true);
      assert.equal((await call('download', listing.key, added)).ok, false, 'not a file the record refers to');

      assert.deepEqual(
        asked.filter(([what]) => what !== 'recall'),
        [
          ['link', 'https://example.com/a'],
          ['save', 'trip.ics', 'BEGIN:VCALENDAR', 'text/calendar'],
          ['remember', 'near', { km: 5 }],
          ['searchPlaces', 'Oslo', { lat: 59.9, lon: 10.7 }],
          ['save', 'file', '\u0004\u0005', 'application/pdf'],
        ],
      );
    } finally {
      close();
    }
  });
});

/** A page that does what a screen asks by writing it down */
function fakeHost() {
  const asked: unknown[][] = [];
  const kept = new Map<string, unknown>();
  const host: ScreenHost = {
    open: (target) => void asked.push(['open', target]),
    searchPlaces: async (text, near) => (asked.push(['searchPlaces', text, near]), []),
    here: async () => null,
    link: (url) => void asked.push(['link', url]),
    save: (name, bytes, type) => void asked.push(['save', name, new TextDecoder().decode(bytes), type]),
    recall: (key) => (asked.push(['recall', key]), kept.get(key) ?? null),
    remember: (key, value) => {
      asked.push(['remember', key, value]);
      kept.set(key, value);
    },
  };
  return { host, asked };
}

const Answer = z.object({ ok: z.boolean(), value: z.unknown().optional(), error: z.string().optional() });

/** A bridge for these collections, and a way to call it as a screen would */
function bridgeFor(node: P2PNode, spaceId: string, collections: ReadonlyArray<string>, host?: ScreenHost) {
  const channel = new MessageChannel();
  const bridge = createScreenBridge({
    node,
    spaceId,
    collections,
    port: channel.port1,
    ...(host ? { host } : {}),
  });
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
  return {
    call,
    close: () => {
      bridge.close();
      channel.port2.close();
    },
  };
}
