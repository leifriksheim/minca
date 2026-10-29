import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { useAccount, useAsync, useConnection, useNode } from '@minca/react';
import { accountHomeLink } from '@minca/core/session';
import { Avatar } from '@minca/app-shared/Avatar';
import { useDismiss } from '@minca/app-shared/useDismiss';
import { message, useCopy } from '@minca/app-shared/action';
import { useNavigate } from '@tanstack/react-router';
import { ConnectAgent } from './ConnectAgent';
import { shortAccount } from '../account-address';
import { shrinkImage } from '../files';
import { palette, styles, ui } from '../styles';

type Place = 'header' | 'sidebar';

/**
 * Who this app acts for, and its menu; the account itself lives in the account home. A pill in a
 * header, or the whole of the bar at the foot of a space's sidebar.
 */
export function AccountMenu({ place = 'header' }: { place?: Place }) {
  const account = useAccount();
  const { connection, state } = useConnection();
  const navigate = useNavigate();
  const { copied, copy } = useCopy();
  const { picture, choose, picker, problem } = usePicture(account.name);
  const [open, setOpen] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, root, close);

  const home = new URL(state.home).host;
  const others = state.accounts.filter((other) => other.did !== account.did);
  const shortDid = `${account.did.slice(8, 16)}…${account.did.slice(-6)}`;

  // Switching is moving the address: the tab acts for whichever account it names (`account-address.ts`).
  const switchTo = (did: string) => {
    close();
    void navigate({ to: '/', search: { as: shortAccount(did) } });
  };
  // The home may be signed in to another account, so the link says which one this app acts for.
  const openHome = () => {
    close();
    globalThis.open(accountHomeLink(state.home, account.did), 'minca-account', 'popup,width=720,height=820');
  };
  const connectAgent = () => {
    close();
    setConnecting(true);
  };

  return (
    // In the sidebar the menu hangs from the whole bar, so it lines up with the bell's panel.
    <div ref={root} style={place === 'sidebar' ? { flex: 1, minWidth: 0 } : { position: 'relative' }}>
      <Trigger place={place} open={open} onClick={() => setOpen((was) => !was)} picture={picture} />

      {open && (
        <div role="menu" style={{ ...menu, ...(place === 'sidebar' ? above : below) }}>
          <div style={{ padding: '14px 14px 12px', display: 'flex', gap: 10, alignItems: 'center' }}>
            <Avatar did={account.did} size={36} round src={picture} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ ...ui.ellipsis, fontWeight: 600, fontSize: 14, color: palette.ink.strong }}>
                {account.name}
              </div>
              <button
                onClick={() => copy(account.did)}
                title={`${account.did} — click to copy`}
                style={didButton}
              >
                {copied ? 'Copied' : shortDid}
              </button>
            </div>
          </div>

          <Section>
            <Item onClick={openHome} hint={home}>
              Account settings
            </Item>
            <Item onClick={choose} hint="Shown in every space">
              {picture ? 'Change picture' : 'Add a picture'}
            </Item>
            {picker}
            {problem && <Note>{problem}</Note>}
            <Item onClick={connectAgent} hint="Claude Code, Desktop, Cursor">
              Connect an agent
            </Item>
            <Note faint>
              An agent in this browser works as you, with nothing to set up. One on your computer connects
              here, and keeps working with this tab closed.
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
            <Item onClick={() => void connection.disconnect()} hint="Your account is untouched">
              Disconnect {others.length > 0 ? account.name : 'this app'}
            </Item>
          </Section>
        </div>
      )}
      {connecting && <ConnectAgent onClose={() => setConnecting(false)} />}
    </div>
  );
}

/** The button that opens the menu: the bar at the foot of the sidebar, or a pill in a header */
function Trigger({
  place,
  open,
  onClick,
  picture,
}: {
  place: Place;
  open: boolean;
  onClick: () => void;
  picture: string | null;
}) {
  const account = useAccount();
  const { state } = useConnection();
  if (place === 'sidebar')
    return (
      <button onClick={onClick} aria-expanded={open} aria-label="Account" className="you-button">
        <Avatar did={account.did} size={32} round src={picture} />
        <span style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column' }}>
          <span style={{ ...ui.ellipsis, fontSize: 13.5, fontWeight: 600, color: palette.ink.strong }}>
            {account.name}
          </span>
          <span style={{ ...ui.ellipsis, fontSize: 11.5, color: palette.ink.faint }}>
            {new URL(state.home).host}
          </span>
        </span>
      </button>
    );
  return (
    <button
      onClick={onClick}
      aria-expanded={open}
      aria-label="Account"
      className="account-button"
      style={pill}
    >
      <Avatar did={account.did} size={28} round src={picture} />
      <span className="account-name">{account.name}</span>
    </button>
  );
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

const below = { right: 0, top: 44 };
const above = { left: 0, bottom: 'calc(100% + 8px)' };

const menu = {
  position: 'absolute' as const,
  zIndex: 20,
  width: 280,
  ...styles.float,
  animation: 'minca-fade .1s ease',
  overflow: 'hidden',
};

const pill = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  height: 36,
  padding: '0 12px 0 4px',
  border: `1px solid ${palette.surface.rule}`,
  borderRadius: palette.radius.pill,
  background: palette.surface.card,
  color: palette.ink.strong,
  fontSize: 13,
  fontWeight: 500,
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

const objectUrl = (file: { bytes: Uint8Array; mime: string }) =>
  URL.createObjectURL(new Blob([file.bytes.slice()], { type: file.mime }));

/**
 * The account's picture: shown where the account is, and chosen from a file,
 * made small before it is kept. Kept in the account registry, so every device
 * and every space the account opens has it (`account.setAvatar`).
 */
function usePicture(name: string) {
  const node = useNode();
  // An app without the account key reads no registry: the shape stands in.
  const kept = useAsync(() => node.account.picture(), [node]);
  const keptUrl = useMemo(
    () => (kept.status === 'done' && kept.value ? objectUrl(kept.value) : null),
    [kept],
  );
  const [chosen, setChosen] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const take = async (file: File) => {
    setProblem(null);
    try {
      const image = await shrinkImage(file, 256);
      await node.account.setAvatar(image, { name });
      setChosen(objectUrl(image));
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
        if (file) void take(file);
        event.target.value = '';
      }}
    />
  );

  return { picture: chosen ?? keptUrl, problem, choose: () => input.current?.click(), picker };
}
