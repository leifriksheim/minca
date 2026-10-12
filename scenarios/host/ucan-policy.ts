/**
 * UCAN 1.0 policies (github.com/ucan-wg/delegation, "Policy"): the
 * conditions a delegation puts on an invocation's arguments. The library's
 * own evaluator (`packages/core/src/identity/policy.ts`, spec 01 §7.4), so
 * the scenarios judge grants the way peers judge notes.
 *
 * A policy is a list of statements, all of which must hold. A selector that
 * finds nothing fails its statement, under `not` too, so a missing field can
 * never turn a "not" into a pass.
 */
import { evaluatePolicy, type Policy } from '../../packages/core/src/identity/policy.js';

export type { Policy };
export type Json = null | boolean | number | string | ReadonlyArray<Json> | { readonly [k: string]: Json };

/** Whether `args` meet every statement of `policy` */
export function allows(policy: Policy, args: Json): boolean {
  return evaluatePolicy(policy, args);
}

export function isRecord(x: Json | undefined): x is { readonly [k: string]: Json } {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}
