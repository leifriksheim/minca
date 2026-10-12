/** 2. Co-op, in Datalog, with membership as of each proposal given by the scenario's host. */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { evaluate, fact, parse, type Fact } from '../datalog.js';
import { factsOf } from '../facts.js';
import { datalog, datalogWhole } from '../programs/coop.js';
import { D, everything, host, removal } from '../../communities/coop.js';
import { judge } from '../../host/cel-host.js';
import type { Version } from '../../host/space.js';
import { shuffles } from './helpers.js';

describe('co-op in Datalog', () => {
  const program = parse(datalog);
  /** member_at facts for each proposal, from the host's replay */
  const memberAt = async (held: Version[]): Promise<Fact[]> => {
    const j = judge(held, host);
    const out: Fact[] = [];
    for (const v of held)
      if (v.collection === 'coop.proposal')
        for (const m of (await j.membersAsOf(v.id)) ?? []) out.push(fact('member_at', v.id, m));
    return out;
  };
  const removed = (fs: Fact[]) => evaluate(program, fs).query('removed');

  test('D is removed: every held ballot is counted, none cited', async () => {
    const held = [...everything, removal('r1', [])];
    assert.deepEqual(removed([...factsOf(held), ...(await memberAt(held))]), [[D]]);
  });

  test("a device without C's ballot says no, not 'wait'", async () => {
    const held = [...everything.filter((v) => v.id !== 'bC'), removal('r1', [])];
    assert.deepEqual(removed([...factsOf(held), ...(await memberAt(held))]), []);
  });

  test('in any order', async () => {
    const held = [...everything, removal('r1', [])];
    const facts = [...factsOf(held), ...(await memberAt(held))];
    for (const order of shuffles(facts, 30)) assert.deepEqual(removed(order), [[D]]);
  });

  test('membership as of a version, derived in Datalog too, is refused: it recurses through count', () => {
    assert.throws(() => parse(datalogWhole), /can't be stratified/);
  });
});
