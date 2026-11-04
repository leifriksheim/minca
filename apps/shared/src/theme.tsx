import { useEffect, useState } from 'react';
import { collection, type P2PNode } from '@minca/core';
import { useNode, useWatched } from '@minca/react';

/**
 * Day or night, chosen once for the account and read by the Minca app and the
 * account home alike: a record in the account's registry (`node.account.space()`),
 * which syncs to every device. Until it arrives, a page shows the last theme
 * this device saw, so it doesn't open in the wrong colours.
 */
type Theme = 'light' | 'dark' | 'system';

const THEMES: ReadonlyArray<Theme> = ['light', 'dark', 'system'];
const isTheme = (value: unknown): value is Theme => THEMES.some((theme) => theme === value);
const CACHE = 'minca.theme';

/** The account's theme: one record per person */
const themes = collection({
  name: 'minca.theme',
  title: 'Theme',
  schema: { type: 'object', properties: { theme: { enum: [...THEMES] } }, required: ['theme'] },
  rules: { onePer: ['@author'] },
});

/** Draws the page in a theme (`data-theme`, `@minca/ui`'s tokens), and remembers it on this device */
function applyTheme(theme: Theme): void {
  if (theme === 'light') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  localStorage.setItem(CACHE, theme);
}

const remembered = (): Theme => {
  const kept = localStorage.getItem(CACHE);
  return isTheme(kept) ? kept : 'light';
};

/** The theme this device last saw: call it before the first render */
export const applyRememberedTheme = () => applyTheme(remembered());

async function readTheme(node: P2PNode): Promise<Theme | null> {
  const space = await node.account.space();
  if (!space) return null;
  const { records } = await node.records.query(space, { collection: themes });
  const body = records[0]?.body;
  const theme = typeof body === 'object' && body !== null && 'theme' in body ? body.theme : null;
  return isTheme(theme) ? theme : null;
}

/** Keeps the page in the account's theme as it changes, here or on another device. Mount it once. */
export function AccountTheme() {
  const theme = useWatched(readTheme, [], { when: (event) => event.type === 'account' });
  useEffect(() => {
    if (theme) applyTheme(theme);
  }, [theme]);
  return null;
}

/** Light, dark, or the device's: kept for the account, so every device and both apps follow */
export function ThemePicker() {
  const node = useNode();
  const [shown, setShown] = useState(remembered);

  const choose = async (theme: Theme) => {
    setShown(theme);
    applyTheme(theme);
    const space = await node.account.space();
    if (!space) return;
    if (!(await node.collections.list(space)).some((c) => c.name === themes.name && c.schema))
      await node.collections.define(space, themes);
    await node.records.put(space, themes, { theme });
  };

  return (
    <div role="tablist" aria-label="Theme">
      {THEMES.map((theme) => (
        <button key={theme} role="tab" aria-selected={shown === theme} onClick={() => void choose(theme)}>
          {{ light: 'Light', dark: 'Dark', system: 'Match device' }[theme]}
        </button>
      ))}
    </div>
  );
}
