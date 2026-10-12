/**
 * A small Datalog, for comparing contract languages. Not protocol.
 *
 * Syntax follows Biscuit's Datalog (doc.biscuitsec.org/reference/datalog):
 * `$x` variables, `<-` for rules, `;` after each statement, `//` comments.
 * Where it differs from Biscuit:
 *
 * - negation, `!pred(...)`, stratified (Biscuit has none);
 * - aggregates, `$n = count $m { ... }` and `$s = sum $a per $r { ... }`;
 * - assignment, `$x = expr`, binds a new variable (Biscuit only tests);
 * - `_`, a fresh variable that is never read;
 * - terms are strings, safe integers and booleans: no dates, bytes or sets,
 *   and no methods on terms (`.starts_with()` and the rest);
 * - no `check if`, `allow if` or scopes: a caller queries derived predicates.
 *
 * Semantics: the least fixpoint, computed bottom-up, semi-naively, one
 * stratum at a time. Results are sets, so the order facts arrive in cannot
 * change them. A program is refused before it runs when a variable is
 * unsafe or a predicate depends on itself through negation or an aggregate.
 */

/** A value in a fact: a string, a safe integer or a boolean */
export type Term = string | number | boolean;

export interface Fact {
  readonly pred: string;
  readonly args: ReadonlyArray<Term>;
}

type Arg = { readonly k: 'var'; readonly name: string } | { readonly k: 'const'; readonly value: Term };

type Expr =
  | Arg
  | { readonly k: 'bin'; readonly op: BinOp; readonly l: Expr; readonly r: Expr }
  | { readonly k: 'neg'; readonly e: Expr };

type BinOp = '+' | '-' | '*' | '/' | '%' | '==' | '!=' | '<' | '<=' | '>' | '>=';

interface Atom {
  readonly pred: string;
  readonly args: ReadonlyArray<Arg>;
}

type Literal =
  | { readonly k: 'atom'; readonly atom: Atom; readonly negated: boolean }
  | { readonly k: 'test'; readonly e: Expr }
  | { readonly k: 'assign'; readonly name: string; readonly e: Expr }
  | {
      readonly k: 'agg';
      readonly name: string;
      readonly fn: 'count' | 'sum';
      /** `sum`: the variable added up */
      readonly of: string | null;
      /** The variables whose distinct values are counted, or summed per */
      readonly per: ReadonlyArray<string>;
      /** Variables of its body that the rule around it binds: the group */
      readonly group: ReadonlyArray<string>;
      readonly body: ReadonlyArray<Literal>;
    };

interface Rule {
  readonly head: Atom;
  readonly body: ReadonlyArray<Literal>;
}

export interface Program {
  readonly facts: ReadonlyArray<Fact>;
  readonly rules: ReadonlyArray<Rule>;
}

/** Refuses a program that can't be read, or can't be run */
const fail = (why: string): never => {
  throw new Error(why);
};

export const fact = (pred: string, ...args: Term[]): Fact =>
  Object.freeze({ pred, args: Object.freeze(args) });

// -- Reading ------------------------------------------------------------------

type Token =
  | { readonly t: 'id'; readonly v: string }
  | { readonly t: 'var'; readonly v: string }
  | { readonly t: 'str'; readonly v: string }
  | { readonly t: 'int'; readonly v: number }
  | { readonly t: 'op'; readonly v: string };

const OPS = '<- == != <= >= ( ) , ; { } ! = < > + - * / %'.split(' ');

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i] ?? '';
    if (/\s/.test(c)) i++;
    else if (src.startsWith('//', i)) while (i < src.length && src[i] !== '\n') i++;
    else if (c === '"') {
      let s = '';
      i++;
      while (src[i] !== '"') {
        if (i >= src.length) fail('a string is not closed');
        if (src[i] === '\\') {
          const e = src[i + 1];
          s +=
            e === 'n' ? '\n' : e === 't' ? '\t' : e === '"' || e === '\\' ? e : fail(`unknown escape \\${e}`);
          i += 2;
        } else s += src[i++];
      }
      i++;
      out.push({ t: 'str', v: s });
    } else if (/[0-9]/.test(c)) {
      const m = /^[0-9]+/.exec(src.slice(i))?.[0] ?? '';
      const n = Number(m);
      if (!Number.isSafeInteger(n)) fail(`${m} is not a safe integer`);
      out.push({ t: 'int', v: n });
      i += m.length;
    } else if (c === '$') {
      const m = /^\$[a-z][a-zA-Z0-9_]*/.exec(src.slice(i))?.[0] ?? fail('a variable is $ and a name');
      out.push({ t: 'var', v: m.slice(1) });
      i += m.length;
    } else if (/[a-zA-Z_]/.test(c)) {
      const m = /^[a-zA-Z_][a-zA-Z0-9_]*/.exec(src.slice(i))?.[0] ?? '';
      out.push({ t: 'id', v: m });
      i += m.length;
    } else {
      const op = OPS.find((o) => src.startsWith(o, i)) ?? fail(`unexpected "${c}"`);
      out.push({ t: 'op', v: op });
      i += op.length;
    }
  }
  return out;
}

