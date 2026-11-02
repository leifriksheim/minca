import { useState, type FormEvent, type ReactNode } from 'react';
import { SPACE_KEEPERS, type SpaceSummary } from '@minca/core';
import { spaceProfile } from '@minca/core/schemas';
import { useCan, useNode } from '@minca/react';
import { useAction } from '@minca/app-shared/action';
import { useMay } from '@minca/app-shared/may';
import { AddBotDialog } from '@minca/app-shared/CommunitySetup';
import { FeatureIcon } from '@minca/app-shared/Feature';
import { useWorkspace } from '../workspace';
import { ConnectAgent } from './ConnectAgent';
import { HOOD, settingsPagesOf, type SpaceScreen } from './SpaceView';
import { cardText, cardTitle, rowButton, sectionHeading } from './rows';
import { Icon, type IconName } from './Icon';
import { palette, stack, styles, ui } from '../styles';
import { useSpaceFace } from '../pictures';
import { shrinkImage } from '../files';
import { SpaceMark } from './SpaceList';
import { LinkButton, PrimaryButton } from './Buttons';

/** A space's Settings: how it presents itself, its agents, where it is kept, what runs on its own, what is under the hood, and leaving */
export function SpaceSettings({ space, go, mayDefine }: Pick<SpaceScreen, 'space' | 'go' | 'mayDefine'>) {
  const { pairs, forget } = useWorkspace();
  const pair = pairs.has(space.id);
  const [addingBot, setAddingBot] = useState(false);
  const [connecting, setConnecting] = useState(false);
  // A bot runs where the space is kept online, so adding one is for whoever chooses that.
  const mayAddBot = useMay(space.id, SPACE_KEEPERS) && space.writable;
  // Writing its profile, or adding the collection for it where the space has none yet.
  const mayPresent = useCan(space.id, 'create', spaceProfile.name) || mayDefine;

  return (
    <div style={stack(32)}>
      {!pair && mayPresent && <GroupProfile space={space} />}

      <section aria-label="Agents" style={stack(12)}>
        <h2 style={sectionHeading}>Agents</h2>
        <ol className="rows" style={ui.list}>
          {mayAddBot && (
            <SettingsRow
              icon={<FeatureIcon kind="bot" size={36} />}
              title="Add a community bot"
              detail="Everyone here can mention it. It answers, sums up threads and posts reminders."
              onClick={() => setAddingBot(true)}
            />
          )}
          <SettingsRow
            icon={<FeatureIcon kind="online" size={36} />}
            title="Connect your own agent"
            detail="Claude, Cursor or another AI of yours, working here as you."
            onClick={() => setConnecting(true)}
          />
        </ol>
      </section>

      <section aria-label={pair ? 'Chat' : 'Group'} style={stack(12)}>
        <h2 style={sectionHeading}>{pair ? 'Chat' : 'Group'}</h2>
        <ol className="rows" style={ui.list}>
          {settingsPagesOf(pair).map((section) => (
            <SettingsRow
              key={section.to}
              icon={<LineIcon name={section.icon} />}
              title={section.label}
              onClick={() => go(section.to)}
            />
          ))}
          <li data-tile style={{ listStyle: 'none' }}>
            <button onClick={() => forget(space.id)} style={rowButton}>
              <span style={{ ...lineIcon, color: palette.accent.danger }}>
                <Icon name="arrowLeft" size={18} />
              </span>
              <strong style={{ ...cardTitle, color: palette.accent.danger }}>
                {pair ? 'Leave this chat' : 'Leave group'}
              </strong>
            </button>
          </li>
        </ol>
      </section>

      {/* The views for the curious: what the space holds and how it travels. */}
      <section aria-label="Under the hood" style={stack(12)}>
        <h2 style={sectionHeading}>Under the hood</h2>
        <ol className="rows" style={ui.list}>
          {HOOD.map((view) => (
            <SettingsRow
              key={view.id}
              icon={<LineIcon name={view.icon} />}
              title={view.label}
              onClick={() => go(view.to)}
            />
          ))}
        </ol>
      </section>

      {addingBot && (
        <AddBotDialog
          spaceId={space.id}
          writable={space.writable}
          onAutomations={() => {
            setAddingBot(false);
            go('/spaces/$spaceId/automations');
          }}
          onClose={() => setAddingBot(false)}
        />
      )}
      {connecting && <ConnectAgent onClose={() => setConnecting(false)} />}
    </div>
  );
}

