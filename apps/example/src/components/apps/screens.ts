/**
 * Screens: a made app's own UI, kept on its launcher record and run sealed.
 *
 * A launcher record (`launcher.ts`) may carry a `screen`: one HTML document,
 * scripts and styles inline. It runs only once someone who may define
 * collections has written that record, and then in a frame that has no network,
 * no storage and no way to reach the page around it, and hands it one thing:
 * a message port to a {@link createScreenBridge bridge}. Through that port the
 * screen reads and writes the records of the collections its app named, in
 * one space, as whoever is looking — so every rule still holds, and a screen
 * can do nothing its viewer couldn't.
 *
 * Inside the frame, the screen finds `window.minca` (see {@link SCREEN_GUIDE}).
 * The port is handed over once, when the document is written; a frame that
 * navigates somewhere else leaves it behind, so a page it navigates to hears
 * nothing.
 */
import {
  checkFilter,
  type FileRef,
  type Filter,
  type Link,
  type NodeRecord,
  type P2PNode,
} from '@minca/core';
import type { FoundPlace } from '@minca/app-shared/places';
import { accent, radius } from '@minca/ui/tokens';
import { UI_GUIDE } from '@minca/ui/guide';
import { shrinkImage } from '../../files';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isObject = isRecord;

/**
 * Collections no screen may use: the space's own, and the launcher's, through
 * which a screen running as someone who may define collections could add apps.
 */
export const offLimits = (name: string): boolean =>
  name.startsWith('sys.') || ['launcher.app', 'std.blueprint', 'std.guide'].includes(name);

/** The largest screen an app may carry, in bytes of UTF-8: it travels with every copy of its record */
export const MAX_SCREEN_BYTES = 48 * 1024;

/** At most this many origins a screen may reach */
const MAX_SCREEN_ORIGINS = 8;

/** `https://api.example.com`, `wss://feed.example.com:8443`: a scheme, a lower-case host, maybe a port; no path, no wildcard */
const SCREEN_ORIGIN =
  /^(https|wss):\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:[0-9]{1,5})?$/;

/**
 * Checks a screen's `network`: why it is wrong, or null.
 * An origin goes straight into the frame's security policy, so only exact
 * origins pass: nothing that could widen it (`*`, `https:`) or break out of it.
 */
export function checkScreenNetwork(network: unknown, hasScreen: boolean): string | null {
  if (network === undefined) return null;
  if (!Array.isArray(network)) return 'network must be a list of origins, like ["https://api.example.com"]';
  if (!hasScreen && network.length) return 'network is where a screen may connect; this app has no screen';
  if (network.length > MAX_SCREEN_ORIGINS) return `network may name at most ${MAX_SCREEN_ORIGINS} origins`;
  for (const origin of network) {
    if (typeof origin !== 'string' || !SCREEN_ORIGIN.test(origin)) {
      return `"${String(origin)}" is not an origin a screen may reach: give https:// or wss:// and a host, lower case, no path, like "https://api.example.com"`;
    }
  }
  if (new Set(network).size !== network.length) return 'network names an origin twice';
  return null;
}

/** What a screen sees of a record */
interface ScreenRecord {
  readonly key: string;
  /** The same as `key` — what a screen written by guessing tends to reach for */
  readonly id: string;
  readonly collection: string;
  readonly body: unknown;
  /** The same as `body` */
  readonly data: unknown;
  /** What its collection's computed fields work out for it, on this device */
  readonly computed: Readonly<Record<string, unknown>>;
  readonly links: ReadonlyArray<Link>;
  /** The account that created it */
  readonly createdBy: string | null;
  /** This version's id, different for every edit: what a record that cites this one names */
  readonly version: string;
  /** 0 for the first version, one more for each edit */
  readonly seq: number;
  /** Its signature, delegation, shape and contract all check out on this device */
  readonly verified: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Whether the person looking created it */
  readonly mine: boolean;
  /** Written under a records-only note: an agent or other program `createdBy`'s account connected */
  readonly viaAgent: boolean;
}

