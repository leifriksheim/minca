import type { ReactNode } from 'react';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import type * as PageTree from 'fumadocs-core/page-tree';
import { baseOptions } from '@/lib/layout';
import { source } from '@/lib/source';

/** Every page, the front page too, has the sidebar. */
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <DocsLayout tree={withApiModulesAsPages(source.getPageTree())} {...baseOptions}>
      {children}
    </DocsLayout>
  );
}

/**
 * Every page carries the whole sidebar, so listing the API's thousand members
 * in it made each page megabytes. A module's members are reached from its
 * page, and from search.
 */
function withApiModulesAsPages(tree: PageTree.Root): PageTree.Root {
  const children = tree.children.map((node): PageTree.Node =>
    node.type === 'folder' && node.index?.url.startsWith('/api/')
      ? { ...node.index, name: node.name, icon: node.icon }
      : node,
  );
  return { ...tree, children };
}
