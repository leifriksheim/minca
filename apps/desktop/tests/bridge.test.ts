import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBridge, type PaneHost, type Shell } from '../src/bun/bridge.ts';
import { preloadFor } from '../src/bun/page.ts';

/** A window the fake shell made: what it was opened with, and every script run in it */
interface FakeWindow {
  readonly url: string;
  readonly secret: string;
  readonly origin: string;
  readonly popup: boolean;
  readonly runs: string[];
  closed: boolean;
  close(): void;
  readonly drags: Array<[string, number, number]>;
}

function setup() {
  const windows: FakeWindow[] = [];
  const external: string[] = [];
  const focused: string[] = [];
  const accounts: unknown[] = [];
  const shell: Shell = {
    preload: ({ secret, origin }) => `${secret} ${origin}`,
    openExternal: (url) => external.push(url),
    account: (who) => accounts.push(who),
    open({ url, preload, popup, closed }) {
      const [secret = '', origin = ''] = preload.split(' ');
      const win: FakeWindow = {
        url,
        secret,
        origin,
        popup,
        runs: [],
        closed: false,
        drags: [],
        close() {
          if (win.closed) return;
          win.closed = true;
          closed();
        },
      };
      windows.push(win);
      const host: PaneHost = {
        run: (js) => win.runs.push(js),
        close: () => win.close(),
        activate: () => focused.push(win.url),
        drag: (phase, x, y) => win.drags.push([phase, x, y]),
        zoom: () => {},
      };
      return host;
    },
  };
  const bridge = createBridge(shell);
  /** What a page sends, as its preload would */
  const send = (from: FakeWindow, message: object) =>
    bridge.receive({ s: from.secret, m: JSON.stringify(message) });
  return { bridge, windows, external, focused, accounts, send };
}

/** What the bridge delivered to a window, and the origin each delivery was guarded by */
function delivered(win: FakeWindow) {
  return win.runs.map((js) => {
    const guard = /^location\.origin === ("[^"]*") &&/.exec(js);
    const body = /window\.__mincaReceive\((.*)\);$/.exec(js);
    assert.ok(guard && body, `not a guarded delivery: ${js}`);
    const parsed: { guard: unknown; message: unknown } = {
      guard: JSON.parse(guard[1] ?? '""'),
      message: JSON.parse(body[1] ?? 'null'),
    };
    return parsed;
  });
}

function withHome() {
  const t = setup();
  t.bridge.openWindow('http://127.0.0.1:47830/app', { width: 1200, height: 820 });
  const app = t.windows[0];
  assert.ok(app);
  t.send(app, { t: 'open', ref: 'w1', url: 'https://home.example/connect', name: 'minca-home' });
  const home = t.windows[1];
  assert.ok(home);
  return { ...t, app, home };
}

test('a popup opens at the address asked, and knows its own origin', () => {
  const { home } = withHome();
  assert.equal(home.url, 'https://home.example/connect');
  assert.equal(home.origin, 'https://home.example');
  assert.equal(home.popup, true);
});

test('the opener hears its popup, from the popup it opened, at the origin the popup was opened for', () => {
  const { app, home, send } = withHome();
  // Whatever the page claims, the origin is the one its secret was made for.
  send(home, {
    t: 'post',
    to: null,
    origin: '*',
    data: JSON.stringify({ type: 'minca:hello', origin: 'https://evil.example' }),
  });
  const [got] = delivered(app);
  assert.deepEqual(got, {
    guard: 'http://127.0.0.1:47830',
    message: {
      t: 'message',
      from: 'w1',
      origin: 'https://home.example',
      data: { type: 'minca:hello', origin: 'https://evil.example' },
    },
  });
});

