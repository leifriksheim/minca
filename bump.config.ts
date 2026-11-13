import { defineConfig } from 'bumpp';

/**
 * Both packages, the desktop app and the Chrome extension share one version.
 * bumpp asks for the next one, writes it to each, refreshes the lockfile, and
 * commits and tags it (`v0.1.2`), locally. `npm run release`
 * (scripts/release.mjs) runs it and pushes; the tag publishes to npm and
 * builds the downloads (.github/workflows/release.yml).
 */
export default defineConfig({
  files: [
    'packages/core/package.json',
    'packages/cli/package.json',
    'apps/desktop/electrobun.config.ts',
    'apps/extension/static/manifest.json',
  ],
  install: true,
  // The lockfile `install` refreshed goes in the same commit. scripts/release.mjs checks the tree is clean first, so it's the only other change.
  all: true,
  commit: 'Release v%s',
  tag: 'v%s',
  // scripts/release.mjs pushes main and the tag together, or neither.
  push: false,
});
