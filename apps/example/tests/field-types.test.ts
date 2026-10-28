/**
 * Which kind of field a schema is, for the builders and the forms: what its
 * `x-kind` says, never a guess from its lengths or description.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fragments } from '@minca/core/schemas';

import { fieldTypeOf } from '../src/derive/field-types';
import { clauseFields } from '../src/derive/conditions';
import { columnsOf, emptyValue, fieldsOf } from '../src/derive/schema-ui';
import { fileRefOf, moneyText, safeHref, whenText } from '../src/derive/kinds';

test('a person is a string labelled x-kind "did", by the fragment or by hand', () => {
  assert.equal(fieldTypeOf(fragments.person('Who is playing black')), 'person');
  assert.equal(fieldTypeOf(fragments.people(8)), 'people');
  assert.equal(fieldTypeOf({ type: 'string', 'x-kind': 'did', description: 'The opponent' }), 'person');
  // Without the label it is text, whatever its description says.
  assert.equal(
    fieldTypeOf({ type: 'string', minLength: 1, maxLength: 256, description: 'An account DID' }),
    'text',
  );
});

test('a condition on a person field picks from people', () => {
  const [opponent] = clauseFields({
    schema: { type: 'object', properties: { opponent: { type: 'string', 'x-kind': 'did' } } },
    topics: [],
  });
  assert.equal(opponent?.kind, 'person');
});

test('each fragment is the type its x-kind says, and lengths alone say nothing', () => {
  assert.equal(fieldTypeOf(fragments.when()), 'date');
  assert.equal(fieldTypeOf(fragments.day()), 'date');
  assert.equal(fieldTypeOf(fragments.url()), 'web link');
  assert.equal(fieldTypeOf(fragments.money()), 'money');
  assert.equal(fieldTypeOf(fragments.blob()), 'file');
  assert.equal(fieldTypeOf(fragments.image()), 'picture');
  assert.equal(fieldTypeOf({ type: 'string', minLength: 10, maxLength: 64 }), 'text');
  assert.equal(fieldTypeOf({ type: 'string', maxLength: 2048 }), 'long text');
});

test('a position is never shown, money is a column, and a labelled field starts empty', () => {
  const schema = {
    type: 'object',
    properties: { text: { type: 'string' }, price: fragments.money(), position: fragments.position() },
  };
  assert.deepEqual(
    fieldsOf(schema).map((f) => f.name),
    ['text', 'price'],
  );
  assert.deepEqual(
    columnsOf(schema).map((f) => f.name),
    ['text', 'price'],
  );
  const price = fieldsOf(schema).find((f) => f.name === 'price');
  assert.equal(price && emptyValue(price), undefined);
});

test('values read by their kind: a time, money, a safe link, a file', () => {
  assert.match(whenText('2026-10-12') ?? '', /2026/);
  assert.doesNotMatch(whenText('2026-10-12') ?? '', /:/);
  assert.match(whenText('2026-10-12T19:00:00+02:00') ?? '', /:/);
  assert.equal(whenText('friday'), null);

  assert.match(moneyText({ amount: '12.50', currency: 'EUR' }) ?? '', /12[.,]50/);
  assert.equal(moneyText({ amount: '12.50', currency: 'XYZW' }), '12.50 XYZW');
  assert.equal(moneyText({ amount: 12.5, currency: 'EUR' }), null);

  assert.equal(safeHref('https://minca.social/a'), 'https://minca.social/a');
  assert.equal(safeHref('javascript:alert(1)'), null);
  assert.equal(safeHref('not a url'), null);

  const ref = { hash: 'a'.repeat(64), size: 3, key: 'k', salt: 's', mime: 'text/plain', name: 'a.txt' };
  assert.deepEqual(fileRefOf(ref), ref);
  assert.equal(fileRefOf({ hash: 'a', size: 3 }), null);
});
