import { useCallback, useRef, useState } from 'react';
import { useAuth, useSession } from '@minca/react';
import { Avatar } from '@minca/app-shared/Avatar';
import { useDismiss } from '@minca/app-shared/useDismiss';
import { useCopy } from '@minca/app-shared/action';
import { palette, styles } from '../styles';
import { useAccountPicture } from '../picture';

const { ink, surface, radius } = palette;

/**
 * Who is signed in, to rename or copy the ID of, and the other accounts this
 * browser keeps: one click to
 * switch to another (it asks for its passkey or password), or to add one.
 * Switching signs this one out of this device first, as one account is open
 * here at a time; its apps keep working.
 */
export function AccountSwitcher() {
  const { auth, state } = useAuth();
  const session = useSession();
  const picture = useAccountPicture();
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState('');
  const { copied, copy } = useCopy();
  const root = useRef<HTMLDivElement>(null);
  useDismiss(
    open,
    root,
    useCallback(() => {
      setOpen(false);
      setRenaming(false);
    }, []),
  );
  const others = state.accounts.filter((account) => account.id !== session.account.id);
  // Two accounts with one name (a profile can name itself anything) are told apart by their ids.
  const named = (name: string) => state.accounts.filter((account) => account.name === name).length;
  const shortId = (did: string) => `…${did.slice(-6)}`;

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
        <Avatar did={session.did} size={30} round src={picture} />
        <span className="switcher-name">{session.account.name}</span>
      </button>
      {open && (
        <div role="menu" style={menu}>
          <div
            style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: 20 }}
          >
            <Avatar did={session.did} size={64} round src={picture} />
            {renaming ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void auth.rename(draft).then((ok) => ok && setRenaming(false));
                }}
                style={{ display: 'flex', gap: 6, width: '100%', marginTop: 4 }}
              >
                <input
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  autoFocus
                  aria-label="Account name"
                  style={{ ...styles.input, height: 34 }}
                />
                <button
                  type="submit"
                  disabled={!draft.trim() || state.busy}
                  data-variant="primary"
                  style={{ ...styles.darkSmall, height: 34 }}
                >
                  Save
                </button>
              </form>
            ) : (
              <p style={{ fontFamily: palette.display, fontSize: 21, fontWeight: 700, color: ink.strong }}>
                {session.account.name}
              </p>
            )}
            <p style={{ fontSize: 12, color: ink.faint, fontFamily: palette.mono }}>
              {named(session.account.name) > 1
                ? shortId(session.did)
                : `${session.did.slice(0, 14)}…${session.did.slice(-4)}`}
            </p>
            <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
              {!renaming && (
                <button
                  onClick={() => {
                    setDraft(session.account.name);
                    setRenaming(true);
                  }}
                  data-variant="quiet"
                  style={styles.smallButton}
                >
                  Rename
                </button>
              )}
              <button onClick={() => copy(session.did)} data-variant="quiet" style={styles.smallButton}>
                {copied ? 'Copied' : 'Copy ID'}
              </button>
            </div>
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
                  <Avatar did={account.did} size={28} round />
                  <span style={{ minWidth: 0, flex: 1, textAlign: 'left' }}>
                    <span style={{ display: 'block', fontWeight: 500, color: ink.strong }}>
                      {account.name}
                    </span>
                    <span style={{ display: 'block', fontSize: 12, color: ink.faint }}>
                      {named(account.name) > 1 ? `Switch · ${shortId(account.did)}` : 'Switch'}
                    </span>
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
