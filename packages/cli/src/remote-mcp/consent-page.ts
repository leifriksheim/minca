/**
 * How the consent page looks: one question, all spaces or some, one button.
 * Self-contained, its styles inline and built from the design system's
 * tokens, so the page loads nothing from anyone (`sendPage` in `consent.ts`).
 */
import { PATHS } from '@minca/ui/shapes';
import { accent, ink, radius, shapeColours, shapeGrounds, surface } from '@minca/ui/tokens';

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
/** JSON inside a `<script>` element: nothing in it can close the element */
const scriptJson = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c');

/** System faces only: the page fetches no fonts */
const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

/** Minca's mark: four bands of a rainbow (`apps/shared/src/mark.ts`) */
const band = (outer: number, inner: number) =>
  `M${12 - outer} 12.5A${outer} ${outer} 0 0 1 ${12 + outer} 12.5` +
  (inner > 0 ? `H${12 + inner}A${inner} ${inner} 0 0 0 ${12 - inner} 12.5Z` : 'Z');
const MARK = `<svg class="mark" viewBox="0 0 24 13" aria-hidden="true">${[
  [band(11.5, 8.75), shapeColours.cobalt],
  [band(8.75, 6), shapeColours.coral],
  [band(6, 3.25), shapeColours.peach],
  [band(3.25, 0), shapeColours.sage],
]
  .map(([d, fill]) => `<path d="${d}" fill="${fill}"/>`)
  .join('')}</svg>`;

/** The tile's shape, big, off its corner */
const ART = `<svg class="art" viewBox="0 0 100 100" aria-hidden="true"><path d="${PATHS.flower}" fill="${shapeColours.peach}"/></svg>`;

const CSS = `
*{box-sizing:border-box}
html{background:${surface.page}}
body{margin:0;padding:56px 16px;min-height:100vh;color:${ink.body};font:15px/1.5 ${FONT};-webkit-font-smoothing:antialiased}
body::before{content:'';position:fixed;inset:0;z-index:-1;
  background-image:linear-gradient(${surface.line} 1px,transparent 1px),linear-gradient(90deg,${surface.line} 1px,transparent 1px);
  background-size:32px 32px;background-position:center -1px;
  -webkit-mask-image:radial-gradient(ellipse 70% 60% at 50% 40%,#000 30%,transparent 100%);mask-image:radial-gradient(ellipse 70% 60% at 50% 40%,#000 30%,transparent 100%)}
main{position:relative;max-width:440px;margin:0 auto;background:${surface.card};border:1px solid ${surface.rule};border-radius:${radius.xl}px;overflow:hidden}
.top{position:relative;overflow:hidden;height:132px;background:${shapeGrounds.peach};border-bottom:1px solid ${surface.rule};display:flex;align-items:center;justify-content:center;gap:14px}
.art{position:absolute;right:-46px;bottom:-58px;width:170px;height:170px;opacity:.9}
.badge{position:relative;display:grid;place-items:center;width:64px;height:64px;border-radius:50%;background:${surface.card};border:1px solid ${surface.rule}}
.badge b{font:700 28px/1 ${FONT};color:${ink.strong};letter-spacing:-.02em}
.mark{width:40px;height:22px;margin-top:4px}
.link{position:relative;width:28px;border-top:2px dotted ${ink.strong}}
.body{padding:28px 28px 24px}
h1{margin:0 0 8px;font:700 26px/1.15 ${FONT};letter-spacing:-.03em;color:${ink.strong}}
p{margin:0}
.lede{color:${ink.muted}}
.lede b{color:${ink.strong};font-weight:600}
fieldset{margin:22px 0 0;padding:0;border:0;display:grid;gap:8px}
legend{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
.option{display:flex;gap:12px;align-items:center;padding:12px 16px;border:1px solid ${surface.lineStrong};border-radius:${radius.lg}px;cursor:pointer;transition:border-color .15s,background-color .15s}
.option:hover{background:${surface.page}}
.option:has(input:checked){border-color:${accent.base};background:${accent.soft}}
.option input{margin:0;width:18px;height:18px;accent-color:${accent.base};flex:none}
.option span{display:grid}
.option b{font-weight:600;color:${ink.strong}}
.option small{font-size:13px;color:${ink.muted}}
.actions{display:grid;gap:8px;margin-top:22px}
button{height:48px;border-radius:${radius.pill}px;font:600 16px/1 ${FONT};cursor:pointer;transition:background-color .15s,border-color .15s,color .15s}
.primary{background:${accent.base};border:1px solid ${accent.base};color:${ink.inverse}}
.primary:hover{background:${accent.hover};border-color:${accent.hover}}
.quiet{height:40px;background:transparent;border:1px solid transparent;color:${ink.muted};font-weight:500;font-size:15px}
.quiet:hover{color:${ink.strong}}
button:disabled{opacity:.55;cursor:default}
#said{min-height:1.5em;margin-top:6px;text-align:center;font-size:14px;color:${ink.muted}}
#said:empty{display:none}
details{margin-top:18px;padding-top:14px;border-top:1px solid ${surface.line};font-size:14px;color:${ink.muted}}
summary{cursor:pointer;color:${ink.strong};font-weight:500;width:max-content}
details ul{margin:10px 0 0;padding-left:18px;display:grid;gap:6px}
label.field{display:block;margin:14px 0 6px;color:${ink.strong};font-weight:500}
input[type=url]{width:100%;height:40px;padding:0 16px;border:1px solid ${surface.lineStrong};border-radius:${radius.pill}px;font:inherit;font-size:14px;background:${surface.card};color:${ink.body}}
input:focus-visible,button:focus-visible,summary:focus-visible,.option:has(input:focus-visible){outline:2px solid ${accent.base};outline-offset:2px}
.notice{padding:32px 28px}
.notice .mark{display:block;margin:0 0 20px}
@media (max-width:520px){body{padding:0}main{min-height:100vh;border:0;border-radius:0}.body{padding:24px 20px}h1{font-size:24px}}
`;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>${CSS}</style></head><body>${body}</body></html>`;
}

export function consentHtml(params: {
  /** The app, as it registered itself */
  readonly app: string;
  /** This service's host */
  readonly host: string;
  /** Where the app sends people back, as they'd recognise it */
  readonly back: string;
  /** The account home suggested */
  readonly home: string;
  /** What the script reads (`consent-script.ts`) */
  readonly data: unknown;
  readonly script: string;
}): string {
  const app = escapeHtml(params.app);
  const host = escapeHtml(params.host);
  const initial = escapeHtml([...params.app.trim()][0]?.toUpperCase() ?? '?');
  return page(
    `Let ${params.app} use your Minca spaces?`,
    `<main>
