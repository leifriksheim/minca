/**
 * Minca on the desktop. One Bun process does five things:
 *
 * - serves the example app's build at a fixed loopback origin, so the
 *   account home knows it as one app across restarts (a new port would be a
 *   new origin, and a new app);
 * - shows it in a window with no title bar, and opens the windows it asks
 *   for, the account home among them (`bridge.ts`);
 * - runs the app's node in a process of its own (`app-node.ts`), which the
 *   window uses over a socket to the same server (`node-link.ts`) and which
 *   keeps running when it closes;
 * - runs a carrier for the person's account beside it (`carrier.ts`), which
 *   keeps their spaces online even once the app's connection has run out;
 * - puts Minca in the menu bar, where it stays when the window closes.
 */
import Electrobun, { BrowserWindow, BuildConfig, PATHS, Tray, Utils } from 'electrobun/bun';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createBridge, type PaneHost } from './bridge';
import { createAppNode, keychainKey } from './app-node';
import { createCarrier, type CarrierState } from './carrier';
import { createNodeLink, MAX_NODE_MESSAGE, nodeUrl, type LinkSocket } from './node-link';
import { connectionMenu, reminderAt, whenEnds } from './menu';
import { createNotifier } from './notify';
import { preloadFor } from './page';

const APP_PORT = 47830;
const APP_URL = `http://127.0.0.1:${APP_PORT}`;
const { VIEWS_FOLDER } = PATHS;
/** How tall the app window's title bar would be: the strip that drags it */
const DRAG_INSET = 28;

/** Electrobun's events carry their payload in `data`; one field of it */
function field(event: unknown, name: string): unknown {
  const data: unknown =
    typeof event === 'object' && event !== null && 'data' in event ? event.data : undefined;
  return typeof data === 'object' && data !== null && name in data ? Reflect.get(data, name) : undefined;
}

// The app: static files, and index.html for any path the app routes itself. The
// site's headers are a file for its host (\`_headers\`); here they are headers.
const appFolder = join(VIEWS_FOLDER, 'app');
const headers = {
  'content-security-policy': "frame-ancestors 'self'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
};
Bun.serve<LinkSocket['data']>({
  hostname: '127.0.0.1',
  port: APP_PORT,
  async fetch(request, server) {
    const token = link.accept(request);
    if (token !== null)
      return server.upgrade(request, { data: { token } }) ? undefined : new Response(null, { status: 400 });
    const { pathname } = new URL(request.url);
    const file = Bun.file(join(appFolder, pathname));
    const served =
      !pathname.includes('..') && !/^\/_(headers|redirects)$/.test(pathname) && (await file.exists());
    return new Response(served ? file : Bun.file(join(appFolder, 'index.html')), { headers });
  },
  websocket: {
    maxPayloadLength: MAX_NODE_MESSAGE,
    // A sync can send the window a lot at once; above this, Bun would drop what it sends.
    backpressureLimit: 64 << 20,
    open: (socket) => link.opened(socket),
    message: (socket, data) => link.message(socket, data),
    close: (socket) => link.closed(socket),
  },
});

let app: PaneHost | null = null;

// Windows. Every one is sandboxed: Electrobun lets a page that isn't, and any
// frame in it, run scripts in every other window, the account home's too.
let openCount = 0;
const bridge = createBridge({
  preload: ({ secret, origin, popup, app: isApp, node }) =>
    preloadFor({
      secret,
      origin,
      popup,
      app: isApp,
      dragInset: isApp ? DRAG_INSET : 0,
      nodeUrl: node ? nodeUrl(origin, node) : null,
    }),
  openExternal: (url) => void Utils.openExternal(url),
  account: (who) => followApp(who),
  open({ url, preload, width, height, app: isApp, closed }) {
    const offset = 40 * (openCount++ % 6);
    const win = new BrowserWindow({
      // Any window but the app's has its address for a title: there is no address bar to show where it is.
      title: isApp ? 'Minca' : new URL(url).host,
      url,
      preload,
      sandbox: true,
      // It stays at the origin it was opened for, and its own about: and blob: pages.
      navigationRules: JSON.stringify([
        '^*',
        `${new URL(url).origin}/*`,
        'about:*',
        `blob:${new URL(url).origin}/*`,
      ]),
      frame: isApp ? { x: 120, y: 80, width, height } : { x: 360 + offset, y: 120 + offset, width, height },
      ...(isApp ? { titleBarStyle: 'hiddenInset' as const, trafficLightOffset: { x: 6, y: 6 } } : {}),
    });
    win.on('close', () => {
      closed();
      if (host === homeWindow) homeWindow = null;
      // The app's window: the dock icon goes with it.
      if (isApp) {
        app = null;
        link.close();
        appNode.detach();
        Utils.setDockIconVisible(false);
      }
    });
    let start = { x: 0, y: 0, frameX: 0, frameY: 0 };
    const host: PaneHost = {
      run: (js) => win.webview.executeJavascript(js),
      close: () => win.close(),
      activate: () => win.activate(),
      drag(phase, x, y) {
        if (phase === 'start') {
          const frame = win.getFrame();
          start = { x, y, frameX: frame.x, frameY: frame.y };
        } else win.setPosition(start.frameX + x - start.x, start.frameY + y - start.y);
      },
      zoom: () => (win.isMaximized() ? win.unmaximize() : win.maximize()),
    };
    return host;
  },
});
// The app's window and its node: only from the app's origin, with its window's token.
const link = createNodeLink({
  origin: APP_URL,
  isToken: (token) => bridge.isNodeToken(token),
  fromWindow: (message) => appNode.fromWindow(message),
});

