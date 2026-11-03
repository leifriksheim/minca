import { MincaAuth, useMinca } from '@minca/react';
import { avatarElement } from '@minca/ui/avatar';
import { PATHS, type ShapeKind } from '@minca/ui/shapes';
import { Loader } from '@minca/app-shared/Loader';
import { rememberedPicture } from '@minca/app-shared/rememberedPictures';
import './auth.css';

/**
 * The shape each kind of choice in the sign-in element is marked with (its `data-option`), and its
 * hue, as the app's lists of choices have them.
 */
const OPTION_SHAPES: Readonly<Record<string, readonly [ShapeKind, number]>> = {
  create: ['sparkle', 1],
  existing: ['key', 2],
  reopen: ['stack', 4],
  pod: ['stack', 4],
  pair: ['signal', 3],
  code: ['lock', 5],
  passkey: ['pass', 1],
  password: ['key', 2],
};

/** Each shape as a mask over its hue: paths live in code, so this one rule is written from them */
const OPTION_CSS = Object.entries(OPTION_SHAPES)
  .map(([name, [kind, hue]]) => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="${PATHS[kind]}"/></svg>`;
    return `html minca-auth .wa-option[data-option="${name}"] .wa-option-icon { display: block; --hue: var(--color-hue-${hue}); mask-image: url("data:image/svg+xml,${encodeURIComponent(svg)}"); }`;
  })
  .join('\n');

/** The sign-in flow, with Minca's own loader while it starts or signs out, or claims a new account's username */
export function SignIn() {
  const { auth, state } = useMinca();
  if (!state || state.stage === 'starting')
    return (
      <p>
        <Loader label={state?.signingOut ? 'Signing out' : 'Looking for your accounts'} showLabel />
      </p>
    );
  // The claim runs right after the account is made: its few seconds get a screen of their own.
  if (state.stage === 'recovery' && state.username?.status === 'claiming')
    return <Claiming username={state.username.username} domain={auth?.usernames ?? null} />;
  return (
    <>
      <style href="minca-auth-options" precedence="minca">
        {OPTION_CSS}
      </style>
      <MincaAuth avatar={face} />
    </>
  );
}

/**
 * An account's face on the sign-in screens: the picture this browser remembers it by, when it has
 * seen the account signed in, else the shape its DID gives. A picture carries that shape small on its
 * corner: anyone can copy a picture, but not the shape, so two accounts with one face still differ.
 */
function face(did: string, size: number, round: boolean): Element {
  const picture = rememberedPicture(did);
  if (!picture) return avatarElement(did, size, round);
  const doc = globalThis.document;
  const holder = doc.createElement('span');
  holder.style.cssText = `position:relative;display:inline-flex;flex-shrink:0;width:${size}px;height:${size}px`;
  const img = doc.createElement('img');
  img.src = picture;
  img.alt = '';
  img.width = size;
  img.height = size;
  // Round here; otherwise the sign-in screens' own corner for a face.
  img.style.cssText = `width:${size}px;height:${size}px;object-fit:cover${round ? ';border-radius:50%' : ''}`;
  if (!round) img.className = 'wa-avatar';
  const badge = Math.max(12, Math.round(size * 0.38));
  const shape = avatarElement(did, badge, true);
  if (shape instanceof HTMLElement || shape instanceof SVGElement)
    shape.style.cssText = `position:absolute;right:-2px;bottom:-2px;box-shadow:0 0 0 2px var(--minca-card);border-radius:50%`;
  holder.append(img, shape);
  return holder;
}

function Claiming({ username, domain }: { username: string; domain: string | null }) {
  const shown = domain && username.endsWith(`@${domain}`) ? username.slice(0, -domain.length - 1) : username;
  return (
    <section>
      <h1>Claiming {shown}</h1>
      <p>Making sure the name is yours, so people can find you by it.</p>
      <Loader size={22} label={`Claiming ${shown}`} />
    </section>
  );
}
