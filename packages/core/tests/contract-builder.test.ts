/**
 * Contracts built in TypeScript (`contract`), and contracts checked against
 * their collection's schema when it is defined. Library only: what a peer
 * judges is the CEL either one stores (spec 09).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as z from 'zod';

import { contract, type ContractContext } from '../src/records/contract-builder.js';
import { parseCel } from '../src/records/cel.js';
import {
  checkContracts,
  checkContractTypes,
  runContracts,
  type CitedVersion,
  type Contract,
  type ContractScope,
} from '../src/records/contracts.js';
import { team } from '../src/space/presets.js';
import { person } from './helpers/person.js';

const ALICE = 'did:key:zAlice';
const BOB = 'did:key:zBob';

const Reaction = z.object({ emoji: z.string() });
const Fame = z.object({ reactions: z.array(z.string()) });
const Payment = z.object({
  to: z.string(),
  amount: z.number(),
  balance: z.number(),
  received: z.array(z.string()),
  note: z.string().optional(),
  tags: z.array(z.string()).optional(),
  kind: z.enum(['pay', 'gift']).optional(),
});
const Move = z.object({ game: z.string(), ply: z.number(), board: z.object({ turn: z.string() }) });

function version(id: string, fields: Partial<CitedVersion> = {}): CitedVersion {
  return {
    id,
    key: `k-${id}`,
    collection: 'app.reaction',
    seq: 0,
    author: ALICE,
    createdAt: '2026-10-13T12:00:00.000Z',
    deleted: false,
    body: null,
    links: [],
    ...fields,
  };
}

function scope(values: Record<string, unknown>, held: ReadonlyArray<CitedVersion> = []): ContractScope {
  return {
    values: { body: null, links: [], author: ALICE, creator: ALICE, prev: null, seq: 0, ...values },
    cite: async (id) => held.find((v) => v.id === id) ?? { later: true },
    member: (did) => did === ALICE || did === BOB,
  };
}

/** How a check comes out: pass, fail or later */
async function outcome(check: Contract, s: ContractScope): Promise<string> {
  const out = await runContracts([check], s);
  return 'later' in out ? 'later' : 'passed' in out ? (out.passed ? 'pass' : 'fail') : 'other';
}

/** The built check and the hand-written one give the same verdict on every case, and both verdicts occur */
async function agree(built: Contract, hand: string, cases: ReadonlyArray<ContractScope>) {
  const seen = new Set<string>();
  for (const [i, s] of cases.entries()) {
    const a = await outcome(built, s);
    assert.equal(a, await outcome({ that: hand, else: 'x' }, s), `case ${i}: ${built.that}`);
    seen.add(a);
  }
  assert.ok(seen.has('pass') && seen.has('fail'), `the cases try both verdicts: ${[...seen].join(', ')}`);
}

