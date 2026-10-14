import type { ElectrobunConfig } from 'electrobun';

/** WebRTC for the carrier: node-datachannel, and the binary for the machine this builds on */
const webrtc = `@node-datachannel/${process.platform}-${process.arch}`;

export default {
  app: {
    name: 'Minca',
    identifier: 'org.minca.desktop',
    version: '0.1.0',
  },
  runtime: {
    // Closing the window leaves the carrier running in the menu bar.
    exitOnLastWindowClosed: false,
    // The account home the carrier connects to: the app's, from the same setting.
    home: process.env.VITE_MINCA_HOME ?? 'https://weave-home.netlify.app/connect',
  },
  build: {
    // The protocol from the workspace, as source, like everything else here.
    bun: { entrypoint: 'src/bun/index.ts', conditions: ['@minca/source'] },
    // Built by `npm run parts`: the example app, and the CLI as one file for Bun.
    copy: {
      'parts/app': 'views/app',
      'parts/minca.js': 'views/minca.js',
      'assets/tray.png': 'views/tray.png',
      '../../node_modules/node-datachannel': 'views/node_modules/node-datachannel',
      [`../../node_modules/${webrtc}`]: `views/node_modules/${webrtc}`,
    },
    // The system's WebKit: no Chromium in the bundle.
    mac: { bundleCEF: false },
    linux: { bundleCEF: false },
    win: { bundleCEF: false },
  },
} satisfies ElectrobunConfig;