/** How to write a screen, for an agent: part of the guide the launcher writes in the space (`launcher.ts`) */
export const SCREEN_GUIDE = `A screen is one HTML document (scripts and styles inline, at most 48 KB) put on an app's launcher.app record as "screen".
When the app is added, the app shows it instead of plain lists. It runs sealed: no network (no fetch, no
images from URLs, no fonts from URLs), no storage, no popups, and no alert, confirm or prompt (show messages in the page).
Forms work: handle "submit", call event.preventDefault() and save with minca.put; a form never goes anywhere itself.
Keep state in records, never in the page.

If it truly needs the network — weather, a map, a timetable — give the record "network": the exact origins it may
fetch from and load images from, like ["https://api.open-meteo.com"] (https:// or wss://, a host, no path; at most 8).
Nothing else is reachable, and fonts never are. Each origin is named when people review the app, and each person is asked
before a screen they open gets it: a person who says no gets the screen sealed, so it must still work without them.
Ask for no more than it needs.

Inside it, window.minca is:
  minca.me                          { did, name } — who is looking
  minca.collections                 the collection names this screen may use (its app's "collections")
  await minca.list(collection, { where? })   records, oldest first: { key, collection, body, computed, links, createdBy, createdAt, updatedAt, mine, viaAgent,
                                    version, seq, verified }: version is what another record cites to mean exactly this one
                                    where: { "link:<rel>": "<record key>" } for records linking there, { field: value } for a field's value,
                                    a computed field's too; computed holds the values the collection's definition works out, like { done: true }
  await minca.get(key)              one record, or null
  await minca.history(key)          the versions of a record this device can read, newest first; older ones only if its collection keeps history
  await minca.put(collection, body, { links?, key? })   → the record written, as the person looking
  await minca.update(key, body, { links? })             → the next version
  await minca.remove(key)
  await minca.people()              [{ did, name }] — everyone in the space who said their name
  await minca.can(action, collection)   whether the person looking may "create", "edit" or "delete" there
  await minca.picture(did)          the picture someone in the space chose, as a data: URL, or null
  await minca.open({ record: key }) or minca.open({ person: did })   shows it in the app around the screen: a record opens in the
                                    app that shows its collection (a message in the chat), else beside this screen
  await minca.open({ record: key, link: 'about' })   opens what that record links to with that role, of any collection:
                                    the message a file was shared on, say
  minca.shown()                     the key of the record this app was last asked to show, or null; minca.onShow(callback)
                                    calls back with each new one: a record of a collection in "shows", opened from anywhere
  await minca.file(key, ref)        a picture one of these records refers to ({ hash, mime, … } in its body), as a data: URL,
                                    made smaller when it is large; null if it isn't a picture or can't be shown
  await minca.blob(key, ref)        the whole file one of these records refers to, as a Blob of its type: for video, audio,
                                    full-size pictures, or reading and changing the bytes (URL.createObjectURL shows it)
  await minca.addFile(bytes, { name?, mime? })   keeps a file (a Uint8Array, at most 25 MB) in the space: → { hash, size, mime, … },
                                    to put in a record's body, like std.file's "blob"
  await minca.download(key, ref)    saves a file one of these records refers to on the person's device
  await minca.places.search(text, near?)   places matching what was typed: [{ name, detail, street, locality, area, country, lat, lon }]
  await minca.places.here()         where the person is, named, if they let the app know; or null
  await minca.link(url)             opens an http or https page in a new tab; the screen itself can't open one
  await minca.save(name, text, type?)   saves text as a file: text/plain, text/calendar, text/csv or application/json
  await minca.remember(key, value)  keeps something small (8 KB) on this device for this app; null forgets it
  await minca.recall(key)           what was remembered, or null
  minca.onChange(callback)          called whenever records in the space change, here or on another device; returns a function to stop
  await minca.live.send(data, { to? })   sends any JSON (at most 64 KB) to everyone in the space who has this app open now, or only to
                                    to's devices (a did, or a device): kept nowhere, so whoever opens it later misses it. For cursors,
                                    typing, who is here, games. About 15 a second at most: → false when one was dropped for going faster
  minca.live.on(callback)           callback({ from, device, data, viaAgent }) for each one sent here: from is the sender's did, device
                                    the sending device (for "to" when replying); returns a function to stop. Not what this device sent; your other devices' yes

Calls may also take one object instead: minca.list({ collection, where }), minca.put({ collection, body, links, key }),
minca.update({ key, body, links }), minca.remove({ key }). Records answer to id / data as well as key / body.
Every write is checked against the collection's rules, as the person looking: a refused write rejects with the reason.
An error the screen doesn't catch is shown to the person, so they can tell you about it.
Links look like { rel: "game", to: "<record key>" }, with the roles the definition declares.
Draw everything from minca.list(...) and redraw on minca.onChange — other people's moves arrive that way.
Two people can write at once: design collections so that clashes resolve by the rules (onePer, each person changing only their own records), not by the screen.
Anyone can also write records without your screen, and a record whose collection changed keeps its old shape: check a body has what you read before reading it.
No other libraries can be loaded.

${UI_GUIDE}`;

