/**
 * The CEL subset against CEL's own conformance suite
 * (`tests/cel-conformance/`). Every test there must either be refused when
 * its expression is checked, because it is outside the subset, or give
 * exactly the expected result. Tests that need what this harness can't
 * express (bytes, types, messages as values, containers) are skipped and
 * counted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

import {
  celMap,
  checkCel,
  evaluateCel,
  isCelError,
  isCelStop,
  isMap,
  isUint,
  parseCel,
  type CelValue,
} from '../src/records/cel.js';

// -- A reader for protobuf text format, enough for these files ----------------

type Field = TextMessage | { readonly scalar: string; readonly quoted: boolean };
interface TextMessage {
  readonly fields: Map<string, Field[]>;
}

function readText(source: string): TextMessage {
  let i = 0;
  const skip = () => {
    for (;;) {
      while (i < source.length && /\s/.test(source[i]!)) i++;
      if (source[i] === '#') while (i < source.length && source[i] !== '\n') i++;
      else return;
    }
  };
  const quoted = (): string => {
    const bytes: number[] = [];
    while (source[i] === '"' || source[i] === "'") {
      const q = source[i++]!;
      while (source[i] !== q) {
        const c = source[i]!;
        if (c !== '\\') {
          bytes.push(...new TextEncoder().encode(String.fromCodePoint(source.codePointAt(i)!)));
          i += source.codePointAt(i)! > 0xffff ? 2 : 1;
          continue;
        }
        const e = source[i + 1]!;
        const simple: Record<string, number> = {
          n: 10,
          t: 9,
          r: 13,
          a: 7,
          b: 8,
          f: 12,
          v: 11,
          '\\': 92,
          "'": 39,
          '"': 34,
          '?': 63,
        };
        if (e in simple) {
          bytes.push(simple[e]!);
          i += 2;
        } else if (e === 'x') {
          const m = /^[0-9a-fA-F]{1,2}/.exec(source.slice(i + 2))![0];
          bytes.push(parseInt(m, 16));
          i += 2 + m.length;
        } else if (e === 'u' || e === 'U') {
          const n = e === 'u' ? 4 : 8;
          bytes.push(
            ...new TextEncoder().encode(String.fromCodePoint(parseInt(source.slice(i + 2, i + 2 + n), 16))),
          );
          i += 2 + n;
        } else {
          const m = /^[0-7]{1,3}/.exec(source.slice(i + 1))![0];
          bytes.push(parseInt(m, 8));
          i += 1 + m.length;
        }
      }
      i++;
      skip();
    }
    return new TextDecoder().decode(new Uint8Array(bytes));
  };
  const value = (): Field => {
    skip();
    const c = source[i];
    if (c === '{' || c === '<') return message(c === '{' ? '}' : '>');
    if (c === '"' || c === "'") return { scalar: quoted(), quoted: true };
    const m = /^[-+\w.]+/.exec(source.slice(i));
    if (!m) throw new Error(`unexpected ${source.slice(i, i + 20)}`);
    i += m[0].length;
    return { scalar: m[0], quoted: false };
  };
  const message = (close: string | null): TextMessage => {
    if (close) i++;
    const fields = new Map<string, Field[]>();
    for (;;) {
      skip();
      if (i >= source.length || source[i] === close) {
        if (close) i++;
        return { fields };
      }
      let name: string;
      if (source[i] === '[') {
        const end = source.indexOf(']', i);
        name = source.slice(i, end + 1);
        i = end + 1;
      } else {
        name = /^\w+/.exec(source.slice(i))![0];
        i += name.length;
      }
      skip();
      if (source[i] === ':') i++;
      skip();
      const list = fields.get(name) ?? fields.set(name, []).get(name)!;
      if (source[i] === '[') {
        i++;
        for (;;) {
          skip();
          if (source[i] === ']') {
            i++;
            break;
          }
          list.push(value());
          skip();
          if (source[i] === ',') i++;
        }
      } else list.push(value());
      skip();
      if (source[i] === ',' || source[i] === ';') i++;
    }
  };
  return message(null);
}

const isMessage = (f: Field | undefined): f is TextMessage => f !== undefined && 'fields' in f;
const one = (m: TextMessage, name: string): Field | undefined => m.fields.get(name)?.[0];
const text = (m: TextMessage, name: string): string | undefined => {
  const f = one(m, name);
  return f && !isMessage(f) ? f.scalar : undefined;
};
const all = (m: TextMessage, name: string): TextMessage[] => (m.fields.get(name) ?? []).filter(isMessage);

/** A conformance `Value` as a CEL value, or undefined for one this harness can't hold */
function toValue(m: TextMessage): CelValue | undefined {
  const [entry] = [...m.fields];
  const kind = entry?.[0];
  const field = entry?.[1][0];
  if (!kind || !field) return undefined;
  const scalar = isMessage(field) ? '' : field.scalar;
  switch (kind) {
    case 'int64_value':
      return BigInt(scalar);
    case 'uint64_value':
      return Object.freeze({ uint: BigInt(scalar) });
    case 'double_value': {
      const s = scalar.toLowerCase();
      return s === 'inf' || s === 'infinity'
        ? Infinity
        : s === '-inf' || s === '-infinity'
          ? -Infinity
          : s === 'nan'
            ? NaN
            : Number(scalar);
    }
    case 'string_value':
      return scalar;
    case 'bool_value':
      return scalar === 'true';
    case 'null_value':
      return null;
    case 'list_value': {
      if (!isMessage(field)) return undefined;
      const items = all(field, 'values').map(toValue);
      return items.every((v) => v !== undefined) ? items.filter((v) => v !== undefined) : undefined;
    }
    case 'map_value': {
      if (!isMessage(field)) return undefined;
      const entries: Array<readonly [CelValue, CelValue]> = [];
      for (const entry of all(field, 'entries')) {
        const key = one(entry, 'key');
        const value = one(entry, 'value');
        const k = isMessage(key) ? toValue(key) : undefined;
        const v = isMessage(value) ? toValue(value) : undefined;
        if (k === undefined || v === undefined) return undefined;
        entries.push([k, v]);
      }
      return celMap(entries);
    }
  }
  return undefined;
}

