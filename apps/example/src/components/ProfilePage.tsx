import { useRef, useState } from 'react';
import {
  useAccount,
  useAccountPicture,
  useAsync,
  useConnection,
  useMyName,
  useNode,
  useObjectUrl,
} from '@minca/react';
import { message } from '@minca/app-shared/action';
import { forgetPicture } from '@minca/app-shared/rememberedPictures';
import { Avatar } from '@minca/app-shared/Avatar';
import { shortUsername } from '@minca/app-shared/usernames';
import { AccountActions, openAccountHome } from './AccountMenu';
import { usePopover } from './usePopover';
import { shrinkImage } from '../files';
import { ConnectAgent } from './ConnectAgent';
import { LinkButton } from './Buttons';
import { Icon } from './Icon';
import { palette, styles, ui } from '../styles';

/**
 * You, at `/profile`: how others see you (your picture, name and username) is changed here, in the
 * app. What guards the account itself, its keys, devices and backups, stays in the account home.
 */
export function ProfilePage() {
  const account = useAccount();
  const { state } = useConnection();
  const node = useNode();
  const me = useMyName();
  const found = useAsync(() => node.inbox.get(), [node]);
  const username = found.status === 'done' ? found.value?.username : undefined;
  const [connecting, setConnecting] = useState(false);

  return (
    <>
      <h1 style={{ ...styles.appTitle, marginBottom: 20 }}>Profile</h1>
      <div style={ui.list}>
        <div style={face}>
          <PictureButton name={me.name} />
          <input
            value={me.name}
            onChange={(event) => me.setName(event.target.value)}
            onBlur={() => void me.save()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
            }}
            maxLength={200}
            aria-label="Your name"
            className="name-input"
            style={nameInput}
          />
          {username ? (
            <span style={{ fontSize: 14, color: palette.ink.muted }}>@{shortUsername(username)}</span>
          ) : (
            found.status === 'done' && (
              <LinkButton onClick={() => openAccountHome(state.home, account.did)}>
                Pick a username
              </LinkButton>
            )
          )}
        </div>
        <AccountActions onConnectAgent={() => setConnecting(true)} />
      </div>
      {connecting && <ConnectAgent onClose={() => setConnecting(false)} />}
    </>
  );
}

/**
 * Your picture, with a badge that says it can be changed: a tap adds one when there is none, and
 * otherwise offers to change or remove it.
 */
function PictureButton({ name }: { name: string }) {
  const account = useAccount();
  const { picture, choose, remove, picker, problem } = usePicture(name);
  const { open, setOpen, close, root } = usePopover();
  const label = picture ? 'Change or remove your picture' : 'Add a picture';
  return (
    <div ref={root} style={{ position: 'relative', marginBottom: 8, ...stackCentre }}>
      <button
        onClick={() => (picture ? setOpen((was) => !was) : choose())}
        aria-label={label}
        title={label}
        aria-haspopup={picture ? 'menu' : undefined}
        aria-expanded={picture ? open : undefined}
        style={pictureButton}
      >
        <Avatar did={account.did} size={88} round src={picture} />
        <span aria-hidden style={badge}>
          <Icon name={picture ? 'pencil' : 'plus'} size={14} />
        </span>
      </button>
      {open && (
        <div role="menu" style={menu}>
          {(
            [
              ['Change picture', choose, false],
              ['Remove picture', remove, true],
            ] as const
          ).map(([text, act, danger]) => (
            <button
              key={text}
              role="menuitem"
              data-menu-item
              onClick={() => {
                close();
                act();
              }}
              style={{ ...menuItem, color: danger ? palette.accent.danger : palette.ink.body }}
            >
              {text}
            </button>
          ))}
        </div>
      )}
      {picker}
      {problem && <p style={{ ...styles.error, marginTop: 8, textAlign: 'center' }}>{problem}</p>}
    </div>
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

const stackCentre = { display: 'flex', flexDirection: 'column', alignItems: 'center' } as const;

const menu = {
  position: 'absolute',
  top: 'calc(100% + 6px)',
  zIndex: 20,
  width: 200,
  padding: 6,
  ...styles.float,
  animation: 'minca-fade .1s ease',
} as const;

const menuItem = {
  width: '100%',
  height: 36,
  padding: '0 10px',
  border: 'none',
  borderRadius: palette.radius.md,
  background: 'none',
  textAlign: 'left',
  fontSize: 14,
} as const;

const face = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 6,
  padding: '28px 16px 20px',
} as const;

const pictureButton = {
  position: 'relative',
  padding: 0,
  border: 'none',
  borderRadius: palette.radius.pill,
  background: 'none',
} as const;

const badge = {
  position: 'absolute',
  right: 0,
  bottom: 0,
  width: 28,
  height: 28,
  display: 'grid',
  placeItems: 'center',
  borderRadius: palette.radius.pill,
  background: palette.accent.base,
  color: palette.surface.card,
  boxShadow: `0 0 0 3px ${palette.surface.card}`,
} as const;

/** Your name, edited where it is shown: it reads as a heading until it is tapped */
const nameInput = {
  ...styles.appTitle,
  width: '100%',
  maxWidth: 320,
  fontSize: 22,
  textAlign: 'center',
  padding: '4px 10px',
  border: '1px solid transparent',
  borderRadius: palette.radius.md,
  background: 'none',
} as const;
