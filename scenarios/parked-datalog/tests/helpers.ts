/** Shared by the tests: seeded shuffles, so an order-dependence shows up the same way every run. */

/** `n` orders of `items`, from a fixed seed: the first is the order given, the second reversed */
export function shuffles<T>(items: ReadonlyArray<T>, n: number, seed = 1): T[][] {
  let s = seed;
  const random = () => {
    // mulberry32
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out: T[][] = [[...items], [...items].reverse()];
  while (out.length < n) {
    const a = [...items];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      const x = a[i];
      const y = a[j];
      if (x === undefined || y === undefined) continue;
      a[i] = y;
      a[j] = x;
    }
    out.push(a);
  }
  return out;
}
