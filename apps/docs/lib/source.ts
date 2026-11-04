import { defineDocs } from 'fumadocs-mdx/macro';
import { loader } from 'fumadocs-core/source';
import { lucideIconsPlugin } from 'fumadocs-core/source/plugins/lucide-icons';

/** The pages scripts/sync.mjs copies in, at their paths: /collections/contracts and so on. */
const docs = defineDocs({ dir: 'content/docs' });

export const source = loader({
  baseUrl: '/',
  source: docs.toFumadocsSource(),
  // Icons are named in nav.json and frontmatter, from lucide.
  plugins: [lucideIconsPlugin()],
});
