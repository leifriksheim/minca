import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
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
  githubUrl: 'https://github.com/leifriksheim/minca',
  // The site follows the system's light or dark.
  themeSwitch: { enabled: false },
};
