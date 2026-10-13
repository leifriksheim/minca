/**
 * Contracts: what a collection's records must be to count, written in CEL
 * (`./cel.ts`) and judged by every reader that can read them (spec 09).
 *
 * A contract is a list of conditions; each is over the version being judged (its body, the
 * version before it, who wrote it) and over versions it cites as evidence,
 * by id. Peers only check; they never search. Whatever is hard to work out
 * (who voted, what adds up, which move is legal) the writer works out and
 * cites, and every peer confirms it from what was cited.
 *
 * So that every peer gets the same answer, whenever it judges:
 *
 * - it always ends: CEL has no loops but over lists in hand, and a step
 *   limit bounds those;
 * - it reads nothing that changes: cited versions are named by id and must
 *   be kept whole (`retain`), the version before is read only when it was
 *   kept whole, and there is no clock;
 * - it has no truthiness: a condition holds only when it gives `true`.
 *
 * One step is bounded, but a record's versions are not: a record whose
 * every version is checked against the one before is a state machine, and
 * versions citing versions build on each other the way a ledger does.
 */
import { isObject } from '../utils/guards.js';
import { canonicalize } from '../schema/version.js';
import type { Link } from '../types.js';
import { LINK_REL_PATTERN } from './links.js';
import {
  celChildren,
  celMap,
  celStop,
  checkCel,
  evaluateCel,
  fromJson,
  isCelProblem,
  isCelStop,
  MAX_CEL_STEPS,
  MAX_CEL_WORK,
  parseCel,
  type CelNode,
  type CelValue,
} from './cel.js';
import { INT, STRING, typeCheckCel, typeOfSchema, versionType, type CelType } from './cel-types.js';

/**
 * A line collection's declaration (spec 09 §6): one line per account, at
 * `lineKey(root, collection)`. `once` names body fields whose citations
 * appear at most once along a line. Its keys are closed.
 */
export interface Line {
  readonly once?: ReadonlyArray<string>;
}

/** The keys a line declaration may have */
const LINE_KEYS: ReadonlyArray<string> = ['once'];

/**
 * Whether a line declaration can be judged: null when it can, `unknown` when
 * it has a key this library doesn't know (the collection is then unjudged),
 * or why it is malformed.
 */
export function checkLine(line: unknown): string | null {
  if (!isObject(line)) return 'line must be an object';
  if (Object.keys(line).some((k) => !LINE_KEYS.includes(k))) return 'unknown';
  const once = line.once;
  if (
    once !== undefined &&
    !(Array.isArray(once) && once.every((f) => typeof f === 'string' && f.length > 0 && f.length <= 64))
  )
    return 'line.once must be a list of field names';
  return null;
}

/** The citations a version claims under `once`: each element of a listed field that is a list, as canonical JSON */
export function onceCitations(body: unknown, fields: ReadonlyArray<string>): string[] {
  if (!isObject(body)) return [];
  const out: string[] = [];
  for (const field of fields) {
    const value = Object.hasOwn(body, field) ? body[field] : undefined;
    if (!Array.isArray(value)) continue;
    const items: ReadonlyArray<unknown> = value;
    for (const item of items) out.push(`${field}\n${canonicalize(item)}`);
  }
  return out;
}

/** A check's condition: a CEL expression, like `body.amount > 0.0`. Checked by `checkContracts`. */
export type Condition = string;

/** One condition of a collection's contract: `that` must be true, else the version doesn't count and `else` says why */
export interface Contract {
  readonly that: Condition;
  readonly else: string;
}

/** Checks one collection may have */
const MAX_CHECKS = 16;
/** Characters in one condition */
const MAX_CONDITION_LENGTH = 4000;
/** Parts (literals, names, operations) in one collection's checks together */
const MAX_CHECK_NODES = 2000;
/** Steps one version's checks may take, together */
export const MAX_CONTRACT_STEPS = MAX_CEL_STEPS;
/** Distinct versions one version's checks may cite */
const MAX_CITED = 256;

/** The names a check reads */
const CHECK_NAMES = new Set([
  'body',
  'links',
  'key',
  'seq',
  'collection',
  'author',
  'creator',
  'createdAt',
  'prev',
]);

const parsed = new Map<string, CelNode>();