/** The script put in front of a screen's document: `window.minca`, over the port the host page kept for it */
export const SCREEN_CLIENT = `(() => {
  const given = window.__minca;
  delete window.__minca;
  if (!given) return;
  const port = given.port;
  const pending = new Map();
  const listeners = new Set();
  const hearing = new Set();
  const showing = new Set();
  let shown = null;
  let next = 0;
  const call = (method, ...args) =>
    new Promise((resolve, reject) => {
      const id = ++next;
      pending.set(id, { resolve, reject });
      port.postMessage({ id, method, args });
    });
  port.onmessage = (event) => {
    const message = event.data || {};
    if (message.show) {
      shown = message.show;
      for (const listener of showing) {
        try { listener(shown); } catch (error) { console.error(error); }
      }
      return;
    }
    if (message.live) {
      for (const listener of hearing) {
        try { listener(message.live); } catch (error) { console.error(error); }
      }
      return;
    }
    if (message.change) {
      for (const listener of listeners) {
        try { listener(); } catch (error) { console.error(error); }
      }
      return;
    }
    const waiting = pending.get(message.id);
    if (!waiting) return;
    pending.delete(message.id);
    if (message.ok) waiting.resolve(message.value);
    else waiting.reject(new Error(message.error));
  };
  // Shown to the person, so a screen that fails says why instead of sitting blank.
  const report = (message) => {
    let bar = document.getElementById('__minca-error');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = '__minca-error';
      bar.setAttribute('role', 'alert');
      bar.style.cssText = 'position:fixed;left:8px;right:8px;bottom:8px;z-index:2147483647;padding:8px 10px;border-radius:${radius.sm}px;background:${accent.dangerSoft};color:${accent.danger};border:1px solid ${accent.danger};font:12px/1.4 system-ui,sans-serif;white-space:pre-wrap';
      (document.body || document.documentElement).appendChild(bar);
    }
    bar.textContent = 'This screen hit an error: ' + message;
  };
  // Browser extensions inject their own scripts into every frame, this one too, and those
  // fail here (MetaMask can't reach its wallet from a sealed frame). Not the screen's to report.
  // chrome-extension://, moz-extension://, safari-web-extension://
  const fromExtension = (...where) => where.some((text) => typeof text === 'string' && text.includes('-extension://'));
  addEventListener('error', (event) => {
    if (fromExtension(event.filename, event.error && event.error.stack)) return;
    report(event.message || String(event.error));
  });
  addEventListener('unhandledrejection', (event) => {
    if (fromExtension(event.reason && event.reason.stack)) return;
    report(event.reason && event.reason.message ? event.reason.message : String(event.reason));
  });
  // minca.me is who is looking; calling it — minca.me() — gives the same.
  // (defineProperty, because a function's own "name" can't be assigned)
  const me = () => ({ did: given.me.did, name: given.me.name });
  Object.defineProperty(me, 'did', { value: given.me.did, enumerable: true });
  Object.defineProperty(me, 'name', { value: given.me.name, enumerable: true });
  window.minca = Object.freeze({
    me: Object.freeze(me),
    collections: Object.freeze(given.collections.slice()),
    list: (collection, options) => call('list', collection, options || {}),
    get: (key) => call('get', key),
    history: (key) => call('history', key),
    put: (collection, body, options) => call('put', collection, body, options || {}),
    update: (key, body, options) => call('update', key, body, options || {}),
    remove: (key) => call('remove', key),
    people: () => call('people'),
    can: (action, collection) => call('can', action, collection),
    picture: (did) => call('picture', did),
    open: (target) => call('open', target),
    file: (key, ref) => call('file', key, ref),
    blob: (key, ref) => call('blob', key, ref),
    addFile: (bytes, about) => call('addFile', bytes, about || {}),
    download: (key, ref) => call('download', key, ref),
    places: Object.freeze({
      search: (text, near) => call('searchPlaces', text, near),
      here: () => call('here'),
    }),
    link: (url) => call('link', url),
    save: (name, text, type) => call('save', name, text, type),
    recall: (key) => call('recall', key),
    remember: (key, value) => call('remember', key, value),
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    shown: () => shown,
    onShow: (listener) => {
      showing.add(listener);
      return () => showing.delete(listener);
    },
    live: Object.freeze({
      send: (data, options) => call('liveSend', data, options || {}),
      on: (listener) => {
        hearing.add(listener);
        return () => hearing.delete(listener);
      },
    }),
  });
})();`;

