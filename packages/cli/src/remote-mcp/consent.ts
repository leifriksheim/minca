/**
 * Where the person allows a chat app: the interaction `oidc-provider` hands
 * over (`oauth.ts`). The page says which app it is and where it will send
 * them back, and connects at their account home like any app does
 * (`consent-script.ts`), for records in the spaces they pick there. Only once the home has signed a records-only note, and the service
 * has checked it, does the app get a code. How it looks is `consent-page.ts`.
 *
 * Every sign-in comes here: the service keeps no sign-in in the browser to skip
 * it with (`oauth.ts`). The code goes only to where the app registered, which
 * registering checked is a place a code is safe at (`redirects.ts`), checked
 * here again.
 */
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isRecord, messageOf } from '../json.js';
import { checkGranted } from './sessions.js';
import { consentScript } from './consent-bundle.js';
import { consentHtml, noticeHtml } from './consent-page.js';
import { INTERACTION_PATH, MCP_SCOPE, type OAuth } from './oauth.js';
import { mayRedirect } from './redirects.js';

/** How many days the note a connector gets lasts: the home may give fewer */
const CONNECT_DAYS = 30;

/** A request parameter as given, or nothing */
const text = (value: unknown) => (typeof value === 'string' ? value : '');

const MAX_BODY = 64 * 1024;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('That request is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const sendJson = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

export interface ConsentOptions {
  readonly oauth: OAuth;
  /** The service's public address */
  readonly issuer: string;
  /** The MCP endpoint tokens are for */
  readonly resource: string;
  /** What the service calls itself */
  readonly name: string;
  /** The account home the page suggests */
  readonly accountHome: string;
  /** More chat apps a code may go to, by host or scheme (`MINCA_MCP_APPS`) */
  readonly moreApps?: ReadonlyArray<string>;
  readonly log?: (line: string) => void;
}

/** Answers requests under {@link INTERACTION_PATH}; false for any other path */
export function createConsent(options: ConsentOptions) {
  const { provider } = options.oauth;
  const log = options.log ?? (() => {});
  const hostName = new URL(options.issuer).host;

  /** The interaction this browser is in, and the app asking, with where it sends people back */
  async function asking(req: IncomingMessage, res: ServerResponse) {
    const details = await provider.interactionDetails(req, res);
    const clientId = text(details.params.client_id);
    const client = await provider.Client.find(clientId);
    if (!client) throw new Error('This app is not registered here any more. Start again from the app.');
    const redirect = text(details.params.redirect_uri);
    const name = (client.clientName ?? '').trim().slice(0, 60) || 'An app';
    return { details, client, redirect, name };
  }

  /** A POST from this page only: same origin, JSON, so no other site can make one */
  const fromThisPage = (req: IncomingMessage) => {
    const origin = req.headers.origin;
    return (
      origin === new URL(options.issuer).origin &&
      (req.headers['content-type'] ?? '').split(';')[0]?.trim() === 'application/json'
    );
  };

  async function page(req: IncomingMessage, res: ServerResponse, uid: string) {
    const { redirect, name } = await asking(req, res);
    if (!mayRedirect(redirect, options.moreApps)) {
      log(`connector refused: ${name} asked to send its code to ${redirect}`);
      return sendPage(
        res,
        400,
        noticeHtml(
          'This app can’t connect here',
          `${name} wants its sign-in sent to ${redirect}, which isn’t a chat app this service knows. If you started this from a chat app, tell its makers; if someone sent you this link, close it.`,
        ),
      );
    }
    const script = await consentScript();
    if (script.includes('</script')) throw new Error('The consent script would end its own element');
    const data = {
      name: `${name}, through ${hostName}`,
      days: CONNECT_DAYS,
      allow: `${INTERACTION_PATH}${uid}/allow`,
      deny: `${INTERACTION_PATH}${uid}/deny`,
    };
    return sendPage(
      res,
      200,
      consentHtml({
        app: name,
        host: hostName,
        back: displayOf(redirect),
        home: options.accountHome,
        data,
        script,
      }),
      script,
    );
  }

  async function allow(req: IncomingMessage, res: ServerResponse) {
    if (!fromThisPage(req)) return sendJson(res, 403, { error: 'Only the consent page may answer' });
    const { details, client, redirect, name } = await asking(req, res);
    // One answer to a sign-in: the person allows once, and nobody adds more under it.
    if (details.result) return sendJson(res, 409, { error: 'This sign-in was answered already' });
    // Checked again here: the page is only a page, and anyone may post.
    if (!mayRedirect(redirect, options.moreApps))
      return sendJson(res, 400, { error: 'This app can’t connect here' });
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return sendJson(res, 400, { error: 'That isn’t JSON' });
    }
    if (!isRecord(body)) return sendJson(res, 400, { error: 'Send the key and the grant' });
    let granted;
    try {
      granted = await checkGranted(body.key, body.grant);
    } catch (error) {
      return sendJson(res, 400, { error: messageOf(error) });
    }
    // Kept only until the app collects its token, which then carries it (`oauth.ts`).
    const id = await options.oauth.pend(granted);
    // Signing in and consenting are one step here: the person consented at their home. So the grant
    // covers what the app asked for, which can only be this endpoint's scope (`oauth.ts` refuses any
    // other resource).
    const grant = new provider.Grant({ accountId: id, clientId: client.clientId });
    const asked = text(details.params.scope).split(' ');
    const scopes = asked.filter((scope) => scope === MCP_SCOPE);
    if (scopes.length) grant.addOIDCScope(scopes.join(' '));
    grant.addResourceScope(options.resource, MCP_SCOPE);
    const grantId = await grant.save();
    const redirectTo = await provider.interactionResult(
      req,
      res,
      { login: { accountId: id }, consent: { grantId } },
      { mergeWithLastSubmission: false },
    );
    log(`connector: ${JSON.stringify(name)} connected for ${granted.grant.did}`);
    return sendJson(res, 200, { redirect: redirectTo });
  }

  async function deny(req: IncomingMessage, res: ServerResponse) {
    if (!fromThisPage(req)) return sendJson(res, 403, { error: 'Only the consent page may answer' });
    const redirectTo = await provider.interactionResult(
      req,
      res,
      { error: 'access_denied', error_description: 'The person said no.' },
      { mergeWithLastSubmission: false },
    );
    return sendJson(res, 200, { redirect: redirectTo });
  }

  return async function route(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
    if (!pathname.startsWith(INTERACTION_PATH)) return false;
    const [uid, action] = pathname.slice(INTERACTION_PATH.length).split('/');
    if (!uid || !/^[A-Za-z0-9_-]{1,64}$/.test(uid)) return false;
    try {
      if (req.method === 'GET' && action === undefined) await page(req, res, uid);
      else if (req.method === 'POST' && action === 'allow') await allow(req, res);
      else if (req.method === 'POST' && action === 'deny') await deny(req, res);
      else return false;
    } catch (error) {
      // Mostly an interaction run out, or another browser's: the app starts it again.
      log(`connector consent failed: ${messageOf(error)}`);
      if (res.headersSent) res.end();
      else if (req.method === 'GET')
        sendPage(res, 400, noticeHtml('This link has run out', 'Go back to the app and connect again.'));
      else sendJson(res, 400, { error: 'This sign-in has run out. Go back to the app and connect again.' });
    }
    return true;
  };
}

/** Where an app sends people back, as they'd recognise it: a host, or "this computer" */
function displayOf(uri: string): string {
  const url = new URL(uri);
  if (url.protocol === 'https:') return url.hostname;
  if (url.protocol === 'http:') return 'an app on this computer';
  return `an app on this device (${url.protocol.slice(0, -1)})`;
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('base64');

/** A page, its script allowed by hash and nothing else: no other script runs, and it reaches only this service */
function sendPage(res: ServerResponse, status: number, html: string, script?: string): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
    'content-security-policy':
      `default-src 'none'; style-src 'unsafe-inline'; connect-src 'self'; ` +
      `script-src ${script ? `'sha256-${sha256(script)}'` : "'none'"}; ` +
      "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  });
  res.end(html);
}
