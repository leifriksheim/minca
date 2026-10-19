import { useState } from 'react';
import { GITHUB } from './Site';

/**
 * Where the downloads are. The desktop app is on the latest GitHub Release,
 * under a name that stays the same from one release to the next
 * (`.github/workflows/release.yml`), so these links never change. The
 * extension is zipped into the site when it is built (`netlify.toml`), so it
 * matches the home the site points at.
 */
export const RELEASES = `${GITHUB}/releases`;
const latest = (file: string) => `${RELEASES}/latest/download/${file}`;

export const DOWNLOADS = {
  mac: latest('Minca-mac-arm64.dmg'),
  windows: latest('Minca-windows-x64.zip'),
  chrome: '/minca-chrome.zip',
  checksums: latest('SHA256SUMS'),
} as const;

/** What the visitor is on, for which download to offer first; `other` is Linux, or anything unknown */
export type Platform = 'mac' | 'windows' | 'mobile' | 'other';

/** `navigator.userAgentData`, where the browser has it (Chromium); not in TypeScript's DOM types yet */
function hasUserAgentData(
  value: Navigator,
): value is Navigator & { userAgentData: { platform: string; mobile: boolean } } {
  return 'userAgentData' in value && typeof value.userAgentData === 'object' && value.userAgentData !== null;
}

function detect(): Platform {
  if (typeof navigator === 'undefined') return 'other';
  if (hasUserAgentData(navigator)) {
    const { platform, mobile } = navigator.userAgentData;
    if (mobile) return 'mobile';
    if (platform === 'macOS') return 'mac';
    if (platform === 'Windows') return 'windows';
    return 'other';
  }
  const agent = navigator.userAgent;
  if (/Android|iPhone|iPad|iPod/.test(agent)) return 'mobile';
  // An iPad asks for the desktop site as a Mac; its touch screen gives it away.
  if (/Macintosh/.test(agent)) return navigator.maxTouchPoints > 1 ? 'mobile' : 'mac';
  if (/Windows/.test(agent)) return 'windows';
  return 'other';
}

/** The visitor's platform. The site renders only in the browser, so it is known from the first render. */
export function usePlatform(): Platform {
  return useState(detect)[0];
}
