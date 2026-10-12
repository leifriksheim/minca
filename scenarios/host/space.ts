/**
 * Weave records as the scenarios see them: a space's held versions.
 * Simplified from spec 02: no signatures, keys or sealing; `seen` names
 * versions directly; a version's id is a label.
 */
import type { Json } from './ucan-policy.js';

export interface Link {
  readonly rel: string;
  readonly to: string;
}

export interface Version {
  readonly id: string;
  readonly key: string;
  readonly collection: string;
  readonly seq: number;
  /** The account (root DID), whichever of its devices signed */
  readonly author: string;
  /** Which of the account's devices signed: neither side reads it */
  readonly device?: string;
  readonly deleted: boolean;
  readonly body: Json;
  readonly links: ReadonlyArray<Link>;
  /** The version before it in this record, by id */
  readonly prev: string | null;
  /** Versions its writer had seen, by id */
  readonly seen: ReadonlyArray<string>;
}

/** A version, with defaults: a first version, seen nothing, key = id */
export const version = (v: Partial<Version> & Pick<Version, 'id' | 'collection' | 'author'>): Version =>
  Object.freeze({ key: v.id, seq: 0, deleted: false, body: {}, links: [], prev: null, seen: [], ...v });
