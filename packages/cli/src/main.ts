/**
 * `minca` — the protocol from a terminal. USAGE below lists the commands.
 *
 * Every data command is generated from NODE_ACTIONS: `minca records put` is the
 * `records_put` action, and its flags are that action's input fields. The same
 * list is what MCP and WebMCP expose, so the three never drift apart.
 *
 * Secrets never go on the command line, where `ps` would show them. An account
 * unlocks with MINCA_RECOVERY_CODE or MINCA_PASSPHRASE, a file named by
 * --code-file / --passphrase-file, or a prompt.
 */
import { version as VERSION } from '../package.json';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface as createPromiseInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { isValidRecoveryCode, NODE_ACTIONS, runAction, type NodeAction, type P2PNode } from '@minca/core';
import { suggestedAutomations } from '@minca/core/schemas';
import { homeAddress } from '@minca/core/session';
import { runCarrier } from './carry.js';
import { runAppNode, stdinLines } from './app-node.js';
import { chooseAccount, createAccount, homePath, nodeFor, openHome, unlock, type Unlocked } from './home.js';
import { findBot, listBots, newBotFolder, type KeptBot } from './bots.js';
import { startDaemon } from './daemon.js';
import { startHost } from './host.js';
import { createReminders, mailerFromEnv } from './reminders.js';
import {
  allowList,
  billingFromEnv,
  checkExposure,
  defaultHostData,
  hostKey,
  hostStores,
  mirrorFromEnv,
  presentationFromEnv,
  botsFromEnv,
  githubFromEnv,
  fundFromEnv,
  statsFromEnv,
  quotaFromEnv,
  limitsFromEnv,
  abuseFromEnv,
  spaceSize,
  walletFromEnv,
} from './host-setup.js';
import { isHostStats, statsLines } from './host-stats.js';
import { CONNECT, connectWaiting, runMcpStdio, runWaitingMcpStdio } from './mcp.js';
import {
  ACCOUNT_HOME,
  claimSlot,
  configuredRelays,
  connectAgent,
  daysLeft,
  defaultAgentName,
  forgetAgent,
  isConnected,
  loadAgentGrant,
  loadModelKey,
  openInBrowser,
  reconnectAgent,
  reloadOnConnect,
  saveModelKey,
  startAgentNode,
  startBotNode,
  type RunningAgent,
  type Slot,
} from './agent.js';
import { createAgentChat, DEFAULT_MODEL, fileSpend, priceOf } from './agent-chat.js';
import { capEachOf, runAutomations } from './bot-runner.js';
import { holdLock } from './writer-keys.js';
import { chooseModel, isLoopback, isPlain, thinker, type ModelChoice } from './model.js';
import { configSnippet, configureClients, serverCommand, unconfigureClients } from './clients.js';
import { addRule, defineStandard, loadModelSetting, setUpModel } from './guide.js';
import * as ask from './ask.js';
import { commaList, isRecord, messageOf } from './json.js';
import { completeInput } from './complete.js';

// From the package itself, so a release's bump is the version it reports; every bundler inlines it.
const USAGE = `minca ${VERSION} — your spaces, from a terminal

Run "minca" alone at a terminal to pick what to do. At a terminal, anything a
command still needs is asked for: a space from your spaces, a role, a yes or
no. Anywhere else (an agent, a script, CI) nothing is ever asked: a missing
value fails at once, naming the flag that gives it. --yes answers yes ahead.

Usage:
  minca init [--name NAME] [--passphrase] [--existing]
  minca whoami
  minca spaces  list | create | invite | join | leave | status   [--flags]
  minca spaces  access | assign | remove_member | step_down | succeed
  minca records list | get | put | update | delete               [--flags]
  minca run [--port 8787] [--host 127.0.0.1] [--node wss://…/peer] [--no-relays] [--create]
  minca host [--port 8787] [--host 127.0.0.1] [--data DIR] [--free] [--allow did:key:…]
  minca host stats <address> [--json]       what a host carries and takes in, as it shows anyone
  minca carry --data DIR                     one account's spaces, from a folder the desktop app connected
  minca app-node --data DIR                  the desktop app's node; the desktop shell runs it
  minca connect [--account-home home.minca.social] [--name NAME] [--relay wss://…] [--no-configure]
  minca disconnect
  minca mcp
  minca agent [--setup] [--model claude-opus-5-5] [--daily-cap 2] [--no-chat]
              [--provider anthropic|openai] [--base-url URL] [--price IN/OUT]
  minca agent --bot [--name NAME] [--invite LINK] [--daily-cap-each 0.5]
                                             an account of its own, as a bot in its spaces
  minca bots                                 the bots kept here, to start again
  minca automation add [--space ID] [--name N] [--collection C] [--where JSON] [--every CRON]
                 [--from ROLES] [--do TEXT] [--by BOT|me]
  minca collections define --standard std.automation [--space ID]
  minca actions

Agents (Claude Code, Claude Desktop, Cursor, VS Code, Windsurf, Zed, Codex, …):
  "minca connect" opens your account home in the browser, where you allow
  this computer's agent, and adds "minca" to the agents it finds. From then
  on they start "minca mcp" themselves: a node of its own, working with every
  tab closed. An agent that starts "minca mcp" before it is connected offers
  one tool, agent_connect, which opens your account home the same way.
  Your account home is home.minca.social unless you name another: at a
  terminal it asks, filled in, so Enter takes it; or --account-home, or
  MINCA_ACCOUNT_HOME. Connecting again uses the one you used last.

  "minca agent" runs the connected agent on its own instead, chatting in this
  terminal, with your Anthropic API key (ANTHROPIC_API_KEY, or asked for once
  and kept in the agent's folder). Deleting or overwriting asks you first, and
  it stops for the day once --daily-cap dollars are spent. It also runs your
  rules (std.automation records): what to do when some records appear or change,
  or at set times. --no-chat runs only those, until stopped.

  Any server that speaks OpenAI's Chat Completions works with --provider
  openai: OpenAI, OpenRouter, DeepSeek, Kimi, or a model on your own machine
  (--base-url http://localhost:11434/v1 for Ollama, no key needed). Models
  whose price it doesn't know need --price, dollars per million tokens.
  The key comes from OPENAI_API_KEY (or ANTHROPIC_API_KEY), or is asked for.

  "minca agent --bot" runs a bot instead: an account of its own that people
  invite to their spaces, known there by its name. Each bot is kept in a
  folder of its own, bots/<name> in the data folder, with its model, key and
  spending; --name picks one, or makes it, and "minca bots" lists them.
  --invite joins a space. It says it is a bot on its std.profile where a
  space keeps them, and runs the rules that name it (by) of its founder and
  members granted /std.automation/instruct there.
  --daily-cap-each limits what each person who sets it off may spend a day
  (a quarter of --daily-cap unless given).

Common flags:
  --home DIR          data folder (default $MINCA_HOME or ~/.minca) — can be the folder a browser uses
  --account NAME      which account, when the folder holds several (or $MINCA_ACCOUNT)
  --json '{…}'        pass an action's input as JSON instead of flags

Unlocking (never as a flag value):
  MINCA_RECOVERY_CODE / --code-file FILE   the account's recovery code
  MINCA_PASSPHRASE / --passphrase-file FILE  a passphrase set with "init --passphrase"
  otherwise you are asked
`;

