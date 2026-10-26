import type { ElectrobunConfig } from 'electrobun';
import { WEBRTC_COPY } from './scripts/webrtc.ts';

const list = (value: string | undefined) =>
  (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

export default {
  app: {
    name: 'Minca',
    identifier: 'org.minca.desktop',
    // Bumped with the packages (bump.config.ts), so a release's tag names it.
    version: '0.1.11',
  },
  runtime: {
    // Closing the window leaves the carrier running in the menu bar.
    exitOnLastWindowClosed: false,
    // The account home the carrier connects to: the app's, from the same setting.
    home: process.env.VITE_MINCA_HOME ?? 'https://home.minca.social/connect',
    // Where the app's node meets peers: the same settings the app is built with (apps/shared/src/relay.ts).
    relays: list(process.env.VITE_SIGNALING_URL),
    nodes: list(process.env.VITE_MINCA_NODES),
    hosts: list(process.env.VITE_MINCA_HOST),
  },
  // Electrobun's binaries marked for macOS 14 (scripts/macos-floor.ts), and the
  // .dmg's app signed ad hoc so a downloaded copy opens (scripts/sign-adhoc.ts).
  scripts: { preBuild: 'scripts/macos-floor.ts', postWrap: 'scripts/sign-adhoc.ts' },
  build: {
    // The protocol from the workspace, as source, like everything else here.
    bun: { entrypoint: 'src/bun/index.ts', conditions: ['@minca/source'] },
    // Built by `npm run parts`: the example app, and the CLI as one file for Bun.
    copy: {
      'parts/app': 'views/app',
      'parts/minca.js': 'views/minca.js',
      'assets/tray.png': 'views/tray.png',
      ...WEBRTC_COPY,
    },
    // The system's WebKit: no Chromium in the bundle.
    // The dock icon: drawn by assets/icon.swift.
    mac: { bundleCEF: false, icons: 'assets/icon.iconset' },
    linux: { bundleCEF: false },
    win: { bundleCEF: false },
  },
} satisfies ElectrobunConfig;
