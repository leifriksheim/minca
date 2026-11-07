import { useCallback, useRef, useState } from 'react';
import { Link, Outlet } from '@tanstack/react-router';
import {
  useAccount,
  useAccountPicture,
  useAsync,
  useConnection,
  useMyName,
  useNode,
  useObjectUrl,
} from '@minca/react';
import type { HostingView } from '@minca/core';
import { message, useCopy } from '@minca/app-shared/action';
import { HostRoom, HostStatusRow, accountStanding, useAskAgain } from '@minca/app-shared/HostOffer';
import { Icon } from '@minca/app-shared/Icon';
import { forgetPicture } from '@minca/app-shared/rememberedPictures';
import { Avatar } from '@minca/app-shared/Avatar';
import { FeatureIcon } from '@minca/app-shared/Feature';
import { shortUsername } from '@minca/app-shared/usernames';
import { shrinkImage } from '@minca/app-shared/images';
import { ThemePicker } from '@minca/app-shared/theme';
import { DOWNLOADS, useAccounts } from './AccountMenu';
import { ConnectAgent } from './ConnectAgent';
import { DownloadsView } from './DownloadsView';
import { LineIcon, SettingsRow } from './SettingsRow';
import { useDownloads } from '../downloads';
import tabs from '../App.module.css';
import styles from './ProfilePage.module.css';

/**
 * You: how others see you at `/profile`, and how this app works for you at `/settings`, under one
 * header the way the home screen's tabs are. What guards the account itself, its keys, devices and
 * backups, stays in the account home.
 */
export function ProfileLayout() {
  return (
    <>
      <header>
        <nav aria-label="You" className={tabs.tabs}>
          <Link to="/profile">Profile</Link>
          <Link to="/settings">Settings</Link>
        </nav>
      </header>
      <Outlet />
    </>
  );
}

/** How others see you, and the accounts this app acts for */
export function ProfilePage() {
  return (
    <>
      <section aria-label="Your profile">
        <article className="stack" data-gap="loose">
          <Picture />
          <NameField />
          <Username />
        </article>
        <YourId />
      </section>
      <Accounts />
    </>
  );
}

/** How this app works for you: its look, downloads, agents, and the account's hosting and security */
export function SettingsPage() {
  const { connection } = useConnection();
  const [downloads] = useDownloads();
  const [connecting, setConnecting] = useState(false);
  const [downloading, setDownloading] = useState(false);

  return (
    <>
      <section aria-label="This app">
        <h2>This app</h2>
        <ol role="list">
          <li className="row">
            <LineIcon name="screen" />
            <span className="stack" data-gap="tight">
              <strong>Theme</strong>
              <small>On every device you use</small>
            </span>
            <ThemePicker />
          </li>
          <SettingsRow
            icon={<LineIcon name="download" />}
            title="Downloads"
            detail={`${DOWNLOADS[downloads.ahead]}, ${size(downloads.keep)} a space`}
            onClick={() => setDownloading(true)}
          />
        </ol>
      </section>

      <section aria-label="Account">
        <h2>Account</h2>
        <ol role="list">
          <AlwaysOnline />
          <SettingsRow
            icon={<FeatureIcon kind="online" size={36} />}
            title="Connect an agent"
            detail="Claude, ChatGPT or Cursor, as you"
            onClick={() => setConnecting(true)}
          />
          <SettingsRow
            icon={<LineIcon name="shield" />}
            title="Security and devices"
            detail="Keys, devices and backups"
            onClick={() => connection.openHome()}
            away
          />
        </ol>
      </section>

      {connecting && <ConnectAgent onClose={() => setConnecting(false)} />}
      {downloading && <DownloadsView onClose={() => setDownloading(false)} />}
    </>
  );
}

/**
 * The hosts keeping the account's spaces online, how each stands and how much
 * room it uses. Choosing and paying stay in the account home, which each row opens.
 */
function AlwaysOnline() {
  const node = useNode();
  const { connection } = useConnection();
  const [hosts, setHosts] = useState<ReadonlyArray<HostingView> | null>(null);
  // Each host's own trouble comes back in its view; a list that fails shows nothing rather than an offer.
  const load = useCallback(() => node.hosting.list().then(setHosts, () => {}), [node]);
  useAskAgain(load);
  const open = () => connection.openHome('hosting');
  if (hosts === null) return null;
  if (hosts.length === 0)
    return (
      <SettingsRow
        icon={<FeatureIcon kind="online" size={36} />}
        title="Keep your spaces online"
        detail="Reachable when all your devices are off"
        onClick={open}
        away
      />
    );
  return hosts.map((host) => {
    const state = accountStanding(host);
    return (
      <li key={host.url} className="stack" data-gap="tight">
        <button data-intent="open" onClick={open} className="row">
          <HostStatusRow size={36} name={host.name} pill={state} line={state.line}>
            <Icon name="external" size={14} />
          </HostStatusRow>
        </button>
        <HostRoom host={host} />
      </li>
    );
  });
}

/** Megabytes, as a person reads them */
const size = (megabytes: string): string => {
  const mb = Number(megabytes);
  return mb >= 1024 ? `${mb / 1024} GB` : `${mb} MB`;
};