/** What `minca` alone offers at a terminal: the things people come to do, each a command */
const MENU: ReadonlyArray<{
  readonly label: string;
  readonly hint: string;
  readonly words: string[] | null;
}> = [
  { label: 'Set up an account on this computer', hint: 'minca init', words: ['init'] },
  { label: 'Invite someone to a space', hint: 'minca spaces invite', words: ['spaces', 'invite'] },
  { label: 'Join a space', hint: 'minca spaces join', words: ['spaces', 'join'] },
  { label: 'Connect an agent to my account', hint: 'minca connect', words: ['connect'] },
  { label: 'Run my agent', hint: 'minca agent', words: ['agent'] },
  { label: 'Run a bot for a community', hint: 'minca agent --bot', words: ['agent', '--bot'] },
  {
    label: 'Tell an agent or bot what to do, and when',
    hint: 'minca automation add',
    words: ['automation', 'add'],
  },
  { label: 'Every command', hint: 'minca help', words: null },
];

interface Globals {
  readonly home?: string;
  readonly account?: string;
  readonly codeFile?: string;
  readonly passphraseFile?: string;
  /** `--yes`: go ahead without asking first */
  readonly yes?: boolean;
}

type Command = (args: string[], globals: Globals) => Promise<number>;

const stderr = ask.say;
const logLine = (line: string) => stderr(`[${new Date().toISOString()}] ${line}`);
const MCP_INFO = { name: 'minca', version: VERSION };

async function main(argv: ReadonlyArray<string>): Promise<number> {
  const { globals, rest } = splitGlobals(argv);
  const [command, ...args] = rest;
  if (!command && ask.interactive()) {
    const words = await pickFromMenu();
    return words ? main([...argv, ...words]) : showUsage();
  }
  if (!command) return showUsage();
  const run = commandFor(command, args);
  if (run) return run(args, globals);
  return runNodeAction(command, args, globals);
}

/** The command a word names; a few look at their first argument too */
function commandFor(command: string, args: string[]): Command | undefined {
  if (['help', '--help', '-h'].includes(command)) return showUsage;
  if (['version', '--version'].includes(command)) return showVersion;
  if (command === 'host' && args[0] === 'stats') return hostStats;
  if (command === 'automation' && args[0] === 'add') return addAutomation;
  if (command === 'collections' && args[0] === 'define' && args.includes('--standard'))
    return defineCollection;
  return COMMANDS.get(command);
}

const COMMANDS = new Map<string, Command>([
  ['actions', listActions],
  ['init', init],
  ['run', run],
  ['carry', carry],
  ['app-node', appNode],
  ['host', host],
  ['connect', connect],
  ['bots', bots],
  ['disconnect', disconnect],
  ['agent', agent],
  ['mcp', agentMcp],
]);

async function pickFromMenu(): Promise<string[] | null> {
  const picked = await ask.select({
    flag: 'command',
    message: 'What would you like to do?',
    options: MENU.map(({ label, hint }, index) => ({ value: String(index), label, hint })),
  });
  return MENU[Number(picked)]?.words ?? null;
}

async function showUsage(): Promise<number> {
  process.stdout.write(USAGE);
  return 0;
}

async function showVersion(): Promise<number> {
  process.stdout.write(`${VERSION}\n`);
  return 0;
}

async function listActions(): Promise<number> {
  return print(
    NODE_ACTIONS.map(({ name, description, input, readOnly }) => ({ name, description, input, readOnly })),
  );
}

async function init(args: string[], globals: Globals): Promise<number> {
  const home = await openHome(globals.home);
  const { values } = parseArgs({
    args,
    options: { name: { type: 'string' }, passphrase: { type: 'boolean' }, existing: { type: 'boolean' } },
  });
  ask.intro('A Minca account on this computer');
  // At a terminal, what the flags didn't say is asked; elsewhere the defaults stand.
  const existing = values.existing ?? (values.name === undefined ? await askExisting() : false);
  const name = values.name ?? (await askAccountName(existing));
  const code = existing
    ? (process.env.MINCA_RECOVERY_CODE ?? (await askSecret('Recovery code of the existing account: ')))
    : undefined;
  const lock =
    values.passphrase ??
    (await ask.confirm(
      'Lock it with a passphrase on this computer? (Otherwise, its recovery code each time.)',
      {
        otherwise: false,
      },
    ));
  const passphrase = lock ? await newPassphrase() : undefined;

  const created = await createAccount(home, {
    name,
    ...(code ? { code } : {}),
    ...(passphrase ? { passphrase } : {}),
  });
  print({ account: created.account.name, did: created.account.did, home: home.path });
  if (created.code) showRecoveryCode(created.code);
  ask.outro(`${created.account.name} is ready. \`minca\` shows what you can do next.`);
  return 0;
}

async function askExisting(): Promise<boolean> {
  if (!ask.interactive()) return false;
  const answer = await ask.select({
    flag: 'existing',
    message: 'A new account, or one you already have?',
    options: [
      { value: 'new', label: 'A new account', hint: 'you get a recovery code' },
      { value: 'existing', label: 'One I already have', hint: 'with its recovery code' },
    ],
  });
  return answer === 'existing';
}

