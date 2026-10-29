/**
 * Contacts, as standard collections — the protocol knows none of them.
 *
 * A contact is someone you share a private space for two with. Your list of
 * them is `std.contact` records in your contacts space, which only your
 * account can find (`deriveContactsSpace`). Your inbox's settings, and the
 * knocks you left on other people's, are kept there too, so every device of
 * the account reads the same ones.
 *
 * `node.contacts` and `node.inbox` do the work with them; these are here so
 * apps can read and query the records like any other.
 */
import { define } from './fragments.js';
import type { BodyOf } from '../query/types.js';

/** Someone you can reach, and the space you share with them. One per person. */
export const contact = define({
  name: 'std.contact',
  title: 'Contact',
  description: 'Someone you can reach, and the space you share with them.',
  schema: {
    type: 'object',
    properties: {
      did: { type: 'string', maxLength: 256, description: 'Their account' },
      name: { type: 'string', maxLength: 200, description: 'What you call them' },
      space: { type: 'string', maxLength: 256, description: 'The id of your space for two' },
      note: { type: 'string', maxLength: 2000 },
      blocked: { type: 'boolean', description: 'Their knocks are hidden, in every space and in your inbox' },
      username: {
        type: 'string',
        maxLength: 320,
        description: 'Their username, when you found them by it: name@domain',
      },
    },
    required: ['did', 'name'],
  },
  rules: { onePer: ['did'] },
});
export type Contact = BodyOf<typeof contact>;

/** A knock left in a space both belong to: sealed to their contact key, so only they open it. */
export const contactRequest = define({
  name: 'std.contact-request',
  title: 'Contact request',
  description: 'A knock left for someone in a space you share, sealed so only they can open it.',
  schema: {
    type: 'object',
    properties: {
      to: { type: 'string', maxLength: 64, description: 'Their contact key, as on their profile here' },
      sealed: { type: 'string', maxLength: 16000, description: 'The knock, sealed to it (spec 07 §6)' },
    },
    required: ['to', 'sealed'],
  },
});
export type ContactRequestRecord = BodyOf<typeof contactRequest>;

/**
 * Your inbox (`node.inbox`): which one it is and where its knocks wait. Its
 * keys are derived from the contact key and `gen`; a new `gen` is a new inbox,
 * and codes for the old one stop working. The newest record is the inbox.
 */
export const inbox = define({
  name: 'std.inbox',
  title: 'Inbox',
  description: 'Where people you share no space with can ask to become your contact.',
  schema: {
    type: 'object',
    properties: {
      gen: { type: 'integer', minimum: 0, description: 'Which inbox: its keys are derived from it' },
      places: {
        type: 'array',
        items: { type: 'string', maxLength: 200 },
        minItems: 1,
        maxItems: 3,
        description: 'Whose mailboxes hold its knocks',
      },
      name: {
        type: 'string',
        maxLength: 64,
        description: 'The name its code gives, shown to whoever knocks',
      },
      username: { type: 'string', maxLength: 320, description: 'The username that leads to it: name@domain' },
      usernameUntil: { type: 'number', description: 'When the username lapses unless claimed again, ms' },
    },
    required: ['gen', 'places'],
  },
});
export type Inbox = BodyOf<typeof inbox>;

/**
 * A knock you left on someone's inbox, waiting for them to join the space for
 * two. You don't know who they are until they do; then it becomes a
 * `std.contact`, and this goes.
 */
export const knock = define({
  name: 'std.knock',
  title: 'Knock',
  description: 'A knock left on an inbox, waiting for them to join.',
  schema: {
    type: 'object',
    properties: {
      space: { type: 'string', maxLength: 256, description: 'The space for two it invites them to' },
      name: { type: 'string', maxLength: 64, description: 'The name their inbox code gave' },
      invite: { type: 'string', maxLength: 12000, description: 'The invite sent, to close once they join' },
      username: {
        type: 'string',
        maxLength: 320,
        description: 'The username you knocked on, when it was one',
      },
    },
    required: ['space', 'name', 'invite'],
  },
  rules: { onePer: ['space'] },
});
export type Knock = BodyOf<typeof knock>;

/**
 * An invite to a space, left for a contact in your space for two with them:
 * only the two of you read it there, so it needs no sealing. What space it is,
 * and its name, are read from the signed invite; `space` only keys the record.
 * Joining deletes it, and the inviter closes the invite once they are in.
 */
export const spaceInvite = define({
  name: 'std.space-invite',
  title: 'Space invite',
  description: 'An invite to a space, left for a contact in your space for two.',
  schema: {
    type: 'object',
    properties: {
      space: { type: 'string', maxLength: 256, description: 'The space it invites them to' },
      invite: { type: 'string', maxLength: 12000, description: 'The invite, as spaces.join takes it' },
    },
    required: ['space', 'invite'],
  },
  rules: { onePer: ['space'] },
});
export type SpaceInviteRecord = BodyOf<typeof spaceInvite>;
