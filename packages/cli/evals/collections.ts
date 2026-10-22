/**
 * Does an agent reach for the standard collections? Each case asks a model
 * for an app, with the real `collections_standard` and `collections_propose`
 * actions against a node of its own, so it reads the same map and gets the
 * same warnings an agent connected to Minca does, and may propose again. A
 * case passes when its last proposal uses the standard collections it should
 * and draws no warning. Not part of the tests: it calls the Claude API, so
 * run it by hand when the library or its descriptions change.
 *
 *   ANTHROPIC_API_KEY=… npm run eval -w @minca/cli
 *   EVAL_MODEL=claude-opus-5-5 EVAL_ONLY=photo npm run eval -w @minca/cli
 */
import Anthropic from '@anthropic-ai/sdk';
import type { BetaMessageParam, BetaTool } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { createNode } from '../../core/src/node/node.js';
import { callAction, offeredActions } from '../../core/src/node/actions.js';
import { createIdentityManager } from '../../core/src/identity/identity-manager.js';
import { createLocalRootSigner } from '../../core/src/identity/root-signer.js';
import { deriveAccountKey } from '../../core/src/identity/account-vault.js';
import { generateSeed } from '../../core/src/identity/recovery-code.js';
import { team } from '../../core/src/space/presets.js';
import { isRecord } from '../../core/src/utils/guards.js';
import { memoryStores } from '../../core/tests/helpers/memory-stores.js';

interface Case {
  readonly id: string;
  /** What the person asks for */
  readonly ask: string;
  /** Standard collections the proposal must use */
  readonly uses: ReadonlyArray<string>;
}

const CASES: ReadonlyArray<Case> = [
  {
    id: 'drive',
    ask: 'A shared drive for our band: upload files and sort them into folders.',
    uses: ['std.file', 'std.list'],
  },
  {
    id: 'photo',
    ask: 'A photo album app for our trip to Lisbon, with albums per day.',
    uses: ['std.file', 'std.list'],
  },
  { id: 'recipes', ask: 'Our family recipes, each with a photo and its ingredients.', uses: ['std.file'] },
  {
    id: 'board',
    ask: 'A board for our renovation: tasks in To do, Doing and Done columns.',
    uses: ['std.task', 'std.column'],
  },
  {
    id: 'coach',
    ask: 'Members book a 30-minute slot with the club coach, first come.',
    uses: ['std.slot', 'std.claim'],
  },
  {
    id: 'rules',
    ask: 'Change the club rules by a vote, decided once enough members agree.',
    uses: ['std.proposal', 'std.ballot'],
  },
  { id: 'party', ask: 'Playlists of songs for our parties.', uses: ['std.track', 'std.list'] },
  {
    id: 'chat',
    ask: 'A chat with a few channels: general, gigs and gear.',
    uses: ['std.message', 'std.channel'],
  },
];

const MODEL = process.env.EVAL_MODEL ?? 'claude-sonnet-5-5';
const TOOLS = ['collections_standard', 'collections_propose'];
const TURNS = 8;

const SYSTEM =
  'You make apps for a Minca space: shared records in collections, read by every app in the space. ' +
  'Propose the collections the app needs with collections_propose. Reply with a short sentence once it is proposed.';

async function aNode() {
  const manager = createIdentityManager();
  const seed = generateSeed();
  const me = await manager.fromSeed(seed);
  return createNode({
    signer: createLocalRootSigner(me, manager.getProvider()),
    stores: memoryStores(),
    accountKey: await deriveAccountKey(seed),
    watchIntervalMs: 0,
  });
}

// As an agent connected to Minca is offered them
const tools: BetaTool[] = offeredActions({ agent: true })
  .filter((action) => TOOLS.includes(action.name))
  .map((action) => ({
    name: action.name,
    description: action.description,
    input_schema: { ...action.input },
  }));

/** The standard collections a proposal names, and whether it drew warnings */
function judged(input: unknown, result: unknown): { names: string[]; warnings: string[] } {
  const given = isRecord(input) && Array.isArray(input.collections) ? input.collections : [];
  const names = given.map((one: unknown) =>
    typeof one === 'string' ? one : isRecord(one) ? String(one.name) : '',
  );
  const warnings = isRecord(result) && Array.isArray(result.warnings) ? result.warnings.map(String) : [];
  return { names, warnings };
}

async function run(client: Anthropic, one: Case) {
  const node = await aNode();
  try {
    const { id: space } = await node.spaces.create({ name: 'Club', ...team, visibility: 'private' });
    const messages: BetaMessageParam[] = [{ role: 'user', content: `In space ${space}: ${one.ask}` }];
    let last: { names: string[]; warnings: string[] } | null = null;
    for (let turn = 0; turn < TURNS; turn += 1) {
      const reply = await client.beta.messages.create({
        model: MODEL,
        max_tokens: 8000,
        system: SYSTEM,
        tools,
        messages,
      });
      messages.push({ role: 'assistant', content: reply.content });
      const calls = reply.content.filter((block) => block.type === 'tool_use');
      if (calls.length === 0) break;
      const results = [];
      for (const call of calls) {
        const done = await callAction(node, call.name, call.input);
        if (call.name === 'collections_propose' && !done.isError) last = judged(call.input, done.value);
        results.push({
          type: 'tool_result' as const,
          tool_use_id: call.id,
          content: done.text,
          is_error: done.isError,
        });
      }
      messages.push({ role: 'user', content: results });
    }
    const missing = one.uses.filter((name) => !last?.names.includes(name));
    const pass = last !== null && missing.length === 0 && last.warnings.length === 0;
    return { id: one.id, pass, proposed: last?.names ?? [], missing, warnings: last?.warnings ?? [] };
  } finally {
    await node.close();
  }
}

const client = new Anthropic();
const only = process.env.EVAL_ONLY;
const results = await Promise.all(
  CASES.filter((one) => !only || one.id === only).map((one) => run(client, one)),
);
for (const result of results) {
  console.log(
    `${result.pass ? 'pass' : 'FAIL'}  ${result.id.padEnd(8)} ${result.proposed.join(', ') || '(nothing proposed)'}`,
  );
  if (result.missing.length) console.log(`        missing ${result.missing.join(', ')}`);
  for (const warning of result.warnings) console.log(`        warned: ${warning}`);
}
const passed = results.filter((result) => result.pass).length;
console.log(`\n${passed}/${results.length} with ${MODEL}`);
process.exitCode = passed === results.length ? 0 : 1;
