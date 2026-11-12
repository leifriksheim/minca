import { define, person, text } from './fragments.js';
import type { BodyOf } from '../query/types.js';

/**
 * A direct message between some members of a space: its text is sealed so
 * only the people in `to` and whoever wrote it can read it, with each one's
 * member key (`docs/direct-messages.md`). Other members see who wrote to whom and
 * when, not what. `to` is a topic, so "sent to me" can be asked of a carrier
 * that can't read it. Write and read it through `node.direct`.
 */
export const direct = define({
  name: 'std.direct',
  title: 'Direct message',
  description: 'A message only the people it is sent to can read.',
  schema: {
    type: 'object',
    properties: {
      to: {
        type: 'array',
        items: person(),
        minItems: 1,
        maxItems: 16,
        description: 'Who it is for, not whoever wrote it',
      },
      data: text(60000, 'The text, sealed with the message key'),
      boxes: {
        type: 'array',
        maxItems: 17,
        description: 'The message key, sealed to each reader: everyone in `to`, and whoever wrote it',
        items: {
          type: 'object',
          properties: { to: person(), sealed: text(1000) },
          required: ['to', 'sealed'],
        },
      },
    },
    required: ['to', 'data', 'boxes'],
  },
  topics: ['to'],
});
export type Direct = BodyOf<typeof direct>;