/** A condition parsed, or why it can't be */
function parse(condition: unknown, at: string): CelNode | string {
  if (typeof condition !== 'string' || !condition.trim() || condition.length > MAX_CONDITION_LENGTH)
    return `${at} is a CEL expression, at most ${MAX_CONDITION_LENGTH} characters`;
  const cached = parsed.get(condition);
  if (cached) return cached;
  try {
    const node = parseCel(condition);
    if (parsed.size > 1000) parsed.clear();
    parsed.set(condition, node);
    return node;
  } catch (error) {
    if (isCelProblem(error)) return `${at}: ${error.message}`;
    throw error;
  }
}

/** Why a collection's checks can't be kept, or null */
export function checkContracts(checks: unknown, at = 'rules.check'): string | null {
  if (!Array.isArray(checks) || checks.length === 0 || checks.length > MAX_CHECKS)
    return `${at} must be a list of 1 to ${MAX_CHECKS} checks`;
  const count = { nodes: 0 };
  const items: ReadonlyArray<unknown> = checks;
  for (const [i, check] of items.entries()) {
    if (!isObject(check)) return `${at}[${i}] must be { that, else }`;
    const extra = Object.keys(check).filter((k) => k !== 'that' && k !== 'else');
    if (extra.length) return `${at}[${i}] has only "that" and "else" (found ${extra.join(', ')})`;
    if (typeof check.else !== 'string' || !check.else.trim() || check.else.length > 200)
      return `${at}[${i}].else says why a version is refused: some text, at most 200 characters`;
    const node = parse(check.that, `${at}[${i}].that`);
    if (typeof node === 'string') return node;
    const problem = checkCel(node, { names: CHECK_NAMES, space: true, linkRel: LINK_REL_PATTERN }, count);
    if (problem) return `${at}[${i}].that: ${problem}`;
    if (count.nodes > MAX_CHECK_NODES)
      return `${at}: checks are too large (at most ${MAX_CHECK_NODES} parts)`;
  }
  return null;
}

/**
 * Mistakes in a collection's checks for the bodies its schema allows: a
 * field it doesn't have, a string compared with a number. Library only: the
 * writer refuses to define it, and peers never ask (`./cel-types.ts` says
 * what this can't catch). Run on checks `checkContracts` accepted.
 */
export function checkContractTypes(
  checks: ReadonlyArray<Contract>,
  schema: unknown,
  at = 'rules.check',
): string | null {
  const version = versionType(typeOfSchema(schema));
  if (version.t !== 'object') return null;
  const names = new Map<string, CelType>(Object.entries(version.fields));
  for (const name of ['id', 'deleted']) names.delete(name);
  names.set('creator', STRING).set('prev', version).set('seq', INT);
  for (const [i, check] of checks.entries()) {
    const node = parse(check.that, `${at}[${i}].that`);
    if (typeof node === 'string') return node;
    const problem = typeCheckCel(node, names);
    if (problem) return `${at}[${i}].that: ${problem}`;
  }
  return null;
}

/** A version a check reads: the one before, or one it cites */
export interface CitedVersion {
  readonly id: string;
  readonly key: string;
  readonly collection: string;
  readonly seq: number;
  /** Who wrote it: the account, not the key that signed */
  readonly author: string;
  readonly createdAt: string;
  readonly deleted: boolean;
  /** Null for a delete, and for a version before that was not kept whole */
  readonly body: unknown;
  readonly links: ReadonlyArray<Link>;
}

/** Why a cited version can't be read: not here yet, can't be opened, or can't count */
export type Uncited =
  | { readonly later: true }
  | { readonly unreadable: true }
  /** In a collection this reader doesn't judge (spec 09 §2) */
  | { readonly unjudged: true }
  | { readonly refused: string };

/** What a check reads, and asks, when judging one version */
export interface ContractScope {
  /** `body`, `links`, `key`, `seq`, `collection`, `author`, `creator`, `createdAt`, `prev` */
  readonly values: Readonly<Record<string, unknown>>;
  /** A version cited by id */
  readonly cite: (id: string) => Promise<CitedVersion | Uncited>;
  /** Whether an account held any role, as of what the version saw */
  readonly member: (did: string) => boolean;
}

/** How a version's checks came out */
export type ContractOutcome =
  | { readonly passed: true }
  | { readonly passed: false; readonly reason: string }
  /** It cites a version not held yet: judge it again when more arrives */
  | { readonly later: true }
  /** Something it reads is sealed with a key this peer doesn't hold: it can't tell */
  | { readonly unreadable: true }
  /** It cites a version in a collection this reader doesn't judge */
  | { readonly unjudged: true };

