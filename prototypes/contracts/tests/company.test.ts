/** 3. Company team, in both languages. */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { evaluate, fact, parse, type Fact } from '../src/datalog.js';
import { may, type Assignment, type Authority } from '../src/grants.js';
import { factsOf, version } from '../src/space.js';
import { ANN, CEO, EVE, HAL, WES, datalog, grants } from '../src/examples/company.js';
import { shuffles } from './helpers.js';

const SOCK = 'did:key:ann-second-account';

describe('company (A): UCAN grants', () => {
  const base: Assignment[] = [
    { by: CEO, to: ANN, role: 'admin' },
    { by: ANN, to: HAL, role: 'hr' },
    { by: ANN, to: EVE, role: 'eng' },
    { by: ANN, to: WES, role: 'web' },
    { by: ANN, to: 'role:web', role: 'eng' }, // the web team holds eng
  ];
  const auth = (more: Assignment[] = []): Authority => ({
    founders: [CEO],
    delegations: grants,
    assignments: [...base, ...more],
  });
  const doing = (a: Authority, who: string, cmd: string, collection: string) =>
    may(a, who, cmd, { collection });

  test('each team writes its own collection; web, inside eng, writes both', () => {
    const a = auth();
    assert.ok(doing(a, HAL, '/record/write', 'app.hr'));
    assert.ok(doing(a, EVE, '/record/write', 'app.eng'));
    assert.ok(!doing(a, EVE, '/record/read', 'app.hr'));
    assert.ok(doing(a, WES, '/record/write', 'app.web'));
    assert.ok(doing(a, WES, '/record/write', 'app.eng'));
  });

  test("the admin manages every team but doesn't read app.hr", () => {
    const a = auth();
    assert.ok(doing(a, ANN, '/record/read', 'app.eng'));
    assert.ok(!doing(a, ANN, '/record/read', 'app.hr'));
    assert.ok(may(a, ANN, '/role/assign', { role: 'hr', to: SOCK }));
  });

  test('a hole: the admin assigns herself hr, and reads app.hr; no policy can refuse it', () => {
    // A policy compares a selector with a literal; "to != the invoker" compares two values.
    const a = auth([{ by: ANN, to: ANN, role: 'hr' }]);
    assert.ok(doing(a, ANN, '/record/read', 'app.hr'));
  });
});

describe('company (C): Datalog', () => {
  const program = parse(datalog);
  const joins = (list: Array<[string, string, string, string]>) =>
    list.map(([by, to, team, as], i) =>
      version({ id: `j${i}`, collection: 'std.role', author: by, body: { to, team, as } }),
    );
  const base: Array<[string, string, string, string]> = [
    [CEO, ANN, 'company', 'admin'],
    [ANN, HAL, 'hr', 'member'],
    [ANN, EVE, 'eng', 'member'],
    [ANN, WES, 'web', 'member'],
  ];
  const requests = [HAL, EVE, WES, ANN, SOCK].flatMap((w) =>
    ['app.hr', 'app.eng', 'app.web'].flatMap((k) => [
      fact('request', w, '/record/read', k),
      fact('request', w, '/record/write', k),
    ]),
  );
  const facts = (more: Array<[string, string, string, string]> = []): Fact[] => [
    fact('founder', CEO),
    ...factsOf(joins([...base, ...more])),
    ...requests,
  ];
  const allowed = (fs: Fact[]) => evaluate(program, fs).query('allowed');
  const can = (fs: Fact[], w: string, c: string, k: string) => evaluate(program, fs).has('allowed', w, c, k);

  test('each team writes its own; web writes eng; the admin reads all but app.hr', () => {
    const fs = facts();
    assert.ok(can(fs, HAL, '/record/write', 'app.hr'));
    assert.ok(!can(fs, EVE, '/record/read', 'app.hr'));
    assert.ok(can(fs, WES, '/record/write', 'app.web'));
    assert.ok(can(fs, WES, '/record/write', 'app.eng'));
    assert.ok(can(fs, ANN, '/record/read', 'app.web'), 'web is two levels below the company');
    assert.ok(!can(fs, ANN, '/record/read', 'app.hr'));
    assert.ok(!can(fs, ANN, '/record/write', 'app.eng'), 'she manages; she does not write');
  });

  test('the admin cannot add herself to hr', () => {
    assert.ok(!can(facts([[ANN, ANN, 'hr', 'member']]), ANN, '/record/read', 'app.hr'));
  });

  test('a limit no language closes: she adds a second account of hers to hr', () => {
    assert.ok(can(facts([[ANN, SOCK, 'hr', 'member']]), SOCK, '/record/read', 'app.hr'));
  });

  test('in any order', () => {
    const fs = facts();
    const expected = JSON.stringify(allowed(fs));
    for (const order of shuffles(fs, 30)) assert.equal(JSON.stringify(allowed(order)), expected);
  });
});
