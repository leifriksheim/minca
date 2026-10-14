/**
 * What the menu bar says about the app's connection: calm while it lasts,
 * a renewal in its last two days, and plain words once it has run out.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectionMenu, reminderAt, whenEnds } from '../src/bun/menu.ts';
import type { AppNodeState } from '../src/bun/app-node.ts';

const HOUR = 3600_000;
const DAY = 24 * HOUR;
// A Tuesday, 14 October 2026, at 10:00 local time.
const now = new Date(2026, 9, 14, 10, 0).getTime();

const ready = (endsIn: number): AppNodeState => ({
  status: 'ready',
  home: 'https://home.example/connect',
  grant: { did: 'did:key:z', name: 'Ada', expiresAt: Math.floor((now + endsIn) / 1000) },
  error: null,
  session: 1,
});

const labels = (state: AppNodeState) => connectionMenu(state, now, 'en-GB').lines.map((line) => line.label);

test('far off, it shows a date and asks for nothing', () => {
  const menu = connectionMenu(ready(30 * DAY), now, 'en-GB');
  assert.deepEqual(
    menu.lines.map((line) => line.label),
    ['Ada', 'Automations on', 'Connected until Fri 13 Nov'],
  );
  assert.equal(menu.attention, false);
  assert.ok(menu.lines.every((line) => !line.action));
});

test('in its last two days, it says when in words and offers to renew', () => {
  const menu = connectionMenu(ready(DAY + 2 * HOUR), now, 'en-GB');
  assert.deepEqual(
    menu.lines.map((line) => line.label),
    ['Ada', 'Automations on', 'Connection ends tomorrow', 'Renew connection…'],
  );
  assert.equal(menu.lines.at(-1)?.action, 'renew');
  assert.equal(menu.attention, true);
});

test('how soon reads as people say it', () => {
  assert.equal(whenEnds(now + 20 * 60_000, now), 'within the hour');
  assert.equal(whenEnds(now + 3 * HOUR, now), 'in 3 hours');
  assert.equal(whenEnds(now + 8 * HOUR, now, 'en-GB'), 'today at 18:00');
  assert.equal(whenEnds(now + DAY, now), 'tomorrow');
  assert.equal(whenEnds(now + 2 * DAY, now, 'en-GB'), 'on Friday');
});

test('once it has run out, it says what stopped and how to start it again, never why', () => {
  const menu = connectionMenu({ ...ready(-HOUR), status: 'expired' }, now);
  assert.deepEqual(
    menu.lines.map((line) => line.label),
    ['Ada', 'Paused: automations are off until you reconnect', 'Reconnect…'],
  );
  assert.equal(menu.attention, true);
  assert.ok(
    !labels({ ...ready(-HOUR), status: 'expired' }).some((label) => /note|token|grant|expire/i.test(label)),
  );
});

test('it reminds once a day before the end, or at once when that is already past', () => {
  assert.equal(reminderAt(ready(30 * DAY), now), now + 29 * DAY);
  assert.equal(reminderAt(ready(5 * HOUR), now), now);
  assert.equal(reminderAt({ ...ready(-HOUR), status: 'expired' }, now), null);
});
