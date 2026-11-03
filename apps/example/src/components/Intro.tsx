import { useState } from 'react';
import { Shape } from '@minca/app-shared/shapes';
import { Wordmark } from '@minca/app-shared/Wordmark';
import type { RoundKind } from '@minca/ui/round';
import css from './ConnectScreen.module.css';

/** Each shape colour's place among the system's hues, for the tile it sits on */
const HUES = { cobalt: 1, coral: 2, peach: 3, sage: 4 } as const;

/** What Minca does differently from the apps people know, a card at a time */
const CARDS: ReadonlyArray<{
  title: string;
  body: string;
  kind: RoundKind;
  colour: keyof typeof HUES;
}> = [
  {
    title: 'Hi, this is Minca.',
    body: 'A place for your group’s chats and plans, owned by the group. There’s no tech billionaire in the middle taking a cut.',
    kind: 'flower',
    colour: 'coral',
  },
  {
    title: 'Your group comes first.',
    body: 'Make a space for your group, then add the tools it needs. Missing one? Ask an AI for it in plain words, or borrow one another group made.',
    kind: 'clover',
    colour: 'sage',
  },
  {
    title: 'What’s said in the group stays in the group.',
    body: 'Private spaces are locked on your device before anything leaves it. Only the people in the space hold the key, so we can’t read it either.',
    kind: 'scallop',
    colour: 'cobalt',
  },
  {
    title: 'One account for every app.',
    body: 'Your account lives in its own home. When an app like this one wants in, it asks there, and you choose what it gets to see. You can take that back anytime.',
    kind: 'burst',
    colour: 'peach',
  },
];

/** A few cards on what Minca is, before the first connect; `onDone` when they're read or skipped */
export function Intro({ onDone }: { onDone: () => void }) {
  const [at, setAt] = useState(0);
  const card = CARDS[at];
  if (!card) return null;
  const last = at === CARDS.length - 1;

  return (
    <main className={css.screen}>
      <header>
        <Wordmark compact />
        {/* Not on the last card, where the main button goes on */}
        <button data-intent="ghost" onClick={onDone} hidden={last}>
          Skip
        </button>
      </header>

      <div aria-hidden className={css.tile} data-hue={HUES[card.colour]}>
        <Shape kind={card.kind} colour={card.colour} size={220} />
        <Shape kind="sparkle" colour="ink" size={28} />
      </div>

      <section>
        <h1>{card.title}</h1>
        <p className={css.body}>{card.body}</p>
        <button data-intent="primary" onClick={() => (last ? onDone() : setAt(at + 1))}>
          {last ? 'Let’s go' : 'Next'}
        </button>
        <div className={css.dots}>
          {CARDS.map((each, i) => (
            <button
              key={each.title}
              onClick={() => setAt(i)}
              aria-label={`Card ${i + 1} of ${CARDS.length}`}
              aria-current={i === at ? 'step' : undefined}
            />
          ))}
        </div>
      </section>
    </main>
  );
}
