/**
 * Adding `minca mcp` to the agents on this computer, so connecting is one
 * command: Claude Code through its own `claude mcp add`, and every other agent
 * add-mcp knows (Claude Desktop, Cursor, VS Code, Windsurf, Zed, Codex, …)
 * through its config file. Only the ones installed are touched, and an
 * existing "minca" entry is replaced, nothing else; disconnecting takes it out.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { errorCode, messageOf } from './json.js';

const run = promisify(execFile);

/** The name the server is added under */
const SERVER_NAME = 'minca';

export interface ServerCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

/**
 * How to start `minca mcp` the way this process was started — from npx, a
 * linked `minca`, the repo, or a compiled binary — with absolute paths, since
 * an agent starts it from anywhere, and a desktop app without the shell's PATH.
 */
export function serverCommand(home: string): ServerCommand {
  const script = process.argv[1] ?? '';
  const tail = ['mcp', '--home', home];
  // A compiled binary is its own runtime.
  if (!script || script === process.execPath || /\$bunfs|~BUN/.test(script))
    return { command: process.execPath, args: tail };
  // Run from npx: its cache is temporary, so ask npx again.
  if (script.includes(`${path.sep}_npx${path.sep}`)) {
    const npx = path.join(path.dirname(process.execPath), process.platform === 'win32' ? 'npx.cmd' : 'npx');
    return { command: existsSync(npx) ? npx : 'npx', args: ['-y', '@minca/cli', ...tail] };
  }
  // From the sources: Node needs tsx, found from here rather than from wherever the agent starts.
  const tsx = script.endsWith('.ts') ? import.meta.resolve('tsx') : null;
  return {
    command: process.execPath,
    args: [...(tsx ? ['--import', tsx] : []), path.resolve(script), ...tail],
  };
}

export interface Configured {
  readonly client: string;
  /** What happened, for the person */
  readonly result: string;
  readonly ok: boolean;
}

/** What to do after adding it, for agents that read their config only at start */
const RESTART: Readonly<Record<string, string>> = {
  'claude-code': 'start a new session to use it',
  'claude-desktop': 'restart it to use it',
};

/**
 * Adds the server to every agent found on this computer. Claude Code goes
 * through `claude mcp add` when it is on the PATH, since it rewrites its own
 * config file while running. Every other agent's config path and format come
 * from add-mcp, which keeps them current; it is loaded only when connecting.
 */
export async function configureClients(server: ServerCommand): Promise<ReadonlyArray<Configured>> {
  const done: Configured[] = [];
  let claudeCli = true;

  try {
    // Replacing: `add` refuses a name that exists.
    await run('claude', ['mcp', 'remove', SERVER_NAME, '--scope', 'user']).catch(() => {});
    await run('claude', ['mcp', 'add', SERVER_NAME, '--scope', 'user', '--', server.command, ...server.args]);
    done.push({ client: 'Claude Code', result: `added — ${RESTART['claude-code']}`, ok: true });
  } catch (error) {
    if (errorCode(error) === 'ENOENT') claudeCli = false;
    else
      done.push({
        client: 'Claude Code',
        result: `could not add it: ${messageOf(error).split('\n')[0]}`,
        ok: false,
      });
  }

  const { agents, detectGlobalAgents, upsertServer } = await import('add-mcp');
  for (const type of await detectGlobalAgents()) {
    if (type === 'claude-code' && claudeCli) continue;
    const agent = agents[type];
    if (!agent.supportedTransports.includes('stdio')) continue;
    const added = upsertServer(type, SERVER_NAME, { command: server.command, args: [...server.args] });
    const restart = RESTART[type];
    done.push(
      added.success
        ? { client: agent.displayName, result: restart ? `added — ${restart}` : 'added', ok: true }
        : {
            client: agent.displayName,
            result: `could not add it to ${added.path}: ${added.error ?? 'unknown error'}`,
            ok: false,
          },
    );
  }
  return done;
}

/**
 * Takes the server out of every agent on this computer that connecting added
 * it to, as `minca disconnect` does. Only an entry that starts `minca mcp` for
 * this home goes: one added by hand, such as `minca mcp --account`, or one for
 * another home, stays.
 */
export async function unconfigureClients(home: string): Promise<ReadonlyArray<Configured>> {
  const { listInstalledServers, removeServer } = await import('add-mcp');
  const done: Configured[] = [];

  for (const found of await listInstalledServers({ global: true })) {
    const entry = found.servers.find((server) => server.serverName === SERVER_NAME);
    if (!entry || !JSON.stringify(entry.config).includes(JSON.stringify(home))) continue;
    const client = found.displayName;

    // Claude Code through its own CLI where it can, for the same reason as adding.
    if (found.agentType === 'claude-code') {
      try {
        await run('claude', ['mcp', 'remove', SERVER_NAME, '--scope', 'user']);
        done.push({ client, result: 'removed', ok: true });
        continue;
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') {
          done.push({ client, result: `could not remove it: ${messageOf(error).split('\n')[0]}`, ok: false });
          continue;
        }
      }
    }

    const removed = removeServer(found.agentType, SERVER_NAME);
    done.push(
      removed.success
        ? { client, result: 'removed', ok: true }
        : {
            client,
            result: `could not remove it from ${removed.path}: ${removed.error ?? 'unknown error'}`,
            ok: false,
          },
    );
  }
  return done;
}

/** The config for anything else that speaks MCP */
export function configSnippet(server: ServerCommand): string {
  return JSON.stringify(
    { mcpServers: { [SERVER_NAME]: { command: server.command, args: server.args } } },
    null,
    2,
  );
}
