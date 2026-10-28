/**
 * Which kind of field a schema is, for the builders: a person is a string
 * labelled `format: "did"`, however its description reads.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fragments } from '@minca/core/schemas';

import { fieldTypeOf } from '../src/derive/field-types';
import { clauseFields } from '../src/derive/conditions';

test('a person is a string labelled format "did", by the fragment or by hand', () => {
  assert.equal(fieldTypeOf(fragments.person('Who is playing black')), 'person');
  assert.equal(fieldTypeOf(fragments.people(8)), 'people');
  assert.equal(fieldTypeOf({ type: 'string', format: 'did', description: 'The opponent' }), 'person');
  // Without the label it is text, whatever its description says.
  assert.equal(
    fieldTypeOf({ type: 'string', minLength: 1, maxLength: 256, description: 'An account DID' }),
    'text',
  );
});

test('a condition on a person field picks from people', () => {
  const [opponent] = clauseFields({
    schema: { type: 'object', properties: { opponent: { type: 'string', format: 'did' } } },
    topics: [],
  });
  assert.equal(opponent?.kind, 'person');
});
