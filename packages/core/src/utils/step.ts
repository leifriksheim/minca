/**
 * Marks a step of starting, such as a node opening its account space, for
 * debug tools that watch with a `PerformanceObserver` (`type: 'mark'`), names
 * starting `minca `. Says nothing on any console, and keeps nothing: the mark
 * is cleared at once, and observers still hear it.
 */
export function markStep(name: string): void {
  try {
    performance.clearMarks(performance.mark(`minca ${name}`).name);
  } catch {
    // An engine without User Timing 3 has nothing to watch with, and starting must not fail for it.
  }
}