/** Your picture, beside the buttons that change or remove it */
function Picture() {
  const account = useAccount();
  const { name } = useMyName();
  const { picture, choose, remove, picker, problem } = usePicture(name);
  return (
    <div className={`row ${styles.picture}`}>
      <button onClick={choose} aria-label={picture ? 'Change picture' : 'Add a picture'}>
        <Avatar did={account.did} size={80} round src={picture} />
      </button>
      <div className="stack" data-gap="tight">
        <div className="row" data-gap="tight">
          <button onClick={choose}>{picture ? 'Change picture' : 'Add a picture'}</button>
          {picture && (
            <button data-intent="ghost" onClick={remove}>
              Remove
            </button>
          )}
        </div>
        <small>Everyone in your spaces sees it.</small>
      </div>
      {picker}
      {problem && <p role="alert">{problem}</p>}
    </div>
  );
}

/** Your name as others see it, kept when you leave the field */
function NameField() {
  const me = useMyName();
  return (
    <label>
      Name
      <input
        value={me.name}
        onChange={(event) => me.setName(event.target.value)}
        onBlur={() => void me.save()}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
        }}
        maxLength={200}
      />
    </label>
  );
}

/** The username people find you by, picked and changed in the account home */
function Username() {
  const node = useNode();
  const { connection } = useConnection();
  const found = useAsync(() => node.inbox.get(), [node]);
  if (found.status !== 'done') return null;
  const username = found.value?.username;
  const open = () => connection.openHome();
  return (
    <div className="stack" data-gap="tight">
      <span className={styles.label}>Username</span>
      <div className="row" data-spread>
        {username ? (
          <strong>@{shortUsername(username)}</strong>
        ) : (
          <small>None yet. With one, people can find you by it.</small>
        )}
        <button data-intent="ghost" onClick={open}>
          {username ? 'Change' : 'Pick a username'}
        </button>
      </div>
    </div>
  );
}

/** Your account's id, quietly under the card, to copy */
function YourId() {
  const { did } = useAccount();
  const { copied, copy } = useCopy();
  return (
    <small className={`row ${styles.id}`}>
      <span className="truncate" title={did}>
        Your ID {did.slice(8, 16)}…{did.slice(-6)}
      </span>
      <button data-intent="inline" onClick={() => copy(did)}>
        {copied ? 'Copied' : 'Copy'}
      </button>
    </small>
  );
}

/** The accounts this app acts for: you, the others to switch to, adding one, and logging out */
function Accounts() {
  const account = useAccount();
  const picture = useAccountPicture();
  const { name } = useMyName();
  const accounts = useAccounts();
  const { others } = accounts;

  return (
    <section aria-label="Accounts">
      <h2>Accounts</h2>
      <ol role="list">
        <li className="row">
          <Avatar did={account.did} size={36} round src={picture} />
          <strong className="truncate">{name}</strong>
          <span className="tag">Using now</span>
        </li>
        {others.map((other) => (
          <li key={other.did} className="row">
            <button data-intent="open" onClick={() => accounts.switchTo(other.did)} className="row truncate">
              <Avatar did={other.did} size={36} round />
              <strong className="truncate">{other.name}</strong>
            </button>
            {/* Takes the account off this app only; it and its other apps carry on. */}
            <button
              onClick={() => void accounts.remove(other)}
              aria-label={`Remove ${other.name} from this app`}
              title={`Remove ${other.name} from this app`}
              data-intent="ghost"
              data-icon
            >
              ×
            </button>
          </li>
        ))}
        <SettingsRow
          icon={<LineIcon name="plus" />}
          title="Add another account"
          detail={accounts.home}
          onClick={accounts.add}
        />
        <li>
          <button data-intent="open" onClick={accounts.logOut} className="row" data-tone="danger">
            <LineIcon name="arrowLeft" />
            {others.length > 0 ? `Log out of ${name}` : 'Log out'}
          </button>
        </li>
      </ol>
      {accounts.error && <small role="alert">{accounts.error}</small>}
    </section>
  );
}

/**
 * The account's picture, chosen from a file and made small before it is kept, or taken away. Kept in
 * the account registry, so every device and every space the account opens has it (`account.setAvatar`).
 */
function usePicture(name: string) {
  const node = useNode();
  const { did } = useAccount();
  const kept = useAccountPicture();
  // What was just chosen, or removed, shows at once, before the account says it changed.
  const [chosen, setChosen] = useState<{ bytes: Uint8Array; mime: string } | 'none' | null>(null);
  const chosenUrl = useObjectUrl(chosen === 'none' ? null : chosen);
  const [problem, setProblem] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const keep = async (image: { bytes: Uint8Array; mime: string } | null) => {
    setProblem(null);
    try {
      await node.account.setAvatar(image, { name });
      setChosen(image ?? 'none');
      // A picture taken away is not shown in a list of accounts either.
      if (!image) forgetPicture(did);
    } catch (error) {
      const noKey = /account key|registry/i.test(message(error));
      setProblem(
        noKey ? 'This app can’t change your picture. Change it in account settings.' : message(error),
      );
    }
  };

  const picker = (
    <input
      ref={input}
      type="file"
      accept="image/*"
      hidden
      onChange={(event) => {
        const file = event.target.files?.[0];
        if (file) void shrinkImage(file, 256).then(keep, (error: unknown) => setProblem(message(error)));
        event.target.value = '';
      }}
    />
  );

  return {
    picture: chosen === 'none' ? null : (chosenUrl ?? kept),
    problem,
    choose: () => input.current?.click(),
    remove: () => void keep(null),
    picker,
  };
}
