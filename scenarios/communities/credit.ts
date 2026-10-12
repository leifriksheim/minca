/**
 * 5. Mutual credit, with a limit of −100. An account's payments are one
 * line: each names the account's previous payment (`prev`, as versions of
 * one record at a key derived from the account), carries the running
 * balance, and claims payments made to it (`received`), each once along the
 * line. Two payments after the same one are a double spend, and neither
 * counts, from whichever devices. Both are the host's line rule, not CEL.
 */
import type { Check } from '../../packages/core/src/records/checks.js';
import { lineKey, type Host } from '../host/cel-host.js';
import { version, type Version } from '../host/space.js';

// -- The community: a CEL contract, plus the line rule: `"line": { "once": ["received"] }` --

export const payContract: Check[] = [
  { that: 'body.amount >= 0.0 && body.to != author', else: 'Pay someone else, an amount of at least 0' },
  {
    that: "versions(body.received).all(r, r.collection == 'app.pay' && r.body.to == author)",
    else: 'Claim only payments to you',
  },
  {
    that: 'body.balance == (prev == null ? 0.0 : prev.body.balance) - body.amount + sum(versions(body.received).map(r, r.body.amount) + [0.0])',
    else: 'The balance follows from the one before',
  },
  { that: 'body.balance >= -100.0', else: 'No account goes below −100' },
];

// -- The story ---------------------------------------------------------------------

export const ALICE = 'did:key:alice';
export const BOB = 'did:key:bob';
export const CAROL = 'did:key:carol';
const DAVE = 'did:key:dave';

interface Pay {
  to: string;
  amount: number;
  balance: number;
  received?: string[];
  device?: string;
}

/** A payment: the next version of the payer's line, after `after` */
export function pay(id: string, by: string, after: Version | null, p: Pay, seen: string[] = []): Version {
  const received = p.received ?? [];
  return version({
    id,
    key: lineKey('app.pay', by),
    collection: 'app.pay',
    author: by,
    device: p.device ?? 'laptop',
    seq: after ? after.seq + 1 : 0,
    prev: after?.id ?? null,
    body: { to: p.to, amount: p.amount, balance: p.balance, received },
    seen: [...(after ? [after.id] : []), ...received, ...seen],
  });
}

export const a0 = pay('a0', ALICE, null, { to: BOB, amount: 30, balance: -30 });
export const a1 = pay('a1', ALICE, a0, { to: CAROL, amount: 50, balance: -80 });
/** Bob spends 20 of the 30 Alice paid him. */
export const b0 = pay('b0', BOB, null, { to: CAROL, amount: 20, balance: 10, received: ['a0'] });
/** Alice's phone spends after a0 too: a double spend of the same line. */
export const a1phone = pay('a1p', ALICE, a0, { to: DAVE, amount: 60, balance: -90, device: 'phone' });

export const host: Host = {
  founders: [],
  members: [ALICE, BOB, CAROL, DAVE],
  contracts: { 'app.pay': payContract },
  lines: { 'app.pay': { once: ['received'], restate: ['to', 'amount'] } },
};