test('the popup hears its opener as its opener', () => {
  const { app, home, send } = withHome();
  send(app, {
    t: 'post',
    to: 'w1',
    origin: 'https://home.example',
    data: JSON.stringify({ type: 'minca:request' }),
  });
  const [got] = delivered(home);
  assert.deepEqual(got, {
    guard: 'https://home.example',
    message: { t: 'message', from: null, origin: 'http://127.0.0.1:47830', data: { type: 'minca:request' } },
  });
});

test('a message to an origin the target is not at is dropped, as a browser drops it', () => {
  const { app, home, send } = withHome();
  send(app, { t: 'post', to: 'w1', origin: 'https://other.example', data: '{}' });
  send(home, { t: 'post', to: null, origin: 'https://home.example', data: '{}' });
  assert.equal(home.runs.length, 0);
  assert.equal(app.runs.length, 0);
});

test('a message without a secret the bridge made counts for nothing', () => {
  const { app, home, bridge } = withHome();
  bridge.receive({ s: 'f'.repeat(64), m: JSON.stringify({ t: 'post', to: null, origin: '*', data: '{}' }) });
  bridge.receive({ m: JSON.stringify({ t: 'post', to: null, origin: '*', data: '{}' }) });
  bridge.receive('{"t":"post"}');
  assert.equal(app.runs.length + home.runs.length, 0);
});

test('a window reaches only its opener and what it opened, not a window beside it', () => {
  const { app, home, windows, send } = withHome();
  send(app, { t: 'open', ref: 'w2', url: 'https://other.example/', name: '' });
  const other = windows[2];
  assert.ok(other);
  // The other popup names the home's ref: it opened nothing by that name.
  send(other, { t: 'post', to: 'w1', origin: '*', data: '{}' });
  send(other, { t: 'close', to: 'w1' });
  assert.equal(home.runs.length, 0);
  assert.equal(home.closed, false);
  // Its opener is the app, which hears it as w2.
  send(other, { t: 'post', to: null, origin: '*', data: '{}' });
  assert.deepEqual(delivered(app)[0]?.message, {
    t: 'message',
    from: 'w2',
    origin: 'https://other.example',
    data: {},
  });
});

test('when a popup closes, its opener is told, and its secret stops working', () => {
  const { app, home, send } = withHome();
  send(home, { t: 'close', to: 'self' });
  assert.equal(home.closed, true);
  assert.deepEqual(delivered(app)[0]?.message, { t: 'closed', ref: 'w1' });
  send(home, { t: 'post', to: null, origin: '*', data: '{}' });
  assert.equal(app.runs.length, 1);
});

test('when the opener closes, the popup is told it has none', () => {
  const { app, home } = withHome();
  app.close();
  assert.deepEqual(delivered(home)[0]?.message, { t: 'closed', ref: null });
});

test('a window no other opened cannot close itself, as in a browser', () => {
  const { app, send } = withHome();
  send(app, { t: 'close', to: 'self' });
  assert.equal(app.closed, false);
});

test('only web addresses open, in a window or the browser', () => {
  const { app, windows, external, send } = withHome();
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,hi', 'not a url']) {
    send(app, { t: 'open', ref: `x${windows.length}`, url, name: '' });
    send(app, { t: 'external', url });
  }
  assert.equal(windows.length, 2);
  assert.deepEqual(external, []);
  send(app, { t: 'external', url: 'https://example.com/docs' });
  assert.deepEqual(external, ['https://example.com/docs']);
});

test('a name already open from a window is that window, opened anew', () => {
  const { home, windows, send, app } = withHome();
  send(app, { t: 'open', ref: 'w2', url: 'https://home.example/connect', name: 'minca-home' });
  assert.equal(home.closed, true);
  assert.equal(windows.length, 3);
});

test('a ref already in use is not opened twice', () => {
  const { windows, send, app } = withHome();
  send(app, { t: 'open', ref: 'w1', url: 'https://other.example/', name: '' });
  assert.equal(windows.length, 2);
});

