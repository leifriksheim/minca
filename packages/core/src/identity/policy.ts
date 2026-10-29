/**
 * @module identity/policy
 * UCAN 1.0's policy language, over canonical JSON values (spec 01 §7.4).
 *
 * A policy is a list of statements, all of which must hold. A statement
 * compares what a selector picks out of the arguments with a literal, or
 * combines statements. Arguments are filled in by whoever checks a note, from
 * what the note is used for: a policy reads nothing else.
 *
 * Evaluation has three outcomes, as in the reference implementations: true,
 * false, and "no data" when a selector can't be resolved. No data never
 * passes: `not` keeps it, so a policy can't be satisfied by naming something
 * that isn't there.
 */
import { isRecord } from '../utils/guards.js';

/** One statement: `[operator, …]`, checked by {@link policyProblem} */
export type Statement = ReadonlyArray<unknown>;
/** Statements that must all hold */
export type Policy = ReadonlyArray<Statement>;

/** How deep statements may nest, so a hostile one can't exhaust the stack */
const MAX_DEPTH = 32;
/** The most statements a policy may hold, all levels counted */
const MAX_STATEMENTS = 256;

type Segment =
  | { readonly kind: 'field'; readonly name: string; readonly optional: boolean }
  | { readonly kind: 'index'; readonly index: number; readonly optional: boolean }
  | {
      readonly kind: 'slice';
      readonly from: number | null;
      readonly to: number | null;
      readonly optional: boolean;
    }
  | { readonly kind: 'values'; readonly optional: boolean };

const NAME_START = /[A-Za-z_]/;
const NAME_PART = /[A-Za-z0-9_]/;
const INTEGER = /^-?(0|[1-9][0-9]*)$/;

/** A selector's segments, or null when it isn't one: `.`, `.a`, `.a[0]`, `.["a b"]`, `.a[]`, `.a[1:3]`, `.a?` */
export function parseSelector(selector: string): ReadonlyArray<Segment> | null {
  if (!selector.startsWith('.')) return null;
  const segments: Segment[] = [];
  let i = 1;
  // Just past a dot: a name may follow, and another dot may not.
  let afterDot = true;
  const optional = () => {
    const last = segments.pop();
    if (last) segments.push({ ...last, optional: true });
  };
  while (i < selector.length) {
    const c = selector[i]!;
    if (afterDot && NAME_START.test(c)) {
      let end = i + 1;
      while (end < selector.length && NAME_PART.test(selector[end]!)) end++;
      segments.push({ kind: 'field', name: selector.slice(i, end), optional: false });
      i = end;
      afterDot = false;
    } else if (c === '[') {
      const parsed = parseBracket(selector, i);
      if (!parsed) return null;
      segments.push(parsed.segment);
      i = parsed.end;
      afterDot = false;
    } else if (c === '.' && !afterDot) {
      afterDot = true;
      i++;
    } else if (c === '?' && (!afterDot || segments.length === 0)) {
      // Repeated `?` is one; on `.` alone it changes nothing.
      optional();
      afterDot = false;
      i++;
    } else {
      return null;
    }
  }
  // `.a.` ends in a dot that selects nothing.
  if (afterDot && segments.length > 0) return null;
  return segments;
}

/** One `[…]` starting at `start`: values, an index, a slice or a quoted name */
function parseBracket(selector: string, start: number): { segment: Segment; end: number } | null {
  if (selector[start + 1] === '"') {
    // A JSON string, then `]`.
    let end = start + 2;
    while (end < selector.length && selector[end] !== '"') end += selector[end] === '\\' ? 2 : 1;
    if (selector[end + 1] !== ']') return null;
    let name: unknown;
    try {
      name = JSON.parse(selector.slice(start + 1, end + 1));
    } catch {
      return null;
    }
    if (typeof name !== 'string') return null;
    return { segment: { kind: 'field', name, optional: false }, end: end + 2 };
  }
  const close = selector.indexOf(']', start);
  if (close < 0) return null;
  const inner = selector.slice(start + 1, close);
  const end = close + 1;
  if (inner === '') return { segment: { kind: 'values', optional: false }, end };
  const colon = inner.indexOf(':');
  if (colon < 0) {
    if (!INTEGER.test(inner)) return null;
    return { segment: { kind: 'index', index: Number(inner), optional: false }, end };
  }
  const from = inner.slice(0, colon);
  const to = inner.slice(colon + 1);
  if ((from !== '' && !INTEGER.test(from)) || (to !== '' && !INTEGER.test(to))) return null;
  return {
    segment: {
      kind: 'slice',
      from: from === '' ? null : Number(from),
      to: to === '' ? null : Number(to),
      optional: false,
    },
    end,
  };
}

/** What a selector found: a value, or nothing (no data) */
type Selected = { readonly found: true; readonly value: unknown } | { readonly found: false };
const NOTHING: Selected = { found: false };
const found = (value: unknown): Selected => ({ found: true, value });

