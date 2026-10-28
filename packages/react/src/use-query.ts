import { useEffect, useState } from 'react';
import { plainQuery, type CollectionRef, type IncludeMap, type Query, type ResultFor } from '@minca/core';
import { useNode } from './context.js';

export interface QueryState<R> {
  /** The latest result, or null until the first one arrives. `result.complete` is false while what it needs is still on its way. */
  readonly result: R | null;
  /** Why the query failed — usually a malformed query, saying what to fix */
  readonly error: Error | null;
}

/**
 * Runs a query and keeps it current as records change, locally or by sync.
 * The query is plain data, compared by value, so writing it inline is fine.
 * Name the collection by its definition and the result comes back typed.
 */
export function useQuery<const C extends CollectionRef, const I extends IncludeMap | undefined = undefined>(
  spaceId: string,
  query: Query<C, I>,
): QueryState<ResultFor<C, I>> {
  const node = useNode();
  const [state, setState] = useState<QueryState<ResultFor<C, I>>>({ result: null, error: null });
  // Compared by its plain form: a definition's validator is not data.
  const key = JSON.stringify(plainQuery(query));

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a new query must not show the last one's result
    setState({ result: null, error: null });
    return node.records.watch(
      spaceId,
      // The plain form `key` was made from: data a connection can send on to the home.
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- parsed from plainQuery's output
      JSON.parse(key) as Query,
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- typed from the query, as records.query is
      (result) => setState({ result: result as ResultFor<C, I>, error: null }),
      (error) => setState((previous) => ({ result: previous.result, error })),
    );
  }, [node, spaceId, key]);

  return state;
}
