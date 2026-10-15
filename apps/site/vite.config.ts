import { defaultClientConditions, defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';

/**
 * Security headers for the deployed site. It is only pages to read: nothing
 * frames it, and nothing it links to needs to know where a reader came from.
 */
function securityHeaders(): Plugin {
  return {
    name: 'security-headers',
    apply: 'build',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: '_headers',
        source: [
          '/*',
          "  Content-Security-Policy: frame-ancestors 'none'",
          '  Referrer-Policy: no-referrer',
          '  X-Content-Type-Options: nosniff',
          '',
        ].join('\n'),
      });
    },
  };
}

/** The protocol and the design system come from the workspace, as source, like the app. */
export default defineConfig(() => ({
  resolve: {
    conditions: ['@minca/source', ...defaultClientConditions],
    dedupe: ['react', 'react-dom'],
  },
  plugins: [securityHeaders(), react()],
  server: { port: 5185 },
}));
