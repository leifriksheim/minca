/**
 * Electrobun's `preBuild` hook: marks its prebuilt binaries as running on
 * macOS 14, before they are copied into the app.
 *
 * The ones it builds with Zig (the .dmg's extractor, libasar, zig-zstd) are
 * marked with the macOS of the machine they were built on, 14.8, so macOS
 * 14.0 to 14.7 refuses the app ("You can't use this version of the
 * application"). The rest of the app needs 14.0 at most (libNativeWrapper,
 * node-datachannel). Each binary changed is signed again, ad hoc, as Apple
 * silicon requires.
 */
import { readdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

const FLOOR = '14.0';
const dist = `../../node_modules/electrobun/dist-${process.env.ELECTROBUN_OS}-${process.env.ELECTROBUN_ARCH}`;

/** `14.0` as semver, `14.0.0` */
const semver = (version: string) => [...version.split('.'), '0', '0'].slice(0, 3).join('.');

function run(command: string[]) {
  const result = Bun.spawnSync(command, { stdout: 'pipe', stderr: 'inherit' });
  if (result.exitCode !== 0) process.exit(result.exitCode ?? 1);
  return result.stdout.toString();
}

if (process.env.ELECTROBUN_OS === 'macos' && process.platform === 'darwin') {
  for (const name of readdirSync(dist)) {
    const path = join(dist, name);
    if (!statSync(path).isFile()) continue;
    // Anything that isn't Mach-O has no build version to show.
    const shown = Bun.spawnSync(['vtool', '-show-build', path], { stdout: 'pipe', stderr: 'ignore' });
    const build = shown.stdout.toString();
    const minos = /minos (\S+)/.exec(build)?.[1];
    const sdk = /sdk (\S+)/.exec(build)?.[1] ?? FLOOR;
    if (shown.exitCode !== 0 || !minos || Bun.semver.order(semver(minos), semver(FLOOR)) <= 0) continue;
    run(['vtool', '-set-build-version', 'macos', FLOOR, sdk, '-replace', '-output', `${path}.floor`, path]);
    renameSync(`${path}.floor`, path);
    run(['codesign', '--force', '--sign', '-', path]);
    console.log(`${name}: macOS ${minos} → ${FLOOR}`);
  }
}
