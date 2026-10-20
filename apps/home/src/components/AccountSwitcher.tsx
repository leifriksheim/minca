import { useCallback, useRef, useState } from 'react';
import { useAuth, useSession } from '@minca/core/react';
import { Avatar } from '@minca/app-shared/Avatar';
import { useDismiss } from '@minca/app-shared/useDismiss';
import { palette, styles } from '../styles';

const { ink, surface, radius } = palette;

/**
 * Who is signed in, and the other accounts this browser keeps: one click to
 * switch to another (it asks for its passkey or password), or to add one.
 * Switching signs this one out of this device first, as one account is open
 * here at a time; its apps keep working.
 */
export function AccountSwitcher() {
  const { auth, state } = useAuth();
  const session = useSession();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useDismiss(
    open,
    root,
    useCallback(() => setOpen(false), []),
  );
  const others = state.accounts.filter((account) => account.id !== session.account.id);

  const switchTo = async (accountId: string) => {
    setOpen(false);
    await auth.signOut();
    await auth.select(accountId);
  };
  const addAccount = async () => {
    setOpen(false);
    await auth.signOut();
    auth.showWelcome();
  };

  return (
    <div ref={root} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen((was) => !was)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`Account: ${session.account.name}`}
        data-variant="quiet"
        style={{
          ...styles.smallButton,
          display: 'inline-flex',
          alignItems: 'center',
          height: 40,
          padding: '0 14px 0 4px',
          gap: 8,
        }}
      >
        <Avatar did={session.did} size={30} />
        <span className="switcher-name">{session.account.name}</span>
      </button>
      {open && (
        <div role="menu" style={menu}>
          <div
            style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: 20 }}
          >
            <Avatar did={session.did} size={56} />
            <p style={{ fontFamily: palette.display, fontSize: 19, fontWeight: 700, color: ink.strong }}>
              Hi, {session.account.name}
            </p>
            <p style={{ fontSize: 12, color: ink.faint }}>Signed in here</p>
          </div>
          {others.length > 0 && (
            <div style={{ borderTop: `1px solid ${surface.line}`, padding: 6 }}>
              {others.map((account) => (
                <button
                  key={account.id}
                  role="menuitem"
                  onClick={() => void switchTo(account.id)}
                  disabled={state.busy}
                  style={item}
                  className="menu-item"
                >
                  <Avatar did={account.did} size={28} />
                  <span style={{ minWidth: 0, flex: 1, textAlign: 'left' }}>
                    <span style={{ display: 'block', fontWeight: 500, color: ink.strong }}>
                      {account.name}
                    </span>
                    <span style={{ display: 'block', fontSize: 12, color: ink.faint }}>Switch</span>
                  </span>
                </button>
              ))}
            </div>
          )}
          <div style={{ borderTop: `1px solid ${surface.line}`, padding: 6 }}>
            <button
              role="menuitem"
              onClick={() => void addAccount()}
              disabled={state.busy}
              style={item}
              className="menu-item"
            >
              <span style={plus} aria-hidden="true">
                +
              </span>
              Add another account
            </button>
            <button
              role="menuitem"
              onClick={() => {
                setOpen(false);
                void auth.signOut();
              }}
              disabled={state.busy}
              style={item}
              className="menu-item"
            >
              <span style={{ width: 28 }} aria-hidden="true" />
              Sign out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const menu = {
  ...styles.float,
  position: 'absolute',
  right: 0,
  top: 'calc(100% + 8px)',
  width: 300,
  maxWidth: 'calc(100vw - 32px)',
  zIndex: 20,
  overflow: 'hidden',
} as const;

const item = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  width: '100%',
  padding: '8px 10px',
  border: 'none',
  borderRadius: radius.md,
  background: 'transparent',
  fontSize: 14,
  color: ink.body,
} as const;

const plus = {
  width: 28,
  height: 28,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: radius.pill,
  border: `1px solid ${surface.rule}`,
  color: ink.strong,
  fontSize: 16,
} as const;
