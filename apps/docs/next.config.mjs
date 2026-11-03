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
};

export default createMDX()(config);
