/**
 * What a collection allows, in plain sentences — worked out from its rules,
 * never taken from what anyone says about it.
 *
 * A definition's title and description are the author's words, and an agent
 * can write anything there: "a friendly poll" whose rules let anyone delete
 * anyone's vote. These sentences come from the rules every peer enforces, so
 * a person deciding whether to add a collection reads what it will actually
 * do.
 *
 * Every rule must say something. A rule this module doesn't know makes it
 * throw rather than fall silent — a summary that leaves out a rule is the
 * lie it exists to prevent.
 */
import type { CollectionRules } from './rules.js';
import type { DefineCollection } from '../node/types.js';
import { storedContract } from './contract-builder.js';
import type { LinkDeclaration } from './links.js';
import { isList, isObject } from '../utils/guards.js';

/** As much of a definition as a summary reads */
export interface Describable {
  readonly name: string;
  readonly title?: string;
  /** Plain JSON Schema; field titles are used when it has them */
  readonly schema?: unknown;
  readonly history?: 'latest' | 'all';
  readonly links?: Readonly<Record<string, LinkDeclaration>>;
  readonly rules?: CollectionRules;
  /** As stored, or built in TypeScript */
  readonly contract?: DefineCollection['contract'];
}

/** Every rule there is. A new one in `CollectionRules` must be added here, with its sentence. */
const KNOWN_RULES = ['create', 'edit', 'delete', 'onePer', 'fixed', 'final'] as const;

/** `closePolls` → `close polls`, `app.carpool.trip` → `trip` */
const words = (name: string) =>
  name
    .replace(/^.*\./, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase();

const article = (noun: string) => (/^[aeiou]/.test(noun) ? `an ${noun}` : `a ${noun}`);
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

function joinOr(parts: ReadonlyArray<string>): string {
  return parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} or ${parts.at(-1)}`;
}

function joinAnd(parts: ReadonlyArray<string>): string {
  return parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

/** A field's label: its schema title, else its name in words */
function fieldLabel(schema: unknown, field: string): string {
  const properties = isObject(schema) ? schema.properties : undefined;
  const property = isObject(properties) ? properties[field] : undefined;
  const title = isObject(property) ? property.title : undefined;
  return typeof title === 'string' && title.trim() ? title.trim().toLowerCase() : words(field);
}

/** What a link role points at, in words: "trip", or "poll or proposal", when it names collections, else the role's own name */
function linkTarget(definition: Describable, rel: string): string {
  const to = definition.links?.[rel]?.to;
  return to !== undefined && isList(to) ? joinOr(to.map(words)) : words(rel);
}

/**
 * The collection's rules, links and history as short sentences, in a fixed
 * order: who may add, who may change or remove, what must be unique, what
 * can't change, what it points at, which permissions roles can hold, and
 * whether old versions are kept.
 *
 * @throws When the rules hold something this doesn't know how to say
 */
export function describeCollection(definition: Describable): ReadonlyArray<string> {
  const rules = definition.rules ?? {};
  const unknown = Object.keys(rules).find((key) => !KNOWN_RULES.some((rule) => rule === key));
  if (unknown) throw new Error(`No way to describe the rule "${unknown}" — add it to records/describe.ts`);

  const noun = (definition.title?.trim() || words(definition.name)).toLowerCase();
  const a = article(noun);
  const sentences: string[] = [];

  // Who may add, change or remove it is the space's grants, not the definition's (spec 02 §7).
  if (rules.final) sentences.push(`Nobody can change or remove ${a} once it is added.`);

  // One per…
  if (rules.onePer?.length) {
    const per = rules.onePer.map((part) =>
      part === '@author'
        ? 'person'
        : part.startsWith('link:')
          ? linkTarget(definition, part.slice(5))
          : fieldLabel(definition.schema, part),
    );
    const perText = `One ${noun} per ${per.join(' per ')}`;
    if (rules.final) sentences.push(`${perText} — the first one added holds it.`);
    else if (rules.onePer.includes('@author'))
      sentences.push(`${perText} — adding another changes the first.`);
    // Not per person: a second one is a change to the first, by whoever may change it.
    else sentences.push(`${perText} — anyone adding another replaces the first.`);
  }

  // Fixed fields
  if (rules.fixed?.length) {
    const fields = rules.fixed.map((field) => `“${fieldLabel(definition.schema, field)}”`);
    sentences.push(`Once ${a} is added, its ${joinAnd(fields)} can't be changed.`);
  }

  // Checks: their own words, which are what a refusal says
  for (const check of storedContract({
    name: definition.name,
    schema: definition.schema,
    ...(definition.contract ? { contract: definition.contract } : {}),
  })?.check ?? [])
    sentences.push(`Every change is checked: “${check.else.trim()}”`);

  // What it points at
  for (const [rel, link] of Object.entries(definition.links ?? {})) {
    const target =
      link.to === '*' ? 'anything in the space' : joinOr(link.to.map((to) => article(words(to))));
    // The link's own name only when it says something the target doesn't: "about", not "trip" → a trip.
    const named =
      isList(link.to) && link.to.length === 1 && words(link.to[0]!) === words(rel) ? '' : ` (“${rel}”)`;
    sentences.push(
      link.cardinality === 'one'
        ? `Each ${noun} points at one thing: ${target}${named}.`
        : `${capital(a)} can point at ${target}${named}.`,
    );
  }

  if (definition.history === 'all') sentences.push(`Every earlier version of ${a} is kept.`);

  return sentences;
}