async function askAccountName(existing: boolean): Promise<string> {
  if (!ask.interactive()) return 'Me';
  return ask.text({
    flag: 'name',
    message: existing ? 'What should it be called on this computer?' : 'What should it be called?',
    placeholder: 'Leif',
  });
}

async function run(args: string[], globals: Globals): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      port: { type: 'string', default: process.env.PORT ?? '8787' },
      host: { type: 'string' },
      node: { type: 'string', multiple: true },
      'no-relays': { type: 'boolean' },
      create: { type: 'boolean' },
    },
  });
  if (values.create) await createIfEmpty(globals);
  const daemon = await startDaemon({
    unlocked: await openAccount(globals),
    port: Number(values.port),
    ...(values.host ? { host: values.host } : {}),
    ...(values.node ? { nodes: values.node } : {}),
    // Meeting the account's other devices needs no one to point anything here.
    relays: values['no-relays'] ? [] : configuredRelays(),
    log: logLine,
  });
  return untilStopped(daemon);
}

/** `run --create`: an account on first start, locked with MINCA_PASSPHRASE, for dev nodes and fresh servers */
async function createIfEmpty(globals: Globals): Promise<void> {
  const home = await openHome(globals.home);
  if ((await home.accounts.list()).length > 0) return;
  const passphrase = process.env.MINCA_PASSPHRASE;
  if (!passphrase) throw new Error('--create needs MINCA_PASSPHRASE, to lock the new account with');
  const { account, code } = await createAccount(home, { name: 'Node', passphrase });
  stderr(`Created account "${account.name}" (${account.did}) in ${home.path}`);
  if (!code) return;
  // On a server stderr is a log anyone may read, so only a person at a terminal sees the code.
  if (process.stderr.isTTY) {
    stderr(`Recovery code: ${code}`);
    return;
  }
  const file = path.join(home.path, `recovery-code-${account.id}.txt`);
  await writeFile(file, `${code}\n`, { mode: 0o600, flag: 'wx' });
  stderr(`The recovery code was not printed, because this output is not a terminal. It is in ${file}`);
  stderr('Copy it somewhere safe — a password manager — and then delete that file.');
}

async function carry(args: string[]): Promise<number> {
  const data = dataFolder(args, 'minca carry needs --data DIR: the folder it carries from.');
  const running = await runCarrier({
    data,
    // One line per change for whatever started it. Taken off by the account, it is done.
    status: (status) => {
      process.stdout.write(`${JSON.stringify(status)}\n`);
      if (status.state === 'removed') process.exit(0);
    },
    log: logLine,
  });
  return running ? untilStopped(running) : 0;
}

/** For the desktop shell: it says init first, on stdin, and reads one JSON line per message */
async function appNode(args: string[]): Promise<number> {
  await runAppNode({
    data: dataFolder(args, 'minca app-node needs --data DIR: the folder the app’s node keeps.'),
    lines: stdinLines(),
    send: (message) => process.stdout.write(`${JSON.stringify(message)}\n`),
    log: logLine,
  });
  return 0;
}

function dataFolder(args: string[], missing: string): string {
  const { values } = parseArgs({ args, options: { data: { type: 'string' } } });
  if (!values.data) throw new Error(missing);
  return path.resolve(values.data);
}

async function hostStats(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: args.slice(1),
    allowPositionals: true,
    options: { json: { type: 'boolean' } },
  });
  const [address] = positionals;
  if (!address)
    throw new Error('minca host stats needs the host’s address: minca host stats https://host.minca.social');
  const base = (address.includes('://') ? address : `https://${address}`).replace(/\/+$/, '');
  const response = await fetch(`${base}/host/stats`, { signal: AbortSignal.timeout(10_000) });
  if (response.status === 404) throw new Error(`${base} keeps its stats to itself`);
  if (!response.ok) throw new Error(`${base} answered ${response.status}`);
  const stats: unknown = await response.json();
  if (!isHostStats(stats)) throw new Error(`${base} answered with something other than stats`);
  if (values.json) return print(stats);
  process.stdout.write(`${statsLines(stats).join('\n')}\n`);
  return 0;
}

async function host(args: string[]): Promise<number> {
  const env = process.env;
  const { values } = parseArgs({
    args,
    options: {
      port: { type: 'string', default: env.PORT ?? '8787' },
      host: { type: 'string' },
      data: { type: 'string', default: env.MINCA_HOST_DATA ?? defaultHostData() },
      free: { type: 'boolean', default: env.MINCA_HOST_FREE === '1' },
      allow: { type: 'string', multiple: true },
    },
  });
  const data = path.resolve(values.data);
  const free = values.free;
  const allow = allowList(values.allow, env);
  checkExposure({ ...(values.host ? { host: values.host } : {}), free, allow });
  const billing = billingFromEnv(env);
  const wallet = walletFromEnv(env);
  const limits = limitsFromEnv(env, free);
  requirePayment(!!(billing || wallet), free, !!limits);
  // With limits, the room is the free one: past it a balance pays.
  const quotaBytes = limits ? undefined : quotaFromEnv(env);
  const stores = await hostStores(data);
  const presentation = presentationFromEnv(env);
  const mirror = mirrorFromEnv(env);
  const mailer = mailerFromEnv(env);
  const reminders = mailer
    ? createReminders({
        store: await stores('host-reminders'),
        mailer,
        name: presentation.name ?? 'Minca host',
        mirror,
        log: logLine,
      })
    : null;
  const github = await githubFromEnv(env);
  const running = await startHost({
    key: await hostKey(data),
    stores,
    bots: await botsFromEnv(env, data),
    connectors: github ? [github] : [],
    ...fundFromEnv(env),
    stats: statsFromEnv(env),
    reminders,
    measure: spaceSize(data),
    ...(quotaBytes ? { quotaBytes } : {}),
    limits,
    ...(limits ? abuseFromEnv(env) : {}),
    port: Number(values.port),
    ...(values.host ? { host: values.host } : {}),
    ...(free ? { free: true } : {}),
    ...(allow ? { allow } : {}),
    ...presentation,
    billing,
    wallet,
    mirror,
    log: logLine,
  });
  return untilStopped(running);
}

