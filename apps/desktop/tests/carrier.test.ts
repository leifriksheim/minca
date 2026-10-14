/**
 * The carrier's side in the desktop: its key and origin, the folder it keeps
 * them in, and connecting through a window the shell opens.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { carrierFolder, carrierKey, connectThroughShell } from '../src/bun/carrier.ts';
import type { ShellWindow } from '../src/bun/bridge.ts';

const folder = async () => join(await mkdtemp(join(tmpdir(), 'minca-carrier-')), 'carrier');

test('its key is kept, and so is the origin it asks from, which is its own: not the app’s, not another install’s', async () => {
  const one = await folder();
  const first = await carrierKey(one);
  const again = await carrierKey(one);
  assert.equal(again.did, first.did);
  assert.equal(again.origin, first.origin);
  assert.match(first.origin, /^http:\/\/carrier-[0-9a-f]{20}\.localhost$/);
  assert.notEqual(first.origin, 'http://127.0.0.1:47830');
  const other = await carrierKey(await folder());
  assert.notEqual(other.origin, first.origin);
  assert.notEqual(other.did, first.did);
});

test('the folder must be a full path, and its key file this user’s own, not a link', async () => {
  await assert.rejects(carrierFolder('carrier'), /full path/);

  const linked = await folder();
  await carrierFolder(linked);
  const elsewhere = join(await mkdtemp(join(tmpdir(), 'minca-elsewhere-')), 'seed');
  await writeFile(elsewhere, `${Buffer.alloc(32, 1).toString('base64url')}\n`, { mode: 0o600 });
  await symlink(elsewhere, join(linked, 'carrier-key'));
  await assert.rejects(carrierKey(linked), /not this user's own file/);

  const open = await folder();
  await carrierFolder(open);
  await chmod(open, 0o755);
  await assert.rejects(carrierKey(open), /not this user's own directory/);
});

test('connecting opens the home at once, from the carrier’s origin, asks for carrying, and puts the page globals back', async () => {
  // A page has these; the shell's worker gets them for the call.
  const events = new EventTarget();
  Object.assign(globalThis, {
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
  });
  const key = await carrierKey(await folder());
  const posted: unknown[] = [];
  const heard: { from: ((event: { data: unknown; origin: string }) => void) | null } = { from: null };
  let closed = false;
  const opened: Array<{ url: string; origin: string }> = [];
  const home: ShellWindow = {
    get closed() {
      return closed;
    },
    postMessage: (data) => posted.push(data),
    close: () => {
      closed = true;
    },
  };
  const before = Reflect.get(globalThis, 'open');
  const connecting = connectThroughShell({
    home: 'https://home.example/connect',
    key,
    openHome: (url, origin, listen) => {
      opened.push({ url, origin });
      heard.from = listen;
      return home;
    },
  });
  // Before any await: the window is open, and the globals are back.
  assert.deepEqual(opened, [{ url: 'https://home.example/connect', origin: key.origin }]);
  assert.equal(Reflect.get(globalThis, 'open'), before);

  const said = heard.from;
  assert.ok(said);
  said({ data: { type: 'minca:hello' }, origin: 'https://home.example' });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const request: unknown = Reflect.get(Object(posted[0]), 'request');
  assert.equal(Reflect.get(Object(posted[0]), 'type'), 'minca:request');
  assert.equal(Reflect.get(Object(request), 'access'), 'carry');
  assert.equal(Reflect.get(Object(request), 'audience'), key.did);

  // The person closes the home's window without answering.
  closed = true;
  await assert.rejects(connecting, /closed/);
});
