/**
 * Running a node's automations (`std.automation`): what `minca agent --no-chat` does at a
 * terminal, and what a host does for each bot it runs. Automations that ask the
 * agent start a fresh conversation each time, one at a time, with nobody
 * there to allow deleting or overwriting, so those are refused. What someone
 * set off is counted against them, so nobody can spend the day for everyone.
 */
import { PEER_CONTENT_NOTE, type P2PNode } from '@minca/core';
import {
  BOT_INSTRUCTIONS_MAX,
  botSettings,
  mayConfigure,
  setActivity,
  startAutomations,
  type ActivityState,
  type AutomationTrigger,
} from '@minca/core/schemas';
import {
  createAgentChat,
  spendFor,
  type ChatTool,
  type Price,
  type Spend,
  type Think,
} from './agent-chat.js';
import { openTrigger, ruleContext, triggerPrompt, writerInstructs } from './agent-automations.js';
import { isRecord, messageOf } from './json.js';

export interface RuleRunnerOptions {
  readonly node: P2PNode;
  /** Whoever runs the rules: the account, or the bot's own */
  readonly account: string;
  /** The bot's name, when this is a bot */
  readonly bot?: string;
  /** A way to think, made fresh for each automation set off */
  readonly think: () => Think;
  readonly model: string;
  readonly price?: Price;
  /** Only the model's plain API: no thinking or fallbacks, at a provider other than Anthropic */
  readonly plain?: boolean;
  readonly spend: Spend;
  /** Dollars a day, for everything */
  readonly dailyCap: number;
  /** Dollars a day for what each person sets off; null for no limit of their own */
  readonly capEach: number | null;
  readonly log: (line: string) => void;
  /**
   * Tools a bot has in a space beyond the node's actions: its connectors'.
   * `mayWrite` says whether this run's instructions come from someone who may
   * configure the bot, so it may act outside the space for them.
   */
  readonly tools?: (space: string, mayWrite: boolean) => Promise<ReadonlyArray<ChatTool>>;
  /**
   * Whether an account is a bot: never one to configure another, as no chat
   * app lets one integration reprogram the next. A host knows the bots it runs.
   */
  readonly isBot?: (did: string) => Promise<boolean>;
  /** Told the automations this runs, each time they change */
  readonly onRules?: (names: ReadonlyArray<string>) => void;
}

/**
 * A bot's instructions in a space: the newest `std.bot` naming it whose
 * current version was written by someone who may configure it, as a person
 * and not an agent.
 */
