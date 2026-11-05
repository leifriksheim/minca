import { useCallback, useRef, useState } from 'react';
import { useAccountPicture, useAuth, useSession } from '@minca/react';
import { Avatar } from '@minca/app-shared/Avatar';
import { useRememberPicture } from '@minca/app-shared/rememberedPictures';
import { useDismiss } from '@minca/app-shared/useDismiss';
import { useCopy } from '@minca/app-shared/action';
import styles from './AccountSwitcher.module.css';

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
  // Kept, so the list of accounts shows this one by its picture once another is signed in.
  useRememberPicture(session.did, picture);
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
    <div ref={root} className={styles.switcher}>
      <button
        onClick={() => setOpen((was) => !was)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`Account: ${session.account.name}`}
        data-intent="ghost"
      >
        <Avatar did={session.did} size={30} round src={picture} />
        <span>{session.account.name}</span>
      </button>
      {open && (
        <menu role="menu">
          <li className={`stack ${styles.me}`}>
            <Avatar did={session.did} size={64} round src={picture} />
            {renaming ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void auth.rename(draft).then((ok) => ok && setRenaming(false));
                }}
                className="row"
              >
                <input
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  autoFocus
                  aria-label="Account name"
                />
                <button type="submit" disabled={!draft.trim() || state.busy} data-intent="primary">
                  Save
                </button>
              </form>
            ) : (
              <h2>{session.account.name}</h2>
            )}
            <small>
              <code>
                {named(session.account.name) > 1
                  ? shortId(session.did)
                  : `${session.did.slice(0, 14)}…${session.did.slice(-4)}`}
              </code>
            </small>
            <div className="row">
              {!renaming && (
                <button
                  onClick={() => {
                    setDraft(session.account.name);
                    setRenaming(true);
                  }}
                >
                  Rename
                </button>
              )}
              <button onClick={() => copy(session.did)}>{copied ? 'Copied' : 'Copy ID'}</button>
            </div>
          </li>
          {others.length > 0 && (
            <li className={styles.items}>
              {others.map((account) => (
                <button
                  key={account.id}
                  data-intent="ghost"
                  role="menuitem"
                  onClick={() => void switchTo(account.id)}
                  disabled={state.busy}
                >
                  <Avatar did={account.did} size={28} round />
                  <span className="stack" data-gap="tight">
                    <strong>{account.name}</strong>
                    <small>{named(account.name) > 1 ? `Switch · ${shortId(account.did)}` : 'Switch'}</small>
                  </span>
                </button>
              ))}
            </li>
          )}
          <li className={styles.items}>
            <button
              role="menuitem"
              data-intent="ghost"
              onClick={() => void addAccount()}
              disabled={state.busy}
            >
              <span className={styles.plus} aria-hidden="true">
                +
              </span>
              Add another account
            </button>
            <button
              role="menuitem"
              data-intent="ghost"
              onClick={() => {
                setOpen(false);
                void auth.signOut();
              }}
              disabled={state.busy}
            >
              <span className={styles.plus} aria-hidden="true" />
              Sign out
            </button>
          </li>
        </menu>
      )}
    </div>
  );
}
