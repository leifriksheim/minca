import { useState } from 'react';
import { useAccount, useNode } from './context.js';
import { useAsync } from './use-async.js';

/**
 * The name others see, for asking where it matters: making or joining a
 * space. Starts as the account's name, so most people just carry on. `save`
 * puts it on the account, and the node tells every space from there, so
 * nobody shows up as a bare code because they never got round to settings.
 */
export function useMyName(): { name: string; setName: (name: string) => void; save: () => Promise<void> } {
  const node = useNode();
  const account = useAccount();
  const profile = useAsync(() => node.account.profile(), [node, account.name]);
  const saved = profile.status === 'done' ? (profile.value?.name ?? null) : null;
  const [typed, setName] = useState<string | null>(null);
  const name = typed ?? saved ?? account.name;

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === saved) return;
    await node.account.setName(trimmed).catch(() => {});
  };

  return { name, setName, save };
}
