/** The worker this app's node runs in, off the page's main thread (`worker` in minca.ts) */
// First, so what the node says while it starts is kept for debug mode.
import '@minca/app-shared/debugLog';
import '@minca/core/node-worker';