/** A host takes payments, hosts for free, or hosts for free within limits past which communities pay */
function requirePayment(paid: boolean, free: boolean, limited: boolean): void {
  if (paid) return;
  if (limited)
    throw new Error(
      'MINCA_HOST_FREE_GB stops carrying communities past the free line for free, so they need a way to pay for themselves: Stripe (STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET) or a wallet (MINCA_WALLET_ADDRESS).',
    );
  if (!free)
    throw new Error(
      'minca host needs a way to take payments — Stripe (STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET), a wallet (MINCA_WALLET_ADDRESS), or both — or --free to host without them, or MINCA_HOST_FREE_GB to host for free within limits.',
    );
}

async function connect(args: string[], globals: Globals): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      'account-home': { type: 'string' },
      name: { type: 'string' },
      relay: { type: 'string', multiple: true },
      'no-configure': { type: 'boolean' },
    },
  });
  const home = homePath(globals.home);
  const accountHome = await chooseAccountHome(home, values['account-home']);
  const grant = await reconnectAgent(home, (slot) =>
    connectHere(slot, accountHome, {
      ...(values.name ? { name: values.name } : {}),
      ...(values.relay ? { relays: values.relay } : {}),
    }),
  );
  stderr('');
  stderr(
    `Connected to ${grant.name}'s account (${grant.did}), for ${daysLeft(grant)} days. What the agent writes shows "via agent".`,
  );
  const server = serverCommand(home);
  if (values['no-configure']) return showSnippet("Add this to your agent's MCP settings:", server);
  const configured = await configureClients(server);
  for (const { client, result } of configured) stderr(`  ${client}: ${result}`);
  if (configured.some((entry) => entry.ok)) return 0;
  return showSnippet(
    "No agent found on this computer to add it to. Add this to your agent's MCP settings:",
    server,
  );
}

function showSnippet(lead: string, server: ReturnType<typeof serverCommand>): number {
  stderr(lead);
  process.stdout.write(`${configSnippet(server)}\n`);
  return 0;
}

async function bots(_args: string[], globals: Globals): Promise<number> {
  const kept = await listBots(homePath(globals.home));
  print(kept);
  stderr(
    kept[0]
      ? `Start one again: minca agent --bot --name "${kept[0].name}"`
      : 'No bots here yet. Make one: minca agent --bot',
  );
  return 0;
}

async function disconnect(_args: string[], globals: Globals): Promise<number> {
  const home = homePath(globals.home);
  await forgetAgent(home);
  for (const { client, result } of await unconfigureClients(home)) stderr(`  ${client}: ${result}`);
  stderr(
    "This computer's agent is forgotten here. To stop its notes working everywhere, disconnect each of its sessions in your account home.",
  );
  return 0;
}

/**
 * `mcp`: the connected agent, a node of its own with a key no other session
 * signs with. Not connected yet, it offers only to connect.
 */
async function agentMcp(_args: string[], globals: Globals): Promise<never> {
  const home = homePath(globals.home);
  const slot = await claimSlot(home);
  let agent: RunningAgent | null = null;
  let stopReloading = () => {};
  const current = () => agent?.node ?? null;
  const close = async () => {
    stopReloading();
    await (agent?.close() ?? slot.release());
  };
  // Stopped by a signal, it still lets go of the slot, so the next session needn't take it over.
  const stop = () => {
    stderr('minca mcp: stopped');
    void close().finally(() => process.exit(0));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  const start = async () => {
    agent = await startAgentNode(home, slot, {
      nodes: commaList(process.env.MINCA_NODES),
      onRevoked: (space: string) =>
        stderr(
          `minca mcp: the agent's key was revoked in ${space}; nothing it writes there counts until it connects again`,
        ),
    });
    const { grant } = agent;
    stderr(`minca mcp: an agent for ${grant.name} (${grant.did}), ${daysLeft(grant)} days left`);
    // `minca connect` again, after a disconnect or to renew, is taken up here.
    stopReloading = reloadOnConnect(slot, agent, (line) => stderr(`minca mcp: ${line}`));
    return agent.node;
  };
  // The model sees only "revoked" otherwise.
  const trouble = () =>
    agent?.revoked().length
      ? "This agent was disconnected in the person's account home, so its key is revoked and nothing it writes counts. " +
        'Ask them to start this session again: it then asks to be allowed at their account home, with a new key.'
      : null;
  const options = { agent: true, trouble };

  if (await isConnected(slot)) {
    const first = await start();
    await runMcpStdio(() => current() ?? first, MCP_INFO, options);
  } else {
    stderr(`minca mcp: this session isn't connected to an account; offering only ${CONNECT} until it is`);
    const accountHome = await usualAccountHome(home);
    const waiting = connectWaiting({
      accountHome,
      others: (await loadAgentGrant(home)) !== null,
      connect: connectOnce(slot.dir, accountHome),
      tryStart: async () => ((await isConnected(slot)) ? start() : null),
      current,
      account: () => agent && { name: agent.grant.name, did: agent.grant.did },
    });
    await runWaitingMcpStdio(waiting, MCP_INFO, options);
  }
  await close();
  // WebRTC keeps the process alive; the agent closed stdin, so it's done.
  process.exit(0);
}

/** Connects from inside MCP, opening the account home once however often the agent asks */
function connectOnce(slot: string, accountHome: string) {
  let link: Promise<{ opened: boolean; url: string }> | null = null;
  return (check: Check) =>
    (link ??= new Promise((resolve, reject) => {
      connectHere(slot, homeAddress(accountHome), {
        check,
        onLink: (url) => void openInBrowser(url).then((opened) => resolve({ opened, url })),
      }).then(
        (grant) => stderr(`minca mcp: connected to ${grant.name}'s account (${grant.did})`),
        (error: unknown) => {
          link = null;
          stderr(`minca mcp: connecting failed: ${messageOf(error)}`);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    }));
}

async function agent(args: string[], globals: Globals): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      model: { type: 'string' },
      provider: { type: 'string' },
      'base-url': { type: 'string' },
      price: { type: 'string' },
      'daily-cap': { type: 'string', default: '2' },
      'daily-cap-each': { type: 'string' },
      'no-chat': { type: 'boolean' },
      bot: { type: 'boolean' },
      name: { type: 'string' },
      invite: { type: 'string' },
      setup: { type: 'boolean' },
    },
  });
  const dailyCap = dollars('daily-cap', values['daily-cap']);
  // A bot answers anyone who can set it off, so each of them gets a share by default.
  const each = values['daily-cap-each'] ?? (values.bot ? String(capEachOf(dailyCap)) : undefined);
  const capEach = each === undefined ? null : dollars('daily-cap-each', each);
  // A bot keeps its account, model, key and spending in a folder of its own.
  const bot = values.bot ? await botAccount(globals, values.name) : null;
  const home = bot?.folder ?? homePath(globals.home);
  const slot = bot ? null : await connectedSlot(home);
  const model = await modelFor(home, values);
  const nodes = commaList(process.env.MINCA_NODES);
  const runner = bot
    ? await botRunner(bot.unlocked, nodes, values.invite)
    : // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- claimed above for every agent that isn't a bot
      await agentRunner(home, slot!, nodes);
  return runAgent(home, runner, { model, dailyCap, capEach, chat: !values['no-chat'] });
}

