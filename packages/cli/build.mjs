/**
 * Builds `minca` as single-file executables with Bun: one for this machine and one
 * per Linux server architecture. Each carries its runtime, so a server needs
 * nothing installed.
 *
 *   bun build.mjs            all targets into dist/
 *   bun build.mjs --native   just this machine
 *
 * The consent page's browser script is built in as MINCA_CONSENT_SCRIPT, as
 * `scripts/bundle.mjs` does for npm: through the API, since it is too long to
 * pass as a flag. The entry has no top-level await, which `bytecode` would
 * reject.
 */
import { consentScript } from './scripts/consent-script.mjs';

const native = process.argv.includes('--native');
const targets = native
  ? [['', 'minca']]
  : [
      ['', 'minca'],
      ['bun-linux-x64', 'minca-linux-x64'],
      ['bun-linux-arm64', 'minca-linux-arm64'],
    ];

const define = { MINCA_CONSENT_SCRIPT: JSON.stringify(await consentScript()) };

for (const [target, name] of targets) {
  const built = await Bun.build({
    entrypoints: ['src/main.ts'],
    compile: { ...(target ? { target } : {}), outfile: `dist/${name}` },
    minify: true,
    bytecode: true,
    conditions: ['@minca/source'],
    // Only ever imported to build the consent script from source.
    external: ['esbuild'],
    define,
  });
  if (!built.success) {
    for (const message of built.logs) console.error(message);
    process.exit(1);
  }
  console.log(`built dist/${name}`);
}
