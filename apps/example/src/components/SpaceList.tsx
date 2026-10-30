import { useState, type FormEvent } from 'react';
import type { SpaceSummary, SpaceVisibility } from '@minca/core';
import type { NewSpace } from '@minca/core';
import { rolePresets } from '@minca/core';
import { Modal } from '@minca/app-shared/Modal';
import { Info } from '@minca/app-shared/Info';
import { Shape } from '@minca/app-shared/shapes';
import { markFor } from '@minca/ui/shapes';
import type { ShapeColour } from '@minca/ui/tokens';
import { styles, palette, stack, ui } from '../styles';
import { useSpaceUnread } from '../seen';
import { Loading } from './Loading';
import { Count } from './apps/AppIcon';
import { Options, type Option } from './Options';
import { LinkButton, PrimaryButton } from './Buttons';

/** How a space is described once it exists: who can read it, and what you are in it. */
function spaceBadges(space: Pick<SpaceSummary, 'visibility' | 'role' | 'joining'>): string {
  return `${space.visibility === 'private' ? 'Private' : 'Public'} · ${space.joining ? 'joining…' : (space.role ?? 'following')}`;
}

/** Shape colours light enough to carry navy rather than paper */
const LIGHT: ReadonlySet<ShapeColour> = new Set(['peach', 'lilac']);

/**
 * A space's icon: its shape, picked by its id so it is the same in the grid,
 * the space's sidebar and every alert, with the first letter of its name in the middle.
 */
export function SpaceMark({ space, size = 40 }: { space: Pick<SpaceSummary, 'id' | 'name'>; size?: number }) {
  const shape = markFor(space.id);
  const letter = [...space.name.trim()][0]?.toUpperCase() ?? '·';
  const navy = LIGHT.has(shape.colour);
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
      <Shape {...shape} size={size} style={{ position: 'absolute', inset: 0 }} />
      <span
        style={{
          position: 'relative',
          fontFamily: palette.display,
          fontSize: Math.round(size * 0.42),
          fontWeight: 700,
          letterSpacing: '-0.04em',
          lineHeight: 1,
          color: navy ? palette.ink.strong : palette.surface.card,
        }}
      >
        {letter}
      </span>
    </span>
  );
}

/**
 * The ways a group can be run, in plain words: each founds it with a preset's roles
 * (`rolePresets` in `packages/core/src/space/presets.ts`).
 */
const RUNS: ReadonlyArray<Option<Run> & { readonly preset: keyof typeof rolePresets }> = [
  {
    value: 'friends',
    preset: 'team',
    shape: 'dots',
    title: 'Friends',
    detail: 'Everyone can change anything and add people.',
  },
  {
    value: 'community',
    preset: 'community',
    shape: 'shield',
    title: 'Community',
    detail: 'Members change their own things. Moderators tidy up.',
  },
  {
    value: 'coop',
    preset: 'coop',
    shape: 'group',
    title: 'Co-op',
    detail: 'Nobody owns it. Stewards run it together.',
  },
];
type Run = 'friends' | 'community' | 'coop';

/** Who can read it; who can write is decided by the roles */
const READS: ReadonlyArray<Option<SpaceVisibility>> = [
  {
    value: 'private',
    shape: 'lock',
    title: 'Encrypted',
    detail: 'Only people you add can read it. Not even the relay can.',
  },
  {
    value: 'public',
    shape: 'signal',
    title: 'Public',
    detail: 'Anyone with the link can read it. Only people you add can change it.',
  },
];

/** The steps of making a group, one question each */
const STEPS = ['name', 'run', 'read'] as const;
type Step = (typeof STEPS)[number];