/** Reads a program: facts and rules, each ending in `;` */
export function parse(src: string): Program {
  const toks = tokenize(src);
  let p = 0;
  let fresh = 0;
  const peek = (o = 0): Token | undefined => toks[p + o];
  const isOp = (v: string, o = 0) => {
    const t = peek(o);
    return t?.t === 'op' && t.v === v;
  };
  const expect = (v: string) => {
    if (!isOp(v)) fail(`expected "${v}"`);
    p++;
  };
  const varName = (): string => {
    const t = toks[p++];
    if (t?.t !== 'var') return fail('expected a variable');
    return t.v;
  };
  const arg = (): Arg => {
    const t = toks[p++];
    if (!t) return fail('unexpected end');
    if (t.t === 'var') return { k: 'var', name: t.v };
    if (t.t === 'id' && t.v === '_') return { k: 'var', name: `_${fresh++}` };
    if (t.t === 'str' || t.t === 'int') return { k: 'const', value: t.v };
    if (t.t === 'id' && (t.v === 'true' || t.v === 'false')) return { k: 'const', value: t.v === 'true' };
    if (t.t === 'op' && t.v === '-' && toks[p]?.t === 'int') {
      const n = toks[p++];
      return { k: 'const', value: n?.t === 'int' ? -n.v : 0 };
    }
    return fail(`unexpected ${t.v}`);
  };
  const atom = (): Atom => {
    const t = toks[p++];
    if (t?.t !== 'id') return fail('expected a predicate');
    expect('(');
    const args: Arg[] = [];
    if (!isOp(')'))
      for (;;) {
        args.push(arg());
        if (isOp(')')) break;
        expect(',');
      }
    expect(')');
    return { pred: t.v, args };
  };
  // Expressions: comparison > additive > multiplicative > unary > primary.
  const primary = (): Expr => {
    if (isOp('(')) {
      p++;
      const e = expr();
      expect(')');
      return e;
    }
    if (isOp('-')) {
      p++;
      return { k: 'neg', e: primary() };
    }
    return arg();
  };
  const binary = (next: () => Expr, ops: ReadonlyArray<string>) => (): Expr => {
    let l = next();
    for (;;) {
      const t = peek();
      if (t?.t !== 'op' || !ops.includes(t.v)) return l;
      p++;
      l = { k: 'bin', op: opOf(t.v), l, r: next() };
    }
  };
  const mult = binary(primary, ['*', '/', '%']);
  const add = binary(mult, ['+', '-']);
  const expr = (): Expr => {
    const l = add();
    const t = peek();
    if (t?.t === 'op' && ['==', '!=', '<', '<=', '>', '>='].includes(t.v)) {
      p++;
      return { k: 'bin', op: opOf(t.v), l, r: add() };
    }
    return l;
  };
  const literals = (end: string): Literal[] => {
    const out: Literal[] = [];
    for (;;) {
      out.push(literal());
      if (isOp(end)) return out;
      expect(',');
    }
  };
  const literal = (): Literal => {
    const t = peek();
    if (isOp('!')) {
      p++;
      return { k: 'atom', atom: atom(), negated: true };
    }
    if (t?.t === 'id' && isOp('(', 1)) return { k: 'atom', atom: atom(), negated: false };
    if (t?.t === 'var' && isOp('=', 1)) {
      p += 2;
      const fn = peek();
      if (fn?.t === 'id' && (fn.v === 'count' || fn.v === 'sum') && !isOp('(', 1)) {
        p++;
        const of = fn.v === 'sum' ? varName() : null;
        if (of !== null) {
          const per = peek();
          if (per?.t !== 'id' || per.v !== 'per') fail('sum $x per $y, ... { ... }');
          p++;
        }
        const per: string[] = [varName()];
        while (isOp(',')) {
          p++;
          per.push(varName());
        }
        expect('{');
        const body = literals('}');
        expect('}');
        return { k: 'agg', name: t.v, fn: fn.v, of, per, group: [], body };
      }
      return { k: 'assign', name: t.v, e: expr() };
    }
    return { k: 'test', e: expr() };
  };

  const facts: Fact[] = [];
  const rules: Rule[] = [];
  while (p < toks.length) {
    const head = atom();
    if (isOp('<-')) {
      p++;
      rules.push(withGroups(head, literals(';')));
    } else {
      const args = head.args.map((a) =>
        a.k === 'const' ? a.value : fail(`a fact has no variables: ${head.pred}`),
      );
      facts.push(fact(head.pred, ...args));
    }
    expect(';');
  }
  const program = { facts, rules };
  check(program);
  return program;
}

