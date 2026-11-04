'use client';
import dynamic from 'next/dynamic';

/** The playground, in the browser only: its connection keeps its grant and keys in this site's storage. */
export const ClientPlayground = dynamic(() => import('./Playground').then((m) => m.Playground), {
  ssr: false,
});
