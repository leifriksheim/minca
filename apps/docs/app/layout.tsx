import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { FONTS_HREF, tokenCss } from '@minca/ui/tokens';
import { Provider } from './provider';
import './global.css';

export const metadata: Metadata = {
  metadataBase: new URL('https://minca.dev'),
  title: { template: '%s · Minca', default: 'Minca for developers' },
  description:
    'Build apps whose data lives in people’s shared spaces, signed and synced between them. No backend to write.',
  icons: { icon: '/favicon.svg' },
};

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link rel="stylesheet" href={FONTS_HREF} />
        {/* The design system's tokens as --minca-* properties. */}
        <style dangerouslySetInnerHTML={{ __html: tokenCss }} />
      </head>
      <body className="flex min-h-screen flex-col">
        <Provider>{children}</Provider>
      </body>
    </html>
  );
}
