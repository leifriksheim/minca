/**
 * Updates, from the GitHub Releases the app is published on
 * (`release.baseUrl` in electrobun.config.ts). It looks shortly after launch
 * and every few hours, downloads a new version quietly, then waits: the
 * app's node is keeping spaces online, so only the person restarts it, from
 * the menu bar.
 */
import type { MenuLine } from './menu';

/** What it needs of Electrobun's `Updater` */
export interface Updater {
  checkForUpdate(): Promise<{ version: string; updateAvailable: boolean; error?: string }>;
  downloadUpdate(): Promise<void>;
  updateInfo(): { updateReady: boolean } | undefined;
  applyUpdate(): Promise<void>;
}

export type UpdateState =
  | { readonly status: 'idle' }
  | { readonly status: 'checking' }
  | { readonly status: 'downloading'; readonly version: string }
  | { readonly status: 'ready'; readonly version: string }
  | { readonly status: 'latest'; readonly version: string };

export interface Updates {
  state(): UpdateState;
  /** Looks for a new version and downloads it; does nothing while it already is */
  check(): Promise<void>;
  /** Swaps in the downloaded version and starts it again */
  apply(): Promise<void>;
}

export function createUpdates(options: {
  updater: Updater;
  /** The version running now */
  current: string;
  changed: (state: UpdateState) => void;
}): Updates {
  const { updater, current, changed } = options;
  let state: UpdateState = { status: 'idle' };
  const set = (next: UpdateState) => {
    state = next;
    changed(state);
  };

  async function check() {
    if (state.status === 'checking' || state.status === 'downloading' || state.status === 'ready') return;
    set({ status: 'checking' });
    try {
      const found = await updater.checkForUpdate();
      // Offline or no release yet: say nothing, and look again next time.
      if (found.error) return set({ status: 'idle' });
      if (!found.updateAvailable) return set({ status: 'latest', version: current });
      set({ status: 'downloading', version: found.version });
      await updater.downloadUpdate();
      set(
        updater.updateInfo()?.updateReady ? { status: 'ready', version: found.version } : { status: 'idle' },
      );
    } catch {
      set({ status: 'idle' });
    }
  }

  return {
    state: () => state,
    check,
    apply: async () => {
      if (state.status === 'ready') await updater.applyUpdate();
    },
  };
}

/** The menu bar's line about updates; a version ready to install wants a click */
export function updateMenu(state: UpdateState): { readonly line: MenuLine; readonly attention: boolean } {
  switch (state.status) {
    case 'checking':
      return { line: { label: 'Checking for updates…' }, attention: false };
    case 'downloading':
      return { line: { label: `Downloading Minca ${state.version}…` }, attention: false };
    case 'ready':
      return { line: { label: `Restart to update to ${state.version}`, action: 'update' }, attention: true };
    case 'latest':
      return { line: { label: `Minca ${state.version} is up to date`, action: 'check' }, attention: false };
    case 'idle':
      return { line: { label: 'Check for updates', action: 'check' }, attention: false };
  }
}