describe('contract(): what it builds', () => {
  test('is a { that, else } of CEL that parses, and that the library would define', () => {
    const built: Contract[] = [
      contract(Payment, ({ body, author }) => body.amount.gte(0).and(body.to.ne(author)), 'a'),
      contract(Payment, ({ body }) => body.amount.add(1).mul(2).sub(body.balance.div(3)).lt(10), 'b'),
      contract(Payment, ({ body }) => body.amount.neg().gt(-5).or(body.balance.eq(0)).not(), 'c'),
      contract(Payment, ({ body }) => body.received.size().eq(0).or(body.received.count().lte(3)), 'd'),
      contract(Payment, ({ body }) => body.received.exists((r) => r.startsWith('b')), 'e'),
      contract(Payment, ({ body }) => body.received.all((r) => r.size().gt(1)), 'f'),
      contract(Payment, ({ body }) => body.received.existsOne((r) => r.endsWith('z')), 'g'),
      contract(
        Payment,
        ({ body }) =>
          body.received
            .filter((r) => r.contains('q'))
            .distinct()
            .count()
            .eq(1),
        'h',
      ),
      contract(
        Payment,
        ({ body }) =>
          body.received
            .map((r) => r.size())
            .sum()
            .gte(2),
        'i',
      ),
      contract(Payment, ({ body }) => body.to.in(['a', 'b']).and(body.received.includes(body.to)), 'j'),
      contract(Payment, ({ body, has }) => has(body.note).and(body.note.eq('a "quoted"\n line \\')), 'k'),
      contract(Payment, ({ body, has }) => has(body.kind).and(body.kind.eq('gift')), 'l'),
      contract(
        Payment,
        ({ body, prev, when }) => body.balance.eq(when(prev.eq(null), 0, prev.body.balance)),
        'm',
      ),
      contract(
        Payment,
        ({ seq, key, creator, author }) => seq.mod(2).eq(0).and(key.startsWith(creator), author.eq(creator)),
        'n',
      ),
      contract(Payment, ({ member, author, hash, body }) => member(author).and(hash(body.to).ne('')), 'o'),
      contract(
        Payment,
        ({ links, link }) => links.exists((l) => l.rel.eq('on')).and(link('on').ne(null)),
        'p',
      ),
      contract(
        Payment,
        ({ body }) => body.received.at(0).eq(body.received.at(body.received.size().sub(1))),
        'q',
      ),
      contract(Payment, ({ body }) => body.amount.toInt().toDouble().eq(body.amount), 'r'),
      contract(
        Payment,
        ({ raw, body }) => raw<boolean>('math.greatest([1, 2]) == 2').and(body.amount.gte(0)),
        's',
      ),
      contract(
        Fame,
        ({ body, versions, link }) =>
          versions(body.reactions)
            .where((r) => r.collection.eq('app.reaction').and(r.deleted.not(), r.link('on').eq(link('on'))))
            .of(Reaction)
            .where((r) => r.body.emoji.eq('🙂'))
            .map((r) => r.author)
            .distinct()
            .count()
            .gte(5),
        't',
      ),
      contract(
        Move,
        ({ body, versions, author }) =>
          versions([body.game]).all((g) => author.eq(g.body.get('white')).or(g.body.get('black').eq(author))),
        'u',
      ),
      contract(Move, ({ body }) => body.board.turn.eq('white'), 'v'),
      // Nested macros get variables of their own.
      contract(Fame, ({ body }) => body.reactions.all((a) => body.reactions.exists((b) => b.eq(a))), 'w'),
    ];
    for (const c of built) {
      assert.deepEqual(Object.keys(c), ['that', 'else']);
      assert.doesNotThrow(() => parseCel(c.that), c.that);
    }
    assert.equal(checkContracts(built.slice(0, 16)), null);
    assert.equal(checkContracts(built.slice(16)), null);
    assert.equal(
      built[19]!.that,
      'versions(body.reactions).filter(x0, x0.collection == "app.reaction" && !x0.deleted && x0.link("on") == link("on")).filter(x0, x0.body.emoji == "🙂").map(x0, x0.author).distinct().size() >= 5',
    );
    assert.equal(built[22]!.that, 'body.reactions.all(x0, body.reactions.exists(x1, x1 == x0))');
  });

  test('literals take the kind CEL needs: a double next to a body number, an int next to a size', () => {
    const c = contract(Payment, ({ body }) => body.amount.add(1).gt(body.received.size().add(1)), 'x');
    assert.equal(c.that, 'body.amount + 1.0 > body.received.size() + 1');
  });

  test('parenthesizes only where CEL binds otherwise', () => {
    const c = contract(
      Payment,
      ({ body }) =>
        body.amount
          .sub(body.balance.sub(1))
          .mul(2)
          .eq(0)
          .or(body.amount.gt(1).and(body.balance.lt(0))),
      'x',
    );
    assert.equal(
      c.that,
      '(body.amount - (body.balance - 1.0)) * 2.0 == 0.0 || body.amount > 1.0 && body.balance < 0.0',
    );
  });

  test('refuses what it can’t make into a condition', () => {
    assert.throws(() => contract(Payment, ({ raw }) => raw('body.amount >'), 'x'), /contract/);
    assert.throws(() => contract(Payment, ({ raw }) => raw('body.amont > 0.0'), 'x'), /has no field "amont"/);
    assert.throws(
      () => contract(Payment, ({ has, body }) => has(body.amount.add(1)), 'x'),
      /has\(\) takes a field/,
    );
    assert.throws(
      () => contract(Payment, ({ body }) => body.amount.gt(Infinity), 'x'),
      /can't hold Infinity/,
    );
    assert.throws(() => contract(Payment, ({ body }) => body.received.size().gt(1.5), 'x'), /not one/);
  });
});

