import { useEffect, useState, type DependencyList } from 'react';

export type AsyncState<T> =
  | { readonly status: 'loading' }
  | { readonly status: 'done'; readonly value: T }
  | { readonly status: 'failed'; readonly error: Error };

/**
 * Runs `load`, and again whenever `deps` change. Until the answer for the
 * current `deps` arrives it is loading; an answer for older ones is dropped.
 */
export function useAsync<T>(load: () => Promise<T>, deps: DependencyList): AsyncState<T> {
  const [settled, setSettled] = useState<Settled<T> | null>(null);
  useEffect(() => {
    let current = true;
    const settle = (state: AsyncState<T>) => current && setSettled({ deps, state });
    load().then(
      (value) => settle({ status: 'done', value }),
      (error: unknown) => settle({ status: 'failed', error: asError(error) }),
    );
    return () => {
      current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the caller names what load reads
  }, deps);
  return settled && sameDeps(settled.deps, deps) ? settled.state : LOADING;
}

interface Settled<T> {
  readonly deps: DependencyList;
  readonly state: AsyncState<T>;
}

const LOADING = { status: 'loading' } as const;

const sameDeps = (a: DependencyList, b: DependencyList) =>
  a.length === b.length && a.every((dep, i) => Object.is(dep, b[i]));

const asError = (error: unknown) => (error instanceof Error ? error : new Error(String(error)));
