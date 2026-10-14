import { useState, type FormEvent } from 'react';
import type { SpaceSummary, SpaceVisibility } from '@minca/core';
import type { NewSpace } from '@minca/core';
import { rolePresets } from '@minca/core';
import { Modal, Choice } from '@minca/app-shared/Modal';
import { Info } from '@minca/app-shared/Info';
import { Shape, markFor } from '@minca/app-shared/shapes';
import type { ShapeColour } from '@minca/app-shared/tokens';
import { useMyName } from '@minca/core/react';
import { NameField } from './NameField';
import { styles, palette } from '../styles';
import { useSpaceUnread } from '../seen';

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
    ? 'End-to-end encrypted. Only people you invite get the key, so nobody else can read it — not even the relay that passes it on.'
    : 'Not encrypted: anyone with the link can read it. Only people you invite can change it.';
}

export function SpaceList({
  spaces,
  loading,
  error,
  onOpen,
  onCreate,
  onJoin,
  onRemove,
}: {
  spaces: ReadonlyArray<SpaceSummary>;
  loading: boolean;
  error: string | null;
  onOpen: (space: SpaceSummary) => void;
  onCreate: (params: NewSpace) => void;
  onJoin: (invite: string) => void;
  onRemove: (spaceId: string) => void;
}) {
  const [dialog, setDialog] = useState<'new' | 'join' | null>(null);

  return (
    <>
      {loading && spaces.length === 0 && <p style={styles.emptyState}>Loading…</p>}

      {!(loading && spaces.length === 0) && (
        <div className="space-grid">
          {spaces.map((space) => (
            <div key={space.id} data-tile style={tile}>
              <button onClick={() => onOpen(space)} style={tileButton}>
                <SpaceMark space={space} />
                <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                  <span
                    style={{
                      ...styles.todoText,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {space.name}
                  </span>
                  <span style={{ ...styles.todoMeta, marginTop: 0 }}>
                    {spaceBadges(space)}
                    <NewIn space={space} />
                  </span>
                </span>
              </button>
              <button
                onClick={() => onRemove(space.id)}
                data-row-action
                data-variant="danger"
                style={{ ...styles.rowAction, position: 'absolute', top: 10, right: 10 }}
                title={`Forget ${space.name}`}
                aria-label={`Forget ${space.name}`}
              >
                ✕
              </button>
            </div>
          ))}

          <button onClick={() => setDialog('new')} data-tile-new style={newTile}>
            <span style={{ fontSize: 22, lineHeight: 1, fontWeight: 400 }}>+</span>
            <span>New space</span>
          </button>
        </div>
      )}

      <div style={{ ...styles.linkRow, marginTop: 12 }}>
        <button
          onClick={() => setDialog('join')}
          data-variant="ghost"
          style={{ ...styles.linkButton, paddingLeft: 0 }}
        >
          Have an invite? Join with a link
        </button>
      </div>

      {error && <p style={{ ...styles.error, marginTop: 10 }}>{error}</p>}

      {dialog && (
        <SpaceDialog initial={dialog} onClose={() => setDialog(null)} onCreate={onCreate} onJoin={onJoin} />
      )}
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

const tile = {
  position: 'relative' as const,
  borderRadius: palette.radius.lg,
  border: `1px solid ${palette.surface.line}`,
  background: palette.surface.card,
};
const tileButton = {
  width: '100%',
  minHeight: 132,
  display: 'flex',
  flexDirection: 'column' as const,
  justifyContent: 'space-between',
  alignItems: 'flex-start',
  gap: 16,
  padding: 16,
  border: 'none',
  borderRadius: palette.radius.lg,
  background: 'none',
  textAlign: 'left' as const,
};
const newTile = {
  minHeight: 134,
  display: 'flex',
  flexDirection: 'column' as const,
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  borderRadius: palette.radius.lg,
  border: `1px dashed ${palette.surface.lineStrong}`,
  background: 'none',
  color: palette.ink.muted,
  fontSize: 14,
  fontWeight: 500,
};

/** Making a space, or joining one from a link, in one dialog */
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
      <Modal title="Join a space" onClose={onClose}>
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
          <button type="submit" disabled={!invite.trim()} data-variant="primary" style={styles.button}>
            Join
          </button>
          <button
            type="button"
            onClick={() => setMode('new')}
            data-variant="ghost"
            style={{ ...styles.linkButton, alignSelf: 'center' }}
          >
            Make a new space instead
          </button>
        </form>
      </Modal>
    );
  }

  return (
    <Modal title="New space" onClose={onClose}>
      <form onSubmit={create} style={styles.form}>
        <input
          type="text"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Notes, Family, Trip…"
          style={styles.input}
          aria-label="Space name"
        />
        <p style={{ ...styles.errorHint, marginTop: 0 }}>Just for you, until you invite someone.</p>

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

        <button type="submit" disabled={!name.trim()} data-variant="primary" style={styles.button}>
          Create space
        </button>
        <button
          type="button"
          onClick={() => setMode('join')}
          data-variant="ghost"
          style={{ ...styles.linkButton, alignSelf: 'center' }}
        >
          Have an invite link? Join instead
        </button>
      </form>
    </Modal>
  );
}