/**
 * The security policy a screen runs under: inline scripts and styles, and
 * the network only to `network`'s exact origins — none, unless the person
 * looking agreed to them. A host page's own frame policy may allow more
 * (any `https:`); this one is always written too, and a page under two
 * policies gets only what both allow. Origins that don't check out give none.
 */
export function screenPolicy(network: ReadonlyArray<string> = []): string {
  const origins = checkScreenNetwork(network, true) === null ? network : [];
  const images = origins.filter((origin) => origin.startsWith('https://'));
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    `img-src data: blob:${images.map((origin) => ` ${origin}`).join('')}`,
    `connect-src ${origins.length ? origins.join(' ') : "'none'"}`,
    'font-src data:',
    'media-src data: blob:',
    // What lets hosts allow forms in the frame: a screen's submit handler runs, and nothing is sent.
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ');
}

/**
 * The document a host page writes into its frame: its policy, the client,
 * the kit, then the screen.
 * @param network The origins the person looking agreed to; none keeps it sealed
 * @param ui The kit as one script (`bundleUi` in `@minca/ui/bundle`), which sets up `ui` over `minca`
 */
export function screenDocument(screen: string, network: ReadonlyArray<string> = [], ui = ''): string {
  // The policy first, so it is in force before any script runs; `minca` next, then `ui` on it, so both are there when the screen's run.
  return `<meta http-equiv="Content-Security-Policy" content="${screenPolicy(network)}">\n<script>${SCREEN_CLIENT}</script>\n<script>${ui}</script>\n${screen}`;
}

const toScreen = (
  record: NodeRecord & { readonly computed?: Readonly<Record<string, unknown>> },
  viewer: string,
): ScreenRecord => ({
  key: record.key,
  id: record.key,
  collection: record.collection,
  body: record.body,
  data: record.body,
  computed: record.computed ?? {},
  links: record.links,
  createdBy: record.createdBy,
  version: record.version,
  seq: record.seq,
  verified: record.verified,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
  mine: record.createdBy === viewer,
  viaAgent: record.recordsOnly === true,
});

/** Only plain data crosses into a screen, and only this much of it */
function plain(value: unknown, what: string): unknown {
  const text = JSON.stringify(value ?? null);
  if (text.length > 256 * 1024) throw new Error(`${what} is too large`);
  return JSON.parse(text);
}

/** A field of whatever a screen sent, or undefined when it sent no object */
const fieldOf = (value: unknown, key: string): unknown => (isObject(value) ? value[key] : undefined);

const isLinkLike = (link: unknown): link is Link =>
  isObject(link) && typeof link.rel === 'string' && typeof link.to === 'string';

function linksOf(options: unknown): { links?: ReadonlyArray<Link> } {
  const links = fieldOf(options, 'links');
  if (links === undefined) return {};
  if (!Array.isArray(links)) throw new Error('links must be a list of { rel, to }');
  const list: unknown[] = links;
  if (!list.every(isLinkLike)) throw new Error('links must be a list of { rel, to }');
  return { links: list.map((l) => ({ rel: l.rel, to: l.to })) };
}

/** What a screen may ask the page around it to show */
export type ScreenOpen = { readonly record: NodeRecord } | { readonly person: string };

/**
 * What only the page around a screen can do, done for it when it asks: a
 * sealed frame has no network, no location, no storage, no downloads and no
 * way to open a page. The bridge checks what is asked before the host sees it.
 */
