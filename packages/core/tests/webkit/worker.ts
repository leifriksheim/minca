/** The site's shared worker in the WebKit test: it runs the one node every tab uses */
import { runNodeWorker } from '../../src/node/worker.js';

runNodeWorker();
