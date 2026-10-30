import { useState, type FormEvent } from 'react';
import type { SpaceSummary, SpaceVisibility } from '@minca/core';
import type { NewSpace } from '@minca/core';
import { rolePresets } from '@minca/core';
import { Modal, Choice } from '@minca/app-shared/Modal';
import { Info } from '@minca/app-shared/Info';
import { Shape } from '@minca/app-shared/shapes';
import { markFor } from '@minca/ui/shapes';
import type { ShapeColour } from '@minca/ui/tokens';
import { useMyName } from '@minca/react';
import { NameField } from './NameField';
import { styles, palette, stack, ui } from '../styles';
import { useSpaceUnread } from '../seen';
import { Loading } from './Loading';
import { LinkButton, PrimaryButton } from './Buttons';

/** How a space is described once it exists: who can read it, and what you are in it. */
function spaceBadges(space: Pick<SpaceSummary, 'visibility' | 'role' | 'joining'>): string {
  return `${space.visibility === 'private' ? 'Private' : 'Public'} · ${space.joining ? 'joining…' : (space.role ?? 'following')}`;
}

/** Shape colours light enough to carry navy rather than paper */
const LIGHT: ReadonlySet<ShapeColour> = new Set(['peach', 'lilac']);

/**
 * A space's icon: its shape, picked by its id so it is the same in the grid,
 * the rail and every alert, with the first letter of its name in the middle.
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

/** What choosing who can read it means; who can write is decided later, per person */
function describe(visibility: SpaceVisibility): string {
  return visibility === 'private'
    ? 'End-to-end encrypted. Only people you add get the key, so nobody else can read it — not even the relay that passes it on.'
    : 'Not encrypted: anyone with the link can read it. Only people you add can change it.';
}

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
        <ul style={{ padding: 0, margin: 0 }}>
          {spaces.map((space) => (
            <li key={space.id} data-tile style={{ position: 'relative', listStyle: 'none' }}>
              <button onClick={() => onOpen(space)} style={row}>
                <SpaceMark space={space} size={44} />
                <span style={{ ...stack(2), minWidth: 0, flex: 1 }}>
                  <span style={{ ...ui.ellipsis, fontSize: 16, fontWeight: 600, color: palette.ink.strong }}>
                    {space.name}
                  </span>
                  <span style={{ ...ui.ellipsis, fontSize: 13, color: palette.ink.muted }}>
                    {spaceBadges(space)}
                    <NewIn space={space} />
                  </span>
                </span>
              </button>
              <button
                onClick={() => onRemove(space.id)}
                data-row-action
                data-variant="danger"
                style={{ ...styles.rowAction, position: 'absolute', top: 'calc(50% - 14px)', right: 8 }}
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

/** What arrived in a space since you last looked, after the rest of its line */
function NewIn({ space }: { space: SpaceSummary }) {
  const { count, forMe } = useSpaceUnread(space);
  if (count === 0) return null;
  const upTo99 = (n: number) => (n > 99 ? '99+' : n);
  return (
    <strong style={{ color: forMe > 0 ? palette.accent.danger : palette.ink.strong, fontWeight: 600 }}>
      {' '}
      · {upTo99(count)} new{forMe > 0 ? `, ${upTo99(forMe)} for you` : ''}
    </strong>
  );
}

const row = {
  width: '100%',
  display: 'flex',
  alignItems: 'center',
  gap: 14,
  padding: '12px 44px 12px 4px',
  border: 'none',
  borderBottom: `1px solid ${palette.surface.line}`,
  background: 'none',
  textAlign: 'left' as const,
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
  const [invite, setInvite] = useState('');
  const me = useMyName();

  const create = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    void me.save();
    // You found it, with an Editor role to start, so inviting someone later
    // needs no setup first. Roles can be changed or added in People.
    onCreate({ name: trimmed, visibility, ...rolePresets.team });
    onClose();
  };

  const join = (event: FormEvent) => {
    event.preventDefault();
    if (!invite.trim()) return;
    void me.save();
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
          <NameField value={me.name} onChange={me.setName} />
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
    <Modal title="New group" onClose={onClose}>
      <form onSubmit={create} style={styles.form}>
        <input
          type="text"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Family, Book club, Trip…"
          style={styles.input}
          aria-label="Group name"
        />
        <p style={{ ...styles.errorHint, marginTop: 0 }}>It starts with a chat. You add people next.</p>

        <Choice
          label="Who can read it"
          value={visibility}
          onChange={setVisibility}
          options={[
            { value: 'private', label: 'Encrypted' },
            { value: 'public', label: 'Public' },
          ]}
        />

        <p style={styles.errorHint}>{describe(visibility)} This one can't be changed later.</p>

        <NameField value={me.name} onChange={me.setName} />

        <PrimaryButton type="submit" disabled={!name.trim()}>
          Create group
        </PrimaryButton>
        <LinkButton type="button" onClick={() => setMode('join')} style={{ alignSelf: 'center' }}>
          Have an invite link? Join instead
        </LinkButton>
      </form>
    </Modal>
  );
}