export interface ScreenHost {
  /** Shows a record of the screen's, or a person in the space */
  open(target: ScreenOpen): void;
  /** Places matching what was typed, the nearest first when `near` is given */
  searchPlaces(text: string, near?: { lat: number; lon: number }): Promise<ReadonlyArray<FoundPlace>>;
  /** Where the person is, named, once they let the page know; null when they don't */
  here(): Promise<FoundPlace | null>;
  /** Opens an http or https page in a new tab */
  link(url: string): void;
  /** Saves bytes as a file on the person's device */
  save(name: string, bytes: Uint8Array, type: string): void;
  /** What this app kept on this device under a name, or null */
  recall(key: string): unknown;
  /** Keeps something small on this device for this app; null forgets it */
  remember(key: string, value: unknown): void;
}

/** What a screen may save as a file */
const SAVE_TYPES = new Set(['text/plain', 'text/calendar', 'text/csv', 'application/json']);
const MAX_SAVE = 1024 * 1024;
/** The largest file a screen may add to the space */
const MAX_ADD = 25 * 1024 * 1024;
const MAX_KEPT = 8 * 1024;
/**
 * How fast one screen may send live messages: a burst, then so many a second.
 * Under what a peer takes from another across everything (60, then 20), so a
 * busy screen leaves room for calls and the rest of the app.
 */
const LIVE_BURST = 30;
const LIVE_PER_SECOND = 15;

/** A live message of one app's screens, as it goes between nodes */
const SCREEN_LIVE = 'screen.live';

/** The file a record's body refers to with this hash, if it does */
function fileIn(body: unknown, hash: string): FileRef | null {
  if (Array.isArray(body)) {
    for (const item of body) {
      const found = fileIn(item, hash);
      if (found) return found;
    }
    return null;
  }
  if (!isObject(body)) return null;
  const { size, key, salt, mime, name } = body;
  if (
    body.hash === hash &&
    typeof size === 'number' &&
    typeof key === 'string' &&
    typeof salt === 'string' &&
    typeof mime === 'string'
  )
    return { hash, size, key, salt, mime, ...(typeof name === 'string' ? { name } : {}) };
  for (const value of Object.values(body)) {
    const found = fileIn(value, hash);
    if (found) return found;
  }
  return null;
}

/** Bytes as a data: URL, without anything only a browser has */
function dataUrl(bytes: Uint8Array, mime: string): string {
  let text = '';
  for (let at = 0; at < bytes.length; at += 0x8000)
    text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return `data:${mime};base64,${btoa(text)}`;
}

/** The longest data: URL a picture is handed to a screen as, under the 256 KB an answer may be */
const MAX_PICTURE = 200 * 1024;

/** A picture as a data: URL a screen can be handed, made smaller if it must be; null if it can't be */
async function picture(bytes: Uint8Array, mime: string): Promise<string | null> {
  const whole = dataUrl(bytes, mime);
  if (whole.length <= MAX_PICTURE) return whole;
  if (typeof createImageBitmap !== 'function') return null;
  const blob = new Blob([bytes.slice()], { type: mime });
  for (const side of [1600, 1024, 512, 256]) {
    // An image the browser can't draw, like an SVG or a broken file, isn't shown.
    const small = await shrinkImage(blob, side).catch(() => null);
    if (!small) return null;
    const url = dataUrl(small.bytes, small.mime);
    if (url.length <= MAX_PICTURE) return url;
  }
  return null;
}

export interface ScreenBridge {
  /** Tell the screen that records changed */
  changed(): void;
  /** Ask the screen to show one of its records, opened from elsewhere (`minca.onShow`) */
  show(key: string): void;
  /** Stop answering, and stop listening to the node */
  close(): void;
}

/**
 * Answers a screen's calls over `port`, for one space and these collections,
 * as the node's account. Every write goes through the node like any other,
 * so the collection's rules decide.
 */
