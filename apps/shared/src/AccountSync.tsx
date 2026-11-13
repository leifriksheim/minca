import { useWatched } from '@minca/react';
import { Shape } from './shapes';
import css from './AccountSync.module.css';

/** The account's other devices and hosts connected to this one now */
interface RestOfAccountOnline {
  readonly devices: number;
  readonly hosts: number;
}

/**
 * Who else of the account this device is connected to, read off the account's
 * own space, which only its devices and hosts are in. Null without the
 * account's key, undefined until first read.
 */
function useRestOfAccountOnline(): RestOfAccountOnline | null | undefined {
  return useWatched(
    async (node) => {
      const accountSpace = await node.account.space();
      if (!accountSpace) return null;
      const status = await node.spaces.status(accountSpace);
      return { devices: status.own.length, hosts: status.carriers.length };
    },
    [],
    { when: (event) => event.type === 'status' },
  );
}

/**
 * Where the rest of the account is, for a device that has little of it yet:
 * one just restored, paired or connected. It says what is connected right
 * now and nothing more, so it is never a step to wait behind.
 */
export function AccountSync() {
  const online = useRestOfAccountOnline();
  if (!online) return null;
  const isSyncing = online.devices + online.hosts > 0;
  const source =
    online.devices > 1 ? 'your other devices' : online.devices === 1 ? 'your other device' : 'your host';
  return (
    <div className={css.sync} role="status" data-syncing={isSyncing || undefined}>
      <div className={css.wire} aria-hidden>
        <Shape kind="scallop" colour={isSyncing ? 'sage' : 'ink'} size={34} />
        <span className={css.dots}>
          <i />
          <i />
          <i />
        </span>
        <Shape kind="squircle" colour="cobalt" size={34} />
      </div>
      <div className="stack" data-gap="tight">
        <strong>{isSyncing ? `Syncing with ${source}` : 'Have Minca on another device?'}</strong>
        <small>
          {isSyncing
            ? 'What you have there shows up here as it arrives. You can carry on meanwhile.'
            : 'Open it there, and what you have comes over on its own.'}
        </small>
      </div>
    </div>
  );
}