/** Equal and of the same kind: `1` and `1.0` differ here, as they do in the suite */
function same(a: CelValue, b: CelValue): boolean {
  if (typeof a !== typeof b) return false;
  if (typeof a === 'number' && typeof b === 'number') return Object.is(a, b) || a === b;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    const la: ReadonlyArray<CelValue> = a;
    const lb: ReadonlyArray<CelValue> = b;
    return la.length === lb.length && la.every((x, i) => same(x, lb[i]!));
  }
  if (isUint(a) && isUint(b)) return a.uint === b.uint;
  if (isMap(a) && isMap(b)) {
    if (a.map.size !== b.map.size) return false;
    for (const [key, [, v]] of a.map) {
      const other = b.map.get(key);
      if (!other || !same(v, other[1])) return false;
    }
    return true;
  }
  return false;
}

const show = (v: CelValue): string =>
  JSON.stringify(v, (_, x: unknown) =>
    typeof x === 'bigint'
      ? `${x}n`
      : x instanceof Map
        ? Object.fromEntries([...x.values()].map(([k, v]) => [String(k), v]))
        : x,
  );

/**
 * Where the subset gives another answer than the suite, on purpose. Each is
 * an expression the subset would rather refuse but can only tell at run
 * time: it gives an error instead of the expected value.
 */
const DEVIATIONS: Readonly<Record<string, string>> = {};

const DIR = new URL('./cel-conformance/', import.meta.url);

test('the CEL subset passes, or refuses, every conformance test', async () => {
  const tally = { passed: 0, refused: 0, skipped: 0, deviations: 0 };
  const failures: string[] = [];
  for (const file of readdirSync(DIR)
    .filter((f) => f.endsWith('.textproto'))
    .sort()) {
    const root = readText(readFileSync(new URL(file, DIR), 'utf8'));
    for (const section of all(root, 'section')) {
      for (const t of all(section, 'test')) {
        const name = `${file.replace('.textproto', '')}/${text(section, 'name')}/${text(t, 'name')}`;
        const expr = text(t, 'expr')!;
        if (
          text(t, 'container') ||
          text(t, 'check_only') === 'true' ||
          text(t, 'disable_macros') === 'true'
        ) {
          tally.skipped++;
          continue;
        }
        const vars = new Map<string, CelValue>();
        let usable = true;
        for (const binding of all(t, 'bindings')) {
          const outer = one(binding, 'value');
          const inner = isMessage(outer) ? one(outer, 'value') : undefined;
          const v = isMessage(inner) ? toValue(inner) : undefined;
          if (v === undefined) usable = false;
          else vars.set(text(binding, 'key')!, v);
        }
        const typed = one(t, 'typed_result');
        const valueField = isMessage(typed) ? one(typed, 'result') : one(t, 'value');
        const expectsError = t.fields.has('eval_error');
        const expected = isMessage(valueField) ? toValue(valueField) : expectsError ? undefined : true;
        if (!usable || (expected === undefined && !expectsError)) {
          tally.skipped++;
          continue;
        }
        let node;
        try {
          node = parseCel(expr);
        } catch {
          tally.refused++;
          continue;
        }
        if (checkCel(node, { names: new Set(vars.keys()) })) {
          tally.refused++;
          continue;
        }
        let got: CelValue;
        try {
          got = await evaluateCel(node, { vars });
        } catch (error) {
          if (!isCelStop(error)) throw error;
          got = { error: error.why };
        }
        const ok = expectsError ? isCelError(got) : expected !== undefined && same(got, expected);
        if (ok) tally.passed++;
        else if (DEVIATIONS[name]) tally.deviations++;
        else
          failures.push(
            `${name}: ${expr}\n    expected ${expectsError ? 'an error' : show(expected!)}, got ${show(got)}`,
          );
      }
    }
  }
  console.log(tally);
  assert.deepEqual(failures, []);
});
