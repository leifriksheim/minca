/**
 * The consent page's script, in the person's browser (bundled by
 * `consent-bundle.ts`). The page is an app like any other to the account
 * home: it makes a key, opens the home in a popup and asks for a records-only
 * note made out to that key (`connectToHome`), for every space; the home lets
 * the person keep it to some. Then it hands the key and the note to the host, which runs the agent under
 * them from now on, and goes where the host says: back to the chat app.
 */
import { didOf } from '@minca/core';
import { connectToHome, homeAddress } from '@minca/core/session';

interface PageData {
  /** What the home shows the connection as: "Claude, through mcp.minca.social" */
  readonly name: string;
  readonly days: number;
  readonly allow: string;
  readonly deny: string;
}

const element = <T extends HTMLElement>(id: string) => {
  const found = document.getElementById(id);
  if (!found) throw new Error(`The page has no #${id}`);
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the page this script ships with has these elements
  return found as T;
};

// eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- written by the host into the page with this script
const data = JSON.parse(element('minca-consent').textContent ?? '{}') as PageData;
const form = element<HTMLFormElement>('connect');
const homeInput = element<HTMLInputElement>('home');
const homeField = element('home-field');
const homeShown = element('home-shown');
const homeName = element('home-name');
const go = element<HTMLButtonElement>('go');
const cancel = element<HTMLButtonElement>('cancel');
const said = element('said');

const GO = go.textContent ?? 'Continue';

/** What the page says under its buttons: a plain line, one with a spinner, or a problem */
function say(text: string, tone: 'plain' | 'busy' | 'danger' = 'plain'): void {
  said.textContent = text;
  if (tone === 'danger') said.setAttribute('data-tone', 'danger');
  else said.removeAttribute('data-tone');
  if (tone === 'busy') said.setAttribute('data-busy', '');
  else said.removeAttribute('data-busy');
}

/** Where the page is: ready, waiting on the home's window, finishing, or gone back to the app */
function stage(now: 'ready' | 'waiting' | 'finishing' | 'done'): void {
  // Waiting, the main button stays: a window the browser hid, or one closed by mistake, opens again from it.
  go.disabled = now === 'finishing' || now === 'done';
  cancel.disabled = now === 'finishing' || now === 'done';
  go.textContent = now === 'waiting' ? 'Open your account home again' : GO;
}

/** Says which home Continue opens, in the button too, so the person knows where they're going */
function showHome(): void {
  try {
    const host = new URL(homeAddress(homeInput.value)).host;
    homeName.textContent = host;
    go.textContent = `Continue to ${host}`;
  } catch {
    homeName.textContent = homeInput.value.trim() || 'none';
    go.textContent = GO;
  }
}

element<HTMLButtonElement>('change-home').addEventListener('click', () => {
  homeShown.hidden = true;
  homeField.hidden = false;
  homeInput.focus();
  homeInput.select();
});
homeInput.addEventListener('input', showHome);
showHome();

/** Tells the host, and follows where it sends the browser next */
async function finish(url: string, body: unknown): Promise<void> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error('Couldn’t reach this service. Check your connection, and try again.');
  }
  const answer: unknown = await response.json().catch(() => ({}));
  const record = typeof answer === 'object' && answer !== null ? answer : {};
  if ('redirect' in record && typeof record.redirect === 'string') {
    globalThis.location.assign(record.redirect);
    return;
  }
  throw new Error(
    'error' in record && typeof record.error === 'string'
      ? record.error
      : `This service couldn’t finish connecting (${response.status}). Start again from the chat app.`,
  );
}

/** A key the host can keep: made here, then handed over whole with the note made out to it */
async function newKey() {
  const keys = await globalThis.crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  return { keys, did: await didOf(keys.publicKey) };
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Each press of Continue opens a window of its own. Whichever the person
 * allows in first is the one kept; a problem is shown only from the latest,
 * since an earlier window was given up for it.
 */
let attempt = 0;
/** The try being finished with the host, or 0 */
let finishing = 0;

form.addEventListener('submit', (event) => {
  event.preventDefault();
  let home: string;
  try {
    home = homeAddress(homeInput.value);
  } catch (error) {
    homeShown.hidden = true;
    homeField.hidden = false;
    homeInput.focus();
    say(message(error), 'danger');
    return;
  }
  const mine = ++attempt;
  stage('waiting');
  say('Allow it in the window that opened. Don’t see it? Press the button to open it again.', 'busy');
  // Made while the popup opens, so the popup still counts as the click's.
  const key = newKey();
  void connectToHome({
    home,
    key,
    request: { name: data.name, access: 'write', scope: 'account', recordsOnly: true, days: data.days },
  })
    .then(async (grant) => {
      if (finishing) return;
      finishing = mine;
      stage('finishing');
      say('Connecting…', 'busy');
      const { keys } = await key;
      const subtle = globalThis.crypto.subtle;
      await finish(data.allow, {
        grant,
        key: {
          privateKey: await subtle.exportKey('jwk', keys.privateKey),
          publicKey: await subtle.exportKey('jwk', keys.publicKey),
        },
      });
      stage('done');
      say('Connected. Taking you back…', 'busy');
    })
    .catch((error: unknown) => {
      // Another window is the one being finished, or this one was given up for a newer one: nothing to say.
      if (finishing ? finishing !== mine : mine !== attempt) return;
      finishing = 0;
      stage('ready');
      showHome();
      say(message(error), 'danger');
    });
});

cancel.addEventListener('click', () => {
  attempt += 1;
  finishing = -1;
  stage('finishing');
  say('Cancelling…', 'busy');
  void finish(data.deny, {}).catch((error: unknown) => {
    finishing = 0;
    stage('ready');
    showHome();
    say(message(error), 'danger');
  });
});
