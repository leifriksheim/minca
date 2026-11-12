/**
 * A standard library of well-known record shapes, broad enough that most apps
 * need no definitions of their own. Optional, and nothing special: the protocol knows
 * none of them. Each is an ordinary collection definition, and a space learns
 * one the same way it learns any other, when someone defines it there:
 *
 * ```ts
 * import { reaction, comment, useSchemas } from '@minca/std';
 *
 * await useSchemas(node, space.id, [reaction, comment]);
 * await node.records.put(space.id, reaction, { emoji: '👍' }, {
 *   links: [{ rel: 'about', to: post.key }],
 * });
 * ```
 *
 * The point of sharing them is agreement, not privilege: two apps that both
 * use `std.reaction` see each other's reactions. An app that prefers its own
 * shape defines its own collection instead, and loses nothing but that.
 *
 * **Two kinds.** Annotations attach to anything (their links point at
 * `'*'`): reactions, comments, ratings, bookmarks. Nouns are the things apps
 * keep — messages, tasks, events, lists, photos, expenses — shared so that two
 * chat apps, or a board and a to-do list, read the same records. Nouns say
 * exactly what they point at. `standardGroups` lists them all by area.
 *
 * They follow a few conventions: what several people edit is several records,
 * not an array in one body; "one per person" is `onePer`; bodies carry no
 * `createdAt`, since the record has one; times, money, places, people and
 * files use the same `fragments` everywhere; and link roles share one
 * vocabulary — `about`, `replyTo`, `root`, `parent`, `in`, `shares`.
 *
 * Nouns that keep a hand-made order carry a `position`: a string that sorts
 * where the record goes. {@link positionBetween} makes one between two others,
 * so moving a card rewrites only that card, and two people moving cards at
 * once never renumber each other's. It is optional, so a record made by
 * something that knows nothing of order still counts: it goes at the end.
 */
import type { DefineCollection, P2PNode } from '@minca/core';
import { definedNames } from '@minca/core/schemas';
export * from './library/annotations.js';
export * from './library/social.js';
export * from './library/publishing.js';
export * from './library/media.js';
export * from './library/planning.js';
export * from './library/life.js';
export * from './library/money.js';
export * from './library/community.js';
export * from './library/collections.js';
export {
  CELL_PRECISIONS,
  geohash,
  cellOf,
  centreOf,
  aroundCell,
  cellsOf,
  cellsAround,
  distanceKm,
  type Cell,
} from './geo.js';
export {
  standardAnnotations,
  standardGroups,
  standardNouns,
  standardSchemas,
  standardDefinition,
} from './standard.js';
export {
  checkBlueprint,
  reviewBlueprint,
  standardCollections,
  supersededBlueprints,
  proposeCollections,
  applyBlueprint,
  copyBlueprint,
  tryContracts,
} from './blueprints.js';
export type { BlueprintReview, CollectionReview, ContractExample, ReviewContext } from './blueprints.js';
export { CHOOSING, lookalikes } from './choosing.js';
export { guidesOf, writeGuide } from './guides.js';

const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz';

/**
 * A `position` that sorts after `before` and ahead of `after` — either may be
 * missing, for the ends. Positions compare as plain strings and never end in
 * `0`, so there is always room for another between any two. Equal positions
 * (two people dropping in the same spot at once) are fine; sort those by key.
 */
export function positionBetween(before?: string | null, after?: string | null): string {
  const a = before ?? '';
  let b = after && after > a ? after : null;
  let out = '';
  for (let i = 0; ; i++) {
    const low = digitAt(a, i);
    const high = b === null ? DIGITS.length : digitAt(b, i);
    const mid = middleDigit(low, high, i < a.length, b !== null);
    if (mid > low && mid < high) return out + DIGITS[mid];
    out += DIGITS[low];
    // Adjacent digits: keep the lower one, and anything above the rest of `a` will do.
    if (low !== high) b = null;
  }
}

const digitAt = (text: string, i: number) => (i < text.length ? DIGITS.indexOf(text[i]!) : 0);

/** At an open end, step by one rather than halving, so a list that only grows at one end keeps short positions */
function middleDigit(low: number, high: number, insideBefore: boolean, bounded: boolean): number {
  if (insideBefore && !bounded) return low + 1;
  if (!insideBefore && bounded) return high - 1;
  return Math.floor((low + high) / 2);
}

/**
 * Makes sure a space knows these collections: defines the ones it has no
 * definition for, and leaves the rest alone — so calling it every time a
 * space opens is fine, and it never bumps a definition someone else owns.
 * A space you cannot write in is skipped.
 */
export async function useSchemas(
  node: P2PNode,
  spaceId: string,
  schemas: ReadonlyArray<DefineCollection>,
): Promise<void> {
  const summary = await node.spaces.get(spaceId);
  if (!summary?.writable) return;
  const known = await definedNames(node, spaceId);
  for (const schema of schemas) {
    if (!known.has(schema.name)) await node.collections.define(spaceId, schema);
  }
}
