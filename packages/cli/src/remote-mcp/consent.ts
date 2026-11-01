/**
 * Where the person allows a chat app: the interaction `oidc-provider` hands
 * over (`oauth.ts`). The page says which app it is and where it will send
 * them back, and connects at their account home like any app does
 * (`consent-script.ts`). Only once the home has signed a records-only note,
 * and the host has checked it, does the app get a code.
 *
 * Every sign-in comes here: the host keeps no sign-in in the browser to skip
 * it with (`oauth.ts`). The code goes only to where the app registered, which
 * registering checked is a place a code is safe at (`redirects.ts`), checked
 * here again.
 */
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isRecord, messageOf } from '../json.js';
import type { Connections } from './connections.js';
import { consentScript } from './consent-bundle.js';
import { INTERACTION_PATH, MCP_SCOPE, type OAuth } from './oauth.js';
import { mayRedirect } from './redirects.js';

/** How many days the note a connector gets lasts: the home may give fewer */
const CONNECT_DAYS = 30;

/** A request parameter as given, or nothing */
const text = (value: unknown) => (typeof value === 'string' ? value : '');

const MAX_BODY = 256 * 1024;

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
  readonly connections: Connections;
  /** The host's public address */
  readonly issuer: string;
  /** The MCP endpoint tokens are for */
  readonly resource: string;
  /** What the host calls itself */
  readonly name: string;
  /** The account home the page suggests */
  readonly accountHome: string;
  /** More chat apps a code may go to, by host or scheme (`MINCA_HOST_MCP_APPS`) */
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
          `${name} wants its sign-in sent to ${redirect}, which isn’t a chat app this host knows. If you started this from a chat app, tell its makers; if someone sent you this link, close it.`,
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
    let connection;
    try {
      connection = await options.connections.add({ key: body.key, grant: body.grant, client: name });
    } catch (error) {
      return sendJson(res, 400, { error: messageOf(error) });
    }
    // Signing in and consenting are one step here: the person consented at their home. So the grant
    // covers what the app asked for, which can only be this endpoint's scope (`oauth.ts` refuses any
    // other resource), and a refresh token.
    const grant = new provider.Grant({ accountId: connection.id, clientId: client.clientId });
    const asked = text(details.params.scope).split(' ');
    grant.addOIDCScope(['offline_access', ...asked.filter((scope) => scope === MCP_SCOPE)].join(' '));
    grant.addResourceScope(options.resource, MCP_SCOPE);
    let redirectTo: string;
    try {
      const grantId = await grant.save();
      redirectTo = await provider.interactionResult(
        req,
        res,
        { login: { accountId: connection.id }, consent: { grantId } },
        { mergeWithLastSubmission: false },
      );
    } catch (error) {
      // No app will act through it: its key isn't kept.
      await options.connections.forget(connection.id);
      throw error;
    }
    log(
      `connector ${connection.id}: ${name} connected for ${connection.grant.name} (${connection.grant.did})`,
    );
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

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
/** JSON inside a `<script>` element: nothing in it can close the element */
const scriptJson = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c');

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('base64');

/** A page, its script allowed by hash and nothing else: no other script runs, and it reaches only this host */
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

// Minca's paper, navy ink and rainbow mark, inline so the page loads nothing from anyone.
const MARK_SVG =
  '<svg width="32" height="17" viewBox="0 0 24 13" aria-hidden="true"><path d="M0.5 12.5A11.5 11.5 0 0 1 23.5 12.5H20.75A8.75 8.75 0 0 0 3.25 12.5Z" fill="#2340d6"/><path d="M3.25 12.5A8.75 8.75 0 0 1 20.75 12.5H18A6 6 0 0 0 6 12.5Z" fill="#ff6b4a"/><path d="M6 12.5A6 6 0 0 1 18 12.5H15.25A3.25 3.25 0 0 0 8.75 12.5Z" fill="#ffc46b"/><path d="M8.75 12.5A3.25 3.25 0 0 1 15.25 12.5Z" fill="#4e8f6c"/></svg>';
const CSS =
  'body{margin:0;background:#f6f3ee;color:#2a3352;font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}' +
  'main{max-width:460px;margin:0 auto;padding:64px 20px}' +
  'h1{margin:28px 0 12px;font:700 28px/1.15 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;letter-spacing:-0.03em;color:#13214a}' +
  'p{margin:0 0 12px}ul{margin:0 0 16px;padding-left:20px}li{margin:4px 0}' +
  'label{display:block;margin:20px 0 6px;font-weight:600;color:#13214a}' +
  'input{box-sizing:border-box;width:100%;padding:10px 12px;border:1px solid #c9c3b8;border-radius:10px;font:inherit;background:#fff;color:inherit}' +
  '.row{display:flex;gap:10px;margin-top:16px}button{flex:1;padding:11px 14px;border-radius:999px;border:1px solid #13214a;font:inherit;font-weight:600;line-height:1;cursor:pointer}' +
  'button[type=submit]{background:#13214a;color:#fff}button[type=button]{background:transparent;color:#13214a}button:disabled{opacity:.5;cursor:default}' +
  '#said{min-height:1.5em;margin-top:14px;color:#5a6178}';

function consentHtml(params: {
  readonly app: string;
  readonly host: string;
  readonly back: string;
  readonly home: string;
  readonly data: unknown;
  readonly script: string;
}): string {
  const app = escapeHtml(params.app);
  const host = escapeHtml(params.host);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Connect ${app} to Minca</title><style>${CSS}</style></head><body><main>${MARK_SVG}
<h1>Connect ${app} to Minca</h1>
<p>${app} will act for you in the spaces you pick at your account home:</p>
<ul><li>It reads them, and writes records there as you, marked “via agent”.</li>
<li>It can’t add collections or change who is in a space: it proposes them for someone who may.</li>
<li>${host} keeps the key it acts with, so ${host} can read those spaces too.</li></ul>
<p>You can disconnect it at your account home at any time. Once you allow it, you go back to ${escapeHtml(params.back)}.</p>
<form id="connect"><label for="home">Your account home</label><input id="home" name="home" autocomplete="url" spellcheck="false" value="${escapeHtml(params.home)}">
<div class="row"><button type="button" id="cancel">Don’t connect</button><button type="submit">Continue</button></div></form>
<p id="said" role="status"></p></main>
<script type="application/json" id="minca-consent">${scriptJson(params.data)}</script>
<script>${params.script}</script></body></html>`;
}

function noticeHtml(title: string, said: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>${CSS}</style></head><body><main>${MARK_SVG}<h1>${escapeHtml(title)}</h1><p>${escapeHtml(said)}</p></main></body></html>`;
}
