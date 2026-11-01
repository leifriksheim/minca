import { useState } from 'react';
import { Shape } from '@minca/app-shared/shapes';
import { Wordmark } from '@minca/app-shared/Wordmark';
import type { RoundKind } from '@minca/ui/round';
import { shapeGrounds } from '@minca/ui/tokens';
import { styles, palette } from '../styles';
import { LinkButton, PrimaryButton } from './Buttons';

/** What Minca does differently from the apps people know, a card at a time */
const CARDS: ReadonlyArray<{
  title: string;
  body: string;
  kind: RoundKind;
  colour: keyof typeof shapeGrounds;
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
    <div className="page">
      <div style={styles.card}>
        <div
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 32 }}
        >
          <Wordmark compact />
          {/* Hidden on the last card, where the main button already goes on */}
          <LinkButton onClick={onDone} style={{ paddingRight: 0, visibility: last ? 'hidden' : undefined }}>
            Skip
          </LinkButton>
        </div>

        {/* A colour tile with its shape off the corner, as on the site */}
        <div
          aria-hidden
          style={{
            position: 'relative',
            height: 180,
            borderRadius: palette.radius.lg,
            background: shapeGrounds[card.colour],
            overflow: 'hidden',
            marginBottom: 28,
          }}
        >
          <Shape
            kind={card.kind}
            colour={card.colour}
            size={220}
            style={{ position: 'absolute', right: -50, bottom: -60 }}
          />
          <Shape kind="sparkle" colour="ink" size={28} style={{ position: 'absolute', left: 28, top: 28 }} />
        </div>

        <h1 style={styles.title}>{card.title}</h1>
        <p style={{ ...styles.subtitle, minHeight: 90 }}>{card.body}</p>

        <PrimaryButton onClick={() => (last ? onDone() : setAt(at + 1))}>
          {last ? 'Let’s go' : 'Next'}
        </PrimaryButton>

        <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginTop: 20 }}>
          {CARDS.map((each, i) => (
            <button
              key={each.title}
              onClick={() => setAt(i)}
              aria-label={`Card ${i + 1} of ${CARDS.length}`}
              aria-current={i === at ? 'step' : undefined}
              style={{
                width: i === at ? 20 : 8,
                height: 8,
                padding: 0,
                border: 'none',
                borderRadius: palette.radius.pill,
                background: i === at ? palette.ink.strong : palette.surface.lineStrong,
                cursor: 'pointer',
                transition: 'width 200ms ease',
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
