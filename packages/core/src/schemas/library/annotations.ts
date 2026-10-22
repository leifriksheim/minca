/** Annotations: records that attach to any other record with an `about` link. */
import { about, choice, count, people, person, text, define, words } from '../fragments.js';
import type { BodyOf } from '../../query/types.js';

/** An emoji reaction to any record. Link it: `{ rel: 'about', to: <key> }`. */
export const reaction = define({
  name: 'std.reaction',
  title: 'Reaction',
  description: 'An emoji reaction to any record.',
  schema: {
    type: 'object',
    properties: {
      respondingTo: person('Whose record it responds to, so they can be told'),
      emoji: { type: 'string', minLength: 1, maxLength: 16 },
    },
    required: ['emoji'],
  },
  links: { about: about('The record reacted to') },
  // One of each emoji per person per record; only yours to take back.
  rules: { onePer: ['@author', 'link:about', 'emoji'] },
  topics: ['respondingTo'],
});
export type Reaction = BodyOf<typeof reaction>;

/**
 * A comment on any record, optionally a reply to another comment. As on a
 * `std.message`, `mentions` names who it calls on and `replyingTo` whose
 * comment it answers, and both are topics: "mentions me" and "replies to me"
 * can be asked of a keeper that can't read it. Commenting is also how to
 * mention someone on a record of any kind, whatever its own definition holds.
 */
export const comment = define({
  name: 'std.comment',
  title: 'Comment',
  description: 'A comment on any record, optionally replying to another comment. To chat, use std.message.',
  schema: {
    type: 'object',
    properties: {
      respondingTo: person('Whose record it responds to, so they can be told'),
      text: { type: 'string', minLength: 1, maxLength: 10000 },
      mentions: people(64, 'Who it mentions, so they can be told'),
      replyingTo: person('Whose comment it replies to, so they can be told'),
    },
    required: ['text'],
  },
  topics: ['mentions', 'replyingTo', 'respondingTo'],
  links: {
    about: about('The record commented on'),
    replyTo: { to: ['std.comment'], cardinality: 'one', description: 'The comment this replies to' },
  },
});
export type Comment = BodyOf<typeof comment>;

/** A label on one or more records. */
export const tag = define({
  name: 'std.tag',
  title: 'Tag',
  description:
    'A loose label on one record, like #urgent: many per record, and anyone may add one. For a named group that exists while empty, use std.list; for a moderator’s label that apps act on, use std.label.',
  schema: {
    type: 'object',
    properties: { label: { type: 'string', minLength: 1, maxLength: 100 } },
    required: ['label'],
  },
  links: { about: about('The record tagged') },
  rules: { onePer: ['@author', 'link:about', 'label'] },
});
export type Tag = BodyOf<typeof tag>;

/** One person's score for something, from 1 to 5, and what they thought. */
export const rating = define({
  name: 'std.rating',
  title: 'Rating',
  description: 'A score from 1 to 5, one per person per thing, changed by rating again.',
  schema: {
    type: 'object',
    properties: { score: count(1, 5), review: text(10000) },
    required: ['score'],
  },
  links: { about: about('What is rated') },
  rules: { onePer: ['@author', 'link:about'] },
});
export type Rating = BodyOf<typeof rating>;

/**
 * A passage marked in a longer text. `prefix` and `suffix` find it again when
 * the quote appears more than once (as W3C Web Annotation's text quote does).
 */
export const highlight = define({
  name: 'std.highlight',
  title: 'Highlight',
  description: 'A passage marked in a text, with an optional note.',
  schema: {
    type: 'object',
    properties: {
      quote: words(10000),
      prefix: text(500, 'Text just before the quote'),
      suffix: text(500, 'Text just after the quote'),
      note: text(10000),
    },
    required: ['quote'],
  },
  links: { about: about('The text highlighted') },
});
export type Highlight = BodyOf<typeof highlight>;

/** A record pinned where everyone sees it. Pinning is for moderators. */
export const pin = define({
  name: 'std.pin',
  title: 'Pin',
  description:
    'A record pinned for everyone by a moderator. To keep something for yourself, put it on a std.list.',
  schema: { type: 'object', properties: { note: text(500) } },
  links: { about: about('The record pinned') },
  rules: { onePer: ['link:about'] },
});
export type Pin = BodyOf<typeof pin>;

/** A report that something breaks the space's norms, for its moderators to see. */
export const report = define({
  name: 'std.report',
  title: 'Report',
  description: 'A report that a record breaks the rules, for moderators.',
  schema: {
    type: 'object',
    properties: {
      reason: choice(['spam', 'abuse', 'sexual', 'misleading', 'illegal', 'other']),
      note: text(2000),
    },
    required: ['reason'],
  },
  links: { about: about('The record reported') },
  rules: { onePer: ['@author', 'link:about'] },
});
export type Report = BodyOf<typeof report>;

/**
 * A moderator's label on a record, which apps act on: `nsfw` blurs, `spoiler`
 * hides until asked. Unlike a tag, only moderators add one.
 */
export const label = define({
  name: 'std.label',
  title: 'Label',
  description:
    'A moderator’s label that apps act on, like nsfw (blurred) or spoiler (hidden). Members label things with std.tag.',
  schema: {
    type: 'object',
    properties: { value: words(64, 'Like "nsfw", "spoiler", "outdated"') },
    required: ['value'],
  },
  links: { about: about('The record labelled') },
  rules: { onePer: ['link:about', 'value'] },
});
export type Label = BodyOf<typeof label>;

/**
 * "I'll take it": one claimer per thing. A potluck dish, a shift, a chore.
 * Whoever claims first holds it until they let it go.
 */
export const claim = define({
  name: 'std.claim',
  title: 'Claim',
  description:
    'Someone taking something on, one per thing, first come: a task, an item to bring, a std.slot to book.',
  schema: {
    type: 'object',
    properties: { respondingTo: person('Whose record it responds to, so they can be told'), note: text(500) },
  },
  links: { about: about('What is claimed') },
  rules: { onePer: ['link:about'] },
  topics: ['respondingTo'],
});
export type Claim = BodyOf<typeof claim>;

/** This file's part of `standardGroups` */
export const annotationGroups = {
  Annotations: [reaction, comment, tag, rating, highlight, pin, report, label, claim],
};
