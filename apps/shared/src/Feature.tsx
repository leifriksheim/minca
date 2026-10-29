import type { CSSProperties, ReactNode } from 'react';
import { Shape } from './shapes';
import { palette, hstack } from './styles';

/** Line glyphs on a 16-unit grid, drawn with the current colour, like the example's icons */
const GLYPHS = {
  cloud: 'M4.5 12.5h7a3 3 0 0 0 .4-6A4 4 0 0 0 4.3 6 3.25 3.25 0 0 0 4.5 12.5Z',
  sparkle: 'M8 1.5 9.4 6.6 14.5 8 9.4 9.4 8 14.5 6.6 9.4 1.5 8 6.6 6.6Z',
  check: 'M3.5 8.5 6.5 11.5 12.5 4.5',
  card: 'M1.5 3.5h13v9h-13zM1.5 6.5h13M4 10h3',
  wallet: 'M2 4.5h11.5v8H2zM2 4.5l8-2.5v2.5M10.5 8.5h1',
  lock: 'M4.5 7V5a3.5 3.5 0 0 1 7 0v2M3 7h10v7H3z',
  shield: 'M8 1.5 13.5 3.5v4c0 3.2-2.3 5.8-5.5 7-3.2-1.2-5.5-3.8-5.5-7v-4Z',
  restore: 'M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2.5v2.5H5',
  users:
    'M6 7.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM1.5 13.5c0-2.5 2-4 4.5-4s4.5 1.5 4.5 4M11 7.5a2 2 0 1 0 0-4M12.5 9.7c1.2.5 2 1.6 2 3.3',
  chat: 'M2.5 2.5h11V11H7l-3.5 3v-3h-1z',
  clock: 'M8 1.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13ZM8 4.5V8l2.5 1.5',
  close: 'M4 4l8 8M12 4l-8 8',
  arrow: 'M3 8h10M9 4l4 4-4 4',
} as const;
export type GlyphName = keyof typeof GLYPHS;

export function Glyph({ name, size = 16, style }: { name: GlyphName; size?: number; style?: CSSProperties }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      style={{ flexShrink: 0, ...style }}
    >
      <path d={GLYPHS[name]} />
    </svg>
  );
}

/** The two things a host sells, each with its own shape */
const FEATURES = {
  online: { kind: 'clover', colour: 'cobalt' },
  bot: { kind: 'sparkle', colour: 'coral' },
} as const;

/** What an upgrade looks like at a glance: its shape, flat, as DESIGN.md has it */
export function FeatureIcon({ kind, size = 40 }: { kind: keyof typeof FEATURES; size?: number }) {
  return <Shape {...FEATURES[kind]} size={size} />;
}

export type Tone = 'good' | 'warn' | 'bad' | 'neutral';
const { accent, ink, surface } = palette;
const TONES: Record<Tone, { dot: string; text: string; background: string }> = {
  good: { dot: accent.good, text: accent.good, background: accent.goodSoft },
  warn: { dot: accent.warn, text: accent.warn, background: accent.warnSoft },
  bad: { dot: accent.danger, text: accent.danger, background: accent.dangerSoft },
  neutral: { dot: ink.faint, text: ink.muted, background: surface.sunken },
};

/** A short state, as a coloured pill with a dot: Online, Runs out in 5 days, Needs payment */
export function StatusPill({ tone, children }: { tone: Tone; children: ReactNode }) {
  const colors = TONES[tone];
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        height: 22,
        padding: '0 8px',
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 500,
        color: colors.text,
        background: colors.background,
        whiteSpace: 'nowrap',
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: 3, background: colors.dot }} />
      {children}
    </span>
  );
}

/** A benefit in a list: a small check and one short line */
export function Benefit({ glyph = 'check', children }: { glyph?: GlyphName; children: ReactNode }) {
  return (
    <li style={{ ...hstack(10), alignItems: 'flex-start', fontSize: 14, color: palette.ink.body }}>
      <span
        style={{
          width: 20,
          height: 20,
          borderRadius: 10,
          flexShrink: 0,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: palette.surface.sunken,
          color: palette.ink.strong,
          marginTop: 0,
        }}
      >
        <Glyph name={glyph} size={12} style={{ strokeWidth: 1.8 }} />
      </span>
      <span style={{ lineHeight: 1.45 }}>{children}</span>
    </li>
  );
}

/** How long until a date, in words people read at a glance */
export function timeLeft(until: number, now = Date.now() / 1000): string {
  const days = Math.ceil((until - now) / 86_400);
  if (days <= 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days < 60) return `in ${days} days`;
  return `on ${new Date(until * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`;
}

/** A date, short */
export function shortDate(seconds: number): string {
  return new Date(seconds * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
