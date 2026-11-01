/**
 * Where a host sends a sign-in's code: only to a place it reaches the app the
 * person allowed, never someone else. Checked when an app registers
 * (`oauth.ts`), so no app here holds a place it may not send a code to, and
 * again on the consent page (`consent.ts`).
 */

/** Chat apps a code may go to over https, by host: their own servers finish the sign-in */
const KNOWN_HOSTS: ReadonlyArray<string> = ['claude.ai', 'claude.com', 'chatgpt.com', 'chat.openai.com'];

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
 * Whether a code may be sent to `uri`: https at a chat app the host knows,
 * plain http on this computer only (RFC 8252), or a known app's own scheme.
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
    return [...KNOWN_HOSTS, ...more.filter((app) => !isScheme(app))].includes(url.hostname.toLowerCase());
  if (url.protocol === 'http:') return LOOPBACK.has(url.hostname);
  return [...KNOWN_SCHEMES, ...more.filter(isScheme)].includes(url.protocol);
}
