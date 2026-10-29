/** The value a map holds for a key, made and kept the first time it is asked for */
export function getOrAdd<K, V>(map: Map<K, V>, key: K, make: () => V): V {
  if (!map.has(key)) map.set(key, make());
  return map.get(key)!;
}
