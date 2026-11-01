/**
 * The consent page's script, in the person's browser (bundled by
 * `consent-bundle.ts`). The page is an app like any other to the account
 * home: it makes a key, opens the home in a popup and asks for a records-only
 * note made out to that key (`connectToHome`), in the spaces the person
 * picks. Then it hands the key and the note to the host, which runs the agent
 * under them from now on, and goes where the host says: back to the chat app.
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
const said = element('said');
const buttons = [...form.querySelectorAll('button')];

const say = (text: string) => (said.textContent = text);
const busy = (on: boolean) => buttons.forEach((button) => (button.disabled = on));

/** Tells the host, and follows where it sends the browser next */
async function finish(url: string, body: unknown): Promise<void> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const answer: unknown = await response.json().catch(() => ({}));
  const record = typeof answer === 'object' && answer !== null ? answer : {};
  if ('redirect' in record && typeof record.redirect === 'string') {
    globalThis.location.assign(record.redirect);
    return;
  }
  throw new Error('error' in record && typeof record.error === 'string' ? record.error : 'The host said no.');
}

/** A key the host can keep: made here, then handed over whole with the note made out to it */
async function newKey() {
  const keys = await globalThis.crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  return { keys, did: await didOf(keys.publicKey) };
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  let home: string;
  try {
    home = homeAddress(homeInput.value);
  } catch (error) {
    say(error instanceof Error ? error.message : String(error));
    return;
  }
  busy(true);
  say('Allow it at your account home, in the window that opened.');
  // Made while the popup opens, so the popup still counts as the click's.
  const key = newKey();
  void connectToHome({
    home,
    key,
    request: { name: data.name, access: 'write', scope: 'spaces', recordsOnly: true, days: data.days },
  })
    .then(async (grant) => {
      say('Connecting…');
      const { keys } = await key;
      const subtle = globalThis.crypto.subtle;
      await finish(data.allow, {
        grant,
        key: {
          privateKey: await subtle.exportKey('jwk', keys.privateKey),
          publicKey: await subtle.exportKey('jwk', keys.publicKey),
        },
      });
    })
    .catch((error: unknown) => {
      busy(false);
      say(error instanceof Error ? error.message : String(error));
    });
});

element<HTMLButtonElement>('cancel').addEventListener('click', () => {
  busy(true);
  void finish(data.deny, {}).catch((error: unknown) => {
    busy(false);
    say(error instanceof Error ? error.message : String(error));
  });
});
