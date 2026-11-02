// The consent page's script (src/remote-mcp/consent-script.ts), bundled for
// the browser, for the builds to put in as MINCA_CONSENT_SCRIPT: the npm bundle
// (scripts/bundle.mjs) and the single-file binaries (build.mjs).
// From source, src/remote-mcp/consent-bundle.ts bundles it the same way.
import { build } from 'esbuild';

export async function consentScript() {
  const result = await build({
    entryPoints: [new URL('../src/remote-mcp/consent-script.ts', import.meta.url).pathname],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    conditions: ['@minca/source'],
    legalComments: 'none',
    write: false,
  });
  return result.outputFiles[0].text;
}