/** A version as a check reads it */
function versionValue(v: CitedVersion): CelValue {
  return celMap([
    ['id', v.id],
    ['key', v.key],
    ['collection', v.collection],
    ['seq', BigInt(v.seq)],
    ['author', v.author],
    ['createdAt', v.createdAt],
    ['deleted', v.deleted],
    ['body', fromJson(v.body)],
    ['links', fromJson(v.links)],
  ]);
}

export async function runContracts(
  checks: ReadonlyArray<Contract>,
  scope: ContractScope,
): Promise<ContractOutcome> {
  const vars = new Map<string, CelValue>();
  for (const [name, value] of Object.entries(scope.values)) {
    if (name === 'seq' && typeof value === 'number') vars.set(name, BigInt(value));
    else if (name === 'prev') vars.set(name, isCheckedVersion(value) ? versionValue(value) : null);
    else vars.set(name, fromJson(value));
  }
  // Steps and citations are counted across all of a version's checks.
  const budget = { steps: 0, max: MAX_CONTRACT_STEPS, work: 0, maxWork: MAX_CEL_WORK };
  const cited = new Map<string, CelValue>();
  const versions = async (ids: ReadonlyArray<string>): Promise<CelValue> => {
    const out: CelValue[] = [];
    for (const id of ids) {
      let value = cited.get(id);
      if (value === undefined) {
        if (cited.size >= MAX_CITED) throw celStop('fail', `it cites more than ${MAX_CITED} versions`);
        const found = await scope.cite(id);
        if ('later' in found) throw celStop('later', `${id} is not here yet`);
        if ('unreadable' in found) throw celStop('unreadable', `${id} can't be opened`);
        if ('unjudged' in found) throw celStop('unjudged', `${id} can't be judged here`);
        // One that doesn't stand fails the check outright, saying why.
        if ('refused' in found) throw celStop('fail', `${id} does not stand: ${found.refused}`);
        value = versionValue(found);
        cited.set(id, value);
      }
      out.push(value);
    }
    return out;
  };
  for (const check of checks) {
    const node = parse(check.that, 'check');
    if (typeof node === 'string') return { passed: false, reason: check.else };
    let result: CelValue;
    try {
      result = await evaluateCel(
        node,
        {
          vars,
          links: vars.get('links'),
          versions,
          member: scope.member,
        },
        budget,
      );
    } catch (error) {
      if (!isCelStop(error)) throw error;
      if (error.stop === 'later') return { later: true };
      if (error.stop === 'unreadable') return { unreadable: true };
      if (error.stop === 'unjudged') return { unjudged: true };
      return { passed: false, reason: `${check.else} (${error.why})` };
    }
    if (result !== true) return { passed: false, reason: check.else };
  }
  return { passed: true };
}

function isCheckedVersion(value: unknown): value is CitedVersion {
  return isObject(value) && typeof value.id === 'string' && typeof value.seq === 'number';
}

/**
 * Advice on a collection's checks, for whoever writes them: patterns whose
 * cost grows fast with the records they read, so a check that passes on
 * small records may run out of steps or work on large ones. Not protocol:
 * a verdict never depends on it.
 */
export function contractCostHints(checks: ReadonlyArray<Contract>): string[] {
  const hints: string[] = [];
  checks.forEach((check, i) => {
    const node = parse(check.that, `check[${i}]`);
    if (typeof node === 'string') return;
    let deepest = 0;
    let citesInLoop = false;
    const walk = (n: CelNode, loops: number) => {
      if (n.k === 'comp') {
        deepest = Math.max(deepest, loops + 1);
        walk(n.range, loops);
        if (n.pred) walk(n.pred, loops + 1);
        if (n.out) walk(n.out, loops + 1);
        return;
      }
      if (n.k === 'call' && n.fn === 'versions' && !n.target && loops > 0) citesInLoop = true;
      for (const child of celChildren(n)) walk(child, loops);
    };
    walk(node, 0);
    if (deepest >= 3)
      hints.push(
        `check[${i}]: macros nest ${deepest} deep, so its cost grows with the ${deepest}th power of list sizes`,
      );
    if (citesInLoop) hints.push(`check[${i}]: calls versions() inside a macro, citing once per element`);
  });
  return hints;
}
