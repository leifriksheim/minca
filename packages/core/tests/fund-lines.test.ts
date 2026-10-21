/**
 * What a device takes of the words a host gives its fund (spec 08 §2): short
 * lines for people, and a usual reply cost it can count with, or nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeHost, fundLines } from '../src/session/hosting.js';

test('a device takes only well-formed fund lines, eight at most, and ignores the rest', () => {
  const model = { for: 'bots', name: 'Claude Sonnet 5.5', price: '$3 / $15 per million tokens' };
  assert.deepEqual(
    fundLines([
      model,
      { for: 'Bots', name: 'Upper case', price: '$1' },
      { for: 'bots', name: '', price: '$1' },
      { for: 'bots', name: 'n'.repeat(61), price: '$1' },
      { for: 'bots', name: 'No price' },
      { for: 'bots', name: 'A number', price: 3 },
      'bots',
      null,
    ]),
    [model],
  );
  assert.equal(fundLines(Array.from({ length: 12 }, () => model)).length, 8);
  assert.deepEqual(fundLines(model), [], 'a list, not one');
  assert.deepEqual(fundLines(undefined), []);
});

test('a host whose fund words are badly formed still stands, without them', async () => {
  const fund = { perGb: '0.10', min: '5', methods: ['checkout'], recurring: true };
  const answer = (described: unknown) => async () =>
    new Response(
      JSON.stringify({ minca: 'host/1', did: 'did:key:zDnae', name: 'Host', free: false, fund: described }),
    );
  const original = globalThis.fetch;
  try {
    globalThis.fetch = answer({
      ...fund,
      botTypical: '0.038',
      lines: [{ for: 'bots', name: 'M', price: '$1' }],
    });
    assert.deepEqual((await describeHost('https://host.example')).fund, {
      ...fund,
      botTypical: '0.038',
      lines: [{ for: 'bots', name: 'M', price: '$1' }],
    });
    globalThis.fetch = answer({ ...fund, botTypical: 'cheap', lines: 'all of it' });
    assert.deepEqual((await describeHost('https://host.example')).fund, fund);
    globalThis.fetch = answer('a fund');
    assert.equal((await describeHost('https://host.example')).fund, undefined);
  } finally {
    globalThis.fetch = original;
  }
});