const BIN_OPS: ReadonlyArray<BinOp> = ['+', '-', '*', '/', '%', '==', '!=', '<', '<=', '>', '>='];
const opOf = (v: string): BinOp => BIN_OPS.find((o) => o === v) ?? fail(`unknown operator ${v}`);

/**
 * Fills in each aggregate's group: the variables of its body that appear in
 * the rule outside it. An aggregate's body is its own scope, so two
 * aggregates can both count a `$m` of their own.
 */
function withGroups(head: Atom, body: ReadonlyArray<Literal>): Rule {
  const shallow = (l: Literal): string[] =>
    l.k === 'atom'
      ? atomVars(l.atom)
      : l.k === 'agg'
        ? [l.name]
        : l.k === 'assign'
          ? [l.name, ...varsOf(l.e)]
          : varsOf(l.e);
  return {
    head,
    body: body.map((l) => {
      if (l.k !== 'agg') return l;
      const outside = new Set([...atomVars(head), ...body.filter((o) => o !== l).flatMap(shallow)]);
      const inside = new Set(l.body.flatMap((b) => (b.k === 'atom' ? atomVars(b.atom) : needs(b))));
      return { ...l, group: [...inside].filter((v) => outside.has(v)) };
    }),
  };
}

// -- Checking -----------------------------------------------------------------

const varsOf = (e: Expr): string[] =>
  e.k === 'var'
    ? [e.name]
    : e.k === 'const'
      ? []
      : e.k === 'neg'
        ? varsOf(e.e)
        : [...varsOf(e.l), ...varsOf(e.r)];

const atomVars = (a: Atom) => a.args.flatMap((x) => (x.k === 'var' ? [x.name] : []));

const isAnon = (name: string) => name.startsWith('_');

/**
 * The order to evaluate a body in, so every variable is bound before it is
 * read; refuses a body where one never is. `bound` holds variables bound
 * outside the body (an aggregate's group).
 */
function plan(body: ReadonlyArray<Literal>, bound: ReadonlySet<string>, where: string): Literal[] {
  const have = new Set(bound);
  const order: Literal[] = [];
  const rest = [...body];
  // Positive atoms first, as written: they bind.
  for (const l of body)
    if (l.k === 'atom' && !l.negated) {
      order.push(l);
      for (const v of atomVars(l.atom)) have.add(v);
    }
  let left = rest.filter((l) => !(l.k === 'atom' && !l.negated));
  while (left.length > 0) {
    const ready = left.find((l) => needs(l).every((v) => have.has(v)));
    if (!ready) {
      const missing = left.flatMap(needs).find((v) => !have.has(v)) ?? '?';
      return fail(`${where}: $${missing} is not bound by a positive atom`);
    }
    order.push(ready);
    if (ready.k === 'assign' || ready.k === 'agg') have.add(ready.name);
    left = left.filter((l) => l !== ready);
  }
  return order;
}

/** Variables a non-binding literal reads */
function needs(l: Literal): string[] {
  switch (l.k) {
    case 'atom':
      // A negated atom may leave `_` free: "there is no such fact, whatever goes there".
      return atomVars(l.atom).filter((v) => !isAnon(v));
    case 'test':
      return varsOf(l.e);
    case 'assign':
      return varsOf(l.e);
    case 'agg':
      return [...l.group];
  }
}

