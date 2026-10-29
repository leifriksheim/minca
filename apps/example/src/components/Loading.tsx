import type { CSSProperties } from 'react';
import { Loader } from '@minca/app-shared/Loader';

/** A line saying what is loading, where it will be */
export function Loading({ label, style }: { label: string; style: CSSProperties }) {
  return (
    <p style={style}>
      <Loader label={label} showLabel />
    </p>
  );
}
