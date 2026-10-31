/**
 * Electrobun's `postWrap` hook, which names one script: the self-extracting
 * Minca.app compressed smaller, then signed. In that order, since signing
 * seals its files. Each step is a script of its own, run with this Bun.
 */
import { join } from 'node:path';

for (const step of ['recompress.ts', 'sign-adhoc.ts']) {
  const result = Bun.spawnSync([process.execPath, join(import.meta.dir, step)], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (result.exitCode !== 0) process.exit(result.exitCode ?? 1);
}
