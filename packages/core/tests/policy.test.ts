/**
 * UCAN 1.0's policy language (spec 01 §7.4), checked against the UCAN
 * working group's own fixtures, and the corners those leave open.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { evaluatePolicy, globMatch, parseSelector, policyProblem, select } from '../src/identity/policy.js';

interface Fixture {
  readonly args: unknown;
  readonly policies: ReadonlyArray<unknown>;
}
const text = readFileSync(new URL('./vectors/ucan-policy.json', import.meta.url), 'utf8');
// eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- a checked-in fixture file
const fixtures = JSON.parse(text) as { valid: Fixture[]; invalid: Fixture[] };

describe('the UCAN 1.0 fixtures (fixtures/1.0.0/policy.json)', () => {
  test('every valid policy holds for its args', () => {
    let count = 0;
    for (const { args, policies } of fixtures.valid)
      for (const policy of policies) {
        assert.equal(policyProblem(policy), null, JSON.stringify(policy));
        assert.equal(evaluatePolicy(policy, args), true, JSON.stringify(policy));
        count++;
      }
    assert.equal(count, 17, 'every valid policy in the file');
  });

  test('no invalid policy holds for its args', () => {
    let count = 0;
    for (const { args, policies } of fixtures.invalid)
      for (const policy of policies) {
        assert.equal(policyProblem(policy), null, JSON.stringify(policy));
        assert.equal(evaluatePolicy(policy, args), false, JSON.stringify(policy));
        count++;
      }
    assert.equal(count, 8, 'every invalid policy in the file');
  });
});

describe('selectors', () => {
  const args = {
    from: 'alice@example.com',
    to: ['bob@example.com', 'carol@not.example.com', 'dan@example.com'],
    cc: ['fraud@example.com'],
    title: 'Meeting Confirmation',
    'odd key': { '.': 1 },
    nested: { a: [{ b: 1 }, { b: 2 }] },
  };
  const found = (selector: string) => {
    const picked = select(selector, args);
    return picked.found ? picked.value : 'NOTHING';
  };

  test('the examples of the delegation spec', () => {
    assert.deepEqual(found('.'), args);
    assert.equal(found('.title'), 'Meeting Confirmation');
    assert.deepEqual(found('.cc'), ['fraud@example.com']);
    assert.equal(found('.to[1]'), 'carol@not.example.com');
    assert.equal(found('.to[-1]'), 'dan@example.com');
    assert.equal(found('.to[99]?'), null);
    assert.equal(found('.to[99]'), 'NOTHING');
  });

  test('quoted names, slices, collection values and optionals', () => {
    assert.deepEqual(found('.["odd key"]'), { '.': 1 });
    assert.equal(found('.["odd key"]["."]'), 1);
    assert.deepEqual(found('.to[0:2]'), ['bob@example.com', 'carol@not.example.com']);
    assert.deepEqual(found('.to[1:]'), ['carol@not.example.com', 'dan@example.com']);
    assert.deepEqual(found('.to[:-2]'), ['bob@example.com']);
    assert.deepEqual(found('.nested.a[].b'), [1, 2]);
    assert.deepEqual(found('.nested[]'), [[{ b: 1 }, { b: 2 }]]);
    // A missing member is null; selecting into it is nothing, unless optional.
    assert.equal(found('.missing'), null);
    assert.equal(found('.missing.deeper'), 'NOTHING');
    assert.equal(found('.missing.deeper?'), null);
    assert.equal(found('.missing?.deeper???'), null);
    // Resolution stops at the first failure, even before an optional segment.
    assert.equal(found('.to[99].x?'), 'NOTHING');
    assert.equal(found('.title[0]'), 'NOTHING');
  });

  test('what is not a selector', () => {
    for (const bad of ['', 'title', '..', '.a..b', '.a.', '.[', '.[x]', '.["a"', '.a[01]', '.a b', '.?a'])
      assert.equal(parseSelector(bad), null, bad);
    for (const good of [
      '.',
      '.a',
      '.a_b0',
      '.[0]',
      '.[-1]',
      '.a[]',
      '.a[1:2]',
      '.["x y"]',
      '.a?',
      '.a.["b"]',
    ])
      assert.notEqual(parseSelector(good), null, good);
  });
});

describe('evaluation', () => {
  const args = { name: 'Katie', age: 35, tags: [], roles: ['admin'] };

  test('a statement whose selector finds nothing never holds, under `not` too', () => {
    assert.equal(evaluatePolicy([['==', '.missing.x', 1]], args), false);
    assert.equal(evaluatePolicy([['!=', '.missing.x', 1]], args), false);
    assert.equal(evaluatePolicy([['not', ['==', '.missing.x', 1]]], args), false);
    assert.equal(
      evaluatePolicy(
        [
          [
            'or',
            [
              ['==', '.missing.x', 1],
              ['==', '.name', 'Katie'],
            ],
          ],
        ],
        args,
      ),
      true,
    );
    assert.equal(
      evaluatePolicy(
        [
          [
            'and',
            [
              ['==', '.missing.x', 1],
              ['==', '.name', 'Bob'],
            ],
          ],
        ],
        args,
      ),
      false,
    );
    // A missing member is null, so it can be compared with null.
    assert.equal(evaluatePolicy([['==', '.missing', null]], args), true);
  });

  test('comparisons only between numbers; like only on strings; quantifiers only over collections', () => {
    assert.equal(evaluatePolicy([['>', '.name', 1]], args), false);
    assert.equal(evaluatePolicy([['like', '.age', '*']], args), false);
    assert.equal(evaluatePolicy([['all', '.name', ['==', '.', 'K']]], args), false);
    // `all` over nothing holds; `any` over nothing doesn't; `or` of no statements holds.
    assert.equal(evaluatePolicy([['all', '.tags', ['==', '.', 'x']]], args), true);
    assert.equal(evaluatePolicy([['any', '.tags', ['==', '.', 'x']]], args), false);
    assert.equal(evaluatePolicy([['or', []]], args), true);
    assert.equal(evaluatePolicy([['not', ['and', []]]], args), false, 'what a note for no spaces says');
    assert.equal(evaluatePolicy([['not', ['any', '.roles', ['==', '.', 'admin']]]], args), false);
    assert.equal(evaluatePolicy([], args), true, 'no conditions');
  });

  test('globs: `*` is any run, `\\*` a star, nothing else special', () => {
    assert.equal(globMatch('*@example.com', 'bob@example.com'), true);
    assert.equal(globMatch('*@example.com', 'bob@example.co'), false);
    assert.equal(globMatch('a*b*c', 'abc'), true);
    assert.equal(globMatch('a*b*c', 'axxbyyc'), true);
    assert.equal(globMatch('a*b*c', 'axxbyy'), false);
    assert.equal(globMatch('\\*', '*'), true);
    assert.equal(globMatch('\\*', 'x'), false);
    assert.equal(globMatch('a?c', 'abc'), false);
    assert.equal(globMatch('a\\b', 'a\\b'), true);
    assert.equal(globMatch('', ''), true);
    assert.equal(globMatch('*', ''), true);
  });

  test('a policy that is not well formed is satisfied by nothing', () => {
    for (const bad of [
      'not a list',
      [['==', '.a']],
      [['<', '.a', 'one']],
      [['like', '.a', 1]],
      [['and', ['==', '.a', 1]]],
      [['not', ['==', '.a', 1], ['==', '.b', 1]]],
      [['every', '.a', ['==', '.', 1]]],
      [[]],
    ]) {
      assert.notEqual(policyProblem(bad), null, JSON.stringify(bad));
      assert.equal(evaluatePolicy(bad, { a: 1, b: 1 }), false, JSON.stringify(bad));
    }
    // Nested too deep, so a hostile note can't exhaust the stack.
    let deep: unknown = ['==', '.a', 1];
    for (let i = 0; i < 40; i++) deep = ['not', deep];
    assert.notEqual(policyProblem([deep]), null);
  });
});
