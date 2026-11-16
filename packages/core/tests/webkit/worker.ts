/** The site's shared worker in the WebKit test: it runs the one node every tab uses */
import { runNodeWorker } from '@minca/session';

runNodeWorker();
