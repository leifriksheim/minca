/**
 * Part of Electrobun's `postWrap` hook (`scripts/post-wrap.ts`): compresses
 * the app inside the self-extracting Minca.app again, at zstd level 19
 * rather than the default Electrobun uses.
 *
 * Electrobun favours build speed. The app is mostly the Bun runtime, and
 * level 19 makes the download about a fifth smaller (22 to 17.6 MB, tried on
 * a copy of the app's parts) for about half a minute more of building.
 *
 * Level 19 needs an 8 MiB window to decompress; the self-extractor gives its
 * decompressor 128 MiB (`src/extractor/main.zig` in Electrobun 1.18.1). The
 * archive is named for a hash of the files in it, not of its compressed
 * bytes, so its name stays. Level 22 saved only 0.3 MB more, at twice the time.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const LEVEL = 19;
const bundle = process.env.ELECTROBUN_WRAPPER_BUNDLE_PATH;
const resources = bundle && join(bundle, 'Contents', 'Resources');
const mb = (bytes: number) => (bytes / 1e6).toFixed(1);

if (process.env.ELECTROBUN_OS === 'macos' && resources && existsSync(resources)) {
  for (const name of readdirSync(resources).filter((file) => file.endsWith('.tar.zst'))) {
    const path = join(resources, name);
    const was = await Bun.file(path).bytes();
    const smaller = Bun.zstdCompressSync(Bun.zstdDecompressSync(was), { level: LEVEL });
    await Bun.write(path, smaller);
    console.log(`${name}: ${mb(was.length)} → ${mb(smaller.length)} MB (zstd level ${LEVEL})`);
  }
}
