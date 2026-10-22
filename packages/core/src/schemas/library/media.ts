/**
 * Lists, files and media. A list is a record and each item another, linked
 * `in` it, so two people ticking items at once never undo each other.
 */
import {
  about,
  blob,
  count,
  one,
  person,
  placeRef,
  position,
  text,
  define,
  url,
  when,
  words,
} from '../fragments.js';
import type { BodyOf } from '../../query/types.js';

/**
 * A list of anything: shopping, packing, reading, people, a playlist. `kind`
 * is a hint for how to show it, not a constraint.
 */
export const list = define({
  name: 'std.list',
  title: 'List',
  description:
    'A named, ordered group of anything that exists while empty: a checklist, a folder, an album, a playlist, a category (`kind`). Each member is a std.list-item in it, about the record it stands for. For loose labels, use std.tag.',
  schema: {
    type: 'object',
    properties: {
      title: words(200),
      description: text(2000),
      icon: text(16, 'An emoji'),
      kind: text(32, 'How to show it, like "checklist", "shopping", "reading", "people" or "playlist"'),
    },
    required: ['title'],
  },
});
export type List = BodyOf<typeof list>;

/** One thing on a list: some text, a web page, a person, or a record it is `about`. */
export const listItem = define({
  name: 'std.list-item',
  title: 'List item',
  description: 'One thing on a list: text, a link, a person or a record.',
  schema: {
    type: 'object',
    properties: {
      text: text(1000),
      url: url(),
      did: person('A person on the list'),
      checked: { type: 'boolean' },
      quantity: { type: 'number', minimum: 0 },
      position: position('Sorts where it goes in its list'),
    },
  },
  links: { in: one(['std.list'], 'The list it is on'), about: about('A record it stands for') },
  topics: ['did'],
});
export type ListItem = BodyOf<typeof listItem>;

/**
 * A file kept in the space, or one kept elsewhere at `url`: the one record for
 * every file, whatever app shares it. A photo, a video or a song's audio is a
 * file with the fields that suit it. `about` is the record it was shared on or
 * attached to, like a message or a task; a file shared on its own has none.
 * Groups of files (folders, albums, categories) are `std.list`s with an item
 * about each file, so one file can be in many.
 */
export const file = define({
  name: 'std.file',
  title: 'File',
  description:
    'Any file people share: a document, photo, video or recording, on its own or attached to a record (about). The only collection for files: a photo or video is a std.file too. For a folder, album or category of files, use std.list with a std.list-item about each file.',
  schema: {
    type: 'object',
    properties: {
      name: words(255),
      mime: { type: 'string', minLength: 1, maxLength: 255 },
      size: count(0),
      blob: blob('Its bytes, kept in the space'),
      url: url('Where it is, when it is kept elsewhere'),
      alt: text(2000, 'What it shows'),
      width: count(1),
      height: count(1),
      duration: { type: 'number', minimum: 0, description: 'Seconds, for a video or a sound' },
      takenAt: when('When it was taken or recorded'),
      place: placeRef('Where it was taken'),
      thumbnail: blob('A still to show before a video plays'),
      captions: blob('WebVTT'),
    },
    required: ['name', 'mime'],
  },
  links: { about: about('The record it was shared on or attached to') },
});
export type FileRecord = BodyOf<typeof file>;

const trackFields = {
  title: words(300),
  artists: { type: 'array', maxItems: 20, items: words(200) },
  album: text(300),
  duration: { type: 'number', minimum: 0, description: 'Seconds' },
  isrc: text(12, 'International Standard Recording Code'),
  mbid: text(36, 'MusicBrainz recording id'),
} as const;

/** A piece of music, known by its ids; `file` when the space holds the audio. */
export const track = define({
  name: 'std.track',
  title: 'Track',
  description:
    'A piece of music, by title, artists and ids. Its audio, when the space holds it, is a std.file it links to. A playlist is a std.list.',
  schema: { type: 'object', properties: { ...trackFields }, required: ['title'] },
  links: { file: one(['std.file'], 'The audio') },
});
export type Track = BodyOf<typeof track>;

/** A track someone listened to, and when: a listening history. */
export const play = define({
  name: 'std.play',
  title: 'Play',
  description: 'A track someone listened to, and when: about the std.track when the space has it.',
  schema: {
    type: 'object',
    properties: { ...trackFields, playedAt: when() },
    required: ['title', 'playedAt'],
  },
  links: { about: one(['std.track'], 'The track, when the space has it') },
});
export type Play = BodyOf<typeof play>;

/** This file's part of `standardGroups` */
export const mediaGroups = {
  Lists: [list, listItem],
  'Files and media': [file, track, play],
};
