/**
 * The Datalog evaluator alone: recursion, negation, aggregates, arithmetic,
 * and the programs it refuses.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { evaluate, fact, parse, type Fact } from '../src/datalog.js';
import { shuffles } from './helpers.js';

const run = (src: string, facts: Fact[] = []) => evaluate(parse(src), facts);

describe('datalog: running', () => {
  test('facts and rules, with recursion', () => {
    const r = run(`
      edge("a", "b"); edge("b", "c"); edge("c", "a"); edge("c", "d");
      path($x, $y) <- edge($x, $y);
      path($x, $z) <- path($x, $y), edge($y, $z);
    `);
    assert.equal(r.query('path').length, 12, 'a, b and c reach all four; d reaches none');
    assert.ok(r.has('path', 'a', 'a'));
    assert.ok(!r.has('path', 'd', 'a'));
  });

  test('stratified negation', () => {
    const r = run(`
      node("a"); node("b"); node("c"); edge("a", "b");
      reach($y) <- edge("a", $y);
      unreached($x) <- node($x), !reach($x), $x != "a";
    `);
    assert.deepEqual(r.query('unreached'), [['c']]);
  });

  test('a negated atom may leave _ free: "no such fact at all"', () => {
    const r = run(`
      p("a"); p("b"); q("a", 1);
      lonely($x) <- p($x), !q($x, _);
    `);
    assert.deepEqual(r.query('lonely'), [['b']]);
  });

  test('comparisons and arithmetic; an error gives no fact', () => {
    const r = run(`
      n(7); n(0); n(-3);
      half($x, $h) <- n($x), $h = $x / 2;
      inverse($x, $i) <- n($x), $i = 100 / $x;
      big($x) <- n($x), $x * 2 > 10;
      label("b"); label("a");
      first($x) <- label($x), $x < "b";
    `);
    assert.deepEqual(
      r.query('half'),
      [
        [-3, -1],
        [0, 0],
        [7, 3],
      ],
      'division truncates toward zero',
    );
    assert.deepEqual(
      r.query('inverse'),
      [
        [-3, -33],
        [7, 14],
      ],
      'no fact for 100 / 0',
    );
    assert.deepEqual(r.query('big'), [[7]]);
    assert.deepEqual(r.query('first'), [['a']]);
  });

  test('past 2^53 a binding gives no fact, not a rounded one', () => {
    const r = run(`n(9007199254740991); next($y) <- n($x), $y = $x + 1;`);
    assert.deepEqual(r.query('next'), []);
  });

  test('count and sum, per group, over distinct values', () => {
    const r = run(`
      vote("p1", "alice"); vote("p1", "bob"); vote("p1", "alice"); vote("p2", "carol");
      proposal("p1"); proposal("p2"); proposal("p3");
      votes($p, $n) <- proposal($p), $n = count $m { vote($p, $m) };
      pay("x", "alice", 30); pay("y", "alice", 30); pay("z", "bob", 5);
      spent($a, $s) <- pay(_, $a, _), $s = sum $amt per $id { pay($id, $a, $amt) };
    `);
    assert.deepEqual(
      r.query('votes'),
      [
        ['p1', 2],
        ['p2', 1],
        ['p3', 0],
      ],
      'a group with none counts 0',
    );
    assert.deepEqual(
      r.query('spent'),
      [
        ['alice', 60],
        ['bob', 5],
      ],
      'two equal amounts are both added',
    );
  });

  test('two aggregates can each count a $m of their own', () => {
    const r = run(`
      member("p", "a"); member("p", "b"); member("p", "c"); yes("p", "a"); yes("p", "b");
      proposal("p");
      passes($p) <- proposal($p), $y = count $m { yes($p, $m) }, $n = count $m { member($p, $m) }, $y * 2 > $n;
    `);
    assert.ok(r.has('passes', 'p'));
  });

  test('the same facts in any order give the same result', () => {
    const program = parse(`
      path($x, $y) <- edge($x, $y);
      path($x, $z) <- path($x, $y), edge($y, $z);
      cut($x) <- node($x), !path("a", $x);
      fanout($x, $n) <- node($x), $n = count $y { path($x, $y) };
    `);
    const facts = [
      ...['a', 'b', 'c', 'd', 'e'].map((n) => fact('node', n)),
      fact('edge', 'a', 'b'),
      fact('edge', 'b', 'c'),
      fact('edge', 'c', 'b'),
      fact('edge', 'd', 'e'),
    ];
    const expected = JSON.stringify(['path', 'cut', 'fanout'].map((p) => evaluate(program, facts).query(p)));
    for (const order of shuffles(facts, 50))
      assert.equal(
        JSON.stringify(['path', 'cut', 'fanout'].map((p) => evaluate(program, order).query(p))),
        expected,
      );
  });

  test('a program past its fact limit fails, whatever order it derives in', () => {
    const program = parse(`n(0); n($y) <- n($x), $y = $x + 1;`);
    assert.throws(() => evaluate(program, [], { facts: 1000 }), /more than 1000 facts/);
  });
});

describe('datalog: refused before running', () => {
  const refused = (src: string, why: RegExp) => assert.throws(() => parse(src), why);

  test('a head variable the body does not bind', () => {
    refused(`p($x, $y) <- q($x);`, /\$y in the head is not bound/);
  });

  test('a variable only in a negated atom, or a comparison', () => {
    refused(`p($x) <- q($x), !r($x, $y);`, /\$y is not bound/);
    refused(`p($x) <- q($x), $x < $y;`, /\$y is not bound/);
  });

  test('_ in a head', () => {
    refused(`p(_) <- q($x);`, /_ can't be in a head/);
  });

  test('recursion through negation', () => {
    refused(`win($x) <- move($x, $y), !win($y);`, /can't be stratified: win depends on win/);
    refused(`p($x) <- q($x), !r($x); r($x) <- p($x);`, /can't be stratified/);
  });

  test('recursion through an aggregate', () => {
    refused(`size($n) <- $n = count $x { size($x) };`, /can't be stratified/);
    refused(`p($x, $n) <- q($x), $n = count $y { p($y, _) };`, /can't be stratified/);
  });

  test('a fact with a variable; text that is not Datalog', () => {
    refused(`p($x);`, /a fact has no variables/);
    refused(`p("a")`, /expected ";"/);
    refused(`p(1.5);`, /unexpected/);
  });
});
