/**
 * The name service on its own (`names.mjs`), for running publicly: an HTTP
 * server that answers /health and /.well-known/minca.json.
 *
 *   NAMES_DOMAIN=minca.social NAMES_CLAIM_URL=https://names.example/.well-known/minca.json \
 *   NAMES_DIR=/data/names node packages/names/server.mjs [port]
 */

import { createServer } from 'node:http';
import { createNames, namesFromEnv } from './names.mjs';

const PORT = Number(process.argv[2] ?? process.env.PORT ?? 8788);
const names = createNames(namesFromEnv(process.env));

const server = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (names.handle(req, res)) return;
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('Not here.\n');
});

server.listen(PORT, () => console.log(`[names] answering on http://localhost:${PORT}`));
