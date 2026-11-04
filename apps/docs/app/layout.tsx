import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Provider } from './provider';
import './global.css';

export const metadata: Metadata = {
  metadataBase: new URL('https://minca.dev'),
  title: { template: '%s · Minca', default: 'Minca for developers' },
  description:
    'Build apps whose data lives in people’s shared spaces, signed and synced between them. No backend to write.',
  icons: { icon: '/favicon.svg' },
};

/** Minca's faces, as apps/site/index.html loads them. */
const FONTS =
  'https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,700;12..96,800&family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&display=swap';

export default function Layout({ children }: { children: ReactNode }) {
  return (
    // The site is the design system's night side, always: developers like it dark.
    // `dark` is Fumadocs' switch, data-theme the design system's.
    <html lang="en" className="dark" data-theme="dark">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link rel="stylesheet" href={FONTS} />
      </head>
      <body className="flex min-h-screen flex-col">
        <Provider>{children}</Provider>
      </body>
    </html>
  );
}
