/** 3. Company team. */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { may, type Assignment, type Authority } from '../host/grants.js';
import { ANN, CEO, EVE, HAL, SOCK, WES, assignments, grants } from '../communities/company.js';

describe('company: grants', () => {
  const auth = (more: Assignment[] = []): Authority => ({
    founders: [CEO],
    delegations: grants,
    assignments: [...assignments, ...more],
  });
  const doing = (a: Authority, who: string, cmd: string, collection: string) =>
    may(a, who, cmd, { collection });

  test('each team writes its own collection; web, a sub-team of eng, writes both', () => {
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
    assert.ok(may(a, ANN, '/role/assign', { role: 'hr', self: false }));
  });

  test('the admin cannot assign herself hr: the policy refuses `.self`', () => {
    const a = auth([{ by: ANN, to: ANN, role: 'hr' }]);
    assert.ok(!may(a, ANN, '/role/assign', { role: 'hr', self: true }));
    assert.ok(!doing(a, ANN, '/record/read', 'app.hr'));
  });

  test('a limit no language closes: she assigns hr to a second account of hers', () => {
    // "Manages hr but can't read it" holds only if someone else manages hr's membership.
    const a = auth([{ by: ANN, to: SOCK, role: 'hr' }]);
    assert.ok(doing(a, SOCK, '/record/read', 'app.hr'));
  });
});
