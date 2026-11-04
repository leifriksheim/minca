/**
 * The catalogues the docs show, written from the code itself so they can't
 * drift: every standard collection, from its definition, and every node
 * action, from NODE_ACTIONS. scripts/sync.mjs runs this and puts each where a
 * page says `<!-- catalogue: name -->`. Prints them as JSON.
 */
import { NODE_ACTIONS } from '../../../packages/core/src/node/actions.ts';
import {
  contact,
  contactRequest,
  inbox,
  knock,
  spaceInvite,
  standardGroups,
} from '../../../packages/core/src/schemas/index.ts';

type Schema = {
  type?: string;
  properties?: Record<string, Schema>;
  required?: ReadonlyArray<string>;
  items?: Schema;
  enum?: ReadonlyArray<unknown>;
  oneOf?: ReadonlyArray<{ const?: unknown }>;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  maxItems?: number;
  'x-kind'?: string;
};
type Definition = {
  name: string;
  description?: string;
  schema?: Schema;
  topics?: ReadonlyArray<string>;
  links?: Record<string, { to: string | ReadonlyArray<string>; cardinality?: string }>;
  rules?: { onePer?: ReadonlyArray<string>; fixed?: ReadonlyArray<string>; final?: ReadonlyArray<string> };
  contract?: unknown;
};

const code = (text: string) => `\`${text}\``;
/** A table cell can't hold a pipe or a line break. */
const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');

/** `a–b`, `≤ b` or `≥ a` for a range, or nothing. */
function range(min: number | undefined, max: number | undefined): string {
  if (min !== undefined && max !== undefined) return ` ${min}–${max}`;
  if (max !== undefined) return ` ≤ ${max}`;
  if (min !== undefined) return ` ≥ ${min}`;
  return '';
}

/** A value's shape, the way the tables read: `string 1–200`, `DID[] (≤ 64)`, `a`/`b`. */
function shape(schema: Schema): string {
  const choices = schema.enum ?? schema.oneOf?.map((option) => option.const);
  if (choices) return choices.map((choice) => code(String(choice))).join('/');
  if (schema['x-kind'] === 'did') return 'DID';
  if (schema.type === 'array' && schema.items) {
    return `${shape(schema.items)}[]${schema.maxItems === undefined ? '' : ` (≤ ${schema.maxItems})`}`;
  }
  if (schema.type === 'object' && schema.properties) return `{ ${fields(schema)} }`;
  const kind = schema['x-kind'] ?? schema.type ?? 'any';
  if (schema.type === 'string') return `${kind}${range(schema.minLength, schema.maxLength)}`;
  if (schema.type === 'integer' || schema.type === 'number')
    return `${kind}${range(schema.minimum, schema.maximum)}`;
  return kind;
}

/** An object's fields, the required ones in bold. */
function fields(schema: Schema): string {
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties ?? {})
    .map(([name, field]) => `${required.has(name) ? `**${code(name)}**` : code(name)} ${shape(field)}`)
    .join('; ');
}

function body(definition: Definition): string {
  const topics = definition.topics?.length
    ? `; ${definition.topics.length === 1 ? 'topic' : 'topics'} ${definition.topics.map(code).join(', ')}`
    : '';
  return (definition.schema ? fields(definition.schema) : '') + topics || '—';
}

function links(definition: Definition): string {
  const entries = Object.entries(definition.links ?? {});
  if (!entries.length) return '—';
  return entries
    .map(([rel, link]) => {
      const to = typeof link.to === 'string' ? code(link.to) : link.to.map(code).join(', ');
      return `${code(rel)} → ${to}, ${link.cardinality === 'one' ? 'one' : 'many'}`;
    })
    .join('; ');
}

function rules(definition: Definition): string {
  const kept = (['onePer', 'fixed', 'final'] as const)
    .filter((rule) => definition.rules?.[rule]?.length)
    .map((rule) => code(`${rule}: [${definition.rules?.[rule]?.join(', ')}]`));
  if (definition.contract) kept.push('a contract');
  return kept.join('; ') || '—';
}

function table(definitions: ReadonlyArray<Definition>): string {
  return [
    '| Name | What it is | Body | Links | Rules |',
    '| --- | --- | --- | --- | --- |',
    ...definitions.map((d) =>
      [code(d.name), d.description ?? '', body(d), links(d), rules(d)]
        .map(cell)
        .join(' | ')
        .replace(/^/, '| ')
        .concat(' |'),
    ),
  ].join('\n');
}

const groups: Record<string, ReadonlyArray<Definition>> = {
  ...standardGroups,
  'Contacts and inboxes': [contact, contactRequest, inbox, knock, spaceInvite],
};
const standard = Object.entries(groups)
  .map(([group, definitions]) => `### ${group}\n\n${table(definitions)}`)
  .join('\n\n');

const flags = (action: (typeof NODE_ACTIONS)[number]) =>
  [
    action.readOnly && 'reads only',
    action.sensitive && 'sensitive',
    action.destructive && 'destructive',
    action.peerContent && "others' content",
  ]
    .filter(Boolean)
    .join(', ') || '—';
const input = (action: (typeof NODE_ACTIONS)[number]) => {
  const required = new Set(action.input.required ?? []);
  return (
    Object.keys(action.input.properties)
      .map((name) => (required.has(name) ? `**${code(name)}**` : code(name)))
      .join(', ') || '—'
  );
};
const actions = [
  '| Action | Does | Input | |',
  '| --- | --- | --- | --- |',
  ...NODE_ACTIONS.map(
    (action) =>
      `| ${[code(action.name), action.description, input(action), flags(action)].map(cell).join(' | ')} |`,
  ),
].join('\n');

console.log(JSON.stringify({ standard, actions }));
