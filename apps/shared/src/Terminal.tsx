import type { CSSProperties } from 'react';
import { ink, mono, radius } from '@minca/ui/tokens';
import { useCopy } from './action';

/** On the dark box: words, flags dimmed, addresses and the prompt green */
const COLOURS = { word: '#dfe4f2', flag: '#8b93b3', address: '#7fd8a6' } as const;

const colourOf = (word: string) =>
  word.startsWith('--') ? COLOURS.flag : /^https?:\/\//.test(word) ? COLOURS.address : COLOURS.word;

/**
 * A line to paste, on one dark row with a copy icon at its end: a command gets a `$` before it, an
 * address goes as it is. The site's MCP page and the apps' "Connect an agent" both use it.
 */
export function Terminal({ text, style }: { text: string; style?: CSSProperties }) {
  const { copied, copy } = useCopy();
  const command = !/^https?:\/\//.test(text);
  return (
    <div style={{ ...box, ...style }}>
      <code style={line}>
        {command && <span style={{ color: COLOURS.address, userSelect: 'none' }}>$ </span>}
        {text.split(' ').map((word, i) => (
          <span key={i} style={{ color: colourOf(word) }}>
            {i > 0 && ' '}
            {word}
          </span>
        ))}
      </code>
      <button
        type="button"
        onClick={() => copy(text)}
        aria-label={copied ? 'Copied' : 'Copy'}
        title={copied ? 'Copied' : 'Copy'}
        style={button}
      >
        {copied ? <Check /> : <Copy />}
      </button>
    </div>
  );
}

const Copy = () => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    aria-hidden
  >
    <rect x="9" y="9" width="12" height="12" rx="2.5" />
    <path d="M5 15H4.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5V5" />
  </svg>
);

const Check = () => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke={COLOURS.address}
    strokeWidth="2.2"
    aria-hidden
  >
    <path d="m5 12.5 4.5 4.5L19 7.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const box: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '6px 6px 6px 18px',
  borderRadius: radius.md,
  background: ink.strong,
};
const line: CSSProperties = {
  flex: 1,
  minWidth: 0,
  padding: '10px 0',
  overflowX: 'auto',
  whiteSpace: 'nowrap',
  scrollbarWidth: 'none',
  background: 'none',
  fontFamily: mono,
  fontSize: 14,
  lineHeight: 1.5,
};
const button: CSSProperties = {
  flex: '0 0 auto',
  display: 'grid',
  placeItems: 'center',
  width: 36,
  height: 36,
  padding: 0,
  border: 'none',
  borderRadius: radius.sm,
  background: 'none',
  color: COLOURS.flag,
  cursor: 'pointer',
};
