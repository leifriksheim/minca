/**
 * `npm run release`: makes the next version on main and pushes its tag. The
 * tag does the rest (.github/workflows/release.yml): tests, npm, the
 * downloads.
 *
 *   npm run release            asks for the next version
 *   npm run release -- patch   or minor, major, 0.3.0-rc.1: asks nothing
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const requestedVersion = process.argv[2];

/** Runs a command where you can see it; throws if it fails */
function run(command, args) {
  console.log(`\n$ ${[command, ...args].join(' ')}`);
  execFileSync(command, args, { stdio: 'inherit' });
}

/** Runs a command quietly and returns what it printed */
function read(command, args) {
  return execFileSync(command, args, { encoding: 'utf8' }).trim();
}

function refuseUnlessCleanAndAtOriginMain() {
  if (read('git', ['status', '--porcelain']))
    throw new Error('The working tree has changes. Commit or stash them first.');
  const branch = read('git', ['branch', '--show-current']);
  if (branch !== 'main') throw new Error(`Releases are cut from main; this is ${branch || 'no branch'}.`);
  run('git', ['fetch', '--quiet', 'origin', 'main']);
  if (read('git', ['rev-parse', 'HEAD']) !== read('git', ['rev-parse', 'origin/main']))
    throw new Error('main and origin/main differ. Pull or push first, so the release is what CI checked.');
}

try {
  refuseUnlessCleanAndAtOriginMain();
  run('npx', ['bumpp', ...(requestedVersion ? ['--release', requestedVersion, '--yes'] : [])]);
  const tag = `v${JSON.parse(readFileSync('packages/core/package.json', 'utf8')).version}`;
  run('git', ['push', '--atomic', 'origin', 'main', tag]);
  console.log(`\nPushed ${tag}. Watch it release: gh run watch`);
} catch (error) {
  console.error(`\nRelease stopped: ${error.message}`);
  process.exit(1);
}
