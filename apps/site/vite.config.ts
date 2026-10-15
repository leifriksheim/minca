import { defaultClientConditions, defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/** The protocol and the design system come from the workspace, as source, like the app. */
export default defineConfig(() => ({
  resolve: {
    conditions: ['@minca/source', ...defaultClientConditions],
    dedupe: ['react', 'react-dom'],
  },
  plugins: [react()],
  server: { port: 5185 },
}));
