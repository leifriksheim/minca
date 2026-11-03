import { useState, type ReactNode } from 'react';
import { useAccount, useAccountPicture, useConnection, useMyName } from '@minca/react';
import { accountHomeLink, popupFeatures } from '@minca/core/session';
import { Avatar } from '@minca/app-shared/Avatar';
import { ask } from '@minca/app-shared/Ask';
import { forgetPicture, rememberedPicture } from '@minca/app-shared/rememberedPictures';
import { usePopover } from './usePopover';
import { useCopy } from '@minca/app-shared/action';
import { useNavigate } from '@tanstack/react-router';
import { ConnectAgent } from './ConnectAgent';
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

  return (
    // The menu opens above your row at the foot of the rail.
    <div ref={root} className={styles.account}>
      <button
        onClick={() => setOpen((was) => !was)}
        aria-expanded={open}
        aria-label="Account"
        title={name}
        className={rail.item}
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
          />
        </menu>
      )}
      {connecting && <ConnectAgent onClose={() => setConnecting(false)} />}
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

/** What you can do as you: in the sidebar's menu, or under your profile on the home screen */
export function AccountActions({
  onDone,
  onConnectAgent,
}: {
  /** After something that leaves, like switching account */
  onDone?: () => void;
  onConnectAgent: () => void;
}) {
  const account = useAccount();
  const { connection, state } = useConnection();
  const navigate = useNavigate();

  const home = new URL(state.home).host;
  const others = state.accounts.filter((other) => other.did !== account.did);

  // Switching is moving the address: the tab acts for whichever account it names (`account-address.ts`).
  const switchTo = (did: string) => {
    onDone?.();
    void navigate({ to: '/', search: { as: shortAccount(did) } });
  };
  const removeAccount = async (other: { readonly did: string; readonly name: string }) => {
    const sure = await ask(
      `${other.name} stops using this app here. The account, and its other apps and devices, are not touched; you can add it again.`,
      { title: `Remove ${other.name} from this app?`, yes: 'Remove' },
    );
    if (!sure) return;
    await connection.disconnect(other.did);
    forgetPicture(other.did);
  };
  const openHome = () => {
    onDone?.();
    openAccountHome(state.home, account.did);
  };

  return (
    <>
      <Section>
        <Item onClick={openHome} hint="Security, devices, backups ↗">
          Account settings
        </Item>
        <Item onClick={onConnectAgent} hint="Claude, ChatGPT, Cursor">
          Connect an agent
        </Item>
        <small>
          An agent in this browser works as you, with nothing to set up. Claude or another AI app connects
          here, and keeps working with this tab closed.
        </small>
      </Section>

      <Section>
        {others.map((other) => (
          <div key={other.did} className="row">
            <button role="menuitem" onClick={() => switchTo(other.did)} className={`${styles.item} truncate`}>
              <Avatar did={other.did} size={24} round src={rememberedPicture(other.did)} />
              <span className="truncate">{other.name}</span>
            </button>
            {/* Takes the account off this app only; it and its other apps carry on. */}
            <button
              onClick={() => void removeAccount(other)}
              aria-label={`Remove ${other.name} from this app`}
              title={`Remove ${other.name} from this app`}
              data-intent="ghost"
              data-icon
            >
              ×
            </button>
          </div>
        ))}
        <Item onClick={() => void connection.connect()} hint={home}>
          Add another account
        </Item>
        {state.error && <small role="alert">{state.error}</small>}
      </Section>

      <Section>
        <Item onClick={() => void connection.disconnect()} hint="Your account stays as it is">
          Log out{others.length > 0 ? ` of ${account.name}` : ''}
        </Item>
      </Section>
    </>
  );
}

/**
 * The account home, in a window of its own: it holds the account's keys, so it is never framed. The
 * home may be signed in to another account, so the link says which one this app acts for.
 */
export function openAccountHome(home: string, did: string) {
  globalThis.open(accountHomeLink(home, did), 'minca-account', popupFeatures(720, 820));
}

/** A group of the menu's rows, under a line */
function Section({ children }: { children: ReactNode }) {
  return <li className={styles.section}>{children}</li>;
}

/** One row of the menu: a label, and optionally a quieter line on the right */
function Item({ children, hint, onClick }: { children: ReactNode; hint?: string; onClick: () => void }) {
  return (
    <button role="menuitem" onClick={onClick} className={styles.item}>
      <span>{children}</span>
      {hint && <small className="truncate">{hint}</small>}
    </button>
  );
}
