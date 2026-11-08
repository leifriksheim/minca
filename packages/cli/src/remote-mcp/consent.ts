/**
 * Where the person allows a chat app: the interaction `oidc-provider` hands
 * over (`oauth.ts`). The page says which app it is and where it will send
 * them back, and connects at their account home like any app does
 * (`consent-script.ts`). Only once the home has signed a records-only note,
 * and the service has checked it, does the app get a code.
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
    if (!fromThisPage(req))
      return sendJson(res, 403, {
        error: 'Only this service’s own page may answer. Reload it, or start again from the chat app.',
      });
    const { details, client, redirect, name } = await asking(req, res);
    // One answer to a sign-in: the person allows once, and nobody adds more under it.
    if (details.result)
      return sendJson(res, 409, {
        error:
          'This sign-in was answered already. Go back to the chat app; connect again from there if it isn’t connected.',
      });
    // Checked again here: the page is only a page, and anyone may post.
    if (!mayRedirect(redirect, options.moreApps))
      return sendJson(res, 400, { error: 'This app can’t connect here' });
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return sendJson(res, 400, {
        error: 'The page sent something this service can’t read. Start again from the chat app.',
      });
    }
    if (!isRecord(body))
      return sendJson(res, 400, { error: 'The page sent no key and grant. Start again from the chat app.' });
    let granted;
    try {
      granted = await checkGranted(body.key, body.grant);
    } catch (error) {
      return sendJson(res, 400, { error: messageOf(error) });
    }
    // Kept as it is only until the app collects its token, then sealed under a key the token carries (`oauth.ts`).
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
    if (!fromThisPage(req))
      return sendJson(res, 403, {
        error: 'Only this service’s own page may answer. Reload it, or start again from the chat app.',
      });
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

// Minca's paper, navy ink and rainbow mark, inline so the page loads nothing from anyone.
const MARK_SVG =
  '<svg width="28" height="15" viewBox="0 0 24 13" aria-hidden="true"><path d="M0.5 12.5A11.5 11.5 0 0 1 23.5 12.5H20.75A8.75 8.75 0 0 0 3.25 12.5Z" fill="#2340d6"/><path d="M3.25 12.5A8.75 8.75 0 0 1 20.75 12.5H18A6 6 0 0 0 6 12.5Z" fill="#ff6b4a"/><path d="M6 12.5A6 6 0 0 1 18 12.5H15.25A3.25 3.25 0 0 0 8.75 12.5Z" fill="#ffc46b"/><path d="M8.75 12.5A3.25 3.25 0 0 1 15.25 12.5Z" fill="#4e8f6c"/></svg>';
/** A tick and a cross, for what it can and can't do */
const YES_SVG =
  '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const NO_SVG =
  '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const CSS =
  ':root{--paper:#f6f3ee;--card:#fffdf9;--ink:#2a3352;--strong:#13214a;--muted:#5a6178;--line:#e3ddd2;--yes:#2f7a52;--no:#b0412e;--danger-bg:#fbe9e5;--focus:#2340d6;color-scheme:light dark}' +
  '@media (prefers-color-scheme:dark){:root{--paper:#11162a;--card:#181f38;--ink:#d6dbec;--strong:#f2f4fb;--muted:#9aa2bd;--line:#2a3253;--yes:#7cc79d;--no:#f08f7c;--danger-bg:#3a1f25;--focus:#8ea2ff}}' +
  '*{box-sizing:border-box}[hidden]{display:none!important}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}' +
  'main{max-width:480px;margin:0 auto;padding:40px 16px 48px}' +
  '.brand{display:flex;align-items:center;gap:8px;font-weight:700;color:var(--strong);letter-spacing:-0.01em;margin-bottom:20px}' +
  '.card{background:var(--card);border:1px solid var(--line);border-radius:20px;padding:28px 24px}' +
  '.pair{display:flex;align-items:center;gap:10px;margin-bottom:18px}' +
  '.badge{display:grid;place-items:center;width:44px;height:44px;border-radius:14px;background:var(--paper);border:1px solid var(--line);font-size:18px;font-weight:700;line-height:1;color:var(--strong)}' +
  '.dots{color:var(--muted);letter-spacing:2px}' +
  'h1{margin:0 0 6px;font-size:26px;font-weight:700;line-height:1.2;letter-spacing:-0.025em;color:var(--strong)}' +
  '.lead{margin:0 0 20px;color:var(--muted)}' +
  'ul{list-style:none;margin:0 0 20px;padding:0;display:grid;gap:10px}' +
  'li{display:flex;gap:10px;align-items:flex-start}li svg{flex:none;margin-top:3px}' +
  'li.yes svg{color:var(--yes)}li.no svg{color:var(--no)}' +
  '.next{margin:0 0 18px;padding:12px 14px;border-radius:12px;background:var(--paper);font-size:14px}' +
  '.home{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:0 0 16px;font-size:14px;color:var(--muted)}' +
  '.home strong{color:var(--strong);font-weight:600;word-break:break-all}' +
  '.link{background:none;border:0;padding:0;color:var(--focus);font:inherit;font-weight:600;cursor:pointer;text-decoration:underline;text-underline-offset:2px}' +
  'label{display:block;margin:0 0 6px;font-weight:600;color:var(--strong);font-size:14px}' +
  'input{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:10px;font:inherit;background:var(--paper);color:inherit;margin-bottom:16px}' +
  '.row{display:flex;flex-direction:column;gap:8px}' +
  'button.go,button.stop{width:100%;padding:13px 16px;border-radius:999px;font:inherit;font-weight:600;line-height:1.2;cursor:pointer}' +
  'button.go{background:var(--strong);color:var(--card);border:1px solid var(--strong)}button.stop{background:transparent;color:var(--muted);border:1px solid transparent}' +
  'button.stop:hover:not(:disabled){color:var(--strong)}' +
  'button:disabled{opacity:.55;cursor:default}' +
  ':focus-visible{outline:2px solid var(--focus);outline-offset:2px}' +
  '#said{min-height:1.5em;margin:14px 0 0;font-size:14px;color:var(--muted)}' +
  '#said[data-tone=danger]{color:var(--no);background:var(--danger-bg);padding:10px 12px;border-radius:10px}' +
  '#said[data-busy]::before{content:"";display:inline-block;width:12px;height:12px;margin-right:8px;vertical-align:-1px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:spin .8s linear infinite}' +
  '@keyframes spin{to{transform:rotate(360deg)}}@media (prefers-reduced-motion:reduce){#said[data-busy]::before{animation:none}}' +
  'details{margin-top:20px;font-size:14px;color:var(--muted)}summary{cursor:pointer;font-weight:600;color:var(--strong)}details p{margin:8px 0 0}' +
  '.foot{margin:16px 4px 0;font-size:13px;color:var(--muted);text-align:center}';

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
  const home = escapeHtml(params.home);
  const homeHost = escapeHtml(hostOf(params.home));
  const initial = escapeHtml(([...params.app.trim()][0] ?? '?').toUpperCase());
  const yes = (text: string) => `<li class="yes">${YES_SVG}<span>${text}</span></li>`;
  const no = (text: string) => `<li class="no">${NO_SVG}<span>${text}</span></li>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Connect ${app} to Minca</title><style>${CSS}</style></head><body><main>
<div class="brand">${MARK_SVG}<span>Minca</span></div>
<div class="card">
<div class="pair" aria-hidden="true"><span class="badge">${initial}</span><span class="dots">···</span><span class="badge">${MARK_SVG}</span></div>
<h1>Connect ${app} to Minca</h1>
<p class="lead">${app} will act for you in your Minca spaces, through ${host}.</p>
<ul aria-label="What ${app} can and can’t do">
${yes('Reads the spaces you choose: every one, or only some')}
${yes('Writes records there as you, marked “via agent”')}
${no('Can’t add collections, change roles or invite people. It proposes them for someone who may')}
${no('Never sees your password or passkeys')}
</ul>
<p class="next">Next, your account home opens in a new window. There you choose which spaces it gets, and what it may change.</p>
<form id="connect" novalidate>
<div class="home" id="home-shown"><span>Account home: <strong id="home-name">${homeHost}</strong></span><button type="button" class="link" id="change-home">Change</button></div>
<div id="home-field" hidden><label for="home">Your account home</label><input id="home" name="home" autocomplete="url" inputmode="url" spellcheck="false" autocapitalize="off" value="${home}"></div>
<div class="row"><button type="submit" class="go" id="go">Continue</button><button type="button" class="stop" id="cancel">Don’t connect</button></div>
<p id="said" role="status" aria-live="polite"></p>
</form>
<details><summary>How your spaces are kept safe</summary>
<p>The key ${app} acts with lives in its sign-in, sealed so only ${host} can open it. While ${app} is working, ${host} holds the spaces it uses in memory and can read them. They go once ${app} has been idle for 10 minutes, and nothing is kept after.</p>
<p>Access lasts 30 days. At your account home ${host} shows as one connection: disconnecting it there disconnects every chat app you connected through ${host}.</p>
</details>
</div>
<p class="foot">Once you allow it, you go back to ${escapeHtml(params.back)}.</p>
</main>
<script type="application/json" id="minca-consent">${scriptJson(params.data)}</script>
<script>${params.script}</script></body></html>`;
}

/** An address as a person reads it: its host, or what was given when it isn't one */
function hostOf(address: string): string {
  try {
    return new URL(address).host;
  } catch {
    return address;
  }
}

function noticeHtml(title: string, said: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title><style>${CSS}</style></head><body><main><div class="brand">${MARK_SVG}<span>Minca</span></div><div class="card"><h1>${escapeHtml(title)}</h1><p class="lead">${escapeHtml(said)}</p></div></main></body></html>`;
}
