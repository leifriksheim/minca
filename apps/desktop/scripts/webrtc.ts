/**
 * WebRTC for the carrier, copied into the app beside the CLI, which is built
 * without it (`npm run parts:node`): node-datachannel, what it imports at run
 * time, and the binary for the machine this builds on.
 */

const abi = process.platform === 'win32' ? '-msvc' : process.platform === 'linux' ? '-gnu' : '';
const binary = `@node-datachannel/${process.platform}-${process.arch}${abi}`;

/** The packages, each to the same path under the app's views */
const PACKAGES = ['node-datachannel', 'detect-libc', binary];

export const WEBRTC_COPY: Record<string, string> = Object.fromEntries(
  PACKAGES.map((name) => [`../../node_modules/${name}`, `views/node_modules/${name}`]),
);
