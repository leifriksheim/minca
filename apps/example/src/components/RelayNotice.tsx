import { useEffect, useState } from 'react';
import { relayOnlyLocal, relayProblem } from '@minca/app-shared/relay';
import { useNetwork, useNode } from '@minca/react';
import { duration, nextRetry } from '../derive/network';
import { useNow } from './NetworkView';

/** Says when no relay is reachable, since otherwise nothing syncs and nothing says why */
export function RelayNotice() {
  const problem = relayProblem();
  if (problem) {
    return (
      <aside data-tone="danger" className="stack" data-gap="tight">
        <strong>Peers cannot find each other</strong>
        <p>{problem}</p>
        <p>
          Your spaces still work, and still save. They just will not reach your other devices until this is
          set.
        </p>
      </aside>
    );
  }
  const local = relayOnlyLocal();
  return local ? <small>{local}</small> : null;
}

/** Every relay failing, more than once each: news, with a Try now */
export function RelayDown() {
  const node = useNode();
  const network = useNetwork();
  const now = useNow();
  const relays = network.relays.filter((relay) => relay.state !== 'stopped');
  const down = relays.length > 0 && relays.every((relay) => relay.state !== 'open' && relay.failures >= 2);
  if (!down) return null;
  const retry = nextRetry(network);
  return (
    <aside role="status" data-tone="danger" className="row" data-spread>
      <div className="stack" data-gap="tight">
        <strong>Can't reach the relay</strong>
        <p>
          Your changes are saved on this device and go out to your other devices once it&apos;s back.
          {retry?.retryAt ? ` Trying again in ${duration(retry.retryAt - now)}.` : ' Trying again…'}
        </p>
      </div>
      <button type="button" onClick={() => node.network.reconnect()}>
        Try now
      </button>
    </aside>
  );
}

/** How long the node may take to answer, on starting or coming back, before the page says so */
const HELD_UP_MS = 8000;

/**
 * Says when the node doesn't answer: another tab of this site, frozen in the
 * background by the browser while its node used the stores, holds this one's
 * up. A tab in a call keeps its node when put away, so it can be that tab.
 */
export function HeldUp() {
  const node = useNode();
  const [held, setHeld] = useState(false);
  useEffect(() => {
    let current = 0;
    const check = () => {
      if (document.visibilityState === 'hidden') return;
      const mine = ++current;
      const timer = setTimeout(() => mine === current && setHeld(true), HELD_UP_MS);
      void node.spaces
        .get('')
        .catch(() => null)
        .then(() => {
          clearTimeout(timer);
          if (mine === current) setHeld(false);
        });
    };
    check();
    document.addEventListener('visibilitychange', check);
    return () => {
      current++;
      document.removeEventListener('visibilitychange', check);
    };
  }, [node]);
  if (!held) return null;
  return (
    <aside role="status" data-tone="danger" className="stack" data-gap="tight">
      <strong>Another Minca tab is holding this one up</strong>
      <p>Close the other Minca tabs, or go back to the one in a call, and this one carries on.</p>
    </aside>
  );
}