/** Each rule's body, and each aggregate's, in the order it is evaluated */
const orders = new WeakMap<object, ReadonlyArray<Literal>>();
const orderOf = (of: object) => orders.get(of) ?? fail('an unchecked rule');

/** Refuses unsafe rules and programs that can't be stratified. */
function check(program: Program): void {
  for (const rule of program.rules) {
    const where = `${rule.head.pred}(...)`;
    const order = plan(rule.body, new Set(), where);
    const bound = new Set<string>();
    for (const l of order) {
      if (l.k === 'atom' && !l.negated) for (const v of atomVars(l.atom)) bound.add(v);
      if (l.k === 'assign' || l.k === 'agg') {
        if (bound.has(l.name) && l.k === 'agg') fail(`${where}: $${l.name} is bound twice`);
        bound.add(l.name);
      }
      if (l.k === 'agg') {
        orders.set(l, plan(l.body, new Set(l.group), `${where}, in ${l.fn}`));
        const local = new Set(l.body.flatMap((b) => (b.k === 'atom' && !b.negated ? atomVars(b.atom) : [])));
        for (const v of [...l.per, ...(l.of ? [l.of] : [])])
          if (!local.has(v) || l.group.includes(v))
            fail(`${where}: ${l.fn} over $${v}, which only its own body may bind`);
      }
    }
    for (const v of atomVars(rule.head)) {
      if (isAnon(v)) fail(`${where}: _ can't be in a head`);
      if (!bound.has(v)) fail(`${where}: $${v} in the head is not bound by the body`);
    }
    orders.set(rule, order);
  }
  strata(program);
}

/** Atoms a literal reads, and whether through negation or an aggregate */
function reads(l: Literal): Array<{ pred: string; negative: boolean }> {
  if (l.k === 'atom') return [{ pred: l.atom.pred, negative: l.negated }];
  if (l.k === 'agg') return l.body.flatMap(reads).map((r) => ({ pred: r.pred, negative: true }));
  return [];
}

/**
 * The program's strata: groups of predicates that depend on each other, in
 * an order where each reads only itself (positively) and those before it.
 * Tarjan's strongly connected components, which come out in that order.
 */
function strata(program: Program): string[][] {
  const edges = new Map<string, Array<{ pred: string; negative: boolean }>>();
  const preds = new Set<string>();
  for (const f of program.facts) preds.add(f.pred);
  for (const r of program.rules) {
    preds.add(r.head.pred);
    const list = edges.get(r.head.pred) ?? [];
    for (const l of r.body)
      for (const e of reads(l)) {
        list.push(e);
        preds.add(e.pred);
      }
    edges.set(r.head.pred, list);
  }
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const on = new Set<string>();
  const out: string[][] = [];
  let n = 0;
  const visit = (v: string) => {
    index.set(v, n);
    low.set(v, n++);
    stack.push(v);
    on.add(v);
    for (const { pred: w } of edges.get(v) ?? []) {
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v) ?? 0, low.get(w) ?? 0));
      } else if (on.has(w)) low.set(v, Math.min(low.get(v) ?? 0, index.get(w) ?? 0));
    }
    if (low.get(v) === index.get(v)) {
      const scc: string[] = [];
      let w: string | undefined;
      do {
        w = stack.pop();
        if (w !== undefined) {
          on.delete(w);
          scc.push(w);
        }
      } while (w !== v && w !== undefined);
      out.push(scc.sort());
    }
  };
  for (const v of [...preds].sort()) if (!index.has(v)) visit(v);
  for (const scc of out)
    for (const v of scc)
      for (const e of edges.get(v) ?? [])
        if (e.negative && scc.includes(e.pred))
          fail(`can't be stratified: ${v} depends on ${e.pred} through negation or an aggregate`);
  return out;
}

// -- Running ------------------------------------------------------------------

/** A set of tuples, by a key that tells `"1"`, `1` and `true` apart */
type Relation = Map<string, ReadonlyArray<Term>>;

const keyOf = (args: ReadonlyArray<Term>) => JSON.stringify(args);

type Binding = ReadonlyMap<string, Term>;

/** Thrown inside an expression: the binding gives no fact */
const NO = new Error('no fact');

