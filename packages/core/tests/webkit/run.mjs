/**
 * Two tabs of an app in WebKit, the engine of Safari and of every browser on
 * an iPhone, sharing one node in a shared worker: the app's key never leaves
 * the tabs, a tab that stops answering doesn't stop the other from writing,
 * and neither waits on the other's stores.
 *
 *   node packages/core/tests/webkit/run.mjs     (after `npx playwright install webkit`)
 */
import { build } from 'esbuild';
import { webkit } from 'playwright';
import http from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';

const here = import.meta.dirname;
const bundle = async (entry) =>
  (
    await build({
      entryPoints: [path.join(here, entry)],
      bundle: true,
      format: 'esm',
      write: false,
      target: 'safari16',
      conditions: ['@minca/source'],
    })
  ).outputFiles[0].text;
const files = {
  '/': ['text/html', '<!doctype html><meta charset="utf-8"><script type="module" src="/page.js"></script>'],
  '/page.js': ['text/javascript', await bundle('page.ts')],
  '/worker.js': ['text/javascript', await bundle('worker.ts')],
};
const server = http.createServer((request, response) => {
  const [type, body] = files[request.url] ?? ['text/plain', ''];
  response.writeHead(files[request.url] ? 200 : 404, { 'content-type': type });
  response.end(body);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;

const browser = await webkit.launch();
try {
  const context = await browser.newContext();
  const open = async () => {
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForFunction(() => 'tab' in window);
    return page;
  };
  const seed = Array.from({ length: 32 }, (_, i) => i);
  const a = await open();
  const b = await open();
  const sessionA = await a.evaluate((s) => window.tab.start(s), seed);
  const sessionB = await b.evaluate((s) => window.tab.start(s), seed);
  assert.equal(sessionB, sessionA, 'one node for both tabs');
  console.log('two tabs started one node in a shared worker');

  const space = await a.evaluate(() => window.tab.createSpace());
  const first = await a.evaluate((id) => window.tab.write(id, 'milk'), space);
  assert.equal(first.author, sessionA, "signed by the app's key, kept in the tab");
  assert.deepEqual(await b.evaluate((id) => window.tab.texts(id), space), ['milk']);
  console.log(`tab A wrote in ${first.ms} ms, and tab B reads it`);

  // Tab B, the newest, signs for the node now. It stops answering, as a tab an iPhone froze in
  // the background does: it keeps its ports and its lock, and says nothing more. (Blocking its
  // thread would block tab A's too, since they share a process here.)
  await b.evaluate(() => {
    MessagePort.prototype.postMessage = () => {};
  });
  const second = await a.evaluate((id) => window.tab.write(id, 'eggs'), space);
  assert.ok(second.ms < 10_000, `tab A wrote while tab B was frozen, in ${second.ms} ms`);
  const third = await a.evaluate((id) => window.tab.write(id, 'bread'), space);
  assert.ok(third.ms < 1000, `and then without waiting on tab B, in ${third.ms} ms`);
  assert.deepEqual(await a.evaluate((id) => window.tab.texts(id), space), ['bread', 'eggs', 'milk']);
  console.log(`tab B frozen: tab A still wrote, in ${second.ms} ms, then in ${third.ms} ms`);

  // A new tab opens while B is still frozen: it starts at once, on the same node and stores.
  const c = await open();
  const t = Date.now();
  assert.equal(await c.evaluate((s) => window.tab.start(s), seed), sessionA);
  assert.deepEqual(await c.evaluate((id) => window.tab.texts(id), space), ['bread', 'eggs', 'milk']);
  console.log(`tab B frozen: a new tab opened the account in ${Date.now() - t} ms`);
  console.log('ok');
} finally {
  await browser.close();
  server.close();
}