describe('contract(): verdicts equal to the hand-written CEL', () => {
  test('a payment: amount, payee, balance from the one before', async () => {
    const pay = (body: Record<string, unknown>, prev: unknown = null, author = ALICE) =>
      scope({ body, author, prev });
    const before = version('p0', { collection: 'app.pay', body: { balance: -30 } });
    const cases = [
      pay({ to: BOB, amount: 10, balance: -10 }),
      pay({ to: ALICE, amount: 10, balance: -10 }),
      pay({ to: BOB, amount: -1, balance: 1 }),
      pay({ to: BOB, amount: 10, balance: -40 }, before),
      pay({ to: BOB, amount: 10, balance: -30 }, before),
    ];
    await agree(
      contract(Payment, ({ body, author }) => body.amount.gte(0).and(body.to.ne(author)), 'x'),
      'body.amount >= 0.0 && body.to != author',
      cases,
    );
    await agree(
      contract(
        Payment,
        ({ body, prev, when }) => body.balance.eq(when(prev.eq(null), 0, prev.body.balance).sub(body.amount)),
        'x',
      ),
      'body.balance == (prev == null ? 0.0 : prev.body.balance) - body.amount',
      cases,
    );
  });

  test('a claim citing reactions', async () => {
    const r = (id: string, emoji: string, author: string, on = 'c1') =>
      version(id, { author, body: { emoji }, links: [{ rel: 'on', to: on }] });
    const held = [
      r('r1', '🙂', ALICE),
      r('r2', '🙂', BOB),
      r('r3', '😐', 'did:key:zC'),
      r('r4', '🙂', BOB, 'c2'),
    ];
    const claim = (ids: string[]) =>
      scope({ body: { reactions: ids }, links: [{ rel: 'on', to: 'c1' }] }, held);
    const built = contract(
      Fame,
      ({ body, versions, link }) =>
        versions(body.reactions)
          .where((x) =>
            x.collection.eq('app.reaction').and(x.link('on').eq(link('on')), x.body.get('emoji').eq('🙂')),
          )
          .map((x) => x.author)
          .distinct()
          .count()
          .gte(2),
      'x',
    );
    await agree(
      built,
      "versions(body.reactions).filter(r, r.collection == 'app.reaction' && r.link('on') == link('on') && r.body.emoji == '🙂').map(r, r.author).distinct().size() >= 2",
      [
        claim(['r1', 'r2']),
        claim(['r1', 'r3']),
        claim(['r1', 'r4']),
        claim(['r2', 'r2']),
        claim(['r1', 'r9']),
      ],
    );
  });
});

describe('contract(): types from the schema', () => {
  test('a misspelled field or a mismatched type is a type error', () => {
    // Only compiled: each line must fail to type-check, so what it gives is an error type.
    /* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- these lines are type errors on purpose */
    const reactions = (scope: ContractContext<{ reactions: string[] }>) =>
      scope.versions(scope.body.reactions).of(Reaction);
    const never = () => {
      // @ts-expect-error -- no such field
      contract(Payment, ({ body }) => body.amont.gte(0), 'x');
      // @ts-expect-error -- a string compared with a number
      contract(Payment, ({ body }) => body.to.eq(1), 'x');
      // @ts-expect-error -- a number compared with a string
      contract(Payment, ({ body }) => body.amount.gt('1'), 'x');
      // @ts-expect-error -- not one of the enum's values
      contract(Payment, ({ body }) => body.kind.eq('loan'), 'x');
      // @ts-expect-error -- versions() takes a list of ids
      contract(Move, ({ body, versions }) => versions(body.game).size().gt(0), 'x');
      // @ts-expect-error -- sum() is for numbers
      contract(Payment, ({ body }) => body.received.sum().gt(0), 'x');
      // @ts-expect-error -- a condition is a bool
      contract(Payment, ({ body }) => body.amount, 'x');
      // @ts-expect-error -- a typed cited body has only its fields
      contract(Fame, (scope) => reactions(scope).all((r) => r.body.emojj.eq('')), 'x');
    };
    /* eslint-enable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */
    assert.equal(typeof never, 'function');
  });
});

