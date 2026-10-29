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
import type { NodeRecord, P2PNode } from '@minca/core';
import {
  file as fileCollection,
  list,
  listItem,
  message,
  poll,
  useSchemas as addSchemas,
} from '@minca/core/schemas';
import { checkLauncherApp } from '../src/components/apps/launcher';
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

  test('a record to show comes with the screen, so it is there for the first draw', () => {
    const port = { postMessage: () => {}, onmessage: null };
    const window: Record<string, unknown> = {
      __minca: { port, me: { did: 'did:key:zMe', name: 'Anna' }, collections: ['std.poll'], shown: 'k1' },
    };
    runScreenClient(window, () => {}, {});
    const minca = window.minca;
    assert.ok(isRecord(minca) && typeof minca.shown === 'function');
    assert.equal(Reflect.apply(minca.shown, undefined, []), 'k1');
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

  test('the script in front of a screen hands live messages to whoever listens, until they stop', () => {
    const port: { postMessage: () => void; onmessage: ((event: unknown) => void) | null } = {
      postMessage: () => {},
      onmessage: null,
    };
    const window: Record<string, unknown> = {
      __minca: { port, me: { did: 'did:key:zMe', name: 'Anna' }, collections: [] },
    };
    runScreenClient(window, () => {}, {});
    const live = isRecord(window.minca) ? window.minca.live : null;
    assert.ok(isRecord(live) && typeof live.on === 'function');
    const heard: unknown[] = [];
    const stop: unknown = Reflect.apply(live.on, undefined, [(one: unknown) => heard.push(one)]);
    const message = { from: 'did:key:zBo', device: 'did:key:zPhone', data: { x: 1 }, viaAgent: false };
    port.onmessage?.({ data: { live: message } });
    assert.ok(typeof stop === 'function');
    Reflect.apply(stop, undefined, []);
    port.onmessage?.({ data: { live: message } });
    assert.deepEqual(heard, [message]);
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
      // A picture too large to hand over whole is made smaller, or, where it can't be drawn, not shown.
      const poster = await alice.node.records.addFile(space, new Uint8Array(300 * 1024), {
        mime: 'image/png',
      });
      const wall = await alice.node.records.put(space, 'app.market.listing', { images: [poster] });
      await waitFor(async () => (await bob.node.records.get(space, wall.key)) !== null, 'the poster');
      const shown = await call('file', wall.key, poster);
      assert.equal(shown.ok, true, 'not too large an answer');
      assert.equal(shown.value, null);
      assert.equal((await call('file', listing.key, 'not-a-file-of-its')).ok, false);

      // The whole file comes as a Blob of the type the record gives, however large, and only one its record refers to.
      const whole = (await call('blob', wall.key, { hash: poster.hash, mime: 'text/html' })).value;
      assert.ok(whole instanceof Blob);
      assert.equal(whole.type, 'image/png');
      assert.equal(whole.size, 300 * 1024);
      const pdf = (await call('blob', listing.key, manual)).value;
      assert.ok(pdf instanceof Blob);
      assert.deepEqual([...new Uint8Array(await pdf.arrayBuffer())], [4, 5]);
      assert.equal((await call('blob', listing.key, poster)).ok, false, 'not a file the record refers to');
      assert.equal((await call('blob', 'nope', photo)).ok, false);

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
/** A page that does what a screen asks, and says what it was asked; `chosen` is what the person picks */
function fakeHost(chosen: NodeRecord | null = null) {
  const asked: unknown[][] = [];
  const kept = new Map<string, unknown>();
  const host: ScreenHost = {
    open: (target) => void asked.push(['open', target]),
    pick: async (text) => (asked.push(['pick', text]), chosen),
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

describe('the Files app', () => {
  test("a file kept about nothing is a file of the space, and anyone may put anyone's file in a category", async () => {
    const { alice, bob, space } = await setup();
    const FILES = [fileCollection.name, list.name, listItem.name];
    await addSchemas(alice.node, space, [fileCollection, list, listItem]);
    const mine = bridgeFor(alice.node, space, FILES);
    const theirs = bridgeFor(bob.node, space, FILES);
    try {
      // Uploaded in Files, not shared anywhere: a file with no about
      const bytes = z
        .looseObject({ hash: z.string(), size: z.number(), mime: z.string() })
        .parse(
          (await mine.call('addFile', new Uint8Array([1, 2]), { name: 'plan.txt', mime: 'text/plain' }))
            .value,
        );
      const put = await mine.call('put', fileCollection.name, {
        name: 'plan.txt',
        mime: 'text/plain',
        size: 2,
        blob: bytes,
      });
      assert.equal(put.ok, true, put.error ?? '');
      const file = z.object({ key: z.string() }).parse(put.value);

      // A category is a list that exists while empty; a file is in it by an item about it.
      const made = await mine.call('put', list.name, { title: 'Plans', kind: 'category' });
      const category = z.object({ key: z.string() }).parse(made.value);
      await waitFor(async () => (await bob.node.records.get(space, category.key)) !== null, 'the category');
      const item = await theirs.call(
        'put',
        listItem.name,
        {},
        {
          links: [
            { rel: 'in', to: category.key },
            { rel: 'about', to: file.key },
          ],
        },
      );
      assert.equal(item.ok, true, item.error ?? '');
      const inIt = await theirs.call('list', listItem.name, { where: { 'link:in': category.key } });
      const Items = z.array(z.object({ links: z.array(z.object({ rel: z.string(), to: z.string() })) }));
      assert.deepEqual(
        Items.parse(inIt.value).map((one) => one.links.find((l) => l.rel === 'about')?.to),
        [file.key],
      );
      // The bytes follow the record; once here, Bob's screen gets them whole.
      await waitFor(async () => (await theirs.call('blob', file.key, bytes.hash)).ok, 'the bytes');
    } finally {
      mine.close();
      theirs.close();
    }
  });

  test('a file opens the message it was shared on, though the app holds no messages', async () => {
    const { alice, space } = await setup();
    await addSchemas(alice.node, space, [fileCollection, message]);
    const said = await alice.node.records.put(space, message.name, { text: 'The plan' });
    const shared = await alice.node.records.put(
      space,
      fileCollection.name,
      { name: 'plan.txt', mime: 'text/plain' },
      { links: [{ rel: 'about', to: said.key }] },
    );
    const { host, asked } = fakeHost();
    const { call, close, show, showed } = bridgeFor(alice.node, space, [fileCollection.name], host);
    try {
      // The page asks the screen to show a file, opened from the chat, say.
      show(shared.key);
      await waitFor(async () => showed.includes(shared.key), 'the file handed over');
      assert.equal((await call('open', { record: shared.key, link: 'about' })).ok, true);
      const opened = asked.find(([what]) => what === 'open')?.[1];
      assert.ok(isRecord(opened) && isRecord(opened.record) && opened.record.key === said.key);
      assert.equal((await call('open', { record: said.key })).ok, false, 'not a record of its own');
    } finally {
      close();
    }
  });

  test('a screen can’t point a link out of its app, so it can’t probe for keys or reach what no one shared', async () => {
    const { alice, space } = await setup();
    await addSchemas(alice.node, space, [fileCollection]);
    const secret = await alice.node.records.put(space, 'app.secret', { pin: 1234 });
    const { call, close } = bridgeFor(alice.node, space, [fileCollection.name], fakeHost().host);
    const pointAt = (to: string) =>
      call('put', fileCollection.name, { name: 'x', mime: 'text/plain' }, { links: [{ rel: 'about', to }] });
    try {
      const here = await pointAt(secret.key);
      const missing = await pointAt(`${secret.key.split('.')[0]}.aaaaaaaaaaaaaaaaaaaaaaaaaa`);
      const own = await pointAt(`collection:${fileCollection.name}`);
      // Refused alike whether or not the record is here, or is the space's own.
      for (const answer of [here, missing, own]) {
        assert.equal(answer.ok, false);
        assert.match(answer.error ?? '', /links only to records of "std.file", or one the person chose/);
      }
      // A link to a record of its own is fine.
      const first = await call('put', fileCollection.name, { name: 'a', mime: 'text/plain' });
      const { key } = z.object({ key: z.string() }).parse(first.value);
      const linked = await call(
        'put',
        fileCollection.name,
        { name: 'b', mime: 'text/plain' },
        { links: [{ rel: 'about', to: key }] },
      );
      assert.equal(linked.ok, true, linked.error ?? '');
    } finally {
      close();
    }
  });
});

describe('sharing a record into an app', () => {
  test('a record someone shared is read through the link to it, and only through that', async () => {
    const { alice, space } = await setup();
    await addSchemas(alice.node, space, [message, poll]);
    const asked = await alice.node.records.put(space, poll.name, {
      question: 'Where?',
      options: ['Here', 'There'],
    });
    // Shared from elsewhere: another app, an agent, another device
    const said = await alice.node.records.put(
      space,
      message.name,
      { text: 'Vote!' },
      { links: [{ rel: 'shares', to: asked.key }] },
    );
    const app = await alice.node.records.put(space, 'launcher.app', { title: 'Hidden' });
    const odd = await alice.node.records.put(
      space,
      message.name,
      { text: 'Look' },
      { links: [{ rel: 'shares', to: app.key }] },
    );
    const { host, asked: opened } = fakeHost();
    const { call, close } = bridgeFor(alice.node, space, [message.name], host);
    try {
      assert.equal((await call('get', asked.key)).value, null, 'not by its key: it is no record of the chat');
      // Opening what a message shares shows it to the person, but never the space's own apps.
      assert.equal((await call('open', { record: said.key, link: 'shares' })).ok, true);
      assert.equal((await call('open', { record: odd.key, link: 'shares' })).ok, true, 'answered the same');
      const shown = opened.filter(([what]) => what === 'open').map(([, target]) => target);
      assert.equal(shown.length, 1);
      assert.ok(isRecord(shown[0]) && isRecord(shown[0].record) && shown[0].record.key === asked.key);
      const shared = await call('get', said.key, { link: 'shares' });
      assert.ok(isRecord(shared.value) && isRecord(shared.value.body));
      assert.equal(shared.value.body.question, 'Where?');
      assert.equal((await call('get', said.key, { link: 'replyTo' })).ok, false, 'only a share is read');
      assert.equal(
        (await call('get', odd.key, { link: 'shares' })).value,
        null,
        'never the space’s own apps',
      );
      assert.equal(
        (await call('get', asked.key, { link: 'shares' })).value,
        null,
        'only from a record of its own',
      );
    } finally {
      close();
    }
  });

  test('a link made for something else shares nothing: a file about a diary entry doesn’t hand the entry over', async () => {
    const { alice, space } = await setup();
    await addSchemas(alice.node, space, [message, fileCollection]);
    const entry = await alice.node.records.put(space, 'app.diary.entry', { text: 'my secret diary' });
    const photo = await alice.node.records.put(
      space,
      fileCollection.name,
      { name: 'p.jpg', mime: 'image/jpeg' },
      { links: [{ rel: 'about', to: entry.key }] },
    );
    // The chat names std.file, as the ready-made one does, so it can list the photo.
    const { call, close } = bridgeFor(
      alice.node,
      space,
      [message.name, fileCollection.name],
      fakeHost().host,
    );
    try {
      const read = await call('get', photo.key, { link: 'about' });
      assert.equal(read.ok, false);
      assert.doesNotMatch(JSON.stringify(read), /secret diary/);
    } finally {
      close();
    }
  });

  test('a screen links out only to what the person picked for it, and is handed what they picked', async () => {
    const { alice, space } = await setup();
    await addSchemas(alice.node, space, [message, poll]);
    const asked = await alice.node.records.put(space, poll.name, { question: 'Where?', options: ['Here'] });
    const share = (
      call: (method: string, ...args: unknown[]) => Promise<{ ok: boolean; error?: string | undefined }>,
    ) => call('put', message.name, { text: 'Vote!' }, { links: [{ rel: 'shares', to: asked.key }] });

    const declined = fakeHost(null);
    const before = bridgeFor(alice.node, space, [message.name], declined.host);
    const chooses = fakeHost(asked);
    const after = bridgeFor(alice.node, space, [message.name], chooses.host);
    try {
      assert.equal((await share(before.call)).ok, false, 'not before the person chose it');
      assert.equal((await before.call('pick', { text: 'poll' })).value, null, 'the person chose nothing');
      assert.equal((await share(before.call)).ok, false);
      assert.deepEqual(declined.asked, [['pick', 'poll']]);

      const picked = await after.call('pick');
      assert.ok(isRecord(picked.value) && picked.value.key === asked.key);
      const sent = await share(after.call);
      assert.equal(sent.ok, true, sent.error ?? '');
      // What was picked in one app is not another's: each bridge keeps its own.
      assert.equal((await share(before.call)).ok, false);
    } finally {
      before.close();
      after.close();
    }
  });

  test('the space’s own records are never picked for a screen', async () => {
    const { alice, space } = await setup();
    await addSchemas(alice.node, space, [message]);
    const app = await alice.node.records.put(space, 'launcher.app', { title: 'Hidden' });
    const { call, close } = bridgeFor(alice.node, space, [message.name], fakeHost(app).host);
    try {
      assert.equal((await call('pick')).value, null);
      const sent = await call(
        'put',
        message.name,
        { text: 'x' },
        { links: [{ rel: 'shares', to: app.key }] },
      );
      assert.equal(sent.ok, false);
    } finally {
      close();
    }
  });
});

describe('a record opened from elsewhere', () => {
  test('the bridge hands the screen the key, and the script in front of it keeps it and calls back', () => {
    const port: { postMessage: () => void; onmessage: ((event: unknown) => void) | null } = {
      postMessage: () => {},
      onmessage: null,
    };
    const window: Record<string, unknown> = {
      __minca: { port, me: { did: 'did:key:zMe', name: 'Anna' }, collections: [] },
    };
    runScreenClient(window, () => {}, {});
    const minca = window.minca;
    assert.ok(isRecord(minca) && typeof minca.shown === 'function' && typeof minca.onShow === 'function');
    assert.equal(Reflect.apply(minca.shown, undefined, []), null);
    const told: unknown[] = [];
    Reflect.apply(minca.onShow, undefined, [(key: unknown) => told.push(key)]);
    port.onmessage?.({ data: { show: 'message-1' } });
    assert.equal(Reflect.apply(minca.shown, undefined, []), 'message-1');
    assert.deepEqual(told, ['message-1']);
  });

  test('an app may only show collections it has', () => {
    const app = { title: 'Chat', collections: ['std.message'], shows: ['std.message'] };
    assert.equal(checkLauncherApp(app), null);
    assert.match(
      checkLauncherApp({ ...app, shows: ['std.file'] }) ?? '',
      /std\.file is not one of its collections/,
    );
  });
});

describe('live messages between screens', () => {
  test("a screen hears the same app's screens on other devices, as who sent it, and no other app's", async () => {
    const { alice, bob, space } = await setup();
    const board = bridgeFor(alice.node, space, [], undefined, 'app.board');
    const bobsBoard = bridgeFor(bob.node, space, [], undefined, 'app.board');
    const bobsGame = bridgeFor(bob.node, space, [], undefined, 'app.game');
    try {
      assert.deepEqual((await board.call('liveSend', { x: 3, y: 4 })).value, true);
      await waitFor(async () => bobsBoard.heard.length > 0, 'the cursor');
      assert.deepEqual(bobsBoard.heard, [
        { from: alice.node.did, device: alice.node.sessionDid, data: { x: 3, y: 4 }, viaAgent: false },
      ]);
      // To one device only, and kept apart from another app's screens in the same space
      assert.equal((await board.call('liveSend', 'just you', { to: bob.node.sessionDid })).ok, true);
      await waitFor(async () => bobsBoard.heard.length > 1, 'the reply');
      assert.equal(bobsGame.heard.length, 0);
      assert.equal(board.heard.length, 0, 'not what this device sent');
      assert.equal((await board.call('liveSend', 'x', { to: 'someone' })).ok, false);
      assert.equal((await board.call('liveSend', 'x'.repeat(70_000))).ok, false, 'at most 64 KB');

      // A screen that sends too fast has some dropped, leaving room for the rest of the app.
      const sent = await Promise.all(Array.from({ length: 60 }, (_, at) => bobsGame.call('liveSend', at)));
      const dropped = sent.filter((answer) => answer.value === false).length;
      assert.ok(dropped >= 20 && dropped < 60, `dropped ${dropped}`);
    } finally {
      board.close();
      bobsBoard.close();
      bobsGame.close();
    }
  });
});

const Answer = z.object({ ok: z.boolean(), value: z.unknown().optional(), error: z.string().optional() });

/** A bridge for these collections, and a way to call it as a screen would */
function bridgeFor(
  node: P2PNode,
  spaceId: string,
  collections: ReadonlyArray<string>,
  host?: ScreenHost,
  app = 'app.test',
) {
  const channel = new MessageChannel();
  const bridge = createScreenBridge({
    node,
    spaceId,
    collections,
    app,
    port: channel.port1,
    ...(host ? { host } : {}),
  });
  // The live messages, and the records to show, handed to the screen
  const heard: unknown[] = [];
  const showed: unknown[] = [];
  channel.port2.addEventListener('message', (event: MessageEvent<unknown>) => {
    if (isRecord(event.data) && 'live' in event.data) heard.push(event.data.live);
    if (isRecord(event.data) && 'show' in event.data) showed.push(event.data.show);
  });
  channel.port2.start();
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
    heard,
    showed,
    show: (key: string) => bridge.show(key),
    close: () => {
      bridge.close();
      channel.port2.close();
    },
  };
}
