import { defaultClientConditions, defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The protocol comes from the workspace, as source: the `@minca/source`
 * export condition points each entry at `packages/core/src`, so there is no
 * build step and edits there hot-reload here.
 */
export default defineConfig({
  resolve: {
    conditions: ['@minca/source', ...defaultClientConditions],
    // The protocol's React bindings sit outside this folder; they must use this app's copy of React.
    dedupe: ['react', 'react-dom'],
  },
  plugins: [react()],
  server: { port: 5176 },
});