function dollars(flag: string, value: string): number {
  const usd = Number(value);
  if (!Number.isFinite(usd) || usd <= 0) throw new Error(`--${flag} is dollars a day, a number above 0`);
  return usd;
}

/** A slot of this computer's agent; one not connected yet is connected now, at a terminal */
async function connectedSlot(home: string): Promise<Slot> {
  const slot = await claimSlot(home);
  if ((await isConnected(slot)) || !ask.interactive()) return slot;
  ask.intro('Connect an agent to your account');
  ask.note('Your account home opens in your browser. Sign in there and allow it.', 'First');
  const grant = await connectHere(slot.dir, await chooseAccountHome(home));
  ask.note(`Connected to ${grant.name}'s account (${grant.did}), for ${daysLeft(grant)} days.`, 'Connected');
  return slot;
}

/** Flags, then the environment, then what setup kept; at a terminal with none of them, setup asks */
async function modelFor(
  home: string,
  values: { provider?: string; model?: string; 'base-url'?: string; price?: string; setup?: boolean },
): Promise<ModelChoice> {
  const env = process.env;
  const told = values.provider ?? values.model ?? env.MINCA_AGENT_PROVIDER ?? env.MINCA_AGENT_MODEL;
  await mkdir(path.join(home, 'agent'), { recursive: true, mode: 0o700 });
  const setUp = values.setup || (!told && ask.interactive() && !(await loadModelSetting(home)));
  const kept = setUp
    ? await setUpModel(home, (model) => priceOf(model) !== null)
    : told
      ? null
      : await loadModelSetting(home);
  return chooseModel(
    {
      provider: values.provider ?? env.MINCA_AGENT_PROVIDER ?? kept?.provider,
      model: values.model ?? env.MINCA_AGENT_MODEL ?? kept?.model,
      baseUrl: values['base-url'] ?? env.MINCA_AGENT_BASE_URL ?? kept?.baseUrl,
      price: values.price ?? env.MINCA_AGENT_PRICE ?? kept?.price,
    },
    DEFAULT_MODEL,
    { provider: '--provider', model: '--model', price: '--price' },
  );
}

/** Who `minca agent` runs as: a person's connected agent, or a bot with an account of its own */
interface Runner {
  readonly node: P2PNode;
  /** The account it acts for, or the bot's own */
  readonly account: string;
  /** Said when it starts: "an agent for Leif, 29 days left", "Club Bot, a bot" */
  readonly intro: string;
  /** The bot's name, when it is one */
  readonly bot?: string;
  close(): Promise<void>;
}

async function agentRunner(home: string, slot: Slot, nodes: string[]): Promise<Runner> {
  const running = await startAgentNode(home, slot, { nodes });
  return {
    node: running.node,
    account: running.grant.did,
    intro: `an agent for ${running.grant.name}, ${daysLeft(running.grant)} days left`,
    close: () => running.close(),
  };
}

async function botRunner(unlocked: Unlocked, nodes: string[], invite?: string): Promise<Runner> {
  let name = unlocked.account.name;
  const started = await startBotNode(unlocked, {
    nodes,
    undisclosed: (id) =>
      void started.node.spaces.list().then((spaces) => {
        const space = spaces.find((s) => s.id === id)?.name ?? id;
        stderr(
          `  ${space} keeps no std.profile, so apps can't show ${name} as a bot, or offer it under “Done by”. ` +
            `Someone who may add collections there can: in the app, Automations; or ` +
            `\`minca collections define --standard std.profile --space ${id}\`.`,
        );
      }),
  });
  name = (await started.node.account.profile())?.name ?? name;
  await joinFirstSpace(started.node, name, invite);
  return {
    node: started.node,
    account: started.node.did,
    intro: `${name}, a bot`,
    bot: name,
    close: () => started.close(),
  };
}

/**
 * `minca agent`: a node, a chat in this terminal, and the automations it runs. The
 * model's words go to stdout; what it does goes to stderr.
 */