function value(e: Expr, b: Binding): Term {
  switch (e.k) {
    case 'const':
      return e.value;
    case 'var': {
      const v = b.get(e.name);
      if (v === undefined) throw NO;
      return v;
    }
    case 'neg': {
      const v = value(e.e, b);
      if (typeof v !== 'number') throw NO;
      return safe(-v);
    }
    case 'bin': {
      const l = value(e.l, b);
      const r = value(e.r, b);
      if (e.op === '==') return l === r;
      if (e.op === '!=') return l !== r;
      if (e.op === '<' || e.op === '<=' || e.op === '>' || e.op === '>=') {
        // Integers with integers, strings with strings (by UTF-16 code units).
        const c =
          typeof l === 'number' && typeof r === 'number'
            ? l - r
            : typeof l === 'string' && typeof r === 'string'
              ? l < r
                ? -1
                : l > r
                  ? 1
                  : 0
              : null;
        if (c === null) throw NO;
        return e.op === '<' ? c < 0 : e.op === '<=' ? c <= 0 : e.op === '>' ? c > 0 : c >= 0;
      }
      if (typeof l !== 'number' || typeof r !== 'number') throw NO;
      if ((e.op === '/' || e.op === '%') && r === 0) throw NO;
      if (e.op === '+') return safe(l + r);
      if (e.op === '-') return safe(l - r);
      if (e.op === '*') return safe(l * r);
      if (e.op === '/') return safe(Math.trunc(l / r));
      return safe(l % r);
    }
  }
}

/** Past ±(2^53 − 1) a binding gives no fact, rather than a rounded one */
const safe = (n: number): number => {
  if (!Number.isSafeInteger(n)) throw NO;
  return n === 0 ? 0 : n;
};

/** What a body reads its atoms from: the whole relation, or for one atom only what is new */
type Source = (atom: Atom, position: number) => Iterable<ReadonlyArray<Term>>;

function solve(order: ReadonlyArray<Literal>, start: Binding, source: Source, db: Db): Binding[] {
  let rows: Binding[] = [start];
  order.forEach((l, i) => {
    const next: Binding[] = [];
    for (const b of rows) {
      if (l.k === 'atom' && !l.negated) {
        for (const tuple of source(l.atom, i)) {
          const m = match(l.atom, tuple, b);
          if (m) next.push(m);
        }
      } else if (l.k === 'atom') {
        const rel = db.rel(l.atom.pred);
        let found = false;
        for (const tuple of rel.values())
          if (match(l.atom, tuple, b)) {
            found = true;
            break;
          }
        if (!found) next.push(b);
      } else if (l.k === 'test') {
        try {
          if (value(l.e, b) === true) next.push(b);
        } catch (e) {
          if (e !== NO) throw e;
        }
      } else if (l.k === 'assign') {
        try {
          const v = value(l.e, b);
          const had = b.get(l.name);
          if (had === undefined) next.push(new Map(b).set(l.name, v));
          else if (had === v) next.push(b);
        } catch (e) {
          if (e !== NO) throw e;
        }
      } else {
        const v = aggregate(l, b, db);
        if (v !== null) next.push(new Map(b).set(l.name, v));
      }
    }
    rows = next;
  });
  return rows;
}

/**
 * `count`: how many distinct values of its variables the body has, for the
 * group bound outside. `sum`: of `of` over the distinct (per, of) values.
 * A sum of anything but integers, or past ±(2^53 − 1), gives no fact.
 */
function aggregate(l: Extract<Literal, { k: 'agg' }>, b: Binding, db: Db): Term | null {
  const group = new Map(l.group.map((v) => [v, b.get(v) ?? fail('unbound group')]));
  const seen = new Set<string>();
  let total = 0;
  for (const r of solve(orderOf(l), group, (atom) => db.rel(atom.pred).values(), db)) {
    const tuple = [...l.per, ...(l.of === null ? [] : [l.of])].map((v) => r.get(v) ?? fail('unbound'));
    const key = keyOf(tuple);
    if (seen.has(key)) continue;
    seen.add(key);
    if (l.fn === 'count') total++;
    else {
      const of = tuple[tuple.length - 1];
      if (typeof of !== 'number' || !Number.isSafeInteger(total + of)) return null;
      total += of;
    }
  }
  return total;
}

