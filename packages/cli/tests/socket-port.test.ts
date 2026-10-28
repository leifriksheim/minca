/** A local socket as a message port: what a node's calls hold crosses it whole, and a process going away fails what waits */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, connect, type Socket } from 'node:net';
import path from 'node:path';
import { remoteNode } from '@minca/core';
import { decodeMessage, encodeMessage, socketPort } from '../src/socket-port.js';
import { tempDir } from './helpers/nodes.js';

test('bytes, a missing argument and an object that looks like a tag come back as they went', () => {
  const message = {
    args: ['space', undefined, new Uint8Array([0, 255]), Buffer.from([7, 8])],
    body: { $minca: 'bytes', base64: 'AAE=', nested: { $minca: 'undefined' } },
  };
  const back = decodeMessage(encodeMessage(message));
  assert.deepEqual(back, {
    args: ['space', undefined, new Uint8Array([0, 255]), new Uint8Array([7, 8])],
    body: { $minca: 'bytes', base64: 'AAE=', nested: { $minca: 'undefined' } },
  });
  assert.ok(!encodeMessage(message).includes('\n'), 'one message, one line');
});

test('a line that never ends drops the connection', async () => {
  const at = path.join(await tempDir(), 'socket');
  const closed = new Promise<void>((resolve) => {
    const server = createServer((socket: Socket) => {
      socketPort(socket);
      socket.once('close', () => {
        server.close();
        resolve();
      });
    });
    server.listen(at, () => {
      const socket = connect(at);
      socket.on('error', () => {});
      // 70 MB with no newline, a megabyte at a time.
      const chunk = 'x'.repeat(2 ** 20);
      for (let sent = 0; sent < 70; sent += 1) socket.write(chunk);
    });
  });
  await closed;
});

test('a node asked across a socket that closes says so, rather than waiting for ever', async () => {
  const at = path.join(await tempDir(), 'socket');
  // A process that takes the call and goes away without answering.
  const server = createServer((socket: Socket) => socket.once('data', () => socket.destroy()));
  await new Promise<void>((resolve) => server.listen(at, resolve));
  try {
    const socket = connect(at);
    await new Promise((resolve) => socket.once('connect', resolve));
    await assert.rejects(remoteNode(socketPort(socket)), /went away/);
  } finally {
    server.close();
  }
});
