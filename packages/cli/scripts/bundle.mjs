// Bundles `minca` to one file, dist/minca.mjs, for npm and the host's image.
// The consent page's script (src/remote-mcp/consent-script.ts) is bundled for
// the browser first and built in as MINCA_CONSENT_SCRIPT, so the bundle needs
// no esbuild at run time (src/remote-mcp/consent-bundle.ts).
//
//   node scripts/bundle.mjs
import { build } from 'esbuild';
import { consentScript } from './consent-script.mjs';

const script = await consentScript();

await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  mainFields: ['module', 'main'],
  target: 'node22',
  conditions: ['@minca/source'],
  outfile: 'dist/minca.mjs',
  // Native or loaded only from source: ws and node-datachannel come with the package; esbuild only builds the consent script in development.
  external: ['ws', 'node-datachannel', 'esbuild'],
  define: { MINCA_CONSENT_SCRIPT: JSON.stringify(script) },
  banner: {
    js: '#!/usr/bin/env node\nimport { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);',
  },
});
console.log(`bundled dist/minca.mjs, with a ${Math.round(script.length / 1024)} KB consent script`);
