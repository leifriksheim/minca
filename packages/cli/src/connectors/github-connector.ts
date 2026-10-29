/**
 * GitHub, as the reference host connects its bots to it (packages/core/docs/bots.md):
 * the host's GitHub App, its install screen, and the bot's tools on an installation.
 */
import type { IncomingMessage } from 'node:http';
import { isRecord } from '../json.js';
import type { GitHubApp } from './github.js';
import { githubTools } from './github-tools.js';
import type { Connected, HostConnector, Refused, ServiceChange } from './connector.js';

const header = (headers: IncomingMessage['headers'], name: string) => {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
};

const installationOf = (data: Readonly<Record<string, unknown>>) =>
  typeof data.installation === 'number' ? data.installation : null;

const NOTHING: ServiceChange = { kind: 'nothing', said: 'nothing to do' };

export function githubConnector(app: GitHubApp): HostConnector {
  return Object.freeze({
    id: 'github',
    name: 'GitHub',

    // The App's settings name the callback; GitHub sends the browser there with the state.
    consentUrl: (state: string) => app.installUrl(state),

    async complete(query: URLSearchParams): Promise<Connected | Refused> {
      if (query.get('setup_action') === 'request')
        return {
          status: 202,
          said: 'GitHub asked an owner of the organisation to approve the app. Connect again once they have.',
        };
      const installation = Number(query.get('installation_id'));
      if (!Number.isSafeInteger(installation) || installation <= 0)
        return { status: 400, said: 'GitHub sent no installation. Start again from the app.' };
      const code = query.get('code');
      if (!code)
        return {
          status: 400,
          said: 'GitHub sent no sign-in. The host’s GitHub App must ask for it during installation.',
        };
      // GitHub doesn't vouch for the installation in its redirect: the user's own token must show it is theirs to give.
      const confirmed = await app.confirm(code, installation).catch(() => null);
      if (!confirmed)
        return {
          status: 403,
          said: 'Only the GitHub account it was installed on, or an admin of that organisation, may connect it.',
        };
      return { account: confirmed.account, reaches: await app.repos(installation), data: { installation } };
    },

    tools(connection: Connected, options: { readonly mayWrite: boolean; readonly budget: () => boolean }) {
      const installation = installationOf(connection.data);
      if (installation === null) return [];
      return githubTools({ app, installation, repos: connection.reaches, ...options });
    },

    ...(app.hooks
      ? {
          async hook(body: string, headers: IncomingMessage['headers']): Promise<ServiceChange> {
            if (!app.signed(body, header(headers, 'x-hub-signature-256'))) return { kind: 'unsigned' };
            const payload: unknown = JSON.parse(body);
            return changeFrom(app, header(headers, 'x-github-event') ?? '', payload);
          },
        }
      : {}),
  });
}

/** What a webhook call from GitHub changes for the connections on its installation */
async function changeFrom(app: GitHubApp, event: string, payload: unknown): Promise<ServiceChange> {
  if (!isRecord(payload) || !isRecord(payload.installation)) return NOTHING;
  const installation = payload.installation.id;
  if (typeof installation !== 'number') return NOTHING;
  const which = (data: Readonly<Record<string, unknown>>) => installationOf(data) === installation;
  const { action } = payload;
  // Uninstalled or suspended on GitHub: the bots it reached are connected no more.
  if (event === 'installation' && (action === 'deleted' || action === 'suspend'))
    return { kind: 'forget', which, said: `installation ${installation} ${String(action)}` };
  if (event === 'installation_repositories' || (event === 'installation' && action === 'unsuspend')) {
    const reaches = await app.repos(installation);
    return {
      kind: 'reaches',
      which,
      reaches,
      said: `installation ${installation}: ${reaches.length} repositories`,
    };
  }
  return NOTHING;
}
