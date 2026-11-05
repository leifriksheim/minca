/**
 * Marks a step of starting, such as a node opening its account space, for
 * debug tools that watch with a `PerformanceObserver` (`type: 'mark'`), names
 * starting `minca `. Says nothing on any console, and keeps nothing: the mark
 * is cleared at once, and observers still hear it.
 */
export function markStep(name: string): void {
  performance.clearMarks(performance.mark(`minca ${name}`).name);
}