async function runAgent(
  home: string,
  runner: Runner,
  options: { model: ModelChoice; dailyCap: number; capEach: number | null; chat: boolean },
): Promise<number> {
  const { model } = options;
  const apiKey = await modelKey(home, model);
  const folder = path.join(home, 'agent');
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const spend = fileSpend(folder);
  const thinking = await thinker(model, apiKey);
  const modelOptions = { model: model.name, price: model.price, ...(isPlain(model) ? { plain: true } : {}) };
  const today = async () => `$${(await spend.today()).toFixed(2)} of $${options.dailyCap.toFixed(2)} today`;

  // Every session of an account may chat, but one runs its automations, or each would run twice.
  const automating = await holdLock(
    path.join(folder, `automations-${runner.account.replace(/^did:key:/, '')}.lock`),
  );
  if (!automating)
    stderr('  Automations run in another `minca agent` on this computer; this one only chats.');
  const stopRules = automating
    ? runAutomations({
        node: runner.node,
        account: runner.account,
        ...(runner.bot ? { bot: runner.bot } : {}),
        think: () => thinking(() => {}),
        ...modelOptions,
        spend,
        dailyCap: options.dailyCap,
        capEach: options.capEach,
        log: stderr,
        onRules: (rules) => stderr(`  Rules: ${rulesLine(rules, runner)}`),
      })
    : () => {};
  if (!runner.bot) await sayWaitingSuggestions(runner);

  const close = async () => {
    stopRules();
    await automating?.();
    await runner.close();
  };
  if (!options.chat) {
    stderr(`minca agent: ${runner.intro}, running automations. ${model.name}, ${await today()}.`);
    return untilStopped({ close });
  }

  const lines = createPromiseInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY,
  });
  const chat = createAgentChat({
    node: runner.node,
    think: thinking((text) => process.stdout.write(text)),
    ...modelOptions,
    spend,
    dailyCap: options.dailyCap,
    // Piped input can't answer for the person, so it never allows what deletes.
    confirm: async (question) => {
      if (!process.stdin.isTTY) return false;
      const answer = await lines.question(`\n${question} [y/N] `);
      return /^y(es)?$/i.test(answer.trim());
    },
    log: (line) => stderr(`  ${line}`),
    ...(runner.bot ? { bot: runner.bot } : {}),
  });

  stderr(`minca agent: ${runner.intro}. ${model.name}, ${await today()}.`);
  stderr('Say what you need. Ctrl-D to stop.');
  lines.setPrompt('\n› ');
  lines.prompt();
  for await (const line of lines) {
    if (line.trim()) await sayToChat(() => chat.say(line), today);
    lines.prompt();
  }
  await close();
  // WebRTC keeps the process alive; the person closed stdin, so it's done.
  process.exit(0);
}

async function sayToChat(
  say: () => Promise<{ cost: number; tools: number }>,
  today: () => Promise<string>,
): Promise<void> {
  try {
    const { cost, tools } = await say();
    process.stdout.write('\n');
    stderr(`  ${tools} tool call${tools === 1 ? '' : 's'} · $${cost.toFixed(3)} · ${await today()}`);
  } catch (error) {
    stderr(`  ${messageOf(error)}`);
  }
}

/** The model's API key: from the environment, kept, or asked for once and kept. A local model needs none. */
async function modelKey(home: string, model: ModelChoice): Promise<string | null> {
  const openai = model.provider === 'openai';
  const key =
    (openai ? process.env.OPENAI_API_KEY : process.env.ANTHROPIC_API_KEY)?.trim() ||
    process.env.MINCA_AGENT_API_KEY?.trim() ||
    (await loadModelKey(home, model.provider));
  if (key || (model.baseUrl && isLoopback(model.baseUrl))) return key;
  stderr(
    openai
      ? `minca agent thinks with your own API key at ${model.baseUrl ?? 'api.openai.com'}.`
      : 'minca agent thinks with your own Anthropic API key. Make one at https://platform.claude.com/settings/keys',
  );
  const asked = await askSecret('API key (kept in the agent folder, readable only by you): ');
  if (!asked) throw new Error('minca agent needs an API key');
  await saveModelKey(home, asked, model.provider);
  return asked;
}

function rulesLine(rules: ReadonlyArray<string>, runner: Runner): string {
  if (rules.length) return rules.map((name) => `“${name}”`).join(', ');
  if (runner.bot) return `none yet. ${botWork(runner.bot, runner.account)}`;
  return 'none yet. Add one in an app, under Automations, or with `minca automation add`.';
}

async function sayWaitingSuggestions(runner: Runner): Promise<void> {
  const spaces = await runner.node.spaces.list();
  const counts = await Promise.all(
    spaces.map((space) => suggestedAutomations(runner.node, space.id, runner.account)),
  );
  const waiting = counts.reduce((sum, count) => sum + count, 0);
  if (waiting)
    stderr(
      `  ${waiting} automation${waiting === 1 ? '' : 's'} the agent suggested ${waiting === 1 ? 'waits' : 'wait'} for you to save it in an app.`,
    );
}

/**
 * The bot `minca agent --bot` runs, unlocked: one kept under the home's
 * `bots/`, by `--name`, the only one, or picked at a terminal; made when there
 * is none. Never the home's own account, which is someone's, or a node's.
 */
async function botAccount(globals: Globals, name?: string): Promise<{ unlocked: Unlocked; folder: string }> {
  const home = homePath(globals.home);
  const picked = await pickBot(await listBots(home), name);
  if (picked)
    return {
      unlocked: await openAccount({ ...globals, home: picked.folder, account: picked.did }),
      folder: picked.folder,
    };

  ask.intro('A bot, with an account of its own');
  const called =
    name ??
    (await ask.text({
      flag: 'name',
      message: 'What is the bot called?',
      placeholder: 'Club Bot',
      hint: 'It is what people see, and type after "@" to mention it.',
    }));
  const folder = await newBotFolder(home, called);
  const kept = (await (await openHome(home)).accounts.list())[0];
  if (kept)
    ask.note(
      `“${kept.name}”, the account in ${home}, stays as it is. The bot gets its own, in ${folder}.`,
      'Its own account',
    );
  const passphrase = await newPassphrase();
  const botHome = await openHome(folder);
  const created = await createAccount(botHome, { name: called, passphrase });
  if (created.code) showRecoveryCode(created.code);
  return { unlocked: await unlock(botHome, created.account, { passphrase }), folder };
}

/** The bot by name, the only one away from a terminal, or one picked at it; undefined for a new one */
async function pickBot(bots: KeptBot[], name?: string): Promise<KeptBot | undefined> {
  if (name) return findBot(bots, name);
  if (bots.length === 1 && !ask.interactive()) return bots[0];
  if (!bots.length) return undefined;
  const folder = await ask.select({
    flag: 'name',
    message: 'Which bot?',
    hint: `The bots here: ${bots.map((bot) => `"${bot.name}"`).join(', ')}.`,
    options: [
      ...bots.map((bot) => ({ value: bot.folder, label: bot.name, hint: bot.did.slice(-6) })),
      { value: '', label: 'A new bot' },
    ],
  });
  return bots.find((bot) => bot.folder === folder);
}

/** How a bot gets work in a space: an automation naming it, which only someone who may instruct it can add */
const botWork = (name: string, did: string) =>
  `It does nothing there until an automation asks it. Someone who may instruct it adds one: in the app, ` +
  `Automations, with “Done by” ${name}; or \`minca automation add --by ${did}\`. ` +
  `An automation for messages mentioning it has it answer when someone writes @${name}.`;

