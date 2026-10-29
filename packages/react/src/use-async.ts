import { useEffect, useState, type DependencyList } from 'react';

export type AsyncState<T> =
  | { readonly status: 'loading' }
  | { readonly status: 'done'; readonly value: T }
  | { readonly status: 'failed'; readonly error: Error };

/**
 * Runs `load`, and again whenever `deps` change. An answer that comes after
 * the component has moved on is dropped.
 */
export function useAsync<T>(load: () => Promise<T>, deps: DependencyList): AsyncState<T> {
  const [state, setState] = useState<AsyncState<T>>({ status: 'loading' });
  useEffect(() => {
    let current = true;
    load().then(
      (value) => current && setState({ status: 'done', value }),
      (error: unknown) => current && setState({ status: 'failed', error: asError(error) }),
    );
    return () => {
      current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the caller names what load reads
  }, deps);
  return state;
}

const asError = (error: unknown) => (error instanceof Error ? error : new Error(String(error)));
