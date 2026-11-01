/**
 * Where a host sends a sign-in's code: only to a place it reaches the app the
 * person allowed, never someone else. Checked when an app registers
 * (`oauth.ts`), so no app here holds a place it may not send a code to, and
 * again on the consent page (`consent.ts`).
 */

/**
 * Chat apps a code may go to over https, at the one path each finishes an MCP
 * sign-in at: these sites serve many apps, and a page of theirs that passes on
 * what it is given would pass on a code too.
 */
const KNOWN_CALLBACKS: ReadonlyArray<string> = [
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
  'https://chatgpt.com/connector_platform_oauth_redirect',
  'https://chat.openai.com/connector_platform_oauth_redirect',
];

/**
 * Apps a code may go to by their own scheme, on the person's device. Named,
 * not every scheme: some open a browser at any address (`x-safari-https:`),
 * which would carry the code to whoever is there.
 */
const KNOWN_SCHEMES: ReadonlyArray<string> = ['cursor:', 'vscode:', 'vscode-insiders:'];

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Whether `entry` names an app's scheme, `zed:`, rather than a host */
const isScheme = (entry: string) => entry.endsWith(':');

/**
 * Whether a code may be sent to `uri`: a known chat app's own callback, a
 * host named in `more` over https, plain http on this computer only (RFC
 * 8252), or a known app's own scheme.
 * @param more More apps, by host (`chat.example.com`) or scheme (`zed:`)
 */
export function mayRedirect(uri: string, more: ReadonlyArray<string> = []): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.protocol === 'https:')
    return (
      KNOWN_CALLBACKS.includes(url.href) ||
      more.filter((app) => !isScheme(app)).includes(url.hostname.toLowerCase())
    );
  if (url.protocol === 'http:') return LOOPBACK.has(url.hostname);
  return [...KNOWN_SCHEMES, ...more.filter(isScheme)].includes(url.protocol);
}
