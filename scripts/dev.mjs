/**
 * `npm run dev`: everything, together.
 *
 * - node (8787): the always-on node with the throwaway identity in
 *   packages/cli/.env.dev (created on first run); it serves the relay and /peer.
 * - host (8788): `minca host`, what "Keep my spaces online" talks to, and
 *   what spaces chip in for. Settings in packages/cli/.env.host.dev,
 *   yours in packages/cli/.env.host.local. Wallet payments on Base Sepolia by default.
 * - stripe: when .env.host.local has a Stripe test key, the Stripe CLI
 *   forwards Stripe's webhooks to the host, and the host gets its secret.
 * - names (8789): usernames at localhost:8789 (packages/names), kept in packages/names/.data.
 * - home (5174), app (5173), site (5185) and Liquid (5186); their .env.development point at the rest.
 *
 * Ctrl-C stops them all.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const colour = {
  node: '\x1b[35m',
  host: '\x1b[32m',
  stripe: '\x1b[34m',
  home: '\x1b[33m',
  app: '\x1b[36m',
  site: '\x1b[37m',
  liquid: '\x1b[94m',
  reset: '\x1b[0m',
};

function start(name, command, args, cwd, env = {}) {
  const child = spawn(command, args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
  const prefix = `${colour[name]}[${name}]${colour.reset} `;
  const forward = (stream, out) => {
    let buffered = '';
    stream.on('data', (chunk) => {
      buffered += chunk;
      const lines = buffered.split('\n');
      buffered = lines.pop();
      for (const line of lines) out.write(prefix + line + '\n');
    });
  };
  forward(child.stdout, process.stdout);
  forward(child.stderr, process.stderr);
  child.on('exit', (code) => {
    process.stderr.write(`${prefix}exited (${code ?? 'signal'})\n`);
    stopAll(code ?? 0);
  });
  return child;
}

/** The CLI from source, with the protocol from source too (the workspace's `@minca/source` condition) */
const fromSource = ['--conditions=@minca/source', '--import', 'tsx'];

const say = (name, line) => process.stderr.write(`${colour[name]}[${name}]${colour.reset} ${line}\n`);

// The host's settings: the committed defaults, then yours.
const hostFiles = ['packages/cli/.env.host.dev', 'packages/cli/.env.host.local'].filter((file) =>
  existsSync(`${root}${file}`),
);
const hostSettings = Object.assign(
  {},
  ...hostFiles.map((file) => parseEnv(readFileSync(`${root}${file}`, 'utf8'))),
);
const hostPort = hostSettings.PORT ?? '8788';
const hostEnv = {};
const extra = [];

// Cards: Stripe in test mode, its webhooks forwarded here by the Stripe CLI.
if (hostSettings.STRIPE_SECRET_KEY && !hostSettings.STRIPE_WEBHOOK_SECRET) {
  const key = hostSettings.STRIPE_SECRET_KEY;
  if (!key.startsWith('sk_test_') && !key.startsWith('rk_test_')) {
    say('stripe', 'STRIPE_SECRET_KEY is not a test key: not forwarding webhooks for it in dev.');
  } else {
    try {
      hostEnv.STRIPE_WEBHOOK_SECRET = execFileSync('stripe', ['listen', '--api-key', key, '--print-secret'], {
        encoding: 'utf8',
      }).trim();
      extra.push(() =>
        start(
          'stripe',
          'stripe',
          [
            'listen',
            '--api-key',
            key,
            '--events',
            'checkout.session.completed,invoice.paid',
            '--forward-to',
            `localhost:${hostPort}/host/billing/webhook`,
          ],
          root,
        ),
      );
    } catch {
      say(
        'stripe',
        'The Stripe CLI is needed to forward webhooks (brew install stripe/stripe-cli/stripe). Cards are off.',
      );
    }
  }
}

const children = [
  start(
    'node',
    process.execPath,
    // Browsers reach it directly, so it meets nobody through relays.
    [
      '--env-file=packages/cli/.env.dev',
      ...fromSource,
      'packages/cli/src/main.ts',
      'run',
      '--create',
      '--no-relays',
    ],
    root,
  ),
  start(
    'host',
    process.execPath,
    [...hostFiles.map((file) => `--env-file=${file}`), ...fromSource, 'packages/cli/src/main.ts', 'host'],
    root,
    hostEnv,
  ),
  // Usernames at localhost:8789 (packages/names), so trying them out claims nothing at minca.social.
  start('names', process.execPath, ['packages/names/server.mjs', '8789'], root, {
    NAMES_DOMAIN: 'localhost:8789',
    NAMES_CLAIM_URL: 'http://localhost:8789/.well-known/minca.json',
    NAMES_DIR: `${root}packages/names/.data`,
    // Everyone trying it here is one address.
    NAMES_NEW_PER_DAY: '1000',
  }),
  ...extra.map((begin) => begin()),
  start('home', 'npm', ['run', 'dev'], `${root}apps/home`),
  start('app', 'npm', ['run', 'dev'], `${root}apps/example`),
  start('site', 'npm', ['run', 'dev'], `${root}apps/site`),
  start('liquid', 'npm', ['run', 'dev'], `${root}apps/liquid`),
];
say('host', `http://localhost:${hostPort}: pay it from the home (Settings, Keep my spaces online)`);

let stopping = false;
function stopAll(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 500);
}
process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));
