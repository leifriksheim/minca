/**
 * What a device takes of the connectors a host describes (spec 08 §3.1): an
 * id it can put in an address and a record, and a name for people.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectorOffers } from '../src/session/hosting.js';

test('a device takes only well-formed connectors from a host’s description, and ignores the rest', () => {
  assert.deepEqual(
    connectorOffers([
      { id: 'github', name: 'GitHub' },
      { id: 'google-calendar', name: 'Google Calendar' },
      { id: 'Notion', name: 'Notion' },
      { id: '../bots', name: 'Path' },
      { id: 'x'.repeat(41), name: 'Too long' },
      { id: 'drive', name: '' },
      { id: 'drive', name: 'n'.repeat(61) },
      { id: 'drive', name: '\u202eevirD' },
      { id: 'drive' },
      'github',
      null,
    ]),
    [
      { id: 'github', name: 'GitHub' },
      { id: 'google-calendar', name: 'Google Calendar' },
    ],
  );
  assert.deepEqual(connectorOffers(undefined), []);
  assert.deepEqual(connectorOffers({ id: 'github', name: 'GitHub' }), [], 'a list, not one');
});
