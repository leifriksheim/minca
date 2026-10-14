import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNodeLink, NODE_PATH, nodeUrl, type LinkSocket } from '../src/bun/node-link.ts';

const APP = 'http://127.0.0.1:47830';
const TOKEN = 'ab'.repeat(32);

function setup() {
  const tokens = new Set([TOKEN]);
  const toNode: unknown[] = [];
  const link = createNodeLink({
    origin: APP,
    isToken: (token) => tokens.has(token),
    fromWindow: (message) => toNode.push(message),
  });
  const socket = (token = TOKEN) => {
    const sent: string[] = [];
    const s: LinkSocket & { sent: string[]; closedWith: number | null } = {
      data: { token },
      sent,
      closedWith: null,
      send: (text) => sent.push(text),
      close: (code) => {
        s.closedWith = code ?? 1005;
      },
    };
    return s;
  };
  return { link, tokens, toNode, socket };
}

/** A request to open the socket, as Bun's server gets it */
const asked = (url: string, origin: string | null) =>
  new Request(url.replace(/^ws/, 'http'), origin ? { headers: { origin } } : {});

test('the socket’s address is the app’s origin, as ws, with the token', () => {
  assert.equal(nodeUrl(APP, TOKEN), `ws://127.0.0.1:47830${NODE_PATH}?t=${TOKEN}`);
  assert.equal(nodeUrl('https://app.example', TOKEN), `wss://app.example${NODE_PATH}?t=${TOKEN}`);
});

test('only a page at the app’s origin, with its window’s token, opens the socket', () => {
  const { link, tokens } = setup();
  const url = nodeUrl(APP, TOKEN);
  assert.equal(link.accept(asked(url, APP)), TOKEN);
  // Another web page trying the loopback port, or a program that sends no origin.
  assert.equal(link.accept(asked(url, 'https://evil.example')), null);
  assert.equal(link.accept(asked(url, 'http://localhost:47830')), null);
  assert.equal(link.accept(asked(url, null)), null);
  // The right origin, with no token, another token, or at another path.
  assert.equal(link.accept(asked(`ws://127.0.0.1:47830${NODE_PATH}`, APP)), null);
  assert.equal(link.accept(asked(nodeUrl(APP, 'cd'.repeat(32)), APP)), null);
  assert.equal(link.accept(asked(`${APP}/app?t=${TOKEN}`, APP)), null);
  // Its window closed.
  tokens.clear();
  assert.equal(link.accept(asked(url, APP)), null);
});

test('one socket at a time: a new one takes the last one’s place, which says nothing more', () => {
  const { link, toNode, socket } = setup();
  const first = socket();
  link.opened(first);
  link.message(first, '{"kind":"attach"}');
  const second = socket();
  link.opened(second);
  assert.equal(first.closedWith, 1000);
  link.message(first, '{"kind":"disconnect"}');
  link.message(second, new TextEncoder().encode('{"kind":"attach"}'));
  assert.deepEqual(toNode, [{ kind: 'attach' }, { kind: 'attach' }]);
  // What the node says goes to the one that is open.
  link.closed(first);
  link.toWindow({ kind: 'state' });
  assert.deepEqual(first.sent, []);
  assert.deepEqual(second.sent, ['{"kind":"state"}']);
});

test('once the window closes, the socket neither hears the node nor reaches it', () => {
  const { link, tokens, toNode, socket } = setup();
  const open = socket();
  link.opened(open);
  tokens.clear();
  link.toWindow({ kind: 'state' });
  link.message(open, '{"kind":"disconnect"}');
  assert.deepEqual(open.sent, []);
  assert.deepEqual(toNode, []);
  assert.equal(open.closedWith, 1008);
});

test('what isn’t JSON is dropped', () => {
  const { link, toNode, socket } = setup();
  const open = socket();
  link.opened(open);
  link.message(open, 'not json');
  assert.deepEqual(toNode, []);
  assert.equal(open.closedWith, null);
});
