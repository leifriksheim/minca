/**
 * @module elements/auth-styles
 * How `<minca-auth>` looks.
 *
 * Black and white, hairline borders, one accent. Every colour, the font and
 * the corner radius are custom properties on the element, so a host page
 * restyles it without reaching inside:
 *
 * ```css
 * minca-auth { --minca-accent: #4f46e5; --minca-font: 'Inter', sans-serif; }
 * ```
 *
 * It sizes itself to its container rather than the window — a container query,
 * not a media query — so the same element fits a full page, a modal or a side
 * panel without being told which.
 */
export const AUTH_CSS = `
minca-auth {
  --minca-ink: #000;
  --minca-body: #171717;
  --minca-muted: #666;
  --minca-faint: #8f8f8f;
  --minca-surface: #fff;
  --minca-sunken: #fafafa;
  --minca-line: #eaeaea;
  --minca-line-strong: #d4d4d4;
  --minca-accent: #000;
  --minca-accent-hover: #383838;
  --minca-on-accent: #fff;
  --minca-danger: #e5484d;
  --minca-danger-soft: #fff0f0;
  --minca-warn: #9a5a0b;
  --minca-good: #2f7a52;
  --minca-radius: 6px;
  --minca-font: "Geist", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --minca-mono: "Geist Mono", ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;

  display: block;
  container-type: inline-size;
  color: var(--minca-body);
  font-family: var(--minca-font);
  font-size: 14px;
  letter-spacing: -0.006em;
  -webkit-font-smoothing: antialiased;
}
minca-auth[hidden] { display: none; }
minca-auth *, minca-auth *::before, minca-auth *::after { box-sizing: border-box; }
minca-auth :is(h1, p) { margin: 0; }

minca-auth .wa-card { width: 100%; max-width: 380px; margin: 0 auto; }
minca-auth .wa-wordmark { display: flex; align-items: center; gap: 8px; margin-bottom: 40px; color: var(--minca-ink); font-weight: 600; font-size: 16px; letter-spacing: -0.03em; }
minca-auth .wa-title { font-size: 28px; font-weight: 600; letter-spacing: -0.04em; color: var(--minca-ink); margin-bottom: 8px; line-height: 1.2; }
minca-auth .wa-subtitle { font-size: 15px; color: var(--minca-muted); margin-bottom: 32px; line-height: 1.5; }
minca-auth .wa-hint { font-size: 14px; color: var(--minca-muted); margin-bottom: 20px; line-height: 1.6; }
minca-auth .wa-small { font-size: 13px; color: var(--minca-muted); margin-top: 8px; line-height: 1.6; }
minca-auth .wa-meter { display: flex; gap: 4px; margin-top: 2px; }
minca-auth .wa-meter > span { flex: 1; height: 4px; border-radius: 2px; background: var(--minca-line); transition: background-color .15s ease; }
minca-auth .wa-meter[data-strength="weak"] > span:first-child { background: var(--minca-danger); }
minca-auth .wa-meter[data-strength="fair"] > span:not(:last-child) { background: var(--minca-warn); }
minca-auth .wa-meter[data-strength="strong"] > span { background: var(--minca-good); }
minca-auth .wa-small[data-strength] { margin-top: 0; }
minca-auth .wa-small[data-strength="weak"] { color: var(--minca-danger); }
minca-auth .wa-error { color: var(--minca-danger); font-size: 14px; font-weight: 500; }
minca-auth .wa-error-box { margin-top: 16px; padding: 12px 14px; border-radius: var(--minca-radius); background: var(--minca-danger-soft); }

minca-auth .wa-form { display: flex; flex-direction: column; gap: 8px; }
minca-auth .wa-form + .wa-form { margin-top: 10px; }
minca-auth input {
  width: 100%; height: 40px; padding: 0 12px;
  border-radius: var(--minca-radius); border: 1px solid var(--minca-line-strong);
  background: var(--minca-surface); color: var(--minca-ink);
  font: inherit; font-size: 14px; outline: none;
  transition: border-color .15s ease, box-shadow .15s ease;
}
minca-auth input::placeholder { color: var(--minca-faint); }
minca-auth .wa-label { font-size: 13px; font-weight: 500; color: var(--minca-ink); margin-top: 8px; }
minca-auth .wa-username {
  display: flex; align-items: center; height: 40px;
  border-radius: var(--minca-radius); border: 1px solid var(--minca-line-strong); background: var(--minca-surface);
  transition: border-color .15s ease, box-shadow .15s ease;
}
minca-auth .wa-username:focus-within { border-color: var(--minca-muted); box-shadow: 0 0 0 3px rgba(0, 0, 0, .06); }
minca-auth .wa-username input, minca-auth .wa-username input:focus { flex: 1; min-width: 0; height: 100%; border: none; box-shadow: none; background: transparent; }
minca-auth .wa-username > span { padding-right: 12px; color: var(--minca-muted); white-space: nowrap; }
minca-auth .wa-small[data-name="free"] { color: var(--minca-good); }
minca-auth .wa-small[data-name="taken"] { color: var(--minca-danger); }
minca-auth input:focus { border-color: var(--minca-muted); box-shadow: 0 0 0 3px rgba(0, 0, 0, .06); }
minca-auth .wa-offscreen {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0;
}

minca-auth button { font: inherit; transition: background-color .15s ease, border-color .15s ease, color .15s ease; }
minca-auth button:not(:disabled) { cursor: pointer; }
minca-auth button:disabled { opacity: .5; cursor: not-allowed; }
minca-auth :focus-visible { outline: 2px solid var(--minca-ink); outline-offset: 2px; }
minca-auth button:focus:not(:focus-visible) { outline: none; }

minca-auth .wa-button {
  width: 100%; height: 40px; padding: 0 16px;
  border-radius: var(--minca-radius); border: 1px solid transparent;
  background: var(--minca-accent); color: var(--minca-on-accent);
  font-size: 14px; font-weight: 500;
}
minca-auth .wa-button:not(:disabled):hover { background: var(--minca-accent-hover); }
minca-auth .wa-link {
  background: none; border: none; padding: 4px 0; margin-right: 12px;
  color: var(--minca-muted); font-size: 13px; font-weight: 500; text-align: left;
}
minca-auth .wa-link:not(:disabled):hover { color: var(--minca-ink); }
minca-auth .wa-links { display: flex; flex-wrap: wrap; margin-top: 10px; }

minca-auth .wa-options { display: flex; flex-direction: column; gap: 12px; }
minca-auth .wa-option {
  display: flex; flex-direction: column; gap: 4px; width: 100%; padding: 16px;
  text-align: left; border-radius: var(--minca-radius);
  border: 1px solid var(--minca-line); background: var(--minca-surface); color: var(--minca-body);
}
minca-auth .wa-option:not(:disabled):hover { background: var(--minca-sunken); border-color: var(--minca-line-strong); }
minca-auth .wa-option-title { display: flex; align-items: center; gap: 8px; font-weight: 500; color: var(--minca-ink); }
minca-auth .wa-option-text { color: var(--minca-muted); font-size: 13px; line-height: 1.5; }
minca-auth .wa-badge {
  font-size: 11px; font-weight: 500; padding: 1px 8px; border-radius: 999px;
  background: var(--minca-sunken); border: 1px solid var(--minca-line); color: var(--minca-muted);
}

minca-auth .wa-accounts { display: flex; flex-direction: column; gap: 8px; }
minca-auth .wa-account { border: 1px solid var(--minca-line); border-radius: var(--minca-radius); background: var(--minca-surface); }
minca-auth .wa-account-open { padding: 20px; border-color: var(--minca-line-strong); }
minca-auth .wa-account-head { display: flex; flex-direction: column; align-items: center; gap: 10px; margin-bottom: 20px; }
minca-auth .wa-account-head .wa-account-name { font-size: 17px; }
minca-auth .wa-account-row {
  display: flex; align-items: center; gap: 12px; width: 100%; padding: 10px 14px;
  text-align: left; color: var(--minca-body);
}
minca-auth .wa-account-row:not(:disabled):hover { background: var(--minca-sunken); }
minca-auth .wa-account-name { display: block; font-weight: 600; color: var(--minca-ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
minca-auth .wa-chevron { color: var(--minca-faint); font-size: 18px; }
minca-auth .wa-or { display: flex; align-items: center; gap: 12px; margin: 14px 0; color: var(--minca-faint); font-size: 12px; }
minca-auth .wa-or::before, minca-auth .wa-or::after { content: ''; flex: 1; height: 1px; background: var(--minca-line); }
minca-auth .wa-secondary.wa-wide { flex: none; width: 100%; height: 40px; }
minca-auth .wa-small .wa-link { padding: 0; margin: 0 8px 0 0; font-size: 13px; }
minca-auth .wa-footer { margin-top: 24px; padding-top: 16px; border-top: 1px solid var(--minca-line); }
minca-auth .wa-footer .wa-links { margin-top: 0; }
minca-auth .wa-avatar { flex-shrink: 0; display: block; border-radius: 8px; }
minca-auth .wa-avatar-round { border-radius: 50% !important; }

minca-auth .wa-code {
  display: block; margin-top: 16px; padding: 12px; border-radius: var(--minca-radius);
  background: var(--minca-sunken); border: 1px solid var(--minca-line);
  font-family: var(--minca-mono); font-size: 13px; color: var(--minca-ink);
  word-break: break-all; user-select: all;
}

minca-auth .wa-code-large { font-size: 17px; letter-spacing: 0.04em; text-align: center; padding: 16px 12px; margin-top: 0; }
minca-auth .wa-row { display: flex; gap: 8px; margin-top: 10px; }
minca-auth .wa-secondary {
  flex: 1; height: 36px; padding: 0 12px;
  border-radius: var(--minca-radius); border: 1px solid var(--minca-line-strong);
  background: var(--minca-surface); color: var(--minca-ink); font-size: 13px; font-weight: 500;
}
minca-auth .wa-secondary:not(:disabled):hover { background: var(--minca-sunken); }
minca-auth .wa-check { display: flex; align-items: flex-start; gap: 10px; margin: 20px 0 16px; font-size: 14px; line-height: 1.5; color: var(--minca-body); cursor: pointer; }
minca-auth .wa-check input { width: 16px; height: 16px; margin: 3px 0 0; padding: 0; flex-shrink: 0; accent-color: var(--minca-accent); box-shadow: none; }
minca-auth .wa-steps { margin: 0 0 20px; padding-left: 20px; font-size: 14px; line-height: 1.6; color: var(--minca-body); }

minca-auth .wa-info { position: relative; display: inline; }
minca-auth .wa-info-button {
  display: inline-flex; align-items: center; justify-content: center;
  width: 16px; height: 16px; padding: 0; margin-left: 6px; vertical-align: text-bottom;
  border-radius: 999px; border: 1px solid var(--minca-line-strong); background: none;
  color: var(--minca-faint); font-size: 10px; font-weight: 700; line-height: 1;
}
minca-auth .wa-popover {
  position: absolute; z-index: 30; top: 22px; left: 0; width: min(260px, 80cqi);
  padding: 12px 14px; border-radius: var(--minca-radius);
  background: var(--minca-surface); border: 1px solid var(--minca-line);
  box-shadow: 0 12px 28px -12px rgba(15, 17, 21, .22);
  font-size: 12.5px; line-height: 1.6; color: var(--minca-muted); font-weight: 400;
}
minca-auth .wa-popover[hidden] { display: none; }

@container (max-width: 340px) {
  minca-auth .wa-title { font-size: 24px; }
  minca-auth .wa-subtitle { margin-bottom: 24px; }
  minca-auth .wa-wordmark { margin-bottom: 28px; }
  minca-auth .wa-popover { left: auto; right: -8px; }
}
`;