export function createScreenBridge(params: {
  readonly node: P2PNode;
  readonly spaceId: string;
  readonly collections: ReadonlyArray<string>;
  /** The app's key: its screens hear only each other's live messages */
  readonly app: string;
  readonly port: MessagePort;
  /** What the page around the screen does for it; without one, the screen can only read and write */
  readonly host?: ScreenHost;
}): ScreenBridge {
  const { node, spaceId, port, app } = params;
  const allowed = new Set(params.collections.filter((name) => !offLimits(name)));
  let closed = false;

  const names = [...allowed].map((name) => `"${name}"`).join(', ');
  const collectionOf = (name: unknown) => {
    if (typeof name !== 'string')
      throw new Error(
        `Name the collection as text, like minca.list("${[...allowed][0] ?? 'app.example.thing'}"). This screen may use ${names}.`,
      );
    if (!allowed.has(name)) throw new Error(`This screen can't use "${name}". It may use ${names}.`);
    return name;
  };
  const ownRecord = async (key: unknown) => {
    if (typeof key !== 'string')
      throw new Error('Name the record by its key, as text: minca.update(record.key, body)');
    const record = await node.records.get(spaceId, key);
    if (!record || !allowed.has(record.collection)) throw new Error(`No record ${key} this screen can use`);
    return record;
  };

  /** `f(a, b)` or `f({ a, b })`: a screen written by guessing may use either */
  const spread = (args: unknown[], keys: ReadonlyArray<string>): Record<string, unknown> => {
    const first = args[0];
    if (isRecord(first) && keys.some((k) => k in first)) {
      return Object.fromEntries(keys.map((k) => [k, first[k]]));
    }
    return Object.fromEntries(keys.map((k, i) => [k, args[i]]));
  };
  const hosted = (): ScreenHost => {
    if (!params.host) throw new Error('This screen runs where the page around it does nothing for it');
    return params.host;
  };
  const keptKey = (key: unknown): string => {
    if (typeof key !== 'string' || !key || key.length > 100)
      throw new Error('Name what is remembered as text, like minca.remember("near", value)');
    return key;
  };

  let tokens = LIVE_BURST;
  let filled = Date.now();
  /** Whether one more live message fits in this screen's allowance, taking it if so */
  const mayGoLive = () => {
    const now = Date.now();
    tokens = Math.min(LIVE_BURST, tokens + ((now - filled) / 1000) * LIVE_PER_SECOND);
    filled = now;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };

  /** A screen's `where`, as a query takes it; anything else is a mistake to tell the screen about */
  const isFilter = (where: unknown): where is Filter => checkFilter(where) === null;

  const methods: Record<string, (...args: unknown[]) => Promise<unknown>> = {
    list: async (...args) => {
      const first = args[0];
      const { collection, where } = isObject(first)
        ? { collection: first.collection, where: first.where }
        : { collection: first, where: fieldOf(args[1], 'where') };
      if (where !== undefined && !isFilter(where))
        throw new Error(`minca.list: ${checkFilter(where, 'where')}`);
      const { records } = await node.records.query(spaceId, {
        collection: collectionOf(collection),
        ...(where !== undefined ? { where } : {}),
      });
      return records.map((record) => toScreen(record, node.did));
    },
    get: async (...args) => {
      const { key } = spread(args, ['key']);
      try {
        return toScreen(await ownRecord(key), node.did);
      } catch {
        return null;
      }
    },
    put: async (...args) => {
      const first = args[0];
      const [collection, body, options] =
        isObject(first) && 'collection' in first
          ? [first.collection, first.body, { links: first.links, key: first.key }]
          : args;
      const key = fieldOf(options, 'key');
      if (key !== undefined && typeof key !== 'string') throw new Error('key must be text');
      const record = await node.records.put(spaceId, collectionOf(collection), plain(body, 'The record'), {
        ...linksOf(options),
        ...(key !== undefined ? { key } : {}),
      });
      return toScreen(record, node.did);
    },
    update: async (...args) => {
      const first = args[0];
      const [key, body, options] =
        isObject(first) && 'key' in first ? [first.key, first.body, { links: first.links }] : args;
      const record = await ownRecord(key);
      return toScreen(
        await node.records.update(spaceId, record.key, plain(body, 'The record'), linksOf(options)),
        node.did,
      );
    },
    remove: async (...args) => {
      const { key } = spread(args, ['key']);
      const record = await ownRecord(key);
      await node.records.delete(spaceId, record.key);
      return null;
    },
    history: async (...args) => {
      const { key } = spread(args, ['key']);
      const record = await ownRecord(key);
      return (await node.records.history(spaceId, record.key)).map((one) => toScreen(one, node.did));
    },
    people: async () =>
      (await node.spaces.profiles(spaceId)).map((profile) => ({ did: profile.did, name: profile.name })),
    can: async (...args) => {
      const { action, collection } = spread(args, ['action', 'collection']);
      if (action !== 'create' && action !== 'edit' && action !== 'delete')
        throw new Error('minca.can takes "create", "edit" or "delete", then a collection');
      return node.records.can(spaceId, action, collectionOf(collection));
    },
    // Only someone in this space, so a screen learns nothing the person looking couldn't see here.
    picture: async (...args) => {
      const { did } = spread(args, ['did']);
      const ref = (await node.spaces.profiles(spaceId)).find((profile) => profile.did === did)?.avatar;
      if (!ref?.mime.startsWith('image/')) return null;
      return dataUrl(await node.records.readFile(spaceId, ref), ref.mime);
    },
    open: async (...args) => {
      const first = args[0];
      const host = hosted();
      if (isObject(first) && 'record' in first) {
        const record = await ownRecord(first.record);
        const { link } = first;
        if (link === undefined) {
          host.open({ record });
          return null;
        }
        // What the app's own record points to, shown by the page; never the space's own records. The answer is
        // the same whether or not it is here, though the page visibly opens one that is.
        if (typeof link !== 'string') throw new Error('link names a link role, like "about"');
        const to = record.links.find((l) => l.rel === link)?.to;
        const target = to ? await node.records.get(spaceId, to) : null;
        if (target && !offLimits(target.collection)) host.open({ record: target });
        return null;
      }
      const did = fieldOf(first, 'person');
      if (typeof did !== 'string' || !(await node.spaces.profiles(spaceId)).some((p) => p.did === did))
        throw new Error('minca.open takes { record: key } or { person: did }, of someone in this space');
      host.open({ person: did });
      return null;
    },
    // Only a picture a record of this app's points to, read from the record rather than taken on the screen's word.
    file: async (...args) => {
      const { key, ref } = spread(args, ['key', 'ref']);
      const hash = typeof ref === 'string' ? ref : fieldOf(ref, 'hash');
      if (typeof hash !== 'string')
        throw new Error('minca.file takes a record key and the file it refers to');
      const file = fileIn((await ownRecord(key)).body, hash);
      if (!file) throw new Error(`Record ${String(key)} refers to no such file`);
      if (!file.mime.startsWith('image/')) return null;
      return picture(await node.records.readFile(spaceId, file), file.mime);
    },
    // The whole file, from the record rather than on the screen's word; a Blob crosses the port without JSON.
    blob: async (...args) => {
      const { key, ref } = spread(args, ['key', 'ref']);
      const hash = typeof ref === 'string' ? ref : fieldOf(ref, 'hash');
      if (typeof hash !== 'string')
        throw new Error('minca.blob takes a record key and the file it refers to');
      const file = fileIn((await ownRecord(key)).body, hash);
      if (!file) throw new Error(`Record ${String(key)} refers to no such file`);
      return new Blob([(await node.records.readFile(spaceId, file)).slice()], { type: file.mime });
    },
    // A file's bytes, kept in the space as the person looking; a record of the app's then refers to it.
    addFile: async (...args) => {
      const [bytes, about] = args;
      if (!(bytes instanceof Uint8Array)) throw new Error('minca.addFile takes the bytes, as a Uint8Array');
      if (bytes.length > MAX_ADD) throw new Error(`A file may be at most ${MAX_ADD / 1024 / 1024} MB`);
      const mime = fieldOf(about, 'mime') ?? 'application/octet-stream';
      const name = fieldOf(about, 'name');
      if (typeof mime !== 'string' || mime.length > 100)
        throw new Error('mime must be a media type, like "image/png"');
      if (name !== undefined && (typeof name !== 'string' || name.length > 200))
        throw new Error('name must be text, at most 200 characters');
      return node.records.addFile(spaceId, bytes, { mime, ...(name ? { name } : {}) });
    },
    download: async (...args) => {
      const { key, ref } = spread(args, ['key', 'ref']);
      const hash = typeof ref === 'string' ? ref : fieldOf(ref, 'hash');
      if (typeof hash !== 'string')
        throw new Error('minca.download takes a record key and the file it refers to');
      const record = await ownRecord(key);
      const file = fileIn(record.body, hash);
      if (!file) throw new Error(`Record ${String(key)} refers to no such file`);
      const named = fieldOf(record.body, 'name');
      const name = file.name ?? (typeof named === 'string' ? named : 'file');
      hosted().save(name.replace(/[/\\]/g, '_'), await node.records.readFile(spaceId, file), file.mime);
      return null;
    },
    liveSend: async (...args) => {
      const [data, options] = args;
      const to = fieldOf(options, 'to');
      if (to !== undefined && (typeof to !== 'string' || !to.startsWith('did:')))
        throw new Error('minca.live.send sends to everyone, or { to: did } of a person or a device');
      const message = { type: SCREEN_LIVE, app, data: plain(data, 'A live message') };
      if (!mayGoLive()) return false;
      await node.spaces.send(spaceId, message, to);
      return true;
    },
    searchPlaces: async (...args) => {
      const [text, near] = args;
      if (typeof text !== 'string' || text.length > 200)
        throw new Error('minca.places.search takes what was typed, as text');
      const lat = fieldOf(near, 'lat');
      const lon = fieldOf(near, 'lon');
      const point = typeof lat === 'number' && typeof lon === 'number' ? { lat, lon } : undefined;
      return hosted().searchPlaces(text, point);
    },
    here: async () => hosted().here(),
    link: async (...args) => {
      const [url] = args;
      const parsed = typeof url === 'string' && URL.canParse(url) ? new URL(url) : null;
      if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:'))
        throw new Error('minca.link opens an http or https address');
      hosted().link(parsed.href);
      return null;
    },
    save: async (...args) => {
      const [name, text, type = 'text/plain'] = args;
      if (typeof name !== 'string' || !name.trim() || name.length > 120 || /[/\\]/.test(name))
        throw new Error('minca.save takes a file name, like "trip.ics"');
      if (typeof text !== 'string' || text.length > MAX_SAVE)
        throw new Error('minca.save saves text, up to 1 MB');
      if (typeof type !== 'string' || !SAVE_TYPES.has(type))
        throw new Error(`minca.save saves ${[...SAVE_TYPES].join(', ')}`);
      hosted().save(name.trim(), new TextEncoder().encode(text), type);
      return null;
    },
    recall: async (...args) => hosted().recall(keptKey(args[0])) ?? null,
    remember: async (...args) => {
      const [key, value] = args;
      const kept = plain(value ?? null, 'What is remembered');
      if (JSON.stringify(kept).length > MAX_KEPT) throw new Error('minca.remember keeps at most 8 KB');
      hosted().remember(keptKey(key), kept);
      return null;
    },
  };

  port.onmessage = (event: MessageEvent) => {
    if (closed) return;
    const message: unknown = event.data;
    if (
      !isObject(message) ||
      typeof message.id !== 'number' ||
      typeof message.method !== 'string' ||
      !Object.hasOwn(methods, message.method)
    )
      return;
    const { id } = message;
    const args: unknown[] = Array.isArray(message.args) ? message.args : [];
    methods[message.method]!(...args).then(
      (value) =>
        !closed &&
        port.postMessage({ id, ok: true, value: value instanceof Blob ? value : plain(value, 'The answer') }),
      (error: unknown) =>
        !closed &&
        port.postMessage({
          id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
    );
  };

  // Changes arrive in bursts while syncing; one nudge per burst is enough.
  let soon: ReturnType<typeof setTimeout> | null = null;
  const changed = () => {
    if (closed || soon) return;
    soon = setTimeout(() => {
      soon = null;
      if (!closed) port.postMessage({ change: true });
    }, 50);
  };
  const stop = node.subscribe((event) => {
    if (event.type === 'records' && event.space === spaceId) changed();
    // Only another app's screen, or a peer with no account, is not passed on.
    if (event.type !== 'message' || event.space !== spaceId || closed || !event.from) return;
    const { message } = event;
    if (!isObject(message) || message.type !== SCREEN_LIVE || message.app !== app) return;
    port.postMessage({
      live: { from: event.from, device: event.peer, data: message.data ?? null, viaAgent: event.recordsOnly },
    });
  });

  return {
    changed,
    show(key) {
      if (!closed) port.postMessage({ show: key });
    },
    close() {
      closed = true;
      if (soon) clearTimeout(soon);
      stop();
      port.close();
    },
  };
}
