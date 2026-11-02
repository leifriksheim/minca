/**
 * The consent page's script as one file for the browser. The published
 * `minca` has it built in (`scripts/consent-script.mjs`, defined as
 * `MINCA_CONSENT_SCRIPT`); run from source, as in development and tests, it is
 * bundled here the same way the first time a page asks for it.
 */
import { fileURLToPath } from 'node:url';

declare const MINCA_CONSENT_SCRIPT: string | undefined;

/** How it is bundled: the same here and in `scripts/consent-script.mjs` */
const CONSENT_BUILD = {
  bundle: true,
  format: 'iife' as const,
  platform: 'browser' as const,
  target: 'es2022',
  minify: true,
  conditions: ['@minca/source'],
  legalComments: 'none' as const,
};

let built: Promise<string> | null = null;

export function consentScript(): Promise<string> {
  if (typeof MINCA_CONSENT_SCRIPT === 'string') return Promise.resolve(MINCA_CONSENT_SCRIPT);
  built ??= (async () => {
    const { build } = await import('esbuild');
    // Next to this file, in the source it runs from.
    const entry = fileURLToPath(new URL('./consent-script.ts', import.meta.url));
    const result = await build({ ...CONSENT_BUILD, entryPoints: [entry], write: false });
    const file = result.outputFiles?.[0];
    if (!file) throw new Error('The consent page’s script did not build');
    return file.text;
  })();
  return built;
}
