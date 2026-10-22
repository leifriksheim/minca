/**
 * Which standard collection holds what: the short map an agent reads before
 * the library (`collections_standard`), and the look-alikes it is warned of
 * when it proposes a collection of its own that the library already has
 * (`collections_propose`). Apps read each other's records only when they
 * reach for the same collection, so the cheapest moment to steer is the one
 * where a twin is about to be made. See "How the library is shaped" in
 * `packages/core/docs/standard-library.md`.
 */
import type { DefineCollection } from '../node/types.js';
import { isRecord } from '../utils/guards.js';

/** What to use for what, one line each */
export const CHOOSING: ReadonlyArray<string> = Object.freeze([
  'Any file (a photo, video, recording, PDF): std.file. On a record, link it "about" that record.',
  'A group that exists while empty (a folder, album, playlist, category, checklist): std.list, with a std.list-item "in" it, "about" each member.',
  'A loose label on a record (#urgent): std.tag.',
  'Something to do: std.task, "in" a std.column on a board.',
  'Something happening at a time: std.event; answers to it: std.rsvp.',
  'Chat, in order: std.message, "in" a std.channel when there are several. A remark on a record: std.comment. A feed: std.post.',
  'A quick question: std.poll and std.vote. A decision: std.proposal, std.ballot and std.decision.',
  'Taking something on, first come (a task, a slot to book, an item to bring): std.claim.',
  'More fields on a standard record: a collection of your own with an "about" link to it and onePer ["link:about"]. Never a copy of the standard one.',
  'Where a record sits (a channel, column, list, calendar): the link role "in".',
]);

/** A definition's fields, when its schema is JSON Schema; a validator's (Zod and the like) say none */
const propertiesOf = (definition: DefineCollection): Readonly<Record<string, unknown>> => {
  const { schema } = definition;
  return isRecord(schema) && isRecord(schema.properties) ? schema.properties : {};
};

/** Whether a field holds a file, as `records.addFile` gives one */
const holdsFile = (definition: DefineCollection): boolean =>
  Object.values(propertiesOf(definition)).some(
    (field) =>
      isRecord(field) &&
      isRecord(field.properties) &&
      'hash' in field.properties &&
      'mime' in field.properties,
  );

/** Link roles that say where a record sits, which the library calls `in` */
const PLACES = [
  'folder',
  'album',
  'playlist',
  'category',
  'channel',
  'column',
  'board',
  'project',
  'calendar',
  'list',
];

/**
 * What in a collection of an app's own looks like one the library already
 * has, each as a sentence to show the agent proposing it. Not a refusal: an
 * app may have its reasons, and the person applying the blueprint decides.
 */
export function lookalikes(definition: DefineCollection): string[] {
  if (definition.name.startsWith('std.')) return [];
  const fields = new Set(Object.keys(propertiesOf(definition)));
  const has = (...names: string[]) => names.some((name) => fields.has(name));
  const said: string[] = [];
  const twin = (std: string, why: string) =>
    said.push(
      `${definition.name} ${why}, like ${std}. Use ${std} so other apps read these records; ` +
        `for fields of your own, keep a collection about each ${std} record instead.`,
    );
  if (holdsFile(definition) && !has('title', 'question', 'price')) twin('std.file', 'keeps a file');
  else if (has('start', 'startsAt') && has('title', 'name')) twin('std.event', 'is something at a time');
  else if (has('title') && has('done', 'due', 'assignees', 'status')) twin('std.task', 'is something to do');
  else if (has('question') && has('options')) twin('std.poll', 'asks a question with options');
  else if (has('emoji') && fields.size <= 2) twin('std.reaction', 'is a reaction');
  else if (has('label', 'tag') && fields.size <= 2) twin('std.tag', 'is a label');
  for (const role of Object.keys(definition.links ?? {}))
    if (PLACES.includes(role))
      said.push(
        `${definition.name} says where a record sits with "${role}": the library calls that link "in", ` +
          'so other apps follow it.',
      );
  return said;
}
