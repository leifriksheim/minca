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
    },
    required: ['did', 'name'],
  },
  rules: { onePer: ['did'] },
});
export type Contact = BodyOf<typeof contact>;

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
    },
    required: ['space', 'name', 'invite'],
  },
  rules: { onePer: ['space'] },
});
export type Knock = BodyOf<typeof knock>;
