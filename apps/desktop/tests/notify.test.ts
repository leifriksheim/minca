import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNotifier, kindOf, type Shown } from '../src/bun/notify.ts';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const at = new Date(0).toISOString();

test('a collection reads as the kind of thing it holds', () => {
  assert.equal(kindOf('app.chat.message'), 'message');
  assert.equal(kindOf('std.kanban.card_moved'), 'card moved');
  assert.equal(kindOf('app.rota.shiftSwap'), 'shift swap');
});

test('one record is one notification, saying where and what kind, nothing of what it says', async () => {
  const shown: Shown[] = [];
  const notifier = createNotifier({ show: (it) => shown.push(it), gatherMs: 20 });
  notifier.woke({ space: 'Book club', collection: 'app.chat.message', at });
  await wait(40);
  assert.deepEqual(shown, [{ title: 'Book club', body: 'New message' }]);
});

test('a burst in one space is one notification; another space has its own', async () => {
  const shown: Shown[] = [];
  const notifier = createNotifier({ show: (it) => shown.push(it), gatherMs: 20 });
  for (let i = 0; i < 5; i++) notifier.woke({ space: 'Team', collection: 'app.chat.message', at });
  notifier.woke({ space: 'Team', collection: 'std.poll.vote', at });
  notifier.woke({ space: 'Family', collection: 'app.chat.message', at });
  await wait(40);
  assert.deepEqual(shown, [
    { title: 'Team', body: '6 new things' },
    { title: 'Family', body: 'New message' },
  ]);

  shown.length = 0;
  notifier.woke({ space: 'Team', collection: 'app.chat.message', at });
  notifier.woke({ space: 'Team', collection: 'app.chat.message', at });
  await wait(40);
  assert.deepEqual(shown, [{ title: 'Team', body: '2 new messages' }]);
});
