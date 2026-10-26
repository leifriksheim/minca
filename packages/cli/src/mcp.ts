/**
 * The node as an MCP server, so an agent on the desktop — Claude Desktop,
 * Claude Code, anything that speaks MCP — can read and write your spaces.
 *
 * The tools are `NODE_ACTIONS`, unchanged: the same names, descriptions and
 * input schemas the CLI and WebMCP use. What an agent may do is therefore
 * exactly what the account may do, through the same gates.
 *
 * Only the stdio transport and the tools capability are implemented — a few
 * JSON-RPC methods over newline-delimited JSON. stdout carries protocol
 * messages only; anything human-readable goes to stderr.
 */
import { createInterface } from 'node:readline';
import { callAction, offeredActions, type NodeAction, type P2PNode } from '@minca/core';
import { isRecord } from './json.js';

const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface JsonRpcRequest {
  readonly jsonrpc: '2.0';
  readonly id?: string | number | null;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

/** The shape every request is checked against before anything reads it */
function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  if (!isRecord(value) || value.jsonrpc !== '2.0' || typeof value.method !== 'string') return false;
  const { id, params } = value;
  const idOk = id === undefined || id === null || typeof id === 'string' || typeof id === 'number';
  return idOk && (params === undefined || isRecord(params));
}

type JsonRpcResponse =
  | { jsonrpc: '2.0'; id: string | number | null; result: unknown }
  | { jsonrpc: '2.0'; id: string | number | null; error: { code: number; message: string } };

export interface McpOptions {
  /** Serving an agent's node (`minca connect`), not the account itself */
  readonly agent?: boolean;
  /** A bot: an account of its own that spaces added, offered what an agent is */
  readonly bot?: boolean;
  /** What is wrong that the model can't see, said with each tool that fails: the agent's key revoked, say */
  readonly trouble?: () => string | null;
}

/** An action's description as a tool, with a warning when its result grants access */
export const toolDescription = (action: NodeAction) =>
  action.sensitive
    ? `${action.description} Confirm with the user before sharing the result.`
    : action.description;

/** What a model is told about the node before it gets the tools */
export function toolInstructions(node: P2PNode, options: McpOptions = {}): string {
  return (
    `You are acting for the identity ${node.did}. Spaces hold signed records in named collections ` +
    '(e.g. "std.event"); start with spaces_list. Writes are signed and synced to every member of the space. ' +
    'Standard collections (collections_standard) are shared by every app that uses them; prefer them to shapes of your own.' +
    (options.bot
      ? ' You are a bot: an account of your own, which spaces added as a member to help everyone in them. What you ' +
        "write shows as you, and every member's device checks it against the grants your roles hold there. You cannot add " +
        'collections or change who is in a space; to make something new, propose the collections it needs ' +
        "(collections_propose) and someone who may adds them. A collection's guides (collections_list) say how " +
        'the apps in a space want new things proposed.'
      : options.agent
        ? ' You are an agent: what you write shows as the person\'s, "via agent". Your note lets you write records, ' +
          'not add collections or change who is in a space; to make something new, propose the collections it needs ' +
          "(collections_propose) and someone who may adds them. A collection's guides (collections_list) say how " +
          'the apps in a space want new things proposed.'
        : '')
  );
}

function mcpTools(options: McpOptions = {}) {
  return offeredActions(options).map((action) => ({
    name: action.name,
    description: toolDescription(action),
    inputSchema: action.input,
    annotations: {
      readOnlyHint: action.readOnly,
      destructiveHint: action.destructive === true,
      idempotentHint: action.readOnly,
      // Reads what others wrote, or writes what everyone in a space will get.
      openWorldHint: action.peerContent === true || !action.readOnly,
    },
  }));
}

/**
 * Handles one JSON-RPC message.
 * @returns The response, or null for a notification
 */
export async function handleMcpMessage(
  node: P2PNode,
  message: JsonRpcRequest,
  serverInfo: { name: string; version: string },
  options: McpOptions = {},
): Promise<JsonRpcResponse | null> {
  const isNotification = message.id === undefined;
  const id = message.id ?? null;
  const reply = (result: unknown): JsonRpcResponse | null =>
    isNotification ? null : { jsonrpc: '2.0', id, result };
  const fail = (code: number, text: string): JsonRpcResponse | null =>
    isNotification ? null : { jsonrpc: '2.0', id, error: { code, message: text } };

  switch (message.method) {
    case 'initialize': {
      const requested = message.params?.protocolVersion;
      const protocolVersion =
        typeof requested === 'string' && SUPPORTED_VERSIONS.includes(requested)
          ? requested
          : SUPPORTED_VERSIONS[0];
      return reply({
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo,
        instructions: toolInstructions(node, options),
      });
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: mcpTools(options) });
    case 'tools/call': {
      const name = message.params?.name;
      if (typeof name !== 'string') return fail(-32602, 'tools/call needs a tool name');
      if (!offeredActions(options).some((action) => action.name === name))
        return fail(-32602, `Unknown tool: ${name}`);
      // A failed tool is a result the model should read, not a protocol error.
      const { text, isError, value } = await callAction(node, name, message.params?.arguments ?? {});
      const trouble = isError ? options.trouble?.() : null;
      return reply({
        content: [{ type: 'text', text: trouble ? `${text}\n\n${trouble}` : text }],
        ...(isError ? {} : { structuredContent: isRecord(value) ? value : { result: value } }),
        isError,
      });
    }
    default:
      return fail(-32601, `Method not found: ${message.method}`);
  }
}

