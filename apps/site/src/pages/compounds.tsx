import { useEffect, useState } from 'react';
import { Shape } from '@minca/app-shared/shapes';
import type { ShapeKind } from '@minca/ui/shapes';
import type { ShapeColour } from '@minca/ui/tokens';

/**
 * Five companies and five groups, building one after another. Each company
 * starts from nothing and stops at the same events app; each group starts
 * from the one before and adds a piece, so the tool grows a step every time.
 * The columns fill in turn, hold, and start over.
 */

const GROUPS: ReadonlyArray<{ group: string; adds: string; kind: ShapeKind; colour: ShapeColour }> = [
  { group: 'Riverside', adds: 'RSVP', kind: 'clover', colour: 'coral' },
  { group: 'Pixel Pals', adds: 'Waitlist', kind: 'scallop', colour: 'cobalt' },
  { group: 'Open Mic', adds: 'Slots', kind: 'flower', colour: 'peach' },
  { group: 'Elm Street', adds: 'Talks', kind: 'wave', colour: 'sage' },
  { group: 'Hill Road', adds: 'Reminders', kind: 'burst', colour: 'lilac' },
];

/** How long each column takes to build, and how long the whole holds before it starts again */
const STEP_MS = 1100;
const HOLD_MS = 3600;

function useBuilt(): number {
  const still = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  const [built, setBuilt] = useState(still ? GROUPS.length : 0);
  useEffect(() => {
    if (still) return;
    const done = built >= GROUPS.length;
    const timer = setTimeout(() => setBuilt(done ? 0 : built + 1), done ? HOLD_MS : STEP_MS);
    return () => clearTimeout(timer);
  }, [built, still]);
  return built;
}

export function Compounds() {
  const built = useBuilt();
  return (
    <div className="frame compound paper-grid">
      <div className="compound-row">
        <div className="compound-label">
          <b>Five companies</b>
          <small>Each one starts from nothing</small>
        </div>
        <div className="compound-cols">
          {GROUPS.map((each, i) => (
            <div key={each.group} className="compound-col" data-on={i < built || undefined}>
              <span className="compound-block is-same">Events app</span>
              <small>Version 1</small>
            </div>
          ))}
        </div>
        <div className="compound-sum">
          <b>1</b>
          <small>idea, built {Math.max(built, 1)} times</small>
        </div>
      </div>

      <div className="compound-row">
        <div className="compound-label">
          <b>Five groups on Minca</b>
          <small>Each one starts where the last stopped</small>
        </div>
        <div className="compound-cols">
          {GROUPS.map((each, i) => (
            <div key={each.group} className="compound-col" data-on={i < built || undefined}>
              {GROUPS.slice(0, i + 1)
                .reverse()
                .map((piece, j) => (
                  <span
                    key={piece.adds}
                    className={
                      j === 0 ? `compound-block is-new c-${piece.colour}` : `compound-block c-${piece.colour}`
                    }
                  >
                    <Shape kind={piece.kind} colour={piece.colour} size={12} />
                    {j === 0 && i > 0 ? `+ ${piece.adds}` : piece.adds}
                  </span>
                ))}
              <small>{each.group}</small>
            </div>
          ))}
        </div>
        <div className="compound-sum is-ours">
          <b>{Math.max(built, 1)}</b>
          <small>{built > 1 ? 'ideas, each built once' : 'idea, built once'}</small>
        </div>
      </div>
    </div>
  );
}