// Messages from pages, from any window: the bridge knows them by their secret, not by where they say they're from.
// Out of the event's own callback: closing a window from inside one crashes Bun.
Electrobun.events.on('host-message', (event: unknown) => {
  const detail = field(event, 'detail');
  setTimeout(() => bridge.receive(detail), 0);
});

// The account home, from the menu bar: its settings, in a window of its own (not the app's, and no popup).
let homeWindow: PaneHost | null = null;
function openHome() {
  if (homeWindow) return homeWindow.activate();
  homeWindow = bridge.openWindow(new URL('/', home).href, { width: 720, height: 820 }, { app: false });
}

// The app's window: made when asked for, gone when closed. The dock icon shows only while it is open.
function openApp() {
  if (app) return app.activate();
  Utils.setDockIconVisible(true);
  app = bridge.openWindow(`${APP_URL}/app`, { width: 1200, height: 820 });
}

// The carrier. Its folder is a setting (`settings.json`, `carrierFolder`), in the
// app's own data folder until someone picks another.
const settings: unknown = await readFile(join(Utils.paths.userData, 'settings.json'), 'utf8').then(
  (text): unknown => JSON.parse(text),
  () => ({}),
);
const chosen: unknown =
  typeof settings === 'object' && settings !== null ? Reflect.get(settings, 'carrierFolder') : null;
const carrierFolder = typeof chosen === 'string' && chosen ? chosen : join(Utils.paths.userData, 'carrier');
const { runtime } = await BuildConfig.get();
const home = typeof runtime?.home === 'string' ? runtime.home : 'https://minca-home.netlify.app/connect';
/** The relays, nodes and hosts the app was built with, so the node meets the same peers */
const listed = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
const network = {
  relays: listed(runtime?.relays),
  nodes: listed(runtime?.nodes),
  hosts: listed(runtime?.hosts),
};

// Minca's rainbow, in one colour: a template image, which macOS tints like the other icons in the bar (assets/tray.swift).
const tray = new Tray({ image: 'views://tray.png', template: true, width: 22, height: 12 });
let carrierState: CarrierState = { state: 'starting' };
// What the account asked to hear about, as the carrier sees it arrive: shown by the system, app open or not.
const notifier = createNotifier({ show: ({ title, body }) => Utils.showNotification({ title, body }) });
const carrier = createCarrier({
  // While the app's node runs, it says what arrived in words of its own; the carrier only knows where.
  woke: (wake) => {
    if (appNode.state().status !== 'ready') notifier.woke(wake);
  },
  folder: carrierFolder,
  // The CLI, run by the Bun this app ships with. Quitting the app stops it.
  cli: [process.execPath, join(VIEWS_FOLDER, 'minca.js')],
  home,
  openHome: (url, origin, hear) => bridge.openFromShell(url, { width: 460, height: 720 }, { origin, hear }),
  changed: (state) => {
    carrierState = state;
    showMenu();
    // It knows now what it carries: the app's account may still want asking.
    if (state.state !== 'starting' && state.state !== 'connecting' && appAccount && !carrying(appAccount))
      followApp(appAccount);
  },
});

// The app's node: the window's, and the menu bar's while the window is closed.
const appNode = createAppNode({
  cli: [process.execPath, join(VIEWS_FOLDER, 'minca.js')],
  folder: join(Utils.paths.userData, 'app-node'),
  origin: APP_URL,
  home,
  network,
  sealKey: () => keychainKey(),
  openHome: (url, origin, hear) => bridge.openFromShell(url, { width: 460, height: 720 }, { origin, hear }),
  toWindow: (message) => link.toWindow(message),
  changed: (state) => {
    const who = state.grant ? { did: state.grant.did, name: state.grant.name } : null;
    if (state.status === 'ready' || state.status === 'expired') followApp(who);
    else if (state.status === 'disconnected') followApp(null);
    remindLater();
    showMenu();
  },
  // With the window open, the app shows its own.
  notify: ({ title, space }) => {
    if (!app) Utils.showNotification({ title, body: space ? `In ${space}` : '' });
  },
  log: (line) => console.error(line),
});

