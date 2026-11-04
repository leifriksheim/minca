import type { ReactNode } from 'react';
import { Shape } from './shapes';
import { Icon, type IconName } from './Icon';

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
const TONES: Record<Tone, 'good' | 'warn' | 'danger' | undefined> = {
  good: 'good',
  warn: 'warn',
  bad: 'danger',
  neutral: undefined,
};

/** A short state, as a tag in its tone: Online, Runs out in 5 days, Needs payment */
export function StatusPill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className="tag" data-tone={TONES[tone]}>
      {children}
    </span>
  );
}

/** A benefit in a list: a small check and one short line */
export function Benefit({ glyph = 'check', children }: { glyph?: IconName; children: ReactNode }) {
  return (
    <li className="row">
      <Icon name={glyph} />
      <p>{children}</p>
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
