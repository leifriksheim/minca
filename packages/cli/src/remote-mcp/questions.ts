/**
 * What a call asks the person before it runs, where their chat app can show
 * them a form (MCP elicitation): which space, when the call names none, and
 * whether to delete a record. The app sends the same call again with the
 * answer, so nothing is kept here between the two.
 *
 * An answer comes from the chat app, as the call's own arguments do: a space
 * it names is checked against the grant like any other.
 */
import {
  inputRequired,
  inputResponse,
  type CallToolResult,
  type ClientCapabilities,
  type InputRequiredResult,
} from '@modelcontextprotocol/server';

export interface ReachedSpace {
  readonly id: string;
  readonly name: string;
}

/** What a call answers with instead of running: a question for the person, or why it didn't run */
export type AnsweredInstead = InputRequiredResult | CallToolResult;

/** What a question came to: its answer, or what the call answers with until there is one */
export type Settled<T> = { readonly settled: T } | { readonly instead: AnsweredInstead };

const notDone = (text: string): CallToolResult => ({ content: [{ type: 'text', text }], isError: true });

const SPACE_QUESTION = 'space';
const DELETE_QUESTION = 'delete';

/** How much of a record the person is shown before it goes */
const PREVIEW_CHARACTERS = 200;

/** Whether the chat app shows its person a form: one that only opens links can't ask these */
export function showsForms(capabilities: ClientCapabilities | undefined): boolean {
  const elicitation = capabilities?.elicitation;
  return elicitation !== undefined && (elicitation.form !== undefined || elicitation.url === undefined);
}

const nameAndId = (space: ReachedSpace) => `${space.name} (${space.id})`;

/**
 * A space as the person is shown it: its name on one line, and the start of
 * its id. Anyone may give a space any name, one of hers or one like it, so
 * the id is what tells two apart; it doesn't say which is hers.
 */
const titleOf = (space: ReachedSpace) =>
  `${space.name.replace(/\s+/g, ' ').trim()} (${space.id.slice(0, 8)}…)`;

/**
 * The space a call that named none runs in: the only one the connection was
 * given, or the one the person picks. `carried` is the space an earlier
 * question of the same call settled.
 *
 * A connection given every space is never settled for the person: its list
 * is what its node has synced so far, and one space there may be one of many.
 */
export function chooseSpace(asked: {
  readonly toolTitle: string;
  readonly reached: ReadonlyArray<ReachedSpace>;
  /** Whether `reached` is the grant's own list, signed and whole, rather than what a node holds now */
  readonly reachedIsWhole: boolean;
  readonly answers: Record<string, unknown> | undefined;
  readonly carried: string | undefined;
  readonly showsForms: boolean;
}): Settled<ReachedSpace> {
  const { reached } = asked;
  const reachedSpaceWithId = (id: unknown): Settled<ReachedSpace> => {
    const space = reached.find((one) => one.id === id);
    return space ? { settled: space } : { instead: notDone('That isn’t a space this connection reaches.') };
  };
  if (asked.carried !== undefined) return reachedSpaceWithId(asked.carried);
  const answer = inputResponse(asked.answers, SPACE_QUESTION);
  if (answer.kind === 'elicit')
    return answer.action === 'accept'
      ? reachedSpaceWithId(answer.content?.[SPACE_QUESTION])
      : { instead: notDone('The person didn’t pick a space, so nothing was done.') };
  const [only, ...others] = reached;
  if (only === undefined) return { instead: notDone('This connection reaches no space yet.') };
  if (others.length === 0 && asked.reachedIsWhole) return { settled: only };
  if (!asked.showsForms)
    return {
      instead: notDone(
        `Say which space, as "space". This connection reaches: ${reached.map(nameAndId).join(', ')}. ` +
          'Ask the person if it isn’t clear which they mean.',
      ),
    };
  return {
    instead: inputRequired({
      inputRequests: {
        [SPACE_QUESTION]: inputRequired.elicit({
          message: `${asked.toolTitle}: in which space?`,
          requestedSchema: {
            type: 'object',
            properties: {
              [SPACE_QUESTION]: {
                type: 'string',
                title: 'Space',
                oneOf: reached.map((space) => ({ const: space.id, title: titleOf(space) })),
              },
            },
            required: [SPACE_QUESTION],
          },
        }),
      },
    }),
  };
}

/** Said after a call that named no space, so the next one names it */
export const ranInSpace = (space: ReachedSpace) =>
  `The call named no space, so it ran in ${nameAndId(space)}. Pass that id as "space" from here on.`;

/** One line of what a record holds, as its body is: what other people wrote, shown to the person, never the model */
function previewOf(body: unknown): string {
  const line = JSON.stringify(body) ?? '';
  return line.length > PREVIEW_CHARACTERS ? `${line.slice(0, PREVIEW_CHARACTERS)}…` : line;
}

export interface RecordToDelete {
  readonly space: ReachedSpace;
  readonly collection: string;
  readonly body: unknown;
}

/**
 * What a delete answers with until the person, shown what goes, has said
 * yes: null once they have, or when there is no such record to show. Asked
 * with the space the call runs in, so one picked a question earlier is still
 * the one deleted from.
 */
export async function askBeforeDelete(
  answers: Record<string, unknown> | undefined,
  findRecord: () => Promise<RecordToDelete | null>,
): Promise<AnsweredInstead | null> {
  const answer = inputResponse(answers, DELETE_QUESTION);
  if (answer.kind === 'elicit')
    return answer.action === 'accept'
      ? null
      : notDone('The person chose not to delete it, so it is still there.');
  const record = await findRecord();
  if (record === null) return null;
  return inputRequired({
    inputRequests: {
      [DELETE_QUESTION]: inputRequired.elicit({
        message:
          `Delete this ${record.collection} record from ${titleOf(record.space)}, for every member?\n\n` +
          previewOf(record.body),
        requestedSchema: { type: 'object', properties: {} },
      }),
    },
    requestState: record.space.id,
  });
}
