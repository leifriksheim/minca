import { useState, type FormEvent } from 'react';
import type { SpaceSummary, SpaceVisibility } from '@minca/core';
import type { NewSpace } from '@minca/core';
import { rolePresets } from '@minca/core';
import { Modal } from '@minca/app-shared/Modal';
import { Info } from '@minca/app-shared/Info';
import { Shape } from '@minca/app-shared/shapes';
import { markFor } from '@minca/ui/shapes';
import type { ShapeColour } from '@minca/ui/tokens';
import { Loader } from '@minca/app-shared/Loader';
import { useAccess, useAccount, useSpaceStatus } from '@minca/react';
import { onlineAccounts } from '../derive/network';
import { PersonFace } from './PersonFace';
import { useSpaceUnread } from '../seen';
import { useSpaceFace } from '../pictures';
import { useFileUrl } from '../files';
import { Count } from './apps/AppIcon';
import { Options, type Option } from './Options';
import styles from './SpaceList.module.css';
import steps from './ConnectScreen.module.css';

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
  // The picture the space's own profile gives it, when it has one.
  const avatar = useSpaceFace(space.id)?.avatar;
  const picture = useFileUrl(space.id, avatar);
  const shape = markFor(space.id);
  if (picture) return <img src={picture} alt="" width={size} height={size} className={styles.picture} />;
  const letter = [...space.name.trim()][0]?.toUpperCase() ?? '·';
  return (
    <span
      aria-hidden
      className={styles.mark}
      data-light={LIGHT.has(shape.colour) || undefined}
      // eslint-disable-next-line react/forbid-dom-props -- the letter scales with the mark's size
      style={{ fontSize: size }}
    >
      <Shape {...shape} size={size} />
      <span>{letter}</span>
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
    title: 'Friends or team',
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
}: {
  spaces: ReadonlyArray<SpaceSummary>;
  loading: boolean;
  error: string | null;
  onOpen: (space: SpaceSummary) => void;
  /** Make a group, from the empty list */
  onNew: () => void;
}) {
  return (
    <>
      {loading && spaces.length === 0 ? (
        <p className="empty">
          <Loader label="Opening your groups" showLabel />
        </p>
      ) : spaces.length === 0 ? (
        <div className="empty">
          <strong>No groups yet</strong>
          <p>A group starts as a chat. Add people, then any app it needs: a board, a poll, a list.</p>
          <button data-intent="primary" onClick={onNew}>
            New group
          </button>
        </div>
      ) : (
        <ul role="list">
          {spaces.map((space) => (
            <GroupRow key={space.id} space={space} detail={spaceBadges(space)} onOpen={() => onOpen(space)} />
          ))}
        </ul>
      )}

      {error && <p role="alert">{error}</p>}
    </>
  );
}

/** A group in a list: its mark, its name, a line under it, and what is new in it */
export function GroupRow({
  space,
  detail,
  onOpen,
}: {
  space: SpaceSummary;
  detail: string;
  onOpen: () => void;
}) {
  return (
    <li>
      <button data-intent="open" onClick={onOpen} className="row">
        <SpaceMark space={space} size={44} />
        <span className="stack truncate" data-gap="tight">
          <strong className="truncate">{space.name}</strong>
          <small className="truncate">{detail}</small>
        </span>
        <MemberFaces space={space} />
        <SpaceCount space={space} />
      </button>
    </li>
  );
}

/** How many faces a group row shows before the rest become "+N" */
const FACES = 4;

/**
 * Who else is in a group, at a glance: a few faces overlapping, those online
 * first with a dot, and how many more. The full list is under Members.
 */
function MemberFaces({ space }: { space: SpaceSummary }) {
  const me = useAccount().did;
  const access = useAccess(space.id);
  const status = useSpaceStatus(space.id);
  const online = status ? onlineAccounts(status, me) : new Set<string>();
  const others = (access?.members ?? [])
    .map((member) => member.did)
    .filter((did) => did !== me)
    .sort((a, b) => Number(online.has(b)) - Number(online.has(a)));
  if (others.length === 0) return null;
  const rest = others.length - FACES;
  return (
    <span className={styles.faces} aria-label={`${others.length + 1} members`}>
      {others.slice(0, FACES).map((did) => (
        <span key={did} className={styles.face}>
          <PersonFace did={did} size={24} round />
          {online.has(did) && <span title="Online now" className={styles.online} />}
        </span>
      ))}
      {rest > 0 && <span className={styles.more}>+{rest}</span>}
    </span>
  );
}

/**
 * What arrived in a space since you last looked, across its apps, as an app shows it: red with an @
 * when some of it names you (a mention, a reply), grey when it is only new
 */
export function SpaceCount({ space }: { space: SpaceSummary }) {
  return <Count unread={useSpaceUnread(space)} />;
}

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
  const [run, setRun] = useState<Run>('friends');
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
    const preset = RUNS.find((option) => option.value === run)?.preset ?? 'team';
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
        <form onSubmit={join} className="stack">
          <input
            type="text"
            value={invite}
            onChange={(event) => setInvite(event.target.value)}
            placeholder="Paste an invite link"
            spellCheck={false}
            aria-label="Invite link"
          />
          <small>
            Paste a link someone shared with you.
            <Info label="What an invite link carries">
              The space itself and, for a private one, the key that opens it — in the part after the{' '}
              <code>#</code>, which browsers never send to a server. So it reaches you without passing through
              whatever is hosting the page.
            </Info>
          </small>
          <button data-intent="primary" type="submit" disabled={!invite.trim()}>
            Join
          </button>
          <button data-intent="ghost" type="button" onClick={() => setMode('new')}>
            Make a new group instead
          </button>
        </form>
      </Modal>
    );
  }

  return (
    <Modal
      title={step === 'name' ? 'New group' : step === 'run' ? 'How is it run?' : 'Who can read it?'}
      onClose={onClose}
    >
      <form onSubmit={next} className="stack">
        {step === 'name' && (
          <>
            <input
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Family, Book club, Trip…"
              aria-label="Group name"
              autoFocus
            />
            <small>It starts with a chat. You add people after.</small>
          </>
        )}
        {step === 'run' && (
          <>
            <Options label="How it's run" options={RUNS} picked={run} onPick={setRun} />
            <small>Roles can be changed later, under Roles.</small>
          </>
        )}
        {step === 'read' && (
          <>
            <Options label="Who can read it" options={READS} picked={visibility} onPick={setVisibility} />
            <small>This one can't be changed later.</small>
          </>
        )}

        <div className="row">
          {step === 'name' ? (
            <button data-intent="ghost" type="button" onClick={() => setMode('join')}>
              Have an invite link?
            </button>
          ) : (
            <button data-intent="ghost" type="button" onClick={back}>
              Back
            </button>
          )}
          {/* Where in the steps you are: a dot for each, the one you're on longer */}
          <span className={steps.dots} aria-hidden>
            {STEPS.map((one) => (
              <span key={one} aria-current={one === step ? 'step' : undefined} />
            ))}
          </span>
          <button data-intent="primary" type="submit" disabled={!name.trim()}>
            {step === 'read' ? 'Create group' : 'Next'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
