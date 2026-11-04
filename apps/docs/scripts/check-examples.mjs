/**
 * Type-checks every TypeScript example in the library's docs against the real
 * code, so an example that stops compiling fails the build instead of
 * drifting. Each ```ts, ```tsx or ```typescript block becomes a module in
 * examples/pages/; examples/given.ts declares the few names the pages take as
 * given, like `node` and `space`. The folder has a tsconfig of its own, so
 * the type checker and the linter read them the same way. Errors are reported at the page and line.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const docsDir = fileURLToPath(new URL('..', import.meta.url));
const out = join(docsDir, 'examples', 'pages');
const library = 'packages/core/docs';
const pages = [
  ...readdirSync(join(root, library))
    .filter((name) => name.endsWith('.md'))
    .map((name) => `${library}/${name}`),
  'packages/calls/README.md',
];

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

/** Where each example came from, by the file it was written to. */
const origins = new Map();
for (const page of pages) {
  const lines = readFileSync(join(root, page), 'utf8').split('\n');
  let start = -1;
  lines.forEach((line, i) => {
    if (start < 0 && /^```(ts|tsx|typescript)\s*$/.test(line)) start = i + 1;
    else if (start >= 0 && line.startsWith('```')) {
      const name = `${basename(page, '.md') === 'README' ? page.split('/').at(-2) : basename(page, '.md')}-${start + 1}.tsx`;
      // `export {}` keeps each example a module of its own.
      writeFileSync(join(out, name), `${lines.slice(start, i).join('\n')}\nexport {};\n`);
      origins.set(name, { page, line: start + 1 });
      start = -1;
    }
  });
}

let report = '';
try {
  execFileSync(
    join(docsDir, 'node_modules/.bin/tsc'),
    ['-p', 'examples/tsconfig.json', '--pretty', 'false'],
    {
      cwd: docsDir,
      encoding: 'utf8',
    },
  );
} catch (error) {
  report = String(error.stdout);
}

// tsc says `examples/pages/name.tsx(3,7): error …`: say the page and line instead.
const errors = report
  .split('\n')
  .filter((line) => line.includes('error TS'))
  .map((line) => {
    const match = line.match(/^examples\/pages\/([^(]+)\((\d+),(\d+)\): (.*)$/);
    const origin = match && origins.get(match[1]);
    return origin ? `${origin.page}:${origin.line + Number(match[2]) - 1}: ${match[4]}` : line;
  });
for (const error of errors) console.error(error);
console.log(`${origins.size} examples, ${errors.length} errors`);
if (errors.length) process.exit(1);
