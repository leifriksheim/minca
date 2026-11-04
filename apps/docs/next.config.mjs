// minca.dev, exported as static pages. The pages come from packages/core/docs
// and spec/ (scripts/sync.mjs); the mark and tokens from the design system.
import { createMDX } from 'fumadocs-mdx/next';

/** @type {import('next').NextConfig} */
const config = {
  output: 'export',
  trailingSlash: true,
  reactStrictMode: true,
  // The design system is TypeScript source in the workspace.
  transpilePackages: ['@minca/app-shared', '@minca/ui'],
  // The playground's Minca code, bundled by scripts/sync.mjs (components/playground/lib.ts).
  turbopack: { resolveAlias: { '@minca/playground': './.minca/playground.js' } },
};

export default createMDX()(config);