describe('collections.define: contracts checked against the schema', () => {
  const PAYMENT = {
    type: 'object',
    properties: {
      to: { type: 'string' },
      amount: { type: 'number' },
      balance: { type: 'number' },
      received: { type: 'array', items: { type: 'string' } },
      game: { type: 'string' },
      flag: { type: 'boolean' },
      kind: {
        oneOf: [
          { const: 'pay', title: 'Pay' },
          { const: 'gift', title: 'Gift' },
        ],
      },
      seen: { type: ['string', 'null'] },
    },
    required: ['to', 'amount'],
  };
  const typed = (that: string) => checkContractTypes([{ that, else: 'x' }], PAYMENT);

  test('refuses a field the schema doesn’t have, saying which it has', () => {
    assert.match(
      typed('body.amont >= 0.0') ?? '',
      /body\.amont: body has no field "amont" \(it has to, amount/,
    );
    assert.match(typed('has(body.notes)') ?? '', /no field "notes"/);
    assert.match(typed('prev.body.balanse == 0.0') ?? '', /no field "balanse"/);
    assert.match(typed('versions(body.received).all(r, r.bdy.x == 1)') ?? '', /no field "bdy"/);
    assert.match(typed('body.to.name == ""') ?? '', /reads a field of body\.to, which is a string/);
  });

  test('refuses what can never be true, or is an error for every body', () => {
    assert.match(typed('body.to == 1') ?? '', /compares body\.to, a string, with 1, an int: never equal/);
    assert.match(typed('body.amount > "1"') ?? '', /by order/);
    assert.match(typed('body.amount + 1 > 2.0') ?? '', /mixes a double and an int.*write 1\.0/);
    assert.match(typed('body.flag && body.to') ?? '', /&& takes a bool/);
    assert.match(typed('versions(body.game).size() > 0') ?? '', /write versions\(\[body\.game\]\)/);
    assert.match(
      typed('sum(body.received) > 0.0') ?? '',
      /sum\(body\.received\) adds up strings, not numbers/,
    );
    assert.match(typed('body.amount.size() > 0') ?? '', /has no size/);
    assert.match(typed('body.amount') ?? '', /never true/);
    assert.match(typed('body.to in [1, 2]') ?? '', /never equal/);
    assert.match(typed('body.kind == 2') ?? '', /never equal/);
  });

  test('accepts what can hold: numbers across kinds, null, cited bodies, dyn', () => {
    for (const that of [
      'body.amount == 1 && body.amount < 1 && body.amount + 1.0 > 0.0',
      'body.balance == (prev == null ? 0.0 : prev.body.balance) - body.amount + sum(versions(body.received).map(r, r.body.amount))',
      'versions([body.game]).all(g, g.body.anything == author && g.body.n + 1 > 0)',
      'has(body.to) && body.seen == null || body.seen.startsWith("x")',
      'body.kind == "gift" && size(body.received) == body.received.size()',
      'dyn(body.to) == 1 || int(body.amount) % 2 == 0',
      'body.received.exists(r, r == author) && links.exists(l, l.rel == "on" && l.to == key)',
      'body.received.map(r, r.size()).all(n, n > 0)',
    ])
      assert.equal(typed(that), null, that);
    // A schema it can't follow reads as dyn, and refuses nothing.
    assert.equal(checkContractTypes([{ that: 'body.x + 1 == "a"', else: 'x' }], { type: 'object' }), null);
    assert.equal(
      checkContractTypes([{ that: 'body.zz == 1.0', else: 'x' }], { ...PAYMENT, additionalProperties: true }),
      null,
    );
  });

  test('the node refuses to define a contract that misreads its schema, hand-written or built', async () => {
    const alice = await person();
    const { id: space } = await alice.node.spaces.create({ name: 'Club', ...team, visibility: 'public' });
    await assert.rejects(
      alice.node.collections.define(space, {
        name: 'app.pay',
        schema: Payment,
        rules: { check: [{ that: 'body.amont >= 0.0', else: 'x' }] },
      }),
      /rules\.check\[0\]\.that: body\.amont: body has no field "amont"/,
    );
    await assert.rejects(
      alice.node.collections.define(space, {
        name: 'app.pay',
        schema: Payment,
        rules: { check: [{ that: 'body.to == 1', else: 'x' }] },
      }),
      /never equal/,
    );
    // Built against one schema, defined with another.
    await assert.rejects(
      alice.node.collections.define(space, {
        name: 'app.pay',
        schema: Reaction,
        rules: { check: [contract(Payment, ({ body }) => body.amount.gte(0), 'x')] },
      }),
      /no field "amount"/,
    );
    const ok = await alice.node.collections.define(space, {
      name: 'app.pay',
      schema: Payment,
      rules: { check: [contract(Payment, ({ body }) => body.amount.gte(0), 'x')] },
    });
    assert.equal(ok.name, 'app.pay');
  });
});