<div class="top">${ART}<span class="badge"><b>${initial}</b></span><span class="link"></span><span class="badge">${MARK}</span></div>
<form id="connect" class="body">
<h1>Let ${app} use your Minca spaces?</h1>
<p class="lede">${app} will read your spaces and write in them as you. Then you go back to <b>${escapeHtml(params.back)}</b>.</p>
<fieldset><legend>Which spaces</legend>
<label class="option"><input type="radio" name="spaces" value="all" checked><span><b>All spaces</b><small>New ones too</small></span></label>
<label class="option"><input type="radio" name="spaces" value="some"><span><b>Choose spaces</b><small>You pick them at your account home</small></span></label>
</fieldset>
<div class="actions"><button type="submit" class="primary">Continue</button><button type="button" id="cancel" class="quiet">Not now</button></div>
<p id="said" role="status"></p>
<details><summary>What this allows</summary>
<ul><li>What ${app} writes shows as yours, marked as from an AI.</li>
<li>It can’t add people or change what they may do.</li>
<li>While ${app} works, ${host} keeps the spaces it uses in memory. They’re gone ten minutes after it stops.</li>
<li>Disconnect ${host} at your account home to stop it. That stops every chat app you connected here.</li>
<li>Its sign-in carries a key to the spaces you give it. Disconnecting stops it writing, but what that key can read can’t be taken back yet.</li></ul>
<label class="field" for="home">Your account home</label><input id="home" name="home" type="url" autocomplete="url" spellcheck="false" value="${escapeHtml(params.home)}">
</details>
</form></main>
<script type="application/json" id="minca-consent">${scriptJson(params.data)}</script>
<script>${params.script}</script>`,
  );
}

export function noticeHtml(title: string, said: string): string {
  return page(
    title,
    `<main class="notice">${MARK}<h1>${escapeHtml(title)}</h1><p class="lede">${escapeHtml(said)}</p></main>`,
  );
}