/** Your groups, one to a row the way chat apps list them, each opening into the app it starts with */
export function SpaceList({
  spaces,
  loading,
  error,
  onOpen,
  onNew,
  onRemove,
}: {
  spaces: ReadonlyArray<SpaceSummary>;
  loading: boolean;
  error: string | null;
  onOpen: (space: SpaceSummary) => void;
  /** Make a group, from the empty list */
  onNew: () => void;
  onRemove: (spaceId: string) => void;
}) {
  return (
    <>
      {loading && spaces.length === 0 ? (
        <Loading label="Opening your groups" style={styles.emptyState} />
      ) : spaces.length === 0 ? (
        <div style={{ ...styles.emptyState, ...stack(10), alignItems: 'center' }}>
          <strong style={{ color: palette.ink.strong, fontSize: 15 }}>No groups yet</strong>
          <span>A group starts as a chat. Add people, then any app it needs: a board, a poll, a list.</span>
          <PrimaryButton onClick={onNew} style={{ marginTop: 6 }}>
            New group
          </PrimaryButton>
        </div>
      ) : (
        <ul className="rows" style={ui.list}>
          {spaces.map((space) => (
            <li key={space.id} data-tile style={{ position: 'relative', listStyle: 'none' }}>
              <button onClick={() => onOpen(space)} style={row}>
                <SpaceMark space={space} size={44} />
                <span style={{ ...stack(2), minWidth: 0, flex: 1 }}>
                  <span style={groupName}>{space.name}</span>
                  <span style={{ ...ui.ellipsis, fontSize: 13, color: palette.ink.muted }}>
                    {spaceBadges(space)}
                  </span>
                </span>
                <SpaceCount space={space} />
              </button>
              <button
                onClick={() => onRemove(space.id)}
                data-row-action
                data-variant="danger"
                style={{ ...styles.rowAction, position: 'absolute', top: 'calc(50% - 14px)', right: 12 }}
                title={`Leave ${space.name}`}
                aria-label={`Leave ${space.name}`}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}

      {error && <p style={{ ...styles.error, marginTop: 10 }}>{error}</p>}
    </>
  );
}

/**
 * What arrived in a space since you last looked, across its apps, as an app shows it: red with an @
 * when some of it names you (a mention, a reply), grey when it is only new
 */
export function SpaceCount({ space }: { space: SpaceSummary }) {
  return <Count unread={useSpaceUnread(space)} />;
}

const row = {
  width: '100%',
  display: 'flex',
  alignItems: 'center',
  gap: 14,
  padding: '14px 52px 14px 16px',
  border: 'none',
  background: 'none',
  textAlign: 'left' as const,
};
/** A group goes by its name in the display face, as its sidebar has it */
const groupName = {
  ...ui.ellipsis,
  fontFamily: palette.display,
  fontSize: 17,
  fontWeight: 700,
  letterSpacing: '-0.03em',
  color: palette.ink.strong,
};

/** Making a group, or joining one from a link, in one dialog */
export function SpaceDialog({
  initial,
  onClose,
  onCreate,
  onJoin,
}: {
  initial: 'new' | 'join';
  onClose: () => void;
  onCreate: (params: NewSpace) => void;
  onJoin: (invite: string) => void;
}) {
  const [mode, setMode] = useState(initial);
  const [name, setName] = useState('');
  const [visibility, setVisibility] = useState<SpaceVisibility>('private');
  const [run, setRun] = useState<Run>('community');
  const [step, setStep] = useState<Step>('name');
  const [invite, setInvite] = useState('');

  // Each step's button goes on to the next; the last one makes the group.
  const next = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    const after = STEPS[STEPS.indexOf(step) + 1];
    if (after) return setStep(after);
    // Founded with the roles its way of running gives, so inviting someone later needs no setup first.
    const preset = RUNS.find((option) => option.value === run)?.preset ?? 'community';
    onCreate({ name: trimmed, visibility, ...rolePresets[preset] });
    onClose();
  };
  const back = () => setStep(STEPS[STEPS.indexOf(step) - 1] ?? 'name');

  const join = (event: FormEvent) => {
    event.preventDefault();
    if (!invite.trim()) return;
    onJoin(invite.trim());
    onClose();
  };

  if (mode === 'join') {
    return (
      <Modal title="Join a group" onClose={onClose}>
        <form onSubmit={join} style={styles.form}>
          <input
            type="text"
            value={invite}
            onChange={(event) => setInvite(event.target.value)}
            placeholder="Paste an invite link"
            style={styles.input}
            spellCheck={false}
            aria-label="Invite link"
          />
          <p style={styles.errorHint}>
            Paste a link someone shared with you.
            <Info label="What an invite link carries">
              The space itself and, for a private one, the key that opens it — in the part after the{' '}
              <code>#</code>, which browsers never send to a server. So it reaches you without passing through
              whatever is hosting the page.
            </Info>
          </p>
          <PrimaryButton type="submit" disabled={!invite.trim()}>
            Join
          </PrimaryButton>
          <LinkButton type="button" onClick={() => setMode('new')} style={{ alignSelf: 'center' }}>
            Make a new group instead
          </LinkButton>
        </form>
      </Modal>
    );
  }

  return (
    <Modal
      title={step === 'name' ? 'New group' : step === 'run' ? 'How is it run?' : 'Who can read it?'}
      onClose={onClose}
    >
      <form onSubmit={next} style={styles.form}>
        {step === 'name' && (
          <>
            <input
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Family, Book club, Trip…"
              style={styles.input}
              aria-label="Group name"
              autoFocus
            />
            <p style={{ ...styles.errorHint, marginTop: 0 }}>It starts with a chat. You add people after.</p>
          </>
        )}
        {step === 'run' && (
          <>
            <Options label="How it's run" options={RUNS} picked={run} onPick={setRun} />
            <p style={{ ...styles.errorHint, marginTop: 0 }}>Roles can be changed later, in Members.</p>
          </>
        )}
        {step === 'read' && (
          <>
            <Options label="Who can read it" options={READS} picked={visibility} onPick={setVisibility} />
            <p style={{ ...styles.errorHint, marginTop: 0 }}>This one can't be changed later.</p>
          </>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 4 }}>
          {step === 'name' ? (
            <LinkButton type="button" onClick={() => setMode('join')}>
              Have an invite link?
            </LinkButton>
          ) : (
            <LinkButton type="button" onClick={back}>
              Back
            </LinkButton>
          )}
          <span style={{ flex: 1, display: 'flex', justifyContent: 'center', gap: 6 }} aria-hidden>
            {STEPS.map((one) => (
              <span key={one} style={one === step ? progressOn : progress} />
            ))}
          </span>
          <PrimaryButton type="submit" disabled={!name.trim()} style={{ width: 'auto', padding: '0 22px' }}>
            {step === 'read' ? 'Create group' : 'Next'}
          </PrimaryButton>
        </div>
      </form>
    </Modal>
  );
}

/** Where in the steps you are: a dot for each, the one you're on longer */
const progress = {
  width: 6,
  height: 6,
  borderRadius: palette.radius.pill,
  background: palette.surface.lineStrong,
} as const;
const progressOn = { ...progress, width: 18, background: palette.accent.base } as const;