// Once for each grant, a day before it ends: the one reminder, then the menu bar's dot.
const remindedFile = join(Utils.paths.userData, 'reminded.json');
let reminded: unknown = await readFile(remindedFile, 'utf8').then(
  (text): unknown => JSON.parse(text),
  () => null,
);
let reminder: ReturnType<typeof setTimeout> | null = null;
function remindLater() {
  if (reminder) clearTimeout(reminder);
  reminder = null;
  const state = appNode.state();
  const at = reminderAt(state, Date.now());
  const ends = state.grant?.expiresAt;
  if (at === null || ends === undefined || reminded === ends) return;
  reminder = setTimeout(
    () => {
      if (appNode.state().grant?.expiresAt !== ends) return;
      reminded = ends;
      void writeFile(remindedFile, JSON.stringify(ends), { mode: 0o600 }).catch(() => {});
      Utils.showNotification({
        title: 'Minca',
        body: `Your connection ends ${whenEnds(ends * 1000, Date.now())}. Renew it from the menu bar.`,
      });
      showMenu();
    },
    Math.min(at - Date.now(), 2 ** 31 - 1),
  );
}

// One account: the one the app is connected as. The menu bar keeps that one's
// spaces online and no other, and asks to, once for each account, as soon as
// the app connects as one it isn't carrying yet.
type Account = { readonly did: string; readonly name: string };
let appAccount: Account | null = null;
let carrierProblem: string | null = null;
const askedFile = join(Utils.paths.userData, 'carrier-asked.json');
const asked = new Set<string>(
  await readFile(askedFile, 'utf8').then(
    (text): string[] => {
      const list: unknown = JSON.parse(text);
      return Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : [];
    },
    () => [],
  ),
);

function carrying(account: Account | null): boolean {
  return carrierState.state === 'carrying' && account !== null && carrierState.account === account.did;
}

function connectCarrier(account: Account) {
  carrierProblem = null;
  void carrier.connect(account).catch((error: unknown) => {
    carrierProblem = error instanceof Error ? error.message : String(error);
    showMenu();
  });
}

function followApp(who: Account | null) {
  appAccount = who;
  showMenu();
  if (!who || carrying(who) || asked.has(who.did)) return;
  // Not while it is still finding out what it carries: it may be this one already.
  if (carrierState.state === 'starting' || carrierState.state === 'connecting') return;
  asked.add(who.did);
  void writeFile(askedFile, JSON.stringify([...asked]), { mode: 0o600 }).catch(() => {});
  connectCarrier(who);
}

/** The carrier, under the connection: it keeps the spaces online, and goes on when the connection has run out */
function carrierItems() {
  const said = (label: string) => ({ type: 'normal' as const, label, action: 'status', enabled: false });
  const offer = (account: Account) => ({
    type: 'normal' as const,
    label: `Keep ${account.name}’s spaces online…`,
    action: 'connect',
  });
  const state = carrierState;
  const account = appAccount;
  const problem = carrierProblem ? [said(carrierProblem)] : [];
  if (!account) return state.state === 'carrying' ? [said(`Keeping ${state.name}’s spaces online`)] : [];
  if (state.state === 'connecting') return [said('Spaces online: waiting for your account home…')];
  if (carrying(account) && state.state === 'carrying')
    return [
      said(`${state.spaces} ${state.spaces === 1 ? 'space' : 'spaces'} online, always`),
      { type: 'normal' as const, label: 'Pause', action: 'pause' },
    ];
  if (state.state === 'paused')
    return [
      said('Spaces online: paused, and your account home still lists it'),
      { type: 'normal' as const, label: 'Resume', action: 'resume' },
    ];
  // Not carrying the app's account: carrying another's, stopped, or nothing yet.
  return [
    ...(state.state === 'carrying' ? [said(`Keeping ${state.name}’s spaces online instead`)] : []),
    ...(state.state === 'stopped' ? [said(`Stopped: ${state.error}`)] : []),
    ...problem,
    offer(account),
  ];
}
/** The app's connection: until when, and a click to renew it near the end */
function connectionItems() {
  const menu = connectionMenu(appNode.state(), Date.now());
  tray.setTitle(menu.attention ? '•' : '');
  return menu.lines.map((line) => ({
    type: 'normal' as const,
    label: line.label,
    action: line.action ?? 'status',
    enabled: line.action !== undefined,
  }));
}
function showMenu() {
  tray.setMenu([
    { type: 'normal', label: 'Open Minca', action: 'open' },
    { type: 'normal', label: 'Account settings…', action: 'settings' },
    { type: 'divider' },
    ...connectionItems(),
    { type: 'divider' },
    ...carrierItems(),
    { type: 'divider' },
    { type: 'normal', label: 'Quit Minca', action: 'quit' },
  ]);
}
tray.on('tray-clicked', (event) => {
  const action = field(event, 'action');
  if (action === 'open') openApp();
  if (action === 'settings') openHome();
  if (action === 'connect' && appAccount) connectCarrier(appAccount);
  if (action === 'renew') appNode.renew();
  if (action === 'pause') void carrier.pause();
  if (action === 'resume') carrier.resume();
  if (action === 'quit') {
    appNode.close();
    carrier.close();
    tray.remove();
    Utils.quit();
  }
});

// The app brought to the front with no window (its dock icon, or a notification): its window again.
Electrobun.events.on('reopen', () => openApp());

showMenu();
// "Ends in 3 hours" stays true only if it is said again.
setInterval(showMenu, 5 * 60_000);
openApp();
