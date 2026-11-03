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
import { Icon } from './Icon';
import styles from './ProfilePage.module.css';

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
    <section>
      <h1>Profile</h1>
      <ul role="list">
        <li className="empty">
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
          />
          {username ? (
            <small>@{shortUsername(username)}</small>
          ) : (
            found.status === 'done' && (
              <button data-intent="quiet" onClick={() => openAccountHome(state.home, account.did)}>
                Pick a username
              </button>
            )
          )}
        </li>
        <AccountActions onConnectAgent={() => setConnecting(true)} />
      </ul>
      {connecting && <ConnectAgent onClose={() => setConnecting(false)} />}
    </section>
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
    <div ref={root} className={styles.picture}>
      <button
        onClick={() => (picture ? setOpen((was) => !was) : choose())}
        aria-label={label}
        title={label}
        aria-haspopup={picture ? 'menu' : undefined}
        aria-expanded={picture ? open : undefined}
      >
        <Avatar did={account.did} size={88} round src={picture} />
        <span aria-hidden>
          <Icon name={picture ? 'pencil' : 'plus'} size={14} />
        </span>
      </button>
      {open && (
        <menu role="menu">
          {(
            [
              ['Change picture', choose, false],
              ['Remove picture', remove, true],
            ] as const
          ).map(([text, act, danger]) => (
            <li key={text}>
              <button
                role="menuitem"
                data-intent={danger ? 'danger' : undefined}
                onClick={() => {
                  close();
                  act();
                }}
              >
                {text}
              </button>
            </li>
          ))}
        </menu>
      )}
      {picker}
      {problem && <p role="alert">{problem}</p>}
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