/**
 * How the group presents itself (`std.space-profile`): its picture, the name shown in place of the one
 * it was founded with, and a line about it. Saving writes your version, the newest, so it is the one shown.
 */
function GroupProfile({ space }: { space: SpaceSummary }) {
  const node = useNode();
  const face = useSpaceFace(space.id);
  const [name, setName] = useState(face?.name ?? space.name);
  const [bio, setBio] = useState(face?.bio ?? '');
  const [picked, setPicked] = useState<{ file: File; url: string } | null>(null);
  const { run, busy, error } = useAction();
  const [saved, setSaved] = useState(false);

  const save = (event: FormEvent) => {
    event.preventDefault();
    setSaved(false);
    void run(async () => {
      const here = await node.collections.list(space.id);
      if (!here.some((c) => c.name === spaceProfile.name && c.version !== null))
        await node.collections.define(space.id, spaceProfile);
      const image = picked ? await shrinkImage(picked.file) : null;
      const avatar = image
        ? await node.records.addFile(space.id, image.bytes, { mime: image.mime })
        : face?.avatar;
      await node.records.put(space.id, spaceProfile, {
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(bio.trim() ? { bio: bio.trim() } : {}),
        ...(avatar ? { avatar } : {}),
      });
      setPicked(null);
      setSaved(true);
    });
  };

  return (
    <section aria-label="Group profile" style={stack(12)}>
      <h2 style={sectionHeading}>Profile</h2>
      <form onSubmit={save} style={{ ...styles.tile, ...stack(12), padding: 16 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 14, cursor: 'pointer' }}>
          {picked ? (
            <img
              src={picked.url}
              alt=""
              width={64}
              height={64}
              style={{ objectFit: 'cover', borderRadius: 16, flexShrink: 0 }}
            />
          ) : (
            <SpaceMark space={space} size={64} />
          )}
          <LinkButton type="button" style={{ pointerEvents: 'none', paddingLeft: 0 }}>
            {face?.avatar || picked ? 'Change picture' : 'Add a picture'}
          </LinkButton>
          <input
            type="file"
            accept="image/*"
            hidden
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              if (file) setPicked({ file, url: URL.createObjectURL(file) });
            }}
          />
        </label>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={100}
          placeholder="The group's name"
          aria-label="The group's name"
          style={styles.input}
        />
        <textarea
          value={bio}
          onChange={(event) => setBio(event.target.value)}
          maxLength={2000}
          rows={3}
          placeholder="What the group is about"
          aria-label="What the group is about"
          style={styles.textarea}
        />
        {error && <p style={styles.error}>{error}</p>}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 12 }}>
          {saved && !busy && <span style={styles.quiet}>Saved</span>}
          <PrimaryButton
            type="submit"
            disabled={busy || !name.trim()}
            style={{ width: 'auto', padding: '0 20px' }}
          >
            {busy ? 'Saving…' : 'Save'}
          </PrimaryButton>
        </div>
      </form>
    </section>
  );
}

/** A row that leads somewhere: its icon, what it is, a line on it, and the way there */
function SettingsRow({
  icon,
  title,
  detail,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  detail?: string;
  onClick: () => void;
}) {
  return (
    <li data-tile style={{ listStyle: 'none' }}>
      <button onClick={onClick} style={rowButton}>
        {icon}
        <span style={{ ...stack(2), flex: 1, minWidth: 0 }}>
          <strong style={cardTitle}>{title}</strong>
          {detail && <span style={cardText}>{detail}</span>}
        </span>
        <span style={{ display: 'inline-flex', color: palette.ink.faint }}>
          <Icon name="chevron" size={14} />
        </span>
      </button>
    </li>
  );
}

/** A line icon on the same tile an app's shape takes */
function LineIcon({ name }: { name: IconName }) {
  return (
    <span style={lineIcon}>
      <Icon name={name} size={18} />
    </span>
  );
}

const lineIcon = {
  width: 36,
  height: 36,
  flexShrink: 0,
  display: 'grid',
  placeItems: 'center',
  borderRadius: palette.radius.md,
  background: palette.surface.sunken,
  color: palette.ink.body,
} as const;
