/**
 * Minca's MCP service (`minca mcp-server`), and links that add it to an AI
 * app in one step, where the app has one. The site's MCP page and the apps'
 * "Connect an agent" both use these.
 */

/** Where chat apps connect: `VITE_MINCA_MCP`, or the public service */
export const MCP_URL = import.meta.env.VITE_MINCA_MCP ?? 'https://mcp.minca.social/mcp';

/** Claude on the web, desktop and phone: opens "Add custom connector" with Minca filled in */
export const addToClaude = (url = MCP_URL) =>
  `https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Minca&connectorUrl=${encodeURIComponent(url)}`;

/** Cursor: opens its MCP install prompt, the config as its mcp.json takes it, base64 */
export const addToCursor = (url = MCP_URL) =>
  `cursor://anysphere.cursor-deeplink/mcp/install?name=minca&config=${encodeURIComponent(btoa(JSON.stringify({ url })))}`;
