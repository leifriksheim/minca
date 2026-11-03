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
import { Icon, type IconName } from '@minca/app-shared/Icon';
import { useSpaceFace } from '../pictures';
import { shrinkImage } from '../files';
import { SpaceMark } from './SpaceList';
import list from './SpaceList.module.css';
import marks from './InvitePeople.module.css';

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
    <>
      {!pair && mayPresent && <GroupProfile space={space} />}

      <section aria-label="Agents">
        <h2>Agents</h2>
        <ol role="list">
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

      <section aria-label={pair ? 'Chat' : 'Group'}>
        <h2>{pair ? 'Chat' : 'Group'}</h2>
        <ol role="list">
          {settingsPagesOf(pair).map((section) => (
            <SettingsRow
              key={section.to}
              icon={<LineIcon name={section.icon} />}
              title={section.label}
              onClick={() => go(section.to)}
            />
          ))}
          <li>
            <button data-intent="open" onClick={() => forget(space.id)} className="row" data-tone="danger">
              <LineIcon name="arrowLeft" />
              {pair ? 'Leave this chat' : 'Leave group'}
            </button>
          </li>
        </ol>
      </section>

      {/* The views for the curious: what the space holds and how it travels. */}
      <section aria-label="Under the hood">
        <h2>Under the hood</h2>
        <ol role="list">
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
    </>
  );
}

/**
 * How the group presents itself (`std.space-profile`): its picture, the name shown in place of the one
 * it was founded with, and a line about it. One record per group, which saving writes or edits.
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
      const body = {
        space: space.id,
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(bio.trim() ? { bio: bio.trim() } : {}),
        ...(avatar ? { avatar } : {}),
      };
      // One record per space: the first writes it, everyone after edits it.
      const key = await node.records.onePerKey(space.id, spaceProfile.name, body);
      if (key && (await node.records.get(space.id, key))) await node.records.update(space.id, key, body);
      else await node.records.put(space.id, spaceProfile, body);
      setPicked(null);
      setSaved(true);
    });
  };

  return (
    <section aria-label="Group profile">
      <h2>Profile</h2>
      <article>
        <form onSubmit={save} className="stack">
          <label className="row">
            {picked ? (
              <img src={picked.url} alt="" width={64} height={64} className={list.picture} />
            ) : (
              <SpaceMark space={space} size={64} />
            )}
            <span>{face?.avatar || picked ? 'Change picture' : 'Add a picture'}</span>
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
          />
          <textarea
            value={bio}
            onChange={(event) => setBio(event.target.value)}
            maxLength={2000}
            rows={3}
            placeholder="What the group is about"
            aria-label="What the group is about"
          />
          {error && <p role="alert">{error}</p>}
          <div className="row">
            {saved && !busy && <small>Saved</small>}
            <button data-intent="primary" type="submit" disabled={busy || !name.trim()}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      </article>
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
    <li>
      <button data-intent="open" onClick={onClick} className="row">
        {icon}
        <span className="stack truncate" data-gap="tight">
          <strong>{title}</strong>
          {detail && <small>{detail}</small>}
        </span>
        <Icon name="chevron" size={14} />
      </button>
    </li>
  );
}

/** A line icon on the same tile an app's shape takes */
function LineIcon({ name }: { name: IconName }) {
  return (
    <span className={marks.mark}>
      <Icon name={name} size={18} />
    </span>
  );
}
