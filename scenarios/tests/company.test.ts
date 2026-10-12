/** 3. Company team. */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { mayIn, type Assignment, type Authority, type Nesting } from '../host/library.js';
import { ANN, CEO, EVE, HAL, SOCK, WES, assignments, grants, nestings } from '../communities/company.js';

describe('company: grants', () => {
  const auth = (more: Assignment[] = [], nested: Nesting[] = []): Authority => ({
    founders: [CEO],
    delegations: grants,
    assignments: [...assignments, ...more],
    nestings: [...nestings, ...nested],
  });
  const doing = (a: Authority, who: string, cmd: string, collection: string) =>
    mayIn(a, who, cmd, { collection });

  test('each team writes its own collection; web, a sub-team of eng, writes both', () => {
    const a = auth();
    assert.ok(doing(a, HAL, '/record/write', 'app.hr'));
    assert.ok(doing(a, EVE, '/record/write', 'app.eng'));
    assert.ok(!doing(a, EVE, '/record/write', 'app.hr'));
    assert.ok(doing(a, WES, '/record/write', 'app.web'));
    assert.ok(doing(a, WES, '/record/write', 'app.eng'));
  });

  test("the admin manages every team but doesn't write in app.hr", () => {
    const a = auth();
    assert.ok(doing(a, ANN, '/record/write', 'app.eng'));
    assert.ok(!doing(a, ANN, '/record/write', 'app.hr'));
    assert.ok(mayIn(a, ANN, '/role/assign', { role: 'hr', self: false }));
  });

  test('the admin cannot assign herself hr: the policy refuses `.self`', () => {
    const a = auth([{ by: ANN, to: ANN, role: 'hr' }]);
    assert.ok(!mayIn(a, ANN, '/role/assign', { role: 'hr', self: true }));
    assert.ok(!doing(a, ANN, '/record/write', 'app.hr'));
  });

  test('a limit no language closes: she assigns hr to a second account of hers', () => {
    // "Manages hr but can't write in it" holds only if someone else manages hr's membership.
    const a = auth([{ by: ANN, to: SOCK, role: 'hr' }]);
    assert.ok(doing(a, SOCK, '/record/write', 'app.hr'));
  });

  test('assigning hr to the role admin is refused: assigning puts accounts in roles, not roles', () => {
    const a = auth([{ by: ANN, to: 'role:admin', role: 'hr' }]);
    assert.ok(!doing(a, ANN, '/record/write', 'app.hr'));
  });

  test('nesting hr in admin is granting: Ann holds neither /role/define nor what hr holds', () => {
    const a = auth([], [{ by: ANN, role: 'admin', holds: 'hr' }]);
    assert.ok(!doing(a, ANN, '/record/write', 'app.hr'));
  });

  test('a nesting by someone who loses what it nests carries only what they still held then', () => {
    // The CEO's nesting stands; one by Ann, who holds no eng grants, gives web nothing.
    const a: Authority = { ...auth(), nestings: [{ by: ANN, role: 'web', holds: 'eng' }] };
    assert.ok(!doing(a, WES, '/record/write', 'app.eng'));
    assert.ok(doing(a, WES, '/record/write', 'app.web'));
  });
});
