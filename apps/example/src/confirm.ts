import { ask } from '@minca/app-shared/Ask';

/** Asks before something that can't be undone, and does it only on a yes */
export function confirmThen(
  question: string,
  options: { title: string; yes: string },
  then: () => unknown,
): void {
  void ask(question, { ...options, danger: true }).then((sure) => {
    if (sure) void then();
  });
}
