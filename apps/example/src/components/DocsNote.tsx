import type { ReactNode } from 'react';

const REPO = 'https://github.com/leifriksheim/minca/blob/main/';

/** A line on what is going on underneath, and the page that explains the rest */
export function DocsNote({ path, children }: { path: string; children: ReactNode }) {
  return (
    <p>
      <small>
        {children}{' '}
        <a href={REPO + path} target="_blank" rel="noreferrer">
          How it works
        </a>
      </small>
    </p>
  );
}