/** Where a list index points, counting back from the end when negative; null when outside */
function position(index: number, length: number): number | null {
  const at = index < 0 ? length + index : index;
  return at >= 0 && at < length ? at : null;
}

/** One segment applied to one value */
function step(segment: Segment, value: unknown): Selected {
  switch (segment.kind) {
    case 'field':
      if (!isRecord(value)) return NOTHING;
      // A missing member is null; selecting into that null then fails.
      return found(Object.hasOwn(value, segment.name) ? value[segment.name] : null);
    case 'index': {
      if (!Array.isArray(value)) return NOTHING;
      const at = position(segment.index, value.length);
      return at === null ? NOTHING : found(value[at]);
    }
    case 'slice': {
      if (!Array.isArray(value)) return NOTHING;
      return found(value.slice(segment.from ?? 0, segment.to ?? value.length));
    }
    case 'values':
      if (Array.isArray(value)) return found(value);
      if (isRecord(value)) return found(Object.values(value));
      return NOTHING;
  }
}

/**
 * Resolves selector segments against a value, left to right. An optional
 * segment that fails gives null; any other failure stops. After `[]`, the
 * rest applies to each element, and fails if it fails for any.
 */
function resolve(segments: ReadonlyArray<Segment>, value: unknown): Selected {
  let current = value;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!;
    const next = step(segment, current);
    if (!next.found) {
      if (!segment.optional) return NOTHING;
      current = null;
      continue;
    }
    if (segment.kind === 'values' && i + 1 < segments.length) {
      // `next.value` is the list `step` just made.
      const elements: ReadonlyArray<unknown> = Array.isArray(next.value) ? next.value : [];
      const rest = segments.slice(i + 1);
      const each: unknown[] = [];
      for (const element of elements) {
        const one = resolve(rest, element);
        if (!one.found) return NOTHING;
        each.push(one.value);
      }
      return found(each);
    }
    current = next.value;
  }
  return found(current);
}

/** What a selector picks out of a value; no data when it can't be resolved or isn't a selector */
export function select(selector: string, value: unknown): Selected {
  const segments = parseSelector(selector);
  return segments ? resolve(segments, value) : NOTHING;
}

/** Deep equality over JSON values: numbers by value, objects by their members */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => jsonEqual(item, b[i]));
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((key) => Object.hasOwn(b, key) && jsonEqual(a[key], b[key]));
  }
  return false;
}

/**
 * Whether a string matches a glob: `*` matches any run of characters,
 * including none; `\*` is a literal `*`. Nothing else is special.
 */
export function globMatch(pattern: string, text: string): boolean {
  const tokens: Array<string | null> = [];
  const chars = Array.from(pattern);
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === '\\' && chars[i + 1] === '*') {
      tokens.push('*');
      i++;
    } else tokens.push(chars[i] === '*' ? null : chars[i]!);
  }
  const subject = Array.from(text);
  // Greedy with one backtrack point: linear in practice, quadratic at worst.
  let p = 0;
  let s = 0;
  let star = -1;
  let resume = 0;
  while (s < subject.length) {
    if (p < tokens.length && tokens[p] !== null && tokens[p] === subject[s]) {
      p++;
      s++;
    } else if (p < tokens.length && tokens[p] === null) {
      star = p++;
      resume = s;
    } else if (star >= 0) {
      p = star + 1;
      s = ++resume;
    } else return false;
  }
  while (p < tokens.length && tokens[p] === null) p++;
  return p === tokens.length;
}

/** True, false, or no data */
type Outcome = boolean | null;

/** `and` over outcomes: any false is false; else any no data is no data */
function every(outcomes: Iterable<Outcome>): Outcome {
  let missing = false;
  for (const outcome of outcomes) {
    if (outcome === false) return false;
    if (outcome === null) missing = true;
  }
  return missing ? null : true;
}

/** `or` over outcomes: any true is true; else any no data is no data */
function some(outcomes: Iterable<Outcome>): Outcome {
  let missing = false;
  for (const outcome of outcomes) {
    if (outcome === true) return true;
    if (outcome === null) missing = true;
  }
  return missing ? null : false;
}

const numbers =
  (compare: (a: number, b: number) => boolean) =>
  (value: unknown, operand: unknown): Outcome =>
    typeof value === 'number' && typeof operand === 'number' && compare(value, operand);

/** `all` and `any`: the inner statement over each item of a list or each value of an object */
const quantifier =
  (combine: (outcomes: Iterable<Outcome>) => Outcome) =>
  (value: unknown, inner: unknown): Outcome => {
    const items = Array.isArray(value) ? value : isRecord(value) ? Object.values(value) : null;
    return items === null ? false : combine(items.map((item) => evaluate(asStatement(inner), item)));
  };

