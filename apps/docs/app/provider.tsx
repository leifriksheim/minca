'use client';
import { RootProvider } from 'fumadocs-ui/provider/next';
import {
  SearchDialog,
  SearchDialogClose,
  SearchDialogContent,
  SearchDialogHeader,
  SearchDialogIcon,
  SearchDialogInput,
  SearchDialogList,
  SearchDialogOverlay,
  type SharedProps,
} from 'fumadocs-ui/components/dialog/search';
import { useStaticSearch } from 'fumadocs-core/search/client';
import type { ReactNode } from 'react';

/** Search runs in the browser, on the index app/api/search/route.ts writes at build. */
function Search(props: SharedProps) {
  return (
    <SearchDialog {...useStaticSearch({})} {...props}>
      <SearchDialogOverlay />
      <SearchDialogContent>
        <SearchDialogHeader>
          <SearchDialogIcon />
          <SearchDialogInput />
          <SearchDialogClose />
        </SearchDialogHeader>
        <SearchDialogList />
      </SearchDialogContent>
    </SearchDialog>
  );
}

export function Provider({ children }: { children: ReactNode }) {
  return <RootProvider search={{ SearchDialog: Search }}>{children}</RootProvider>;
}
