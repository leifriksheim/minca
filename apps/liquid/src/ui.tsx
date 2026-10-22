import type { ReactNode } from 'react';
import { Avatar } from '@minca/app-shared/Avatar';
import { Shape } from '@minca/app-shared/shapes';
import { shapeFor } from '@minca/ui/shapes';
import type { Choice, PartyRule } from './schema';
import type { Assembly, PartyFull, TopicView } from './model';
import { PARTY_SHARE, type Step, type Tally } from './tally';
import { markOf, onShape, palette, partyMarkOf, tone } from './styles';

export const CHOICE_LABEL: Readonly<Record<Choice, string>> = {
  for: 'For',
  against: 'Against',
  abstain: 'Abstain',
};

export const PARTY_RULE_LABEL: Readonly<Record<PartyRule, string>> = {
  majority: 'More than half',
  'two-thirds': 'Two-thirds',
  'three-quarters': 'Three-quarters',
  everyone: 'Everyone',
  representative: 'A representative',
};

/** How a party takes a position, in a few words: "5 of its 7 members vote alike", "Ada votes for it" */
export function decidesText(a: Assembly, party: Pick<PartyFull, 'decides' | 'representative' | 'members'>) {
  if (party.decides === 'representative')
    return party.representative && party.members.has(party.representative)
      ? `${a.name(party.representative)} votes for it`
      : 'Needs a representative who is a member';
  const n = party.members.size;
  return `${PARTY_SHARE[party.decides](n)} of its ${n} ${n === 1 ? 'member' : 'members'} vote alike`;
}

/** "just now", "5m", "3h", "2d", then a date */
export function ago(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (seconds < 45) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  if (seconds < 7 * 86400) return `${Math.round(seconds / 86400)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** A topic's mark: a small shape, the same one wherever the topic shows */
function TopicMark({ topic, size = 11 }: { topic: { name: string; hue: number }; size?: number }) {
  return <Shape {...markOf(topic.name, topic.hue)} size={size} />;
}

export function TopicChip({ topic }: { topic: TopicView }) {
  return (
    <span className="lq-chip">
      <TopicMark topic={topic} />
      {topic.name}
    </span>
  );
}

/** Topics as chips to pick: the picked one is chosen as a segment is, with the rule */
export function TopicPicker<T extends { name: string; hue: number }>({
  topics,
  on,
  onToggle,
}: {
  topics: ReadonlyArray<T>;
  on: (topic: T) => boolean;
  onToggle: (topic: T) => void;
}) {
  return topics.map((t) => (
    <button
      key={'key' in t && typeof t.key === 'string' ? t.key : t.name}
      type="button"
      className="lq-chip"
      data-filter
      aria-pressed={on(t)}
      onClick={() => onToggle(t)}
    >
      <TopicMark topic={t} size={12} />
      {t.name}
    </button>
  ));
}

/** A party's mark: its shape in its colour, with its initial in the middle when there is room */
export function PartyMark({ party, size = 28 }: { party: Pick<PartyFull, 'name' | 'hue'>; size?: number }) {
  const mark = partyMarkOf(party.name || '?', party.hue);
  return (
    <span
      aria-hidden
      style={{
        position: 'relative',
        width: size,
        height: size,
        flexShrink: 0,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Shape {...mark} size={size} style={{ position: 'absolute', inset: 0 }} />
      {size >= 24 && (
        <span
          style={{
            position: 'relative',
            fontFamily: palette.display,
            fontSize: size * 0.42,
            fontWeight: 700,
            letterSpacing: '-0.02em',
            color: onShape(mark.colour),
          }}
        >
          {party.name.trim().charAt(0).toUpperCase() || '?'}
        </span>
      )}
    </span>
  );
}

export function PartyChip({ party }: { party: PartyFull }) {
  return (
    <span className="lq-chip">
      <PartyMark party={party} size={13} />
      {party.name}
    </span>
  );
}

/** Someone, by face and name */
export function Who({
  did,
  a,
  size = 24,
  children,
}: {
  did: string;
  a: Assembly;
  size?: number;
  children?: ReactNode;
}) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
      <Avatar did={did} size={size} />
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {did === a.me ? 'You' : a.name(did)}
      </span>
      {children}
    </span>
  );
}

/** A step on a vote's way: a person or a party */
function StepView({ step, a }: { step: Step; a: Assembly }) {
  if (step.kind === 'person') return <Who did={step.did} a={a} size={18} />;
  const party = a.partyOf(step.key);
  return party ? <PartyChip party={party} /> : <span className="lq-faint">a party that’s gone</span>;
}

/** Where a vote went: You → Ada → Greens */
export function PathView({ path, a, from }: { path: ReadonlyArray<Step>; a: Assembly; from: string }) {
  return (
    <span className="lq-path">
      <Who did={from} a={a} size={18} />
      {path.map((step, i) => (
        <span key={i} style={{ display: 'contents' }}>
          <span className="lq-path-arrow">→</span>
          <StepView step={step} a={a} />
        </span>
      ))}
    </span>
  );
}

/** For, against and abstain along one bar, out of everyone */
export function Meter({ tally, size }: { tally: Tally; size?: 'lg' }) {
  const all = tally.for + tally.against + tally.abstain + tally.uncast || 1;
  const pct = (n: number) => `${(n / all) * 100}%`;
  return (
    <div
      className="lq-meter"
      data-size={size}
      role="img"
      aria-label={`${tally.for} for, ${tally.against} against, ${tally.abstain} abstaining, ${tally.uncast} not cast`}
    >
      <span style={{ width: pct(tally.for), background: tone.for }} />
      <span style={{ width: pct(tally.against), background: tone.against }} />
      <span style={{ width: pct(tally.abstain), background: tone.abstain }} />
    </div>
  );
}

export function Upvote({
  count,
  pressed,
  disabled,
  onToggle,
}: {
  count: number;
  pressed: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      className="lq-upvote"
      aria-pressed={pressed}
      disabled={disabled}
      aria-label={pressed ? 'Take back your support' : 'Support: help it get seen'}
      title={pressed ? 'You support this' : 'Support this, so more people see it'}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
    >
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
        <path d="M7 2.5 12 9H2z" fill="currentColor" />
      </svg>
      {count}
    </button>
  );
}

export function Problem({ children }: { children: ReactNode }) {
  return children ? (
    <p role="alert" style={{ fontSize: 13, color: tone.against, lineHeight: 1.5 }}>
      {children}
    </p>
  ) : null;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="lq-empty lq-fade">
      <Shape {...shapeFor(title)} size={40} />
      <p className="lq-display" style={{ fontSize: 18 }}>
        {title}
      </p>
      {children}
    </div>
  );
}
