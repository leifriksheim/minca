// Copies the root README into a package before it is packed, with its
// relative links made absolute: npm resolves them against the package's own
// folder, where `spec/` and `apps/` don't exist.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPO = 'https://github.com/leifriksheim/minca';
const root = fileURLToPath(new URL('../README.md', import.meta.url));

const absolute = (path) => {
  if (/^(?:[a-z]+:|#|\/\/)/i.test(path)) return path;
  const kind = /\.(?:svg|png|jpe?g|gif|webp)$/i.test(path) ? 'raw' : 'blob';
  return `${REPO}/${kind}/main/${path.replace(/^\.\//, '')}`;
};

const readme = readFileSync(root, 'utf8')
  .replace(/\]\(([^)\s]+)\)/g, (_, path) => `](${absolute(path)})`)
  .replace(
    /(<(?:img|source|a)\b[^>]*?\s(?:src|srcset|href)=")([^"]+)"/g,
    (_, start, path) => `${start}${absolute(path)}"`,
  );

writeFileSync('README.md', readme);
