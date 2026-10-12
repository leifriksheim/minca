/**
 * 5. Mutual credit, with a limit of −100. An account's payments are one
 * line (spec 09 §6): each names the account's previous payment (`prev`, as
 * versions of one record at the account's line key), carries the running
 * balance, and claims payments made to it (`received`), each once along the
 * line. Two payments after the same one are a double spend, and neither
 * counts, from whichever devices. Judged by the library: a founder's node
 * holds the space, and every member signs their own payments.
 */
import type { Contract } from '../../packages/core/src/records/contracts.js';
import type { DefineCollection } from '../../packages/core/src/node/types.js';
import type { Version } from '../../packages/core/src/types.js';
import { lineKey } from '../../packages/core/src/records/key.js';
import { communityNode, type Community } from '../../packages/core/tests/helpers/community.js';
import type { Person } from '../../packages/core/tests/helpers/person.js';

// -- The community: a CEL contract, and the line rule: `"line": { "once": ["received"] }` --

const payContract: Contract[] = [
  { that: 'body.amount >= 0.0 && body.to != author', else: 'Pay someone else, an amount of at least 0' },
  {
    that: "versions(body.received).all(r, r.collection == 'app.pay' && r.body.to == author)",
    else: 'Claim only payments to you',
  },
  {
    // `sum([])` is `0.0`: a payment that claims nothing adds up without padding.
    that: 'body.balance == (prev == null ? 0.0 : prev.body.balance) - body.amount + sum(versions(body.received).map(r, r.body.amount))',
    else: 'The balance follows from the one before',
  },
  { that: 'body.balance >= -100.0', else: 'No account goes below −100' },
];

const pays = (line: Readonly<Record<string, unknown>> = { once: ['received'] }): DefineCollection => ({
  name: 'app.pay',
  schema: { type: 'object' },
  rules: { check: payContract },
  line,
});

// -- The story ---------------------------------------------------------------------

interface Pay {
  readonly to: Person;
  readonly amount: number;
  readonly balance: number;
  readonly received?: ReadonlyArray<Version>;
}

/** Alice founds it; Bob, Carol and Dave are members */
export async function story(line?: Readonly<Record<string, unknown>>) {
  const c: Community = await communityNode(3, [pays(line)]);
  const bob = c.members[0]!;
  const carol = c.members[1]!;
  const dave = c.members[2]!;
  const alice = c.founder;

  /** A payment: the next version of the payer's line, after `after`, from a device of its own */
  const pay = async (by: Person, after: Version | null, p: Pay): Promise<Version> =>
    c.sign(by, {
      collection: 'app.pay',
      body: {
        to: p.to.node.did,
        amount: p.amount,
        balance: p.balance,
        received: (p.received ?? []).map((v) => v.id),
      },
      version: after
        ? { key: after.key, seq: after.seq + 1, prev: after.id, genesis: after.genesis ?? after.id }
        : { key: await lineKey(by.node.did, 'app.pay'), seq: 0 },
    });

  const a0 = await pay(alice, null, { to: bob, amount: 30, balance: -30 });
  const a1 = await pay(alice, a0, { to: carol, amount: 50, balance: -80 });
  /** Bob spends 20 of the 30 Alice paid him. */
  const b0 = await pay(bob, null, { to: carol, amount: 20, balance: 10, received: [a0] });
  /** Alice's phone pays after a0 too: a double spend of the same line. */
  const a1phone = await pay(alice, a0, { to: dave, amount: 60, balance: -90 });

  /** An account's balance: the newest version of its line that counts */
  const balance = async (who: Person): Promise<number | null> => {
    const head = await alice.node.records.get<{ balance: number }>(
      c.space,
      await lineKey(who.node.did, 'app.pay'),
    );
    return head?.body?.balance ?? null;
  };

  return { c, alice, bob, carol, dave, pay, balance, a0, a1, b0, a1phone };
}
