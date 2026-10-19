/**
 * Electrobun's `postWrap` hook: signs the self-extracting Minca.app ad hoc,
 * before it goes into the .dmg.
 *
 * Unsigned, the wrapper keeps only its launcher's linker signature, which
 * seals none of its resources. macOS then calls a downloaded copy "damaged"
 * and offers no way to open it. Signed ad hoc, it is only "from an
 * unidentified developer", which System Settings → Privacy & Security →
 * Open Anyway gets past. A Developer ID (`build.mac.codesign`) signs over
 * this one after the hook.
 */
const bundle = process.env.ELECTROBUN_WRAPPER_BUNDLE_PATH;

if (process.env.ELECTROBUN_OS === 'macos' && process.platform === 'darwin' && bundle) {
  for (const args of [
    ['--force', '--deep', '--sign', '-', bundle],
    ['--verify', '--deep', '--strict', bundle],
  ]) {
    const result = Bun.spawnSync(['codesign', ...args], { stdio: ['ignore', 'inherit', 'inherit'] });
    if (result.exitCode !== 0) process.exit(result.exitCode ?? 1);
  }
  console.log(`signed ad hoc: ${bundle}`);
}
