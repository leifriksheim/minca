/**
 * UCAN 1.0 policies (github.com/ucan-wg/delegation, "Policy"): the
 * conditions a delegation puts on an invocation's arguments, as the
 * library's own evaluator reads them (`packages/core/src/identity/policy.ts`,
 * spec 01 §7.4). The scenarios' grants are judged by the library itself
 * (`host/library.ts`); this names the shapes they are written in.
 */
import type { Policy } from '../../packages/core/src/identity/policy.js';

export type { Policy };
export type Json = null | boolean | number | string | ReadonlyArray<Json> | { readonly [k: string]: Json };

export function isRecord(x: Json | undefined): x is { readonly [k: string]: Json } {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}
