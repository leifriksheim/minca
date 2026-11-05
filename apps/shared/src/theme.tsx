import { useEffect } from 'react';
import { accountSetting, fieldOf } from './setting';

/**
 * Day or night, chosen once for the account and read by the Minca app and the
 * account home alike (`accountSetting`). Until the record arrives, a page shows
 * the last theme this device saw, so it doesn't open in the wrong colours.
 */
type Theme = 'light' | 'dark' | 'system';

const THEMES: ReadonlyArray<Theme> = ['light', 'dark', 'system'];
const isTheme = (value: unknown): value is Theme => THEMES.some((theme) => theme === value);

const theme = accountSetting({
  name: 'minca.theme',
  title: 'Theme',
  schema: { type: 'object', properties: { theme: { enum: [...THEMES] } }, required: ['theme'] },
  valid: (body): body is { readonly theme: Theme } => isTheme(fieldOf(body, 'theme')),
  fallback: { theme: 'light' },
});

/** Draws the page in a theme (`data-theme`, `@minca/ui`'s tokens) */
function draw(chosen: Theme): void {
  if (chosen === 'light') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = chosen;
}

/** The theme this device last saw: call it before the first render */
export const applyRememberedTheme = () => draw(theme.get().theme);

/** Keeps the page in the account's theme as it changes, here or on another device. Mount it once. */
export function AccountTheme() {
  const [{ theme: shown }] = theme.use();
  useEffect(() => draw(shown), [shown]);
  return null;
}

/** Light, dark, or the device's: kept for the account, so every device and both apps follow */
export function ThemePicker() {
  const [{ theme: shown }, choose] = theme.use();
  return (
    <div role="tablist" aria-label="Theme">
      {THEMES.map((one) => (
        <button key={one} role="tab" aria-selected={shown === one} onClick={() => choose({ theme: one })}>
          {{ light: 'Light', dark: 'Dark', system: 'Match device' }[one]}
        </button>
      ))}
    </div>
  );
}