/** The operators that test what a selector picks, by the value picked and the statement's operand */
const TESTS = new Map<unknown, (value: unknown, operand: unknown) => Outcome>([
  ['==', (value, operand) => jsonEqual(value, operand)],
  ['!=', (value, operand) => !jsonEqual(value, operand)],
  ['<', numbers((a, b) => a < b)],
  ['<=', numbers((a, b) => a <= b)],
  ['>', numbers((a, b) => a > b)],
  ['>=', numbers((a, b) => a >= b)],
  [
    'like',
    (value, pattern) => typeof value === 'string' && typeof pattern === 'string' && globMatch(pattern, value),
  ],
  ['all', quantifier(every)],
  ['any', quantifier(some)],
]);

function evaluate(statement: Statement, args: unknown): Outcome {
  const [op, first, second] = statement;
  if (op === 'not') {
    const inner = evaluate(asStatement(first), args);
    return inner === null ? null : !inner;
  }
  if (op === 'and') return every(asStatements(first).map((each) => evaluate(each, args)));
  if (op === 'or') {
    const each = asStatements(first);
    return each.length === 0 ? true : some(each.map((one) => evaluate(one, args)));
  }
  const test = TESTS.get(op);
  if (!test) return false;
  const picked = select(String(first), args);
  return picked.found ? test(picked.value, second) : null;
}

/** A nested statement, as `policyProblem` already checked it is one */
const asStatement = (value: unknown): Statement => (Array.isArray(value) ? value : []);
const asStatements = (value: unknown): ReadonlyArray<Statement> =>
  Array.isArray(value) ? value.map(asStatement) : [];

/**
 * Whether arguments satisfy a policy: every statement true. A policy that
 * isn't well formed ({@link policyProblem}) is satisfied by nothing.
 */
export function evaluatePolicy(policy: unknown, args: unknown): boolean {
  if (policyProblem(policy) !== null || !Array.isArray(policy)) return false;
  return policy.every((statement) => evaluate(asStatement(statement), args) === true);
}

/**
 * A policy's outcome over arguments that may leave something out: true,
 * false, or null for no data. A definite outcome stays the same whatever the
 * missing part holds, since no data never turns into a pass or a fail on its
 * own. A policy that isn't well formed is false.
 */
export function policyOutcome(policy: unknown, args: unknown): boolean | null {
  if (policyProblem(policy) !== null || !Array.isArray(policy)) return false;
  return every(policy.map((statement) => evaluate(asStatement(statement), args)));
}

/** Whether any selector in a policy reads `field` or something inside it: `.body`, `.body.amount` */
export function policyReads(policy: unknown, field: string): boolean {
  const reads = (value: unknown): boolean =>
    typeof value === 'string'
      ? value === `.${field}` || value.startsWith(`.${field}.`) || value.startsWith(`.${field}[`)
      : Array.isArray(value) && value.some(reads);
  return reads(policy);
}

/** What is wrong with a policy's shape, or null when it is well formed */
export function policyProblem(policy: unknown): string | null {
  if (!Array.isArray(policy)) return 'A policy is a list of statements';
  let count = 0;
  const check = (statement: unknown, depth: number): string | null => {
    if (++count > MAX_STATEMENTS) return `A policy holds at most ${MAX_STATEMENTS} statements`;
    if (depth > MAX_DEPTH) return `Statements nest at most ${MAX_DEPTH} deep`;
    if (!Array.isArray(statement) || statement.length === 0) return 'A statement is a non-empty list';
    const parts: ReadonlyArray<unknown> = statement;
    const [op, first, second] = parts;
    const selector = () =>
      typeof first === 'string' && parseSelector(first) ? null : `Bad selector in ${String(op)}`;
    const arity = (n: number) => (parts.length === n ? null : `${String(op)} takes ${n - 1} arguments`);
    switch (op) {
      case '==':
      case '!=':
        return (
          arity(3) ?? selector() ?? (isJson(second, 0) ? null : `${String(op)} compares with a JSON value`)
        );
      case '<':
      case '<=':
      case '>':
      case '>=':
        return (
          arity(3) ??
          selector() ??
          (typeof second === 'number' ? null : `${String(op)} compares with a number`)
        );
      case 'like':
        return arity(3) ?? selector() ?? (typeof second === 'string' ? null : 'like takes a pattern string');
      case 'not':
        return arity(2) ?? check(first, depth + 1);
      case 'and':
      case 'or':
        if (parts.length !== 2 || !Array.isArray(first)) return `${String(op)} takes a list of statements`;
        for (const inner of first) {
          const problem = check(inner, depth + 1);
          if (problem) return problem;
        }
        return null;
      case 'all':
      case 'any':
        return arity(3) ?? selector() ?? check(second, depth + 1);
      default:
        return `Unknown operator ${JSON.stringify(op)}`;
    }
  };
  for (const statement of policy) {
    const problem = check(statement, 1);
    if (problem) return problem;
  }
  return null;
}

/** Whether a value is plain JSON: what canonical JSON can write (spec 02 §1) */
export function isJson(value: unknown, depth = 0): boolean {
  if (depth > MAX_DEPTH) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJson(item, depth + 1));
  if (isRecord(value)) return Object.values(value).every((item) => isJson(item, depth + 1));
  return false;
}
