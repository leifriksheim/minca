/**
 * The preload and the bridge together, as a page sees them. The first tests
 * are the review's probes: each showed an attack that worked before its fix.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call, setupHarness } from './harness.ts';
import { preloadFor } from '../src/bun/page.ts';

const HOME = 'https://home.example/connect';

test('a window opened with noopener has no opener: it opens in the browser, and open returns null', () => {
  const { windows, external, flush, openApp } = setupHarness();
  const app = openApp();
  app.page.click();
  // apps/shared/src/Payment.tsx falls back to this when it has no blank window.
  const tab = call(app.page, 'open', 'https://checkout.evil.example/pay', '_blank', 'noopener');
  flush();
  assert.equal(tab, null);
  assert.equal(windows.length, 1);
  assert.deepEqual(external, ['https://checkout.evil.example/pay']);
});

test('a blank window opened on a click sends its first address to the browser, once, with no way back', () => {
  const { windows, external, flush, openApp } = setupHarness();
  const app = openApp();
  app.page.click();
  const tab: unknown = call(app.page, 'open', 'about:blank', '_blank');
  assert.equal(Reflect.get(Object(tab), 'opener'), null);
  const location: unknown = Reflect.get(Object(tab), 'location');
  Reflect.set(Object(location), 'href', 'https://checkout.example/pay');
  Reflect.set(Object(location), 'href', 'https://checkout.example/again');
  flush();
  assert.equal(windows.length, 1);
  assert.deepEqual(external, ['https://checkout.example/pay']);
});

test('nothing opens without a click, though WebKit counts a script the shell ran as one', () => {
  const { windows, external, flush, openApp } = setupHarness();
  const app = openApp();
  assert.equal(call(app.page, 'open', HOME, 'minca-home', 'popup'), null);
  assert.equal(call(app.page, 'open', 'about:blank', '_blank'), null);
  flush();
  assert.equal(windows.length, 1);
  assert.deepEqual(external, []);
});

test('a click counts for a moment, not for ever', () => {
  const { windows, flush, openApp, clock } = setupHarness();
  const app = openApp();
  app.page.click();
  clock.now += 1500;
  assert.equal(call(app.page, 'open', HOME, 'minca-home', 'popup'), null);
  app.page.click();
  assert.notEqual(call(app.page, 'open', HOME, 'minca-home', 'popup'), null);
  flush();
  assert.equal(windows.length, 2);
});

test('a page that hears a message has not been clicked', () => {
  const { windows, flush, openApp } = setupHarness();
  const app = openApp();
  app.page.click();
  const toPopup = call(app.page, 'open', 'https://popup.example/', 'p', 'popup');
  flush();
  const popup = windows[1];
  assert.ok(popup);
  // It opens a window from the message's own handler, as a hostile page would.
  let opened: unknown = 'not yet';
  const listen: unknown = Reflect.get(popup.page.context, 'addEventListener');
  assert.ok(typeof listen === 'function');
  Reflect.apply(listen, popup.page.context, [
    'message',
    () => {
      opened = call(popup.page, 'open', 'https://evil.example/');
    },
  ]);
  const postMessage: unknown = Reflect.get(Object(toPopup), 'postMessage');
  assert.ok(typeof postMessage === 'function');
  Reflect.apply(postMessage, toPopup, [{ type: 'hello' }, '*']);
  flush();
  assert.equal(opened, null);
  assert.equal(windows.length, 2);
});

test('a page that opens windows in a loop gets a few, not hundreds', () => {
  const { windows, flush, openApp } = setupHarness();
  const app = openApp();
  app.page.click();
  call(app.page, 'open', 'https://checkout.evil.example/', '_blank');
  flush();
  const popup = windows[1];
  assert.ok(popup);
  // Even if it got a click past the preload: the bridge holds the line.
  popup.page.click();
  for (let i = 0; i < 200; i++) call(popup.page, 'open', `https://evil.example/${i}`);
  flush();
  assert.ok(windows.length <= 2 + 8, `${windows.length} windows`);
});

test('after the app page loads again, it opens a new window, and the old one is not heard as it', () => {
  const { windows, flush, openApp } = setupHarness();
  const app = openApp();
  app.page.click();
  call(app.page, 'open', HOME, 'minca-home', 'popup,width=460,height=720');
  flush();
  const oldHome = windows[1];
  assert.ok(oldHome);
  app.load('http://127.0.0.1:47830/app');
  app.page.click();
  const again = call(app.page, 'open', 'https://other-home.example/connect', 'other', 'popup');
  flush();
  assert.equal(windows.length, 3);
  // The old home's opener is still the app's window, as in a browser, but not this proxy.
  const back: unknown = Reflect.get(oldHome.page.context, 'opener');
  const postMessage: unknown = Reflect.get(Object(back), 'postMessage');
  assert.ok(typeof postMessage === 'function');
  Reflect.apply(postMessage, back, [{ type: 'minca:hello' }, '*']);
  flush();
  assert.ok(app.page.heard.every((heard) => heard.source !== again));
});

test('a page opens at most one link in the browser a second', () => {
  const { external, flush, openApp } = setupHarness();
  const app = openApp();
  app.page.click();
  for (let i = 0; i < 20; i++) call(app.page, 'open', `https://example.com/${i}`, '_blank', 'noopener');
  flush();
  assert.deepEqual(external, ['https://example.com/0']);
});

test('the connect exchange: hello, request and grant, each heard from the window it came from', () => {
  const { windows, flush, openApp } = setupHarness();
  const app = openApp();
  app.page.click();
  const popup = call(app.page, 'open', HOME, 'minca-home', 'popup');
  flush();
  const home = windows[1];
  assert.ok(home);
  const opener: unknown = Reflect.get(home.page.context, 'opener');
  const reply: unknown = Reflect.get(Object(opener), 'postMessage');
  const ask: unknown = Reflect.get(Object(popup), 'postMessage');
  assert.ok(typeof reply === 'function' && typeof ask === 'function');
  Reflect.apply(reply, opener, [{ type: 'minca:hello' }, '*']);
  Reflect.apply(ask, popup, [{ type: 'minca:request' }, 'https://home.example']);
  Reflect.apply(reply, opener, [{ type: 'minca:grant' }, 'http://127.0.0.1:47830']);
  flush();
  assert.deepEqual(
    app.page.heard.map(({ data, origin, source }) => [JSON.stringify(data), origin, source === popup]),
    [
      ['{"type":"minca:hello"}', 'https://home.example', true],
      ['{"type":"minca:grant"}', 'https://home.example', true],
    ],
  );
  assert.deepEqual(
    home.page.heard.map(({ data, origin, source }) => [JSON.stringify(data), origin, source === opener]),
    [['{"type":"minca:request"}', 'http://127.0.0.1:47830', true]],
  );
});

test('a page that hooks toJSON never sees the secret', () => {
  const { envelopes, flush, makePage } = setupHarness();
  const secret = 'ab'.repeat(32);
  const preload = preloadFor({
    secret,
    origin: 'https://home.example',
    popup: true,
    app: false,
    dragInset: 0,
  });
  const page = makePage(HOME, preload, {
    before: `globalThis.leaked = []; Object.prototype.toJSON = function () { leaked.push(JSON.stringify(Object.assign({}, this))); return this; };
      JSON.stringify = (value) => { leaked.push(String(value)); return '{}'; };`,
  });
  const opener: unknown = Reflect.get(page.context, 'opener');
  const postMessage: unknown = Reflect.get(Object(opener), 'postMessage');
  assert.ok(typeof postMessage === 'function');
  Reflect.apply(postMessage, opener, [{ type: 'x' }, '*']);
  flush();
  assert.equal(envelopes.length, 1);
  assert.ok(envelopes[0]?.includes(secret), 'the envelope carries it');
  assert.ok(!String(Reflect.get(page.context, 'leaked')).includes(secret), 'the page never had it');
});

test('a frame, or a page at another origin, gets no bridge', () => {
  const { makePage } = setupHarness();
  const preload = preloadFor({
    secret: 'ab'.repeat(32),
    origin: 'https://home.example',
    popup: true,
    app: false,
    dragInset: 0,
  });
  for (const page of [makePage(HOME, preload, { frame: true }), makePage('https://evil.example/', preload)]) {
    assert.equal(Reflect.get(page.context, 'opener'), undefined);
    assert.equal(Reflect.get(page.context, '__mincaReceive'), undefined);
  }
});

test('a window here has no SharedWorker and no passkeys, so pages take the paths that work in it', () => {
  const { openApp } = setupHarness();
  const app = openApp();
  for (const name of ['SharedWorker', 'PublicKeyCredential']) {
    assert.ok(Object.prototype.hasOwnProperty.call(app.page.context, name), name);
    assert.equal(Reflect.get(app.page.context, name), undefined, name);
  }
});

test('the app’s window can tell the menu bar its account; a popup has no way to', () => {
  const { windows, envelopes, flush, openApp } = setupHarness();
  const app = openApp();
  app.page.click();
  call(app.page, 'open', HOME, 'minca-home', 'popup');
  flush();
  const home = windows[1];
  assert.ok(home);
  assert.equal(Reflect.get(home.page.context, 'mincaDesktop'), undefined);
  const desktop: unknown = Reflect.get(app.page.context, 'mincaDesktop');
  const account: unknown = Reflect.get(Object(desktop), 'account');
  assert.ok(typeof account === 'function');
  const before = envelopes.length;
  Reflect.apply(account, desktop, [{ did: 'did:key:zLeif', name: 'Leif' }]);
  flush();
  assert.equal(envelopes.length, before + 1);
  assert.ok(envelopes.at(-1)?.includes('did:key:zLeif'));
});

test('the app’s window talks to its node through the shell, both ways; a popup has no way to', () => {
  const { bridge, windows, toNode, flush, openApp } = setupHarness();
  const app = openApp();
  app.page.click();
  call(app.page, 'open', HOME, 'minca-home', 'popup');
  flush();
  const home = windows[1];
  assert.ok(home);
  const desktop: unknown = Reflect.get(app.page.context, 'mincaDesktop');
  const node: unknown = Reflect.get(Object(desktop), 'node');
  const send: unknown = Reflect.get(Object(node), 'send');
  const listen: unknown = Reflect.get(Object(node), 'listen');
  assert.ok(typeof send === 'function' && typeof listen === 'function');

  const heard: unknown[] = [];
  Reflect.apply(listen, node, [(data: unknown) => heard.push(data)]);
  Reflect.apply(send, node, [{ kind: 'attach' }]);
  flush();
  assert.deepEqual(toNode, [{ kind: 'attach' }]);
  bridge.toApp({ kind: 'state', state: { status: 'ready', session: 1 } });
  // Made in the page's realm: compared as what crossed.
  assert.deepEqual(JSON.parse(JSON.stringify(heard)), [
    { kind: 'state', state: { status: 'ready', session: 1 } },
  ]);

  // The home's page hears nothing of it, and a forged delivery there reaches nobody.
  assert.equal(Reflect.get(home.page.context, 'mincaDesktop'), undefined);
  call(home.page, '__mincaReceive', { t: 'node', data: { kind: 'port' } });
  assert.equal(heard.length, 1);
});
