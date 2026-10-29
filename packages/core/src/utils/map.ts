/** The value a map holds for a key, made and kept the first time it is asked for */
export function getOrAdd<K, V>(map: Map<K, V>, key: K, make: () => V): V {
  const found = map.get(key);
  if (found !== undefined) return found;
  const made = make();
  map.set(key, made);
  return made;
}

/** Sets a value in a map that lets its oldest entry go past `max` */
export function setCapped<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  map.set(key, value);
  const oldest = map.keys().next();
  if (map.size > max && !oldest.done) map.delete(oldest.value);
}

/**
 * A promise kept by key, so each is made once. One that fails, or whose value
 * `keep` turns down, is forgotten and made again next time.
 */
export function cached<T>(
  cache: Map<string, Promise<T>>,
  key: string,
  make: () => Promise<T>,
  keep: (value: T) => boolean = () => true,
): Promise<T> {
  const known = cache.get(key);
  if (known) return known;
  const made = make();
  cache.set(key, made);
  void made.then(
    (value) => keep(value) || cache.delete(key),
    () => cache.delete(key),
  );
  return made;
}