/** Joins the space of `--invite`; or, at a terminal, when the bot is in none yet, asks for an invite */
async function joinFirstSpace(node: P2PNode, name: string, invite?: string): Promise<void> {
  if (!invite && (await node.spaces.list()).length > 0) return;
  if (!invite && !ask.interactive()) {
    stderr(`${name} is in no spaces yet. Give it an invite for the role it should hold: --invite '…'.`);
    return;
  }
  const link = invite ?? (await askInvite());
  const preview = await node.spaces.preview(link);
  const role = preview.role ? ` as ${preview.role}` : '';
  if (!(await ask.confirm(`Join “${preview.space.name}”${role}?`, { otherwise: true }))) return;
  await node.spaces.join(link);
  const joined = `${name} is a member of ${preview.space.name}. ${botWork(name, node.did)}`;
  if (ask.interactive()) ask.note(joined.replace('. ', '.\n'), `Joined ${preview.space.name}`);
  else stderr(joined);
}

async function askInvite(): Promise<string> {
  ask.note(
    'Someone who may assign the role it should hold makes an invite for it:\nin the app, People & roles; or `minca spaces invite --role …`.',
    'Invite the bot',
  );
  return ask.text({ flag: 'invite', message: 'Paste the invite', placeholder: 'https://…#invite=…' });
}

async function addAutomation(args: string[], globals: Globals): Promise<number> {
  const { values } = parseArgs({
    args: args.slice(1),
    options: {
      space: { type: 'string' },
      name: { type: 'string' },
      collection: { type: 'string' },
      where: { type: 'string' },
      every: { type: 'string' },
      do: { type: 'string' },
      from: { type: 'string' },
      by: { type: 'string' },
    },
  });
  return withNode(globals, async (node) => print(await addRule(node, values)));
}

async function defineCollection(args: string[], globals: Globals): Promise<number> {
  const { values } = parseArgs({
    args: args.slice(1),
    options: { standard: { type: 'string' }, space: { type: 'string' } },
  });
  const name = values.standard;
  if (!name) throw new Error('--standard needs a name, like std.automation');
  return withNode(globals, async (node) => print(await defineStandard(node, name, values.space)));
}

/** Every other command is a node action: `records put` is `records_put`, its flags the action's input */
async function runNodeAction(command: string, args: string[], globals: Globals): Promise<number> {
  // Found before the account is opened, so a command this version lacks says so instead of asking for one.
  const found = command === 'whoami' ? findAction(['node_info']) : findAction([command, ...args]);
  if (!found) {
    stderr(
      `Unknown command "${[command, ...args].slice(0, 2).join(' ')}". Try "minca help" or "minca actions".`,
    );
    return 2;
  }
  const { action } = found;
  return withNode(globals, async (node) => {
    // What the flags left out is asked for at a terminal, or refused naming its flag.
    const input = await completeInput(node, action, inputFromFlags(action, found.rest));
    // With nobody to ask, it runs: an agent or a script said so.
    const question = await confirmation(node, action, input);
    if (
      question &&
      !(await ask.confirm(question, { ...(globals.yes ? { yes: true } : {}), otherwise: true }))
    )
      return 1;
    const result = await runAction(node, action.name, input);
    const invite = action.name === 'spaces_invite' && isRecord(result) ? result.invite : undefined;
    if (typeof invite !== 'string' || !process.stdout.isTTY) return print(result);
    // To a person, the invite alone, whole on one line to copy.
    ask.note(
      'Anyone holding it can join, and read everything in a private space: send it only to them.',
      'The invite',
    );
    process.stdout.write(`${invite}\n`);
    return 0;
  });
}

/** What to ask before running an action: joining a space, or anything that removes or overwrites */
async function confirmation(
  node: P2PNode,
  action: NodeAction,
  input: Record<string, unknown>,
): Promise<string | null> {
  if (action.name === 'spaces_join' && typeof input.invite === 'string') {
    const preview = await node.spaces.preview(input.invite);
    return `Join “${preview.space.name}”${preview.role ? ` as ${preview.role}` : ', to read it'}?`;
  }
  if (action.destructive) return `${action.description.split(/\.\s/)[0]?.replace(/\.$/, '')}. Go ahead?`;
  return null;
}

function findAction(
  words: ReadonlyArray<string>,
): { action: NodeAction; rest: ReadonlyArray<string> } | null {
  const [first, second] = words;
  const byPair = second ? NODE_ACTIONS.find((a) => a.name === `${first}_${second}`) : undefined;
  if (byPair) return { action: byPair, rest: words.slice(2) };
  const byName = NODE_ACTIONS.find((a) => a.name === first || a.name === first?.replace(/-/g, '_'));
  return byName ? { action: byName, rest: words.slice(1) } : null;
}

/** Turns `--space x --limit 3 --body '{…}'` into an action's input, by its schema. */
function inputFromFlags(action: NodeAction, args: ReadonlyArray<string>): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument "${arg}"`);
    const [flag = '', inline] = arg.slice(2).split(/=(.*)/s, 2);
    if (flag === 'json') {
      Object.assign(input, JSON.parse(inline ?? args[++i] ?? '{}'));
      continue;
    }
    const key = flag.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    const type = action.input.properties[key]?.type;
    if (!action.input.properties[key]) throw unknownFlag(action, flag);
    if (type === 'boolean') {
      input[key] = inline === undefined ? true : inline === 'true';
      continue;
    }
    const value = inline ?? args[++i];
    if (value === undefined) throw new Error(`--${flag} needs a value`);
    input[key] = flagValue(type, value);
  }
  return input;
}

function flagValue(type: string | undefined, value: string): unknown {
  if (type === 'integer' || type === 'number') return Number(value);
  if (type === 'object') return JSON.parse(value);
  return value;
}

function unknownFlag(action: NodeAction, flag: string): Error {
  const flags = Object.keys(action.input.properties).map((key) => `--${key}`);
  return new Error(`${action.name} has no --${flag}. It takes: ${flags.join(' ') || 'nothing'}`);
}

const GLOBAL_FLAGS: Readonly<Record<string, 'home' | 'account' | 'codeFile' | 'passphraseFile'>> = {
  '--home': 'home',
  '--account': 'account',
  '--code-file': 'codeFile',
  '--passphrase-file': 'passphraseFile',
};

function splitGlobals(argv: ReadonlyArray<string>): { globals: Globals; rest: string[] } {
  const globals: Record<string, string | boolean> = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--yes' || arg === '-y') {
      globals.yes = true;
      continue;
    }
    const [flag = '', inline] = arg.split(/=(.*)/s, 2);
    const name = GLOBAL_FLAGS[flag];
    if (name) globals[name] = inline ?? argv[++i] ?? '';
    else rest.push(arg);
  }
  return { globals, rest };
}

/**
 * Runs something against the unlocked account's folder, offline. With a
 * daemon running on the same folder, it picks the change up and syncs it.
 */
async function withNode(globals: Globals, work: (node: P2PNode) => Promise<number>): Promise<number> {
  const node = await nodeFor(await openAccount(globals), { watchIntervalMs: 0 });
  try {
    return await work(node);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Unknown space'))
      throw new Error(
        `${error.message}. This computer knows only the spaces it has seen: \`minca run\` fetches the rest from ` +
          'your other devices, a browser among them, while one is open. Then try again.',
        { cause: error },
      );
    throw error;
  } finally {
    await node.close();
  }
}

