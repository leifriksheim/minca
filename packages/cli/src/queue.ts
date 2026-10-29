/** Runs one piece of work at a time, in the order asked; one that fails doesn't stop the next */
export function queue() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(work: () => Promise<T>): Promise<T> => {
    const next = tail.then(work);
    tail = next.catch(() => {});
    return next;
  };
}
