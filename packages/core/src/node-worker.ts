/**
 * A worker script that runs a browser node: the page starts one with
 * `startNodeInWorker`, or with `worker` in `createMincaAuth` and
 * `createMincaConnection`. A bundler needs a file of the app's own to point
 * `new Worker` at, holding just this import:
 *
 * ```ts
 * // minca-worker.ts
 * import '@minca/core/node-worker';
 * // the app
 * const worker = () => new Worker(new URL('./minca-worker.ts', import.meta.url), { type: 'module' });
 * ```
 */
import { runNodeWorker } from './node/worker.js';

runNodeWorker();
