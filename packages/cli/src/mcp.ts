/**
 * What a model is given of a node as MCP tools, the same wherever it is
 * served: the MCP service for chat apps (`remote-mcp/`), and `minca agent`'s
 * own chat. The tools are `NODE_ACTIONS`, unchanged: the same names,
 * descriptions and input schemas the CLI uses, so what an agent may do is
 * exactly what its note lets it, through the same gates.
 */
import { type P2PNode } from '@minca/core';
import { offeredActions, type NodeAction } from '@minca/actions';

export interface McpOptions {
  /** Serving an agent's node (`minca connect`), not the account itself */
  readonly agent?: boolean;
  /** A bot: an account of its own that spaces added, offered what an agent is */
  readonly bot?: boolean;
}

/**
 * Minca's mark, for a client to show beside the server: a transparent PNG, since
 * favicon services draw the site's SVG onto white, a white square on a dark
 * client. Inline, so showing it asks nothing of any server.
 */
export const MINCA_ICONS = [
  {
    src: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAACJklEQVR42u1XQUoDQRDMD/YRPiC+QEQQJEgWBEUDGggeAutVj+YDQhI/EMhBEBQPuSkYDwFPkpNe9wlBfEC7RTaYbHp6ZncTFdIFBWF3pqdqprt3UigoFAqFQqFQKFYba5sfXkQ/YjNiP2IYkRIM43fNeKz3H4RXIz4wYl2JudW/2O1GxFEO4UmO4pjessX7hvRYFBHbX9aud5YoPMnOwk4jFj90XXxje0CVUo/a+60Z4hnepTAxzG0iClB0yXWIu6tc0md9jygoicQYjMUcx9oo5tn5kU34e+3UKtpEzHUwMkp9Era0Wd96o8fj88zCk0QsxFxYOkkFu7vz5JQqaYmYiC0VdppW+aviU5jwXVInzCz+okzUPiS6rxE914kGwZj4jWd4hzHZTYRiKsVfQzbnRfEQ1T35EWwjxgpGsJZQEw3JANt1xIK9OpjdbVdiDuYKhW3qStLFjG2Vovi0wpMUTAgttsoZYG+Vxj6/CPEWE1jbdIvlitd995G/Qtp8vQT02gvo5nZM/MYzMZ0MNSGcgmdtnfjkswaEgoXgo+uAys2zGeIZ3omFzawFDdaWGv9LmhvEdh7slEFEqzsvPEmMMZpgTgEaDAaa0wb63K2S3X30csPO28RPaDwJxGbWNNxi+9MGQuf8xweJyXkubUzEWLYmENu9DsJpA3MDcIdnDTDFiyJ1FT8h5rDFzKwJLZzGbAZypo81jbIYUCgUCoVCoVhRfAM9m3YlWA2dBQAAAABJRU5ErkJggg==',
    mimeType: 'image/png',
    sizes: ['48x48'],
  },
];

/** An action's description as a tool, with a warning when its result grants access */
export const toolDescription = (action: NodeAction) =>
  action.sensitive
    ? `${action.description} Confirm with the user before sharing the result.`
    : action.description;

/** What a model is told about the node before it gets the tools */
export function toolInstructions(node: Pick<P2PNode, 'did'>, options: McpOptions = {}): string {
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

/** The node's actions as MCP tools */
export function mcpTools(options: McpOptions = {}) {
  return offeredActions(options).map((action) => ({
    name: action.name,
    title: action.title,
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
