/**
 * The space's own collections: blueprints of collections someone proposes,
 * and guides to how the ones it has are meant to be used. Neither is about
 * any one app. How they are used is in `schemas/blueprints.ts` and
 * `schemas/guides.ts`.
 */
import type { JsonSchema } from '../../schema/collection-def.js';
import type { LinkDeclaration } from '../../records/links.js';
import type { CollectionRules } from '../../records/rules.js';
import type { BodyOf } from '../../query/types.js';
import { define, typed } from '../fragments.js';

/** One collection a blueprint would add, as `collections_define` takes it, without a version: the space decides that */
export interface DraftCollection {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly schema: JsonSchema;
  readonly history?: 'latest' | 'all';
  readonly links?: Readonly<Record<string, LinkDeclaration>>;
  readonly permissions?: ReadonlyArray<string>;
  readonly rules?: CollectionRules;
  /** Fields whose values keepers can match without reading: `mentions`, `channel` */
  readonly topics?: ReadonlyArray<string>;
}

export interface Blueprint {
  /** What it is for, in a few words: "Carpool" */
  readonly title: string;
  /** What it is for, in its proposer's words: shown as theirs, never as what it does */
  readonly description?: string;
  readonly collections: ReadonlyArray<DraftCollection>;
  /** Where it was copied from: `<space id>/<record key>` */
  readonly from?: string;
  /** The key of the blueprint in this space that this one is a new version of */
  readonly updates?: string;
}

/** At most this many collections in one blueprint */
export const MAX_BLUEPRINT_COLLECTIONS = 10;

/** Collections someone proposes for the space: what they are for, and each definition, not yet added. */
export const blueprint = typed<Blueprint>()({
  name: 'std.blueprint',
  title: 'Blueprint',
  description: 'Collections someone proposes for this space, not yet added.',
  schema: {
    type: 'object',
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 100 },
      description: { type: 'string', maxLength: 1000 },
      collections: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_BLUEPRINT_COLLECTIONS,
        items: { type: 'object' },
      },
      from: { type: 'string', maxLength: 300 },
      updates: { type: 'string', minLength: 1, maxLength: 100 },
    },
    required: ['title', 'collections'],
  },
  permissions: ['moderate'],
  rules: { edit: 'creator', delete: ['creator', 'can:moderate'] },
});

/**
 * How some of the space's collections are meant to be used, for whoever
 * writes to them next. One of each name: whoever writes it first holds it.
 */
export const guide = define({
  name: 'std.guide',
  title: 'Guide',
  description: 'How some of the space’s collections are meant to be used, for whoever writes to them next.',
  schema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        minLength: 1,
        maxLength: 100,
        description: 'Which guide, so there is one of each: "launcher.apps"',
      },
      title: { type: 'string', minLength: 1, maxLength: 200 },
      text: { type: 'string', minLength: 1, maxLength: 20000 },
      collections: {
        type: 'array',
        maxItems: 16,
        items: { type: 'string', minLength: 1, maxLength: 200 },
        description: 'The collections it is about',
      },
    },
    required: ['name', 'title', 'text'],
  },
  permissions: ['moderate'],
  rules: { edit: 'creator', delete: ['creator', 'can:moderate'], onePer: ['name'] },
});
export type Guide = BodyOf<typeof guide>;

export const collectionsGroups = { Collections: [blueprint, guide] };
