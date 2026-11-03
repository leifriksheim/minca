import type { ReactNode } from 'react';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { baseOptions } from '@/lib/layout';
import { source } from '@/lib/source';

/** Every page, the front page too, has the sidebar. */
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <DocsLayout tree={source.getPageTree()} {...baseOptions}>
      {children}
    </DocsLayout>
  );
}