async function openAccount(globals: Globals) {
  const home = await openHome(globals.home);
  const account = await chooseAccount(home, globals.account);
  const code = process.env.MINCA_RECOVERY_CODE ?? (await readSecretFile(globals.codeFile));
  const passphrase = process.env.MINCA_PASSPHRASE ?? (await readSecretFile(globals.passphraseFile));
  if (code || passphrase)
    return unlock(home, account, { ...(code ? { code } : {}), ...(passphrase ? { passphrase } : {}) });
  const answer = await askSecret(`Recovery code or passphrase for ${account.name}: `);
  return unlock(home, account, isValidRecoveryCode(answer) ? { code: answer } : { passphrase: answer });
}

async function readSecretFile(file: string | undefined): Promise<string | undefined> {
  return file ? (await readFile(file, 'utf8')).trim() : undefined;
}

/** Reads a secret without showing it, at a terminal; anywhere else it has to come from the environment. */
const askSecret = (prompt: string) =>
  ask.secret(prompt.replace(/:\s*$/, ''), 'set it in the environment, as `minca help` says');

/** A passphrase chosen here: typed twice, unseen, or `MINCA_PASSPHRASE` */
async function newPassphrase(): Promise<string> {
  if (process.env.MINCA_PASSPHRASE) return process.env.MINCA_PASSPHRASE;
  const passphrase = await askSecret('Choose a passphrase for this computer: ');
  if ((await askSecret('Again: ')) !== passphrase) throw new Error('Passphrases did not match');
  return passphrase;
}

/** A new account's recovery code, shown once: at a terminal in a box, otherwise on stderr */
function showRecoveryCode(code: string): void {
  const said =
    'It is the only way back into this account, and it is stored nowhere. Write it down, or put it in a password manager.';
  if (ask.interactive()) {
    ask.note(`${code}\n\n${said}`, 'Recovery code');
    return;
  }
  stderr('');
  stderr(`Recovery code: ${code}`);
  stderr(said);
}

/** The account home this agent was last connected at, else `MINCA_ACCOUNT_HOME`, else home.minca.social */
async function usualAccountHome(home: string): Promise<string> {
  const before = (await loadAgentGrant(home))?.home;
  return before ? new URL(before).host : (process.env.MINCA_ACCOUNT_HOME ?? ACCOUNT_HOME);
}

/** The account home given; at a terminal asked for with the usual one filled in; else the usual one */
async function chooseAccountHome(home: string, given?: string): Promise<string> {
  if (given) return homeAddress(given);
  const usual = await usualAccountHome(home);
  if (!ask.interactive()) return homeAddress(usual);
  const typed = await ask.text({
    flag: 'account-home',
    message: 'Your account home',
    initialValue: usual,
    hint: `Give it as --account-home ${usual}`,
    validate: (value) => {
      try {
        homeAddress(value);
        return undefined;
      } catch (error) {
        return messageOf(error);
      }
    },
  });
  return homeAddress(typed);
}

type Check = (matches: (typed: string) => boolean) => Promise<void>;

/**
 * Connects a slot of this computer's agent: opens the account home in the
 * browser at a new code, and waits there for the person to allow it.
 * @param options.onLink Given the link first, instead of opening and showing it here
 */
function connectHere(
  slot: string,
  accountHome: string,
  options: { name?: string; relays?: string[]; onLink?: (url: string) => void; check?: Check } = {},
) {
  const session = Number(path.basename(slot));
  // Each session named apart, so the person can tell them apart at their account home.
  const name = options.name ?? `${defaultAgentName()}${session > 1 ? `, session ${session}` : ''}`;
  return connectAgent({
    slot,
    accountHome,
    check: options.check ?? typeCheck,
    name,
    relays: [...new Set([...(options.relays ?? []), ...configuredRelays()])],
    onLink: options.onLink ?? openLink,
  });
}

/** The link carries the code, so it is shown only when no browser opens */
function openLink(url: string): void {
  void openInBrowser(url).then((opened) =>
    stderr(
      opened
        ? `Opened your account home in the browser. Allow it there.`
        : `Open this link to allow it, on any device. Keep it to yourself:\n  ${url}`,
    ),
  );
}

/** The check code the account home shows, typed here: the agent keeps its note only once it matches */
async function typeCheck(matches: (typed: string) => boolean): Promise<void> {
  if (!ask.interactive())
    throw new Error(
      'Connecting needs a terminal to type the code your account home shows. Run it in one, or connect from your AI.',
    );
  await ask.text({
    flag: 'check',
    message: 'The code your account home shows',
    validate: (typed) => (matches(typed) ? undefined : 'That isn’t the code your account home shows.'),
  });
}

/** Prints what a command returns, as JSON */
function print(value: unknown): number {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  return 0;
}

/** Serves until SIGINT or SIGTERM, then closes what was started and exits. */
async function untilStopped(running: { close(): Promise<void> }): Promise<never> {
  const stop = () => {
    stderr('shutting down');
    void running.close().then(() => process.exit(0));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return new Promise(() => {});
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    stderr(`minca: ${messageOf(error)}`);
    process.exitCode = 1;
  },
);
