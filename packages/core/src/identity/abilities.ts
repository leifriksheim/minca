/**
 * @module identity/abilities
 * What a note lets its key do (spec 01 §8).
 *
 * A note (a delegation from the account, `identity/ucan.ts`) covers one
 * command, about the whole account or one space, under a policy. Writing a
 * record takes `/record/write`. Three more commands are checked by every
 * peer, so a note can leave them out and its key can't do those things
 * anywhere:
 *
 * - `/collection/define`: define, change or remove a space's collections;
 * - `/access/change`: anything else in the access history — roles, members,
 *   invites, revocations, the space's key, relays and keepers;
 * - `/account/write`, about the whole account: anything about the account
 *   itself — its own spaces (its list of spaces, a carrier's passes, its
 *   inbox, its knocks), its own place in any space, and its other keys.
 *
 * So a key is a device or an app by what its note says: a note for `/` about
 * the whole account acts as the account; anything narrower acts in spaces.
 * A key the account trusts less gets `/record`, and proposes what it can't do.
 */
import { DEFINITION_COLLECTION } from '../space/roles.js';
import { commandCovers, noteCovers, parseDelegation, type Delegation, type Requirement } from './ucan.js';
import type { Policy } from './policy.js';

/** Every command */
export const ALL_COMMAND = '/';
/** Records and nothing more */
export const RECORDS_COMMAND = '/record';
export const WRITE_COMMAND = '/record/write';
export const READ_COMMAND = '/record/read';
export const DEFINE_COMMAND = '/collection/define';
export const ACCESS_COMMAND = '/access/change';
export const ACCOUNT_COMMAND = '/account/write';

/** The prefix of a definition record's key, before the collection it defines (spec 02 §6.1) */
const DEFINITION_KEY = 'collection:';

/** What writing a version in a space needs: `/record/write`, with the space and the collection as arguments */
export const writeRequirement = (space: string, collection: string): Requirement => ({
  space,
  cmd: WRITE_COMMAND,
  args: { collection, space },
});

/**
 * What a change to the access history needs besides: `/collection/define`
 * for a definition, whose `collection` argument is the collection it
 * defines; `/access/change` for anything else, with the version's own.
 */
export const accessRequirement = (space: string, collection: string, key: string): Requirement =>
  collection === DEFINITION_COLLECTION
    ? {
        space,
        cmd: DEFINE_COMMAND,
        args: { collection: key.startsWith(DEFINITION_KEY) ? key.slice(DEFINITION_KEY.length) : key, space },
      }
    : { space, cmd: ACCESS_COMMAND, args: { collection, space } };

/** What acting as the account itself needs: `/account/write` about the whole account, no arguments */
export const ACCOUNT_REQUIREMENT: Requirement = Object.freeze({
  space: null,
  cmd: ACCOUNT_COMMAND,
  args: {},
});

/**
 * Whether a proof grants a requirement, by what its note says. A version
 * with no proof was signed by the account itself, which may do anything; a
 * proof that can't be read as one note grants nothing. Whether the note is
 * sound is the capability gate's question.
 */
export function noteGrants(proof: unknown, required: Requirement): boolean {
  if (proof === undefined || proof === null) return true;
  const note = parseDelegation(proof);
  return note !== null && noteCovers(note, required);
}

/** Whether a proof lets its key act as the account itself (spec 01 §8). True with no proof: the account signed. */
export const actsForAccount = (proof: unknown): boolean => noteGrants(proof, ACCOUNT_REQUIREMENT);

/** Whether a note lets its key write records somewhere. False for anything unreadable. */
export function writesRecords(note: unknown): boolean {
  const cmd = parseDelegation(note)?.payload.cmd;
  return cmd !== undefined && commandCovers(cmd, WRITE_COMMAND);
}

/** Whether a note grants records and nothing more: its command is under `/record`. False for anything unreadable. */
export function grantsRecordsOnly(note: unknown): boolean {
  const cmd = parseDelegation(note)?.payload.cmd;
  return cmd !== undefined && commandCovers(RECORDS_COMMAND, cmd);
}

/** What a note from the account says, for what a home grants: a command, about the account or one space, under a policy */
export interface NoteTerms {
  readonly command: string;
  /** Absent: the account itself */
  readonly subject?: string;
  readonly policy?: Policy;
}

/**
 * The terms of a note for these spaces. Every space is a note about the
 * account. One space is a note about it. Several are a note about the
 * account whose policy names them, by the `space` argument; none, one whose
 * policy nothing satisfies.
 */
export function noteTerms(command: string, spaceIds: ReadonlyArray<string> | 'all'): NoteTerms {
  if (spaceIds === 'all') return { command };
  const ids = [...new Set(spaceIds)].sort();
  if (ids.length === 1) return { command, subject: `space:${ids[0]!}` };
  if (ids.length === 0) return { command, policy: [['not', ['and', []]]] };
  return { command, policy: [['or', ids.map((id) => ['==', '.space', id])]] };
}

/** The spaces one statement limits a note to, when it is `==` on `.space` or an `or` of those; else null */
function spacesNamed(statement: ReadonlyArray<unknown>): string[] | null {
  const [op, first] = statement;
  const options = op === 'or' && Array.isArray(first) ? first : [statement];
  const named: string[] = [];
  for (const option of options) {
    if (
      !Array.isArray(option) ||
      option[0] !== '==' ||
      option[1] !== '.space' ||
      typeof option[2] !== 'string'
    )
      return null;
    named.push(option[2]);
  }
  return named;
}

/**
 * The spaces a note reaches, for what a program shows and offers: every
 * space, or a list. Reads its subject and its policy's statements, each of
 * which must name spaces as `noteTerms` writes them: a statement it can't
 * read that way reaches no space, so a program offers less, never more.
 * Peers judge each use against the note itself.
 */
export function noteSpaces(note: Delegation): ReadonlyArray<string> | 'all' {
  const { sub, pol, iss } = note.payload;
  if (sub.startsWith('space:')) return [sub.slice('space:'.length)];
  if (sub !== iss) return [];
  const limits: string[][] = [];
  for (const statement of pol) {
    // The policy nothing satisfies, as noteTerms writes it.
    if (statement[0] === 'not' && JSON.stringify(statement[1]) === '["and",[]]') return [];
    const named = spacesNamed(statement);
    if (!named) return [];
    limits.push(named);
  }
  const [first, ...rest] = limits;
  if (!first) return 'all';
  return [...new Set(first.filter((id) => rest.every((list) => list.includes(id))))];
}
