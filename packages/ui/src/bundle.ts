import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

/** Marks a resolve the plugin below asked for itself, so it doesn't ask again */
const again = Symbol('again');

/**
 * The kit as one script, ready to put in a screen's document: `frame/index.ts` and
 * everything it imports, minified. A host bundles it at build time or in its
 * dev server (the example app's Vite config), and tests use the same, so they
 * run what a browser gets.
 */
export async function bundleUi(): Promise<{
  readonly script: string;
  readonly files: ReadonlyArray<string>;
}> {
  const result = await build({
    metafile: true,
    entryPoints: [fileURLToPath(new URL('./frame/index.ts', import.meta.url))],
    bundle: true,
    write: false,
    format: 'iife',
    target: 'es2022',
    minify: true,
    conditions: ['@minca/source'],
    legalComments: 'none',
    plugins: [
      {
        // Core's modules only define things, so what the kit doesn't use of them can go:
        // `positionBetween` without the whole standard library beside it.
        name: 'core-has-no-side-effects',
        setup(build) {
          build.onResolve({ filter: /.*/ }, async ({ path, importer, kind, resolveDir, pluginData }) => {
            if (pluginData === again) return undefined;
            if (!path.startsWith('@minca/core/') && !importer.includes('/packages/core/src/'))
              return undefined;
            const found = await build.resolve(path, { importer, kind, resolveDir, pluginData: again });
            return found.errors.length ? undefined : { path: found.path, sideEffects: false };
          });
        },
      },
    ],
  });
  const text = result.outputFiles[0]?.text;
  if (!text) throw new Error('The ui kit bundled to nothing');
  return {
    // It goes inside a <script> element, which ends at the first "</script" whatever the JavaScript around it.
    script: text.replaceAll('</script', '<\\/script'),
    // What it was made from, for a dev server to watch
    files: Object.keys(result.metafile.inputs).map((file) => resolve(file)),
  };
}