function match(atom: Atom, tuple: ReadonlyArray<Term>, b: Binding): Binding | null {
  if (tuple.length !== atom.args.length) return null;
  let out: Map<string, Term> | null = null;
  for (const [i, a] of atom.args.entries()) {
    const t = tuple[i];
    if (t === undefined) return null;
    if (a.k === 'const') {
      if (a.value !== t) return null;
      continue;
    }
    const had = (out ?? b).get(a.name);
    if (had === undefined) (out ??= new Map(b)).set(a.name, t);
    else if (had !== t) return null;
  }
  return out ?? b;
}

interface Db {
  rel(pred: string): Relation;
}

export interface Limits {
  /** Facts the database may hold, given and derived: past this, the program fails */
  readonly facts: number;
}

/** The facts a program derives, by predicate */
export interface Result {
  /** Every tuple of a predicate, sorted */
  query(pred: string): Term[][];
  has(pred: string, ...args: Term[]): boolean;
}

/**
 * Runs a program over facts. The result is the same set whatever order the
 * facts come in. Past `limits.facts`, throws: facts only grow, so the limit
 * is passed, or not, whatever order they were derived in.
 */
export function evaluate(
  program: Program,
  facts: Iterable<Fact> = [],
  limits: Limits = { facts: 100_000 },
): Result {
  const rels = new Map<string, Relation>();
  let count = 0;
  const rel = (pred: string): Relation => {
    let r = rels.get(pred);
    if (!r) rels.set(pred, (r = new Map()));
    return r;
  };
  const add = (pred: string, args: ReadonlyArray<Term>): boolean => {
    const r = rel(pred);
    const key = keyOf(args);
    if (r.has(key)) return false;
    for (const a of args) if (typeof a === 'number' && !Number.isSafeInteger(a)) fail(`${a} in ${pred}`);
    if (++count > limits.facts) fail(`more than ${limits.facts} facts`);
    r.set(key, args);
    return true;
  };
  const db: Db = { rel };
  for (const f of [...program.facts, ...facts]) add(f.pred, f.args);

  for (const stratum of strata(program)) {
    const inStratum = new Set(stratum);
    const rules = program.rules.filter((r) => inStratum.has(r.head.pred));
    const fire = (rule: Rule, source: Source, into: Map<string, Relation>) => {
      for (const b of solve(orderOf(rule), new Map(), source, db)) {
        const args = rule.head.args.map((a) =>
          a.k === 'const' ? a.value : (b.get(a.name) ?? fail('unbound')),
        );
        const pred = rule.head.pred;
        if (rel(pred).has(keyOf(args))) continue;
        let d = into.get(pred);
        if (!d) into.set(pred, (d = new Map()));
        d.set(keyOf(args), args);
      }
    };
    const commit = (found: Map<string, Relation>) => {
      const delta = new Map<string, Relation>();
      for (const [pred, r] of found)
        for (const [k, args] of r)
          if (add(pred, args)) {
            let d = delta.get(pred);
            if (!d) delta.set(pred, (d = new Map()));
            d.set(k, args);
          }
      return delta;
    };
    // First round: every rule over everything known.
    const first = new Map<string, Relation>();
    for (const rule of rules) fire(rule, (atom) => rel(atom.pred).values(), first);
    let delta = commit(first);
    // Then semi-naive: each round, a rule fires only with at least one atom
    // of this stratum read from what the last round added.
    while (delta.size > 0) {
      const found = new Map<string, Relation>();
      for (const rule of rules) {
        orderOf(rule).forEach((l, i) => {
          if (l.k !== 'atom' || l.negated || !inStratum.has(l.atom.pred)) return;
          const d = delta.get(l.atom.pred);
          if (!d) return;
          fire(rule, (atom, at) => (at === i ? d.values() : rel(atom.pred).values()), found);
        });
      }
      delta = commit(found);
    }
  }

  return {
    query: (pred) => [...rel(pred).values()].map((t) => [...t]).sort(compareTuples),
    has: (pred, ...args) => rel(pred).has(keyOf(args)),
  };
}

function compareTuples(a: ReadonlyArray<Term>, b: ReadonlyArray<Term>): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = JSON.stringify(a[i] ?? null);
    const y = JSON.stringify(b[i] ?? null);
    if (x !== y) return x < y ? -1 : 1;
  }
  return a.length - b.length;
}
