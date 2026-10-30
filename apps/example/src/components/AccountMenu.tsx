import { useState, type ReactNode } from 'react';
import { useAccount, useAccountPicture, useConnection, useMyName } from '@minca/react';
import { accountHomeLink } from '@minca/core/session';
import { Avatar } from '@minca/app-shared/Avatar';
import { usePopover } from './usePopover';
import { useCopy } from '@minca/app-shared/action';
import { useNavigate } from '@tanstack/react-router';
import { ConnectAgent } from './ConnectAgent';
import { shortAccount } from '../account-address';
import { palette, styles, ui, hstack } from '../styles';

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
    // The menu hangs from the foot of the rail it sits in, as the bell's panel does.
    <div ref={root}>
      <button
        onClick={() => setOpen((was) => !was)}
        aria-expanded={open}
        aria-label="Account"
        title={name}
        className="you-button"
      >
        <Avatar did={account.did} size={32} round src={picture} />
      </button>

      {open && (
        <div role="menu" style={menu}>
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
        </div>
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
    <div style={{ padding: '14px 14px 12px', ...hstack(10), alignItems: 'center' }}>
      <Avatar did={account.did} size={36} round src={picture} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ ...ui.ellipsis, fontWeight: 600, fontSize: 14, color: palette.ink.strong }}>{name}</div>
        <button onClick={() => copy(account.did)} title={`${account.did} — click to copy`} style={didButton}>
          {copied ? 'Copied' : shortDid}
        </button>
      </div>
    </div>
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
        <Item onClick={onConnectAgent} hint="Claude Code, Desktop, Cursor">
          Connect an agent
        </Item>
        <Note faint>
          An agent in this browser works as you, with nothing to set up. One on your computer connects here,
          and keeps working with this tab closed.
        </Note>
      </Section>

      <Section>
        {others.map((other) => (
          <button
            key={other.did}
            role="menuitem"
            onClick={() => switchTo(other.did)}
            data-menu-item
            style={{ ...item, justifyContent: 'flex-start', height: 40 }}
          >
            <Avatar did={other.did} size={24} round />
            <span style={{ ...ui.ellipsis, flex: 1, textAlign: 'left' }}>{other.name}</span>
          </button>
        ))}
        <Item onClick={() => void connection.connect()} hint={home}>
          Add another account
        </Item>
        {state.error && <Note>{state.error}</Note>}
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
  globalThis.open(accountHomeLink(home, did), 'minca-account', 'popup,width=720,height=820');
}

/** A group of the menu's rows, under a line */
function Section({ children }: { children: ReactNode }) {
  return (
    <>
      <div style={{ height: 1, background: palette.surface.line }} />
      <div style={{ padding: 6 }}>{children}</div>
    </>
  );
}

/** One row of the menu: a label, and optionally a quieter line on the right */
function Item({ children, hint, onClick }: { children: ReactNode; hint?: string; onClick: () => void }) {
  return (
    <button role="menuitem" onClick={onClick} data-menu-item style={item}>
      <span style={{ whiteSpace: 'nowrap', flexShrink: 0 }}>{children}</span>
      {hint && <span style={{ ...ui.ellipsis, color: palette.ink.faint, fontSize: 12 }}>{hint}</span>}
    </button>
  );
}

function Note({ children, faint = false }: { children: ReactNode; faint?: boolean }) {
  const color = faint ? palette.ink.faint : palette.ink.muted;
  return <p style={{ margin: '4px 10px 6px', fontSize: 12, lineHeight: 1.45, color }}>{children}</p>;
}

const menu = {
  position: 'absolute' as const,
  left: 0,
  bottom: 'calc(100% + 8px)',
  zIndex: 20,
  width: 280,
  ...styles.float,
  animation: 'minca-fade .1s ease',
  overflow: 'hidden',
};

const didButton = {
  border: 'none',
  background: 'none',
  padding: 0,
  marginTop: 2,
  fontFamily: palette.mono,
  fontSize: 11.5,
  color: palette.ink.faint,
};

const item = {
  width: '100%',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  height: 36,
  padding: '0 10px',
  border: 'none',
  borderRadius: palette.radius.md,
  background: 'none',
  color: palette.ink.body,
  fontSize: 14,
  textAlign: 'left' as const,
};
