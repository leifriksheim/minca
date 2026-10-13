/**
 * The scenarios' contracts in SQL, each beside the CEL it replaces
 * (`scenarios/communities/`). A contract reads the tables of `SCHEMA`
 * (`scenarios/sql/host.ts`): `this`, `prev`, `cited`, `link`, `line` and
 * `members`; bodies are JSON text.
 */
import type { SqlCollection } from './host.js';

/** The first `on` link of a version, as CEL's `link('on')` */
const linkOn = (id: string) =>
  `(SELECT target FROM link WHERE id = ${id} AND rel = 'on' ORDER BY ord LIMIT 1)`;

// -- 1. Chess club: the player whose turn it is moves --------------------------------

export const chess: SqlCollection = {
  cites: ['game'],
  check: [
    {
      that: `SELECT EXISTS (SELECT 1 FROM cited g, this t WHERE g.field = 'game' AND g.collection = 'app.chess.game'
  AND t.author = CASE WHEN (t.body ->> '$.ply') % 2 = 0 THEN g.body ->> '$.white' ELSE g.body ->> '$.black' END)`,
      else: 'The player whose turn it is moves',
    },
  ],
};

// -- 2. Co-op: a proposal lists every member; a removal has a majority of them ----------

export const coopProposal: SqlCollection = {
  check: [
    {
      that: `SELECT json_array_length(t.body, '$.members') = (SELECT count(*) FROM members)
  AND (SELECT count(DISTINCT j.value) FROM json_each(t.body, '$.members') j WHERE j.value IN (SELECT did FROM members))
      = json_array_length(t.body, '$.members')
  AND t.body ->> '$.member' IN (SELECT value FROM json_each(t.body, '$.members'))
FROM this t`,
      else: 'A proposal lists every member as of itself',
    },
  ],
};

export const coopMember: SqlCollection = {
  cites: ['proposal', 'ballots'],
  check: [
    {
      that: `SELECT t.body ->> '$.op' = 'add' OR EXISTS (SELECT 1 FROM cited p WHERE p.field = 'proposal'
  AND p.collection = 'coop.proposal' AND p.body ->> '$.member' = t.body ->> '$.did')
FROM this t`,
      else: 'A removal cites a proposal to remove that member',
    },
    {
      that: `SELECT t.body ->> '$.op' = 'add' OR (
  SELECT count(DISTINCT b.author) * 2 > json_array_length(p.body, '$.members')
  FROM cited p JOIN cited b ON b.field = 'ballots'
  WHERE p.field = 'proposal' AND b.collection = 'coop.ballot' AND ${linkOn('b.id')} = p.key
    AND json_type(b.body, '$.yes') = 'true'
    AND b.author IN (SELECT value FROM json_each(p.body, '$.members')))
FROM this t`,
      else: 'More than half of the members as of the proposal said yes',
    },
  ],
};

// -- 4. Hall of fame: five different people's 🙂 on the comment ---------------------

export const fame: SqlCollection = {
  cites: ['reactions'],
  check: [
    {
      that: `SELECT count(DISTINCT c.author) >= 5 FROM cited c
WHERE c.field = 'reactions' AND c.collection = 'app.reaction' AND NOT c.deleted
  AND c.body ->> '$.emoji' = '🙂' AND ${linkOn('c.id')} = ${linkOn('(SELECT id FROM this)')}`,
      else: "A comment enters the hall of fame with 5 different people's 🙂",
    },
  ],
};

// -- 5. Mutual credit: a line of payments, a limit of −100 -----------------------------

const payChecks = [
  {
    that: `SELECT typeof(t.body ->> '$.amount') IN ('integer', 'real') AND t.body ->> '$.amount' >= 0
  AND t.body ->> '$.to' IS NOT t.author FROM this t`,
    else: 'Pay someone else, an amount of at least 0',
  },
  {
    that: `SELECT NOT EXISTS (SELECT 1 FROM cited r, this t WHERE r.field = 'received'
  AND (r.collection IS NOT 'app.pay' OR r.body ->> '$.to' IS NOT t.author))`,
    else: 'Claim only payments to you',
  },
  {
    // `sum()` of no rows is NULL; `total()` is 0.0.
    that: `SELECT t.body ->> '$.balance' = coalesce((SELECT body ->> '$.balance' FROM prev), 0)
  - (t.body ->> '$.amount') + (SELECT total(body ->> '$.amount') FROM cited WHERE field = 'received')
FROM this t`,
    else: 'The balance follows from the one before',
  },
  {
    that: `SELECT typeof(t.body ->> '$.balance') IN ('integer', 'real') AND t.body ->> '$.balance' >= -100 FROM this t`,
    else: 'No account goes below −100',
  },
];

/** With the line rule built in, as the library has it: `"line": { "once": ["received"] }` */
export const credit: SqlCollection = { cites: ['received'], line: { once: ['received'] }, check: payChecks };

/**
 * The line rule (spec 09 §7.2–7.5) in SQL. The host still computes the line
 * key and fills `line` with every version it holds at this key, in this
 * collection, by this author: deletes and twins included.
 */
export const lineInSql = [
  { that: `SELECT key = line_key FROM this`, else: "A line is at its account's line key" },
  {
    that: `SELECT NOT EXISTS (SELECT 1 FROM line l, this t WHERE l.id != t.id AND l.prev IS t.prev)`,
    else: 'Two versions after the same one are a double spend',
  },
  {
    that: `WITH RECURSIVE chain(id, prev, deleted, body) AS (
  SELECT id, prev, deleted, body FROM this
  UNION ALL SELECT l.id, l.prev, l.deleted, l.body FROM line l JOIN chain c ON l.id = c.prev)
SELECT NOT EXISTS (SELECT 1 FROM chain WHERE deleted AND id != (SELECT id FROM this))
  AND (SELECT count(*) = count(DISTINCT j.value) FROM chain, json_each(chain.body, '$.received') j
       WHERE json_type(chain.body, '$.received') = 'array')`,
    else: 'A delete ends a line, and a payment is claimed once along it',
  },
];

export const creditLineInSql: SqlCollection = { cites: ['received'], lineCheck: lineInSql, check: payChecks };
