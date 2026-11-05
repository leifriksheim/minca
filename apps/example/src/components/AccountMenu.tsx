import { useState, type ReactNode } from 'react';
import { useAccount, useAccountPicture, useConnection, useMyName } from '@minca/react';
import { Avatar } from '@minca/app-shared/Avatar';
import { ask } from '@minca/app-shared/Ask';
import { forgetPicture } from '@minca/app-shared/rememberedPictures';
import { usePopover } from './usePopover';
import { useCopy } from '@minca/app-shared/action';
import { useNavigate } from '@tanstack/react-router';
import { ConnectAgent } from './ConnectAgent';
import { DownloadsView } from './DownloadsView';
import { useDownloads } from '../downloads';
import { shortAccount } from '../account-address';
import styles from './AccountMenu.module.css';
import rail from './SpaceView.module.css';

/**
 * Who this app acts for, and its menu, at the foot of a space's rail; the account itself lives
 * in the account home. The home screen has the same as a page of its own (`ProfilePage.tsx`).
 */
export function AccountMenu() {
  const account = useAccount();
  const picture = useAccountPicture();
  // The name as the account has it now, so one changed in Profile shows here too
  const { name } = useMyName();
  const navigate = useNavigate();
  const { open, setOpen, close, root } = usePopover();
  const [connecting, setConnecting] = useState(false);
  const [downloading, setDownloading] = useState(false);

  return (
    // The menu opens above your row at the foot of the rail.
    <div ref={root} className={styles.account}>
      <button
        onClick={() => setOpen((was) => !was)}
        aria-expanded={open}
        aria-label="Account"
        title={name}
        data-intent="ghost"
        className={`row ${rail.item}`}
      >
        <Avatar did={account.did} size={32} round src={picture} />
        <strong className="truncate">{name}</strong>
      </button>

      {open && (
        <menu role="menu" className={styles.menu}>
          <MenuHeader picture={picture} />
          {/* Your picture, name and username are changed in one place: Profile. */}
          <Section>
            <Item
              onClick={() => {
                close();
                void navigate({ to: '/profile' });
              }}
              hint="Picture, name, username"
            >
              Edit profile
            </Item>
          </Section>
          <AccountActions
            onDone={close}
            onConnectAgent={() => {
              close();
              setConnecting(true);
            }}
            onDownloads={() => {
              close();
              setDownloading(true);
            }}
          />
        </menu>
      )}
      {connecting && <ConnectAgent onClose={() => setConnecting(false)} />}
      {downloading && <DownloadsView onClose={() => setDownloading(false)} />}
    </div>
  );
}

/** The sidebar menu's top: who you are, and your key's id to copy */
function MenuHeader({ picture }: { picture: string | null }) {
  const account = useAccount();
  const { name } = useMyName();
  const { copied, copy } = useCopy();
  const shortDid = `${account.did.slice(8, 16)}…${account.did.slice(-6)}`;
  return (
    <li className="row">
      <Avatar did={account.did} size={36} round src={picture} />
      <div className="stack truncate" data-gap="tight">
        <strong className="truncate">{name}</strong>
        <small>
          <button
            data-intent="inline"
            onClick={() => copy(account.did)}
            title={`${account.did} — click to copy`}
          >
            {copied ? 'Copied' : shortDid}
          </button>
        </small>
      </div>
    </li>
  );
}

/**
 * The accounts this app acts for, and moving between them: switching to another, removing one from
 * the app, adding one, logging out. The sidebar's menu and Profile both use it.
 */
export function useAccounts(onDone?: () => void) {
  const account = useAccount();
  const { connection, state } = useConnection();
  const navigate = useNavigate();
  const others = state.accounts.filter((other) => other.did !== account.did);

  return {
    others,
    /** The account home's address, where another account is added from */
    home: new URL(state.home).host,
    error: state.error,
    // Switching is moving the address: the tab acts for whichever account it names (`account-address.ts`).
    switchTo: (did: string) => {
      onDone?.();
      void navigate({ to: '/', search: { as: shortAccount(did) } });
    },
    remove: async (other: { readonly did: string; readonly name: string }) => {
      const sure = await ask(
        `${other.name} stops using this app here. The account, and its other apps and devices, are not touched; you can add it again.`,
        { title: `Remove ${other.name} from this app?`, yes: 'Remove' },
      );
      if (!sure) return;
      await connection.disconnect(other.did);
      forgetPicture(other.did);
    },
    add: () => void connection.connect(),
    logOut: () => void connection.disconnect(),
    openHome: () => {
      onDone?.();
      connection.openHome();
    },
  };
}

/** What you can do as you, in the sidebar's menu */
function AccountActions({
  onDone,
  onConnectAgent,
  onDownloads,
}: {
  /** After something that leaves, like switching account */
  onDone?: () => void;
  onConnectAgent: () => void;
  onDownloads: () => void;
}) {
  const account = useAccount();
  const accounts = useAccounts(onDone);
  const { others } = accounts;
  const [downloads] = useDownloads();

  return (
    <>
      <Section>
        <Item onClick={accounts.openHome} hint="Security, devices, backups ↗">
          Account settings
        </Item>
        <Item onClick={onConnectAgent} hint="Claude, ChatGPT, Cursor">
          Connect an agent
        </Item>
        <Item onClick={onDownloads} hint={DOWNLOADS[downloads.ahead]}>
          Downloads
        </Item>
      </Section>

      <Section>
        {others.map((other) => (
          <div key={other.did} className="row">
            <button
              role="menuitem"
              data-intent="ghost"
              onClick={() => accounts.switchTo(other.did)}
              className={`row ${styles.item} truncate`}
            >
              <Avatar did={other.did} size={24} round />
              <span className="truncate">{other.name}</span>
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
          </div>
        ))}
        <Item onClick={accounts.add} hint={accounts.home}>
          Add another account
        </Item>
        {accounts.error && <small role="alert">{accounts.error}</small>}
      </Section>

      <Section>
        <Item onClick={accounts.logOut} hint="Your account stays as it is">
          Log out{others.length > 0 ? ` of ${account.name}` : ''}
        </Item>
      </Section>
    </>
  );
}

/** What this device downloads before a file is opened, in a word or two */
export const DOWNLOADS = {
  thumbnails: 'Thumbnails first',
  photos: 'Photos ahead',
  everything: 'Everything ahead',
} as const;

/** A group of the menu's rows, under a line */
function Section({ children }: { children: ReactNode }) {
  return <li className={styles.section}>{children}</li>;
}

/** One row of the menu: a label, and optionally a quieter line on the right */
function Item({ children, hint, onClick }: { children: ReactNode; hint?: string; onClick: () => void }) {
  return (
    <button role="menuitem" data-intent="ghost" onClick={onClick} className={`row ${styles.item}`}>
      <span>{children}</span>
      {hint && <small className="truncate">{hint}</small>}
    </button>
  );
}
