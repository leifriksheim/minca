import { useEffect, useState } from 'react';
import type { SpaceSummary } from '@minca/core';
import { Loader } from '@minca/app-shared/Loader';
import { ConnectAgent } from '../ConnectAgent';
import { useNode } from '@minca/react';
import { useLauncherRecords } from './entries';
import { checkLauncherApp, prepareLauncher } from './launcher';

const TITLE = 'Add your own app';

/**
 * Making an app by asking an agent for it: connect one, then ask it in your
 * own words. It proposes the app as
 * the guide the launcher writes in the space says, and the proposal shows
 * here when it arrives.
 */
export function CreateApp({
  space,
  mayDefine,
  onClose,
  onReview,
  onBuildByHand,
}: {
  space: SpaceSummary;
  mayDefine: boolean;
  onClose: () => void;
  /** Shows the space's apps, where proposals are added */
  onReview: () => void;
  onBuildByHand?: () => void;
}) {
  const node = useNode();
  // The guide the agent reads is in the space before it looks, when this person may write it.
  useEffect(() => {
    if (mayDefine) void prepareLauncher(node, space.id).catch(() => {});
  }, [node, space.id, mayDefine]);
  const ask = (
    <AskForApp
      space={space}
      mayDefine={mayDefine}
      onReview={() => {
        onClose();
        onReview();
      }}
      {...(mayDefine && onBuildByHand
        ? {
            onBuildByHand: () => {
              onClose();
              onBuildByHand();
            },
          }
        : {})}
    />
  );

  return <ConnectAgent title={TITLE} onClose={onClose} then={ask} />;
}

/** The last step: what to say to the agent, and the app it proposes once it has */
function AskForApp({
  space,
  mayDefine,
  onReview,
  onBuildByHand,
}: {
  space: SpaceSummary;
  mayDefine: boolean;
  onReview: () => void;
  onBuildByHand?: () => void;
}) {
  const apps = useLauncherRecords(space.id);
  // A proposal made since this opened is the answer. The creator's clock only shows the way; it decides nothing.
  const [since] = useState(() => new Date(Date.now() - 60_000).toISOString());
  const proposed = apps.find((one) => one.createdAt >= since && one.body && !one.body.template)?.body;
  const adds = mayDefine ? 'you add it' : 'someone who runs the space adds it';
  // Said here too, so the person can tell the agent while its chat is still open.
  const problem = proposed ? checkLauncherApp(proposed) : null;

  return (
    <>
      <p>
        In a new chat with your agent, say what {space.name} should have, or what to change in an app it has.
        For example:
      </p>
      <aside>“In Minca, add a potluck sign-up to {space.name}, where everyone says what they bring.”</aside>

      {proposed ? (
        <aside className="stack" data-tone="good">
          <strong>✓ Your agent proposed “{proposed.title}”</strong>
          {problem ? (
            <p role="alert">It can't be added yet; ask your agent to fix it: {problem}</p>
          ) : (
            <p>
              Nothing changes in {space.name} until {adds}.
            </p>
          )}
          <button type="button" data-intent="primary" onClick={onReview}>
            Review it
          </button>
        </aside>
      ) : (
        <small className="row">
          <Loader size={10} decorative /> Its proposal shows here. Nothing changes in {space.name} until{' '}
          {adds}.
        </small>
      )}

      {onBuildByHand && (
        <button type="button" data-intent="quiet" onClick={onBuildByHand}>
          Or build one by hand
        </button>
      )}
    </>
  );
}
