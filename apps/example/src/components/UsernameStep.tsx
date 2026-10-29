import { useState } from 'react';
import { useAccount, useAsync, useNode } from '@minca/react';
import { useCopy } from '@minca/app-shared/action';
import { Shape } from '@minca/app-shared/shapes';
import { UsernamePicker } from '@minca/app-shared/UsernamePicker';
import { useFreeUsername, usernameIdeas } from '@minca/app-shared/usernames';
import { Wordmark } from '@minca/app-shared/Wordmark';
import { palette, styles } from '../styles';
import { AddButton, LinkButton, QuietButton } from './Buttons';
import { shareUsername } from './UsernameCard';

const { ink } = palette;

/** Where this device remembers that the account skipped or finished the step */
const seenKey = (did: string) => `minca.username-step.${did}`;

function seen(did: string): boolean {
  try {
    return globalThis.localStorage.getItem(seenKey(did)) !== null;
  } catch {
    return false;
  }
}

/**
 * Whether to ask for a username before the app opens: once per account on
 * this device, while the account has none. A new account lands here right
 * after it is made; this app's node claims it, as the node that reads the
 * knocks it brings.
 */
export function useUsernameStep(): { ask: boolean; looking: boolean; done: () => void } {
  const node = useNode();
  const { did } = useAccount();
  const [finished, setFinished] = useState(() => seen(did));
  const inbox = useAsync(() => node.inbox.get().catch(() => null), [node]);
  return {
    ask: !finished && inbox.status === 'done' && !inbox.value?.username,
    // Not known yet: nothing drawn for that moment, so the app doesn't show and then give way.
    looking: !finished && inbox.status !== 'done',
    done: () => {
      try {
        globalThis.localStorage.setItem(seenKey(did), String(Date.now()));
      } catch {
        // Asked again next time, which is all that is lost.
      }
      setFinished(true);
    },
  };
}

/**
 * The last step of getting started: a username, so people can find and add
 * you. A free one is offered from your name; skipping it is fine, since the
 * contacts screen asks again.
 */
export function UsernameStep({ onDone }: { onDone: () => void }) {
  const account = useAccount();
  const suggestion = useFreeUsername(usernameIdeas(account.name));
  const [claimed, setClaimed] = useState<string | null>(null);
  const copy = useCopy();
  const link = useCopy();

  return (
    <div className="page" style={{ position: 'relative', overflow: 'hidden' }}>
      <Shape kind="flower" colour="peach" size={260} style={art} />
      <div style={{ ...styles.card, position: 'relative' }}>
        <div style={{ marginBottom: 40 }}>
          <Wordmark />
        </div>
        {claimed ? (
          <>
            <p style={eyebrow}>All set</p>
            <h1 style={{ ...styles.title, overflowWrap: 'anywhere' }}>
              You’re <span style={{ display: 'inline-block' }}>{claimed.slice(0, claimed.indexOf('@'))}</span>
              <span style={{ display: 'inline-block', color: ink.muted }}>
                {claimed.slice(claimed.indexOf('@'))}
              </span>
            </h1>
            <p style={styles.subtitle}>
              Give it to people, and they can add you. You choose who gets in, and you can change it on your
              contacts page.
            </p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <AddButton onClick={onDone} style={{ height: 44, padding: '0 22px' }}>
                Start using Minca
              </AddButton>
              <QuietButton onClick={() => copy.copy(claimed)} style={{ height: 44, padding: '0 18px' }}>
                {copy.copied ? 'Copied' : 'Copy'}
              </QuietButton>
              <QuietButton
                onClick={() => void shareUsername(claimed, link.copy)}
                style={{ height: 44, padding: '0 18px' }}
              >
                {link.copied ? 'Link copied' : 'Share'}
              </QuietButton>
            </div>
          </>
        ) : (
          <>
            <p style={eyebrow}>One last thing</p>
            <h1 style={styles.title}>Pick your username</h1>
            <p style={styles.subtitle}>
              It’s how people find you and add you, like a phone number you choose.
            </p>
            <UsernamePicker suggestion={suggestion} onClaimed={setClaimed}>
              <LinkButton type="button" onClick={onDone}>
                Skip for now
              </LinkButton>
            </UsernamePicker>
          </>
        )}
      </div>
    </div>
  );
}

/** The step's shape: big, off the top right corner of the page */
const art = { position: 'absolute', top: -90, right: -80, transform: 'rotate(12deg)', opacity: 0.9 } as const;

const eyebrow = {
  fontSize: 12,
  fontWeight: 600,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  color: ink.muted,
  marginBottom: 8,
} as const;