type Outgoing = JsonRpcResponse | { jsonrpc: '2.0'; method: string };
const send = (message: Outgoing) => process.stdout.write(`${JSON.stringify(message)}\n`);

/** Serves MCP over stdin/stdout until stdin closes, from the node `node()` gives at each message: it can change while it runs. */
export async function runMcpStdio(
  node: () => P2PNode,
  serverInfo: { name: string; version: string },
  options: McpOptions = {},
): Promise<void> {
  await serveStdio((message) => handleMcpMessage(node(), message, serverInfo, options));
}

async function serveStdio(
  handle: (message: JsonRpcRequest) => Promise<JsonRpcResponse | null>,
): Promise<void> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

  for await (const line of lines) {
    if (!line.trim()) continue;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      continue;
    }
    if (!isJsonRpcRequest(message)) {
      send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
      continue;
    }
    // Handled concurrently, answered as each finishes — ids tie them together.
    void handle(message).then((response) => {
      if (response) send(response);
    });
  }
}

/** The one tool offered while another process runs the agent */
export const TAKE_OVER = 'agent_take_over';
/** The one tool offered while this computer's agent isn't connected to an account */
export const CONNECT = 'agent_connect';

/** Minca isn't here yet: what the model is told, the one tool it may call, and how it comes to run here */
export interface Waiting {
  /** Why, and what to do: the server's instructions, and what any other tool says */
  readonly why: string;
  readonly tool: {
    readonly name: string;
    readonly description: string;
    readonly destructive: boolean;
    readonly inputSchema?: Record<string, unknown>;
  };
  /** What calling the tool does, with its arguments: starts the agent here, or says in words what happens next */
  readonly call: (args: Record<string, unknown>) => Promise<P2PNode | string>;
  /** Starts the agent here once it can, or gives null meanwhile */
  readonly tryStart: () => Promise<P2PNode | null>;
  /** The node once the agent runs here, if it can change after it starts: a reconnect starts it again */
  readonly current?: () => P2PNode | null;
}

/** Another process runs this computer's agent: say who, and offer {@link TAKE_OVER} */
export function busyWaiting(params: {
  /** Who runs it, for the person to recognise (`describeAgentProcess`) */
  readonly holder: string;
  readonly tryStart: () => Promise<P2PNode | null>;
  /** Stops the other and starts the agent here */
  readonly takeOver: () => Promise<P2PNode>;
  readonly current?: () => P2PNode | null;
}): Waiting {
  return {
    why:
      `Minca isn't available in this session: this computer's agent is already running in ${params.holder}. ` +
      'Only one process may run it at a time, since two would sign with the same key. ' +
      `Tell the user, and ask them before calling ${TAKE_OVER}: it stops the other one, which then loses Minca. ` +
      'If they close that one instead, this session gets Minca by itself within a few seconds.',
    tool: {
      name: TAKE_OVER,
      description:
        `Stop the other process running this computer's Minca agent (${params.holder}) and run it here instead, ` +
        'which brings every Minca tool to this session. The other one loses Minca. Ask the user first.',
      destructive: true,
    },
    call: () => params.takeOver(),
    tryStart: params.tryStart,
    ...(params.current ? { current: params.current } : {}),
  };
}

/** This computer's agent isn't connected: offer {@link CONNECT}, which opens the person's account home */
export function connectWaiting(params: {
  /** The account home it opens unless the person names another */
  readonly accountHome: string;
  /** Starts connecting at that home, and gives the link the person allows it at */
  readonly connect: (accountHome: string) => Promise<string>;
  readonly tryStart: () => Promise<P2PNode | null>;
  readonly current?: () => P2PNode | null;
}): Waiting {
  return {
    why:
      "Minca isn't connected to the user's account on this computer yet. " +
      `Call ${CONNECT} when they want to use Minca: it opens their account home in the browser, ` +
      'where they sign in, or make an account, and allow this agent. Every Minca tool arrives once they have.',
    tool: {
      name: CONNECT,
      description:
        "Connect Minca to the user's account: opens their Minca account home in the browser to allow this agent. " +
        `Gives the link too, in case the browser does not open. Their home is ${params.accountHome} unless they ` +
        'say they use another; then pass its address.',
      destructive: false,
      inputSchema: {
        type: 'object',
        properties: {
          account_home: {
            type: 'string',
            description: `The address of the user's account home, only if it is not ${params.accountHome}`,
          },
        },
      },
    },
    call: async (args) => {
      const asked = typeof args.account_home === 'string' && args.account_home.trim();
      const url = await params.connect(asked || params.accountHome);
      return (
        `Opened the user's Minca account home in their browser. If it didn't open, give them this link: ${url} ` +
        "There they sign in or make an account, and allow this agent. Once they have, Minca's tools arrive here " +
        'by themselves; tell them to say when they are done.'
      );
    },
    tryStart: params.tryStart,
    ...(params.current ? { current: params.current } : {}),
  };
}