test('a drag needs numbers, and moves only the window that sent it', () => {
  const { app, home, send } = withHome();
  send(app, { t: 'drag', phase: 'start', x: 10, y: 20 });
  send(app, { t: 'drag', phase: 'move', x: 'a', y: 20 });
  send(app, { t: 'drag', phase: 'move', x: Number.NaN, y: 20 });
  assert.deepEqual(app.drags, [['start', 10, 20]]);
  assert.deepEqual(home.drags, []);
});

test('the preload is a script that carries its options', () => {
  const source = preloadFor({
    secret: 'ab'.repeat(32),
    origin: 'https://home.example',
    popup: true,
    app: false,
    dragInset: 0,
  });
  // eslint-disable-next-line no-implied-eval -- parses the preload, as the window would, without running it
  assert.doesNotThrow(() => new Function(source));
  assert.ok(source.includes('ab'.repeat(32)));
  assert.ok(source.includes('"https://home.example"'));
});

test('a window the shell opens hears the shell as its opener, at the origin the shell names', () => {
  const { bridge, windows, send } = setup();
  const heard: Array<{ data: unknown; origin: string }> = [];
  const home = bridge.openFromShell(
    'https://home.example/connect',
    { width: 460, height: 720 },
    { origin: 'http://carrier-abc.localhost', hear: (event) => heard.push(event) },
  );
  assert.ok(home);
  const page = windows[0];
  assert.ok(page);
  assert.equal(page.popup, true);

  home.postMessage({ type: 'minca:request' }, 'https://home.example');
  home.postMessage({ type: 'lost' }, 'https://other.example');
  assert.deepEqual(
    delivered(page).map(({ message }) => message),
    [{ t: 'message', from: null, origin: 'http://carrier-abc.localhost', data: { type: 'minca:request' } }],
  );

  send(page, { t: 'post', to: null, origin: 'http://carrier-abc.localhost', data: '{"type":"minca:grant"}' });
  send(page, { t: 'post', to: null, origin: 'http://127.0.0.1:47830', data: '{"type":"elsewhere"}' });
  assert.deepEqual(heard, [{ data: { type: 'minca:grant' }, origin: 'https://home.example' }]);

  // The shell's side has no secret a page could send.
  bridge.receive({ s: '', m: JSON.stringify({ t: 'post', to: 'shell', origin: '*', data: '{}' }) });
  assert.equal(page.runs.length, 1);

  page.close();
  assert.equal(home.closed, true);
});

test('a window brings another to the front at most once a second', () => {
  const t = setup();
  t.bridge.openWindow('http://127.0.0.1:47830/app', { width: 1200, height: 820 });
  const app = t.windows[0];
  assert.ok(app);
  t.send(app, { t: 'open', ref: 'w1', url: 'https://popup.example/', name: '' });
  const popup = t.windows[1];
  assert.ok(popup);
  for (let i = 0; i < 50; i++) t.send(popup, { t: 'focus', to: null });
  assert.equal(t.focused.length, 1);
});

test('only the app’s own window says which account it is connected as, never a popup', () => {
  const { windows, accounts, send } = withHome();
  const [app, home] = windows;
  assert.ok(app && home);
  send(home, { t: 'account', who: { did: 'did:key:zEvil', name: 'Mallory' } });
  send(app, { t: 'account', who: { did: 'not a did', name: 'Leif' } });
  send(app, { t: 'account', who: { did: 'did:key:zLeif', name: 'Leif' } });
  send(app, { t: 'account', who: null });
  assert.deepEqual(accounts, [{ did: 'did:key:zLeif', name: 'Leif' }, null]);
});

test('a window the shell opens as no app — the account home, from the menu bar — says no account', () => {
  const t = setup();
  t.bridge.openWindow('https://home.example/', { width: 720, height: 820 }, { app: false });
  const home = t.windows[0];
  assert.ok(home);
  t.send(home, { t: 'account', who: { did: 'did:key:zLeif', name: 'Leif' } });
  assert.deepEqual(t.accounts, []);
});
