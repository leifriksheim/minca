import { Loader } from '@minca/app-shared/Loader';

/** A line saying what is loading, where it will be */
export function Loading({ label }: { label: string }) {
  return (
    <p>
      <Loader label={label} showLabel />
    </p>
  );
}
