import { tokenCss } from '../tokens';

/**
 * Minca's look for a screen, so it sits well beside the app around it without
 * the screen writing any of it: plain elements styled as the app's are, and a
 * few classes for layout. Everything reads the tokens' custom properties, so a
 * screen can use them too: `var(--minca-accent)`.
 */
export const css = `${tokenCss}
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; }
body {
  background: var(--minca-page); color: var(--minca-body);
  font: 14px/1.5 var(--minca-font); padding: 16px;
}
h1, h2, h3, h4 { margin: 0; color: var(--minca-ink); font-family: var(--minca-display); font-weight: 700; letter-spacing: -0.04em; line-height: 1.2; }
h1 { font-size: 24px; } h2 { font-size: 18px; } h3 { font-size: 15px; } h4 { font-size: 13px; }
p { margin: 0; }
a { color: var(--minca-accent); }
button {
  font: inherit; font-size: 13px; font-weight: 500; min-height: 36px; padding: 0 14px;
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  border: 1px solid var(--minca-line-strong); border-radius: var(--minca-radius-pill);
  background: var(--minca-card); color: var(--minca-ink); cursor: pointer;
}
button[data-icon] { width: 36px; padding: 0; flex-shrink: 0; }
button:hover { background: var(--minca-sunken); }
button[data-variant="primary"] { background: var(--minca-accent); border-color: transparent; color: var(--minca-inverse); }
button[data-variant="primary"]:hover { background: var(--minca-accent-hover); }
button[data-variant="ghost"] { background: none; border-color: transparent; color: var(--minca-muted); }
button[data-variant="ghost"]:hover { background: var(--minca-sunken); color: var(--minca-ink); }
button[data-variant="danger"] { color: var(--minca-danger); }
button:disabled { opacity: .5; cursor: default; }
input, textarea, select {
  font: inherit; color: var(--minca-ink); width: 100%; min-height: 36px; padding: 6px 12px;
  background: var(--minca-card); border: 1px solid var(--minca-line-strong); border-radius: var(--minca-radius-md);
}
input:focus, textarea:focus, select:focus { outline: none; border-color: var(--minca-accent); }
:focus-visible { outline: 2px solid var(--minca-accent); outline-offset: 2px; }
.card { background: var(--minca-card); border: 1px solid var(--minca-line); border-radius: var(--minca-radius-lg); padding: 12px 14px; }
.row { display: flex; align-items: center; gap: 8px; }
.stack { display: flex; flex-direction: column; gap: 8px; }
.muted { color: var(--minca-muted); }
.faint { color: var(--minca-faint); font-size: 12px; }
.empty { padding: 40px 16px; text-align: center; color: var(--minca-muted); }
.person { display: inline-flex; align-items: center; gap: 6px; min-height: 0; padding: 0; border: none; background: none; color: inherit; font-size: inherit; font-weight: inherit; }
.person:hover { background: none; text-decoration: underline; text-underline-offset: 3px; }
.ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.label { font-size: 12px; font-weight: 600; color: var(--minca-muted); }
.error { font-size: 13px; color: var(--minca-danger); }
.badge { padding: 2px 8px; border-radius: var(--minca-radius-pill); background: var(--minca-sunken); color: var(--minca-muted); font-size: 12px; }
.tabs { display: flex; gap: 2px; align-self: flex-start; max-width: 100%; padding: 4px; overflow-x: auto; border-radius: var(--minca-radius-pill); background: var(--minca-sunken); }
.tabs > button { min-height: 30px; padding: 0 14px; border-color: transparent; background: none; color: var(--minca-muted); white-space: nowrap; }
.tabs > button:hover { background: none; color: var(--minca-ink); }
.tabs > button[aria-selected="true"] { background: var(--minca-card); border-color: var(--minca-rule); color: var(--minca-ink); }
.scroll-x { display: flex; gap: 6px; align-items: center; overflow-x: auto; scrollbar-width: none; }
.scroll-x > * { flex-shrink: 0; white-space: nowrap; }
.divider { width: 1px; height: 20px; margin: 0 4px; background: var(--minca-line); }
.c-cobalt { --c: var(--minca-cobalt); } .c-coral { --c: var(--minca-coral); } .c-peach { --c: var(--minca-peach); }
.c-sage { --c: var(--minca-sage); } .c-lilac { --c: var(--minca-lilac); }
.chip { min-height: 32px; max-width: 280px; padding: 0 12px; font-weight: 400; }
.chip[aria-pressed="true"] { background: var(--minca-ink); border-color: var(--minca-ink); color: var(--minca-inverse); }
.modal-scrim { position: fixed; inset: 0; z-index: 100; display: flex; align-items: flex-start; justify-content: center; padding: 40px 16px; overflow-y: auto; background: var(--minca-scrim); }
.modal { width: 100%; display: flex; flex-direction: column; gap: 16px; padding: 20px; background: var(--minca-card); border-radius: var(--minca-radius-lg); box-shadow: var(--minca-shadow); }
.modal:focus { outline: none; }
.cover { position: relative; overflow: hidden; background: var(--minca-sunken); }
.place-field { position: relative; }
.place-chosen { min-height: 40px; padding: 4px 4px 4px 16px; border: 1px solid var(--minca-line-strong); border-radius: var(--minca-radius-pill); }
.suggestions { position: absolute; z-index: 5; left: 0; right: 0; margin: 4px 0 0; padding: 4px 0 0; list-style: none; overflow: hidden; background: var(--minca-card); border: 1px solid var(--minca-line); border-radius: var(--minca-radius-md); box-shadow: var(--minca-shadow-small); }
.suggestions li { display: flex; flex-direction: column; padding: 8px 12px; cursor: pointer; }
.suggestions li[aria-selected="true"] { background: var(--minca-sunken); }
.suggestions .credit { padding: 6px 12px; font-size: 11px; color: var(--minca-faint); border-top: 1px solid var(--minca-line); }
.mention-input { position: relative; flex: 1; min-width: 0; }
.suggestions.above { top: auto; bottom: 100%; margin: 0 0 4px; }
.attachments { display: flex; flex-wrap: wrap; gap: 6px; }
.attachment { justify-content: flex-start; max-width: 280px; min-height: 36px; border-radius: var(--minca-radius-md); font-weight: 400; }
.attachment.picture { padding: 0; overflow: hidden; border: 1px solid var(--minca-line); }
.attachment.picture img { display: block; max-width: 280px; max-height: 220px; object-fit: cover; }
.attachment.playable { display: block; padding: 6px; border: 1px solid var(--minca-line); background: var(--minca-sunken); }
.attachment.playable.video { padding: 0; overflow: hidden; background: #000; }
.attachment.playable video { display: block; width: 280px; max-height: 220px; }
.attachment.playable audio { display: block; width: 268px; }
.record { justify-content: flex-start; gap: 8px; max-width: 100%; min-height: 36px; padding: 4px 10px 4px 6px; border-radius: var(--minca-radius-md); font-weight: 400; text-align: left; }
.record-face { flex-shrink: 0; width: 24px; height: 24px; display: grid; place-items: center; object-fit: cover; border-radius: var(--minca-radius-sm); }
.lightbox { display: block; max-width: 100%; max-height: 75vh; margin: 0 auto; object-fit: contain; border-radius: var(--minca-radius-md); }
.comment-text { white-space: pre-wrap; word-break: break-word; }
.mention { padding: 0 2px; border-radius: var(--minca-radius-sm); background: var(--minca-accent-soft); color: var(--minca-accent); }
`;
