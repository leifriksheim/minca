import { useState } from 'react';
import { ConnectAgent } from './ConnectAgent';
import { Morph, type RoundKind } from '@minca/app-shared/shapes';
import type { ShapeColour } from '@minca/app-shared/tokens';
import { Icon } from './Icon';
import { styles, palette } from '../styles';

/** An app you make can be anything, so its shape keeps turning into the next */
const BECOMES: ReadonlyArray<{ kind: RoundKind; colour: ShapeColour }> = [
  { kind: 'flower', colour: 'cobalt' },
  { kind: 'burst', colour: 'coral' },
  { kind: 'clover', colour: 'sage' },
  { kind: 'scallop', colour: 'peach' },
];

/** Under the list of spaces: the way to make apps of your own, with an agent */
export function AgentCard() {
  const [connecting, setConnecting] = useState(false);
  return (
    <section
      aria-label="Make your own apps"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        flexWrap: 'wrap',
        marginTop: 28,
        padding: 16,
        borderRadius: palette.radius.lg,
        border: `1px solid ${palette.surface.line}`,
        background: palette.surface.sunken,
      }}
    >
      <Morph steps={BECOMES} size={44} />
      <div style={{ flex: '1 1 220px', minWidth: 0 }}>
        <strong style={{ fontSize: 14, color: palette.ink.strong }}>Make apps for your group</strong>
        <p style={{ fontSize: 13, lineHeight: 1.45, color: palette.ink.muted, marginTop: 2 }}>
          Connect Claude or Cursor, say what you need — a sign-up sheet, a rota, a reading list — and it
          builds it in your space.
        </p>
      </div>
      <button
        onClick={() => setConnecting(true)}
        data-variant="quiet"
        style={{ ...styles.smallButton, height: 36, display: 'inline-flex', alignItems: 'center', gap: 6 }}
      >
        <Icon name="terminal" size={14} /> Connect an agent
      </button>
      {connecting && <ConnectAgent onClose={() => setConnecting(false)} />}
    </section>
  );
}