/** How often a waiting server looks for the agent to be ready */
const RETRY_MS = 5_000;

/**
 * Answers MCP while Minca can't run here yet: another process runs the agent,
 * or it isn't connected. Exiting would leave the client with only
 * "connection closed"; this says why and offers one tool. Once the agent
 * runs here, the node's own tools replace it and the client is told
 * (`notifications/tools/list_changed`).
 */
export function waitingMcp(
  waiting: Waiting,
  serverInfo: { name: string; version: string },
  options: McpOptions,
  notify: (message: Outgoing) => void,
) {
  let node: P2PNode | null = null;
  // One start at a time: the retry and the tool never race for the lock.
  let queue: Promise<unknown> = Promise.resolve();
  const exclusive = (start: () => Promise<P2PNode | string | null>): Promise<P2PNode | string | null> => {
    const next = queue.then(async () => {
      if (node) return node;
      const result = await start();
      if (result !== null && typeof result !== 'string') {
        node = result;
        clearInterval(timer);
        notify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
      }
      return result;
    });
    queue = next.catch(() => {});
    return next;
  };
  const attempt = () => exclusive(waiting.tryStart).catch(() => null);
  const timer = setInterval(() => void attempt(), RETRY_MS);
  timer.unref();

  const tool = {
    name: waiting.tool.name,
    description: waiting.tool.description,
    inputSchema: waiting.tool.inputSchema ?? { type: 'object', properties: {} },
    annotations: {
      readOnlyHint: false,
      destructiveHint: waiting.tool.destructive,
      idempotentHint: true,
      openWorldHint: false,
    },
  };

  const live = () => (node ? (waiting.current?.() ?? node) : null);

  async function handle(message: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    const running = live();
    if (running) return handleMcpMessage(running, message, serverInfo, options);
    const id = message.id ?? null;
    const reply = (result: unknown): JsonRpcResponse | null =>
      message.id === undefined ? null : { jsonrpc: '2.0', id, result };
    const text = (said: string, isError: boolean) =>
      reply({ content: [{ type: 'text', text: said }], isError });

    switch (message.method) {
      case 'initialize': {
        const requested = message.params?.protocolVersion;
        return reply({
          protocolVersion:
            typeof requested === 'string' && SUPPORTED_VERSIONS.includes(requested)
              ? requested
              : SUPPORTED_VERSIONS[0],
          capabilities: { tools: { listChanged: true } },
          serverInfo,
          instructions: waiting.why,
        });
      }
      case 'tools/list': {
        const started = (await attempt()) && live();
        return started ? handleMcpMessage(started, message, serverInfo, options) : reply({ tools: [tool] });
      }
      case 'tools/call': {
        if (message.params?.name === tool.name) {
          try {
            const args = message.params?.arguments;
            const result = await exclusive(() => waiting.call(isRecord(args) ? args : {}));
            return typeof result === 'string'
              ? text(result, false)
              : text(`Done: Minca runs in this session now, with ${mcpTools(options).length} tools.`, false);
          } catch (error) {
            return text(error instanceof Error ? error.message : String(error), true);
          }
        }
        const started = (await attempt()) && live();
        return started ? handleMcpMessage(started, message, serverInfo, options) : text(waiting.why, true);
      }
      case 'ping':
        return reply({});
      default:
        return message.id === undefined
          ? null
          : { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${message.method}` } };
    }
  }

  return {
    handle,
    /** The node, once the agent runs here */
    node: live,
    stop: () => clearInterval(timer),
  };
}

/**
 * Serves MCP over stdin/stdout while Minca can't run here yet, until stdin
 * closes ({@link waitingMcp}).
 * @returns The node, if the agent came to run here, for the caller to close
 */
export async function runWaitingMcpStdio(
  waiting: Waiting,
  serverInfo: { name: string; version: string },
  options: McpOptions = {},
): Promise<P2PNode | null> {
  const server = waitingMcp(waiting, serverInfo, options, send);
  await serveStdio(server.handle);
  server.stop();
  return server.node();
}