export async function personaIn(
  node: P2PNode,
  space: string,
  bot: string,
  isBot?: (did: string) => Promise<boolean>,
): Promise<{ readonly instructions: string; readonly by: string } | null> {
  const records = await node.records.list(space, { collection: botSettings.name });
  const newest = records
    .filter(
      (record) =>
        record.verified &&
        !record.deleted &&
        !record.recordsOnly &&
        record.root &&
        isRecord(record.body) &&
        record.body.bot === bot &&
        typeof record.body.instructions === 'string' &&
        record.body.instructions.trim(),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  for (const record of newest) {
    if (!record.root || !isRecord(record.body) || typeof record.body.instructions !== 'string') continue;
    if (!(await isBot?.(record.root)) && (await mayConfigure(node, space, bot, record.root)))
      return { instructions: record.body.instructions.slice(0, BOT_INSTRUCTIONS_MAX), by: record.root };
  }
  return null;
}

/** What each person who sets a bot off may spend a day unless told: a quarter of its cap, so nobody spends the day for everyone */
export const capEachOf = (dailyCap: number) => dailyCap / 4;

/** Starts running the automations that name this node; returns how to stop */
export function runAutomations(options: RuleRunnerOptions): () => void {
  const { node, spend, log } = options;
  const names = new Map<string, string>();
  const nameOf = async (space: string, did: string) => {
    if (!names.has(did)) {
      const found = (await node.spaces.profiles(space).catch(() => [])).find((p) => p.did === did);
      if (found) names.set(did, found.name);
    }
    return names.get(did) ?? did.slice(-6);
  };
  const today = async () => `$${(await spend.today()).toFixed(2)} of $${options.dailyCap.toFixed(2)} today`;

  /**
   * Says on the record that set an automation off (or the automation, for one set off by
   * the time) where the work stands, for apps to show. Never in the way of it.
   */
  // Once for each space where nobody can see it at work, since the space keeps no std.activity.
  const unseen = new Set<string>();
  const mark = (trigger: AutomationTrigger, state: ActivityState) =>
    setActivity(
      node,
      trigger.automation.space,
      trigger.match?.record.key ?? trigger.automation.key,
      state,
      // The automation's name to begin with; at the end, whatever the model said it was doing stays.
      state === 'done' || state === 'failed' ? undefined : trigger.automation.body.name.slice(0, 120),
    )
      .then((set) => {
        if (!set && !unseen.has(trigger.automation.space)) {
          unseen.add(trigger.automation.space);
          log(
            `  ${trigger.automation.space} keeps no std.activity, so nobody sees it at work there. ` +
              'Someone who may add collections can show it: in the app, Automations, “Show it”.',
          );
        }
        return set;
      })
      .catch(() => null);

  let queue: Promise<unknown> = Promise.resolve();
  const answer = async (sealed: AutomationTrigger): Promise<{ did: string; ok: boolean }> => {
    const trigger = await openTrigger(node, sealed);
    const name = trigger.automation.body.name;
    const space = trigger.automation.space;
    const who = trigger.match?.record.createdBy ?? null;
    const by = who ? ` by ${await nameOf(space, who)}` : '';
    if (who && who !== options.account && options.capEach !== null) {
      const spent = await spend.today(who);
      if (spent >= options.capEach) {
        const did = `Set off${by}, who has used their $${options.capEach.toFixed(2)} for today`;
        log(`  [${name}] ${did}`);
        await mark(sealed, 'failed');
        return { did, ok: false };
      }
    }
    // The automation's words are whoever wrote its current version: for a bot, they must be someone who
    // may configure it, or the words it would read as its maker's are someone else's.
    const current = options.bot
      ? await node.records.get(space, trigger.automation.key).catch(() => null)
      : null;
    const author = current?.recordsOnly ? null : (current?.root ?? null);
    // Never the bot itself, nor an agent (`mayConfigure`): what it wrote for itself runs, but writes nothing outside.
    const authorMay =
      !!author &&
      !(await options.isBot?.(author)) &&
      (await mayConfigure(node, space, options.account, author).catch(() => false));
    if (options.bot && author !== trigger.automation.maker && !authorMay) {
      const did = 'Its words were changed by someone who may not instruct this bot: not run';
      log(`  [${name}] ${did}`);
      await mark(sealed, 'failed');
      return { did, ok: false };
    }
    log(`  [${name}] set off${by}${trigger.match ? '' : ' by the time'}`);
    const instructs = await writerInstructs(node, trigger, {
      account: options.account,
      bot: !!options.bot,
    }).catch(() => false);
    // Like an app a workspace installs: an automation made by someone who may configure the bot may act
    // outside the space, whoever sets it off. What sets it off is in the prompt as data, and can steer it.
    const mayWrite = !!options.bot && authorMay;
    const extra = options.tools ? await options.tools(space, mayWrite).catch(() => []) : [];
    const persona = options.bot
      ? await personaIn(node, space, options.account, options.isBot).catch(() => null)
      : null;
    const run = createAgentChat({
      node,
      think: options.think(),
      model: options.model,
      ...(options.price ? { price: options.price } : {}),
      ...(options.plain ? { plain: true } : {}),
      spend: who ? spendFor(spend, who) : spend,
      dailyCap: options.dailyCap,
      confirm: async () => false,
      log: (line) => log(`  [${name}] ${line}`),
      maxSteps: 15,
      unattended: true,
      ...(options.bot ? { bot: options.bot } : {}),
      ...(extra.length ? { extra } : {}),
      ...(persona
        ? { persona: { instructions: persona.instructions, by: await nameOf(space, persona.by) } }
        : {}),
    });
    const shown = await mark(sealed, 'working');
    const context = await ruleContext(node, trigger).catch(() => undefined);
    try {
      const { cost, text } = await run.say(
        triggerPrompt(trigger, PEER_CONTENT_NOTE, {
          ...(context ? { context } : {}),
          ...(shown ? { activityOn: sealed.match?.record.key ?? sealed.automation.key } : {}),
          writerInstructs: instructs,
        }),
      );
      log(`  [${name}] ${text || 'Done.'} · $${cost.toFixed(3)} · ${await today()}`);
      await mark(sealed, 'done');
      return { did: text || 'Done.', ok: true };
    } catch (error) {
      const did = messageOf(error);
      log(`  [${name}] ${did}`);
      await mark(sealed, 'failed');
      return { did, ok: false };
    }
  };

  return startAutomations(node, {
    account: options.account,
    ...(options.bot ? { bot: true } : {}),
    // A person's app may run the same automations; the earlier of two claims acts.
    claimMs: 1500,
    ask: (trigger) => {
      // Queued behind another: waiting, until its turn comes.
      const waiting = mark(trigger, 'waiting');
      const turn = queue.then(async () => {
        await waiting;
        return answer(trigger);
      });
      queue = turn.catch(() => {});
      return turn;
    },
    onRules: (rules) => options.onRules?.(rules.map((rule) => rule.body.name)),
    onRun: (trigger, run) => {
      if (trigger.automation.body.then.kind !== 'ask') log(`  [${trigger.automation.body.name}] ${run.did}`);
    },
    onError: (error) => log(`  Automations: ${messageOf(error)}`),
  });
}
