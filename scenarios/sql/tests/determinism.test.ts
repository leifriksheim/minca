/**
 * What the lockdown refuses, and probes of where SQLite's answers could
 * differ between peers or surprise a contract's author. Each asserts what
 * the bundled build (`@sqlite.org/sqlite-wasm` 3.53) gives; where an older
 * SQLite gives something else, the test says so (measured against 3.46.1
 * and Node's `node:sqlite` 3.51.2; see `spec/drafts/sql-contracts.md`).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { loadEngine, type Outcome, type Table } from '../engine.js';

const engine = await loadEngine();
const t: Record<string, Table> = {
  this: { columns: ['id', 'body'], rows: [['v', '{"a":1,"s":"x","big":9007199254740993,"f":0.1}']] },
};
const verdict = (o: Outcome) => ('passed' in o ? o.passed : o);
const one = (sql: string) => engine.rows(sql)[0]?.[0];
const quiet = <T>(f: () => T): T => {
  const error = console.error;
  console.error = () => {};
  try {
    return f();
  } finally {
    console.error = error;
  }
};

describe('sql lockdown: only a read-only SELECT, over the given tables, with allowed functions', () => {
  for (const [what, sql] of [
    ['a write', `INSERT INTO this VALUES ('w', '{}')`],
    ['a pragma', `SELECT * FROM pragma_table_info('this')`],
    ['the schema', `SELECT count(*) = 0 FROM sqlite_schema`],
    ['an attach', `ATTACH ':memory:' AS x`],
    ['randomness', `SELECT random() IS NOT NULL`],
    ['the clock', `SELECT datetime('now') IS NOT NULL`],
    ['connection state', `SELECT changes() = 0`],
    ['the version', `SELECT sqlite_version() IS NOT NULL`],
    ['float printing', `SELECT printf('%.2f', 1) = '1.00'`],
    ['an order-dependent aggregate', `SELECT group_concat(id) = 'v' FROM this`],
    ['a window function', `SELECT row_number() OVER () = 1 FROM this`],
    ['libm', `SELECT sqrt(4) = 2`],
  ] as const)
    test(`refuses ${what}`, () => {
      assert.ok('refused' in quiet(() => engine.evaluate(sql, t)), sql);
    });

  test('a query that never ends stops at the step limit', () => {
    const out = quiet(() =>
      engine.evaluate(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n) SELECT max(i) > 0 FROM n`,
        t,
      ),
    );
    assert.ok('limit' in out);
  });

  test('two rows, or a column that is not 1, fail', () => {
    assert.deepEqual(verdict(engine.evaluate(`SELECT 1 UNION ALL SELECT 1`, t)), false);
    assert.deepEqual(verdict(engine.evaluate(`SELECT 'yes'`, t)), false);
  });

  test('steps are counted per VM instruction, not per unit of work: one step can scan a long string', () => {
    const long = `{"s":"${'a'.repeat(900_000)}b"}`;
    const big = { this: { columns: ['body'], rows: [[long]] } };
    const out = engine.evaluate(`SELECT instr(body, 'b') > 0 FROM this`, big);
    assert.ok('steps' in out && out.steps < 30, JSON.stringify(out));
  });
});

describe('sql determinism probes', () => {
  test('floats: printing changed between versions (3.53 prints 17 digits, 3.46 and 3.51 print 15)', () => {
    assert.equal(one(`SELECT cast(0.1 + 0.2 AS text)`), '0.30000000000000004'); // '0.3' before 3.52
    assert.equal(one(`SELECT cast(1e15 AS text)`), '1000000000000000.0'); // '1.0e+15' before 3.52
    assert.equal(one(`SELECT json_quote(0.1 + 0.2)`), '0.30000000000000004'); // '0.3' before 3.52
    assert.equal(one(`SELECT 0.1 + 0.2 = 0.3`), 0); // comparison is IEEE in every version
  });

  test('integers: overflow turns to a float, silently; abs() and sum() raise; division by zero is NULL', () => {
    assert.equal(one(`SELECT typeof(9223372036854775807 + 1)`), 'real');
    assert.equal(one(`SELECT 1 / 0`), null);
    assert.ok(
      'error' in
        quiet(() =>
          engine.evaluate(`SELECT sum(x) > 0 FROM (SELECT 9223372036854775807 AS x UNION ALL SELECT 1)`, t),
        ),
    );
  });

  test('JSON numbers keep their text: 2^53 + 1 is exact in SQL, where CEL and JavaScript read 2^53', () => {
    assert.equal(engine.rows(`SELECT body ->> '$.big' = 9007199254740993 FROM this`, t)[0]?.[0], 1);
    assert.equal(one(`SELECT typeof('{"n":1.0}' ->> '$.n') || typeof('{"n":1}' ->> '$.n')`), 'realinteger');
  });

  test('NULL: a missing field makes a "none violate" check pass, where CEL would fail it', () => {
    const cited = {
      cited: { columns: ['body'], rows: [['{"emoji":"🙂"}'], ['{}']] },
    };
    // Every cited reaction is a 🙂? The one without an emoji compares as NULL, and slips through.
    assert.deepEqual(
      verdict(
        engine.evaluate(`SELECT NOT EXISTS (SELECT 1 FROM cited WHERE body ->> '$.emoji' != '🙂')`, cited),
      ),
      true,
    );
    assert.equal(
      verdict(
        engine.evaluate(
          `SELECT NOT EXISTS (SELECT 1 FROM cited WHERE body ->> '$.emoji' IS NOT '🙂')`,
          cited,
        ),
      ),
      false,
    );
    assert.deepEqual(
      engine.rows(`SELECT NULL = NULL, 1 NOT IN (2, NULL), sum(x), total(x) FROM (SELECT NULL AS x)`),
      [[null, null, null, 0]],
    );
  });

  test('types: text compares above every number, and true is 1', () => {
    assert.deepEqual(engine.rows(`SELECT 'a' > 9e999, '1' = 1, true = 1, '12abc' + 0`), [[1, 0, 1, 12]]);
  });

  test('unordered results: the same query, two valid answers', () => {
    const rows = { r: { columns: ['x'], rows: [['a'], ['b']] } };
    const sql = `SELECT (SELECT x FROM r LIMIT 1) = 'a'`;
    assert.equal(verdict(engine.evaluate(sql, rows)), true);
    // `PRAGMA reverse_unordered_selects`, or another plan, gives 'b': SQL leaves it open.
    assert.deepEqual(engine.rows(`PRAGMA reverse_unordered_selects = 1; SELECT x FROM r LIMIT 1`, rows), [
      ['b'],
    ]);
  });

  test('text without ICU: lower() and LIKE fold ASCII only; strings order by UTF-8 bytes, not UTF-16 as CEL', () => {
    assert.deepEqual(
      engine.rows(`SELECT lower('ÄB'), upper('ß'), 'Ä' LIKE 'ä', 'A' LIKE 'a', length('😀é')`),
      [['Äb', 'ß', 0, 1, 2]],
    );
    assert.equal(one(`SELECT char(65535) < char(128512)`), 1);
    const [bmp, astral] = [String.fromCharCode(0xffff), String.fromCodePoint(0x1f600)];
    assert.equal(bmp < astral, false); // JavaScript and CEL: UTF-16 code units
    assert.equal(one(`SELECT '${'\u00e9'}' = '${'e\u0301'}'`), 0); // NFC against NFD: no normalization
  });

  test('JSON on odd input: duplicate keys take the first, JSON5 is read, malformed JSON is an error', () => {
    assert.equal(one(`SELECT '{"a":1,"a":2}' ->> '$.a'`), 1);
    assert.deepEqual(engine.rows(`SELECT json_valid('{a:1}'), json('{a:1}')`), [[0, '{"a":1}']]);
    assert.ok('error' in quiet(() => engine.evaluate(`SELECT '[1,2' ->> '$[0]' = 1`, t)));
    // A lone surrogate, escaped in JSON, becomes bytes that are not UTF-8.
    assert.equal(one(`SELECT length(CAST(json_extract('"\\ud800"', '$') AS blob))`), 3);
  });
});
