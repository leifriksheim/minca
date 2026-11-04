import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { Play } from 'lucide-react';
import { Mark } from '@minca/app-shared/Wordmark';

/** What every page's sidebar has: the wordmark, GitHub, no theme picker. */
export const baseOptions: BaseLayoutProps = {
  nav: {
    title: (
      <span className="wordmark">
        <Mark size={24} />
        minca
      </span>
    ),
  },
  // Above the pages: the playground isn't one of them.
  links: [{ text: 'Playground', url: '/playground/', icon: <Play />, active: 'url' }],
  githubUrl: 'https://github.com/leifriksheim/minca',
  // Always dark (app/layout.tsx).
  themeSwitch: { enabled: false },
};
