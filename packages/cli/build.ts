/**
 * Builds `minca` as single-file executables with Bun: one for this machine and one
 * per Linux server architecture. Each carries its runtime, so a server needs
 * nothing installed.
 *
 *   bun build.ts            all targets into dist/
 *   bun build.ts --native   just this machine
 *
 * The entry has no top-level await, which `--bytecode` would reject.
 */
import { execFileSync } from 'node:child_process';

const native = process.argv.includes('--native');
const targets: ReadonlyArray<[string, string]> = native
  ? [['', 'minca']]
  : [
      ['', 'minca'],
      ['bun-linux-x64', 'minca-linux-x64'],
      ['bun-linux-arm64', 'minca-linux-arm64'],
    ];

for (const [target, name] of targets) {
  const targetFlag = target ? [`--target=${target}`] : [];
  execFileSync(
    'bun',
    [
      'build',
      'src/main.ts',
      '--compile',
      '--minify',
      '--bytecode',
      '--conditions=@minca/source',
      ...targetFlag,
      '--outfile',
      `dist/${name}`,
    ],
    { stdio: 'inherit' },
  );
  console.log(`built dist/${name}`);
}
