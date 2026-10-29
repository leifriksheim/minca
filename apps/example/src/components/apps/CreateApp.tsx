import { useEffect, useState } from 'react';
import type { SpaceSummary } from '@minca/core';
import { Loader } from '@minca/app-shared/Loader';
import { ConnectAgent, stepText } from '../ConnectAgent';
import { useNode } from '@minca/react';
import { useLauncherRecords } from './entries';
import { checkLauncherApp, prepareLauncher } from './launcher';
import { styles, palette, hstack, stack } from '../../styles';

const TITLE = 'Add your own app';

/** Things a group might ask for, to show how plainly it can be said */
const IDEAS = [
  'a potluck sign-up, where everyone says what they bring',
  'a reading list, with when we meet and a rating from each of us',
  'a chore rota that takes turns, week by week',
] as const;

/**
 * Making an app by asking an agent for it, step by step: connect one, or
 * skip that when it is, then ask it in your own words. It proposes the app as
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

  return <ConnectAgent title={TITLE} onClose={onClose} then={{ title: 'Ask it for your app', body: ask }} />;
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
      <p style={stepText}>
        Start a new chat in your agent and say what {space.name} should have, in your own words. For example:
      </p>
      <ul style={ideas}>
        {IDEAS.map((idea) => (
          <li key={idea} style={hstack(8)}>
            <span aria-hidden style={{ color: palette.ink.faint }}>
              “
            </span>
            <span>
              In Minca, make {space.name} {idea}.
            </span>
          </li>
        ))}
      </ul>

      {proposed ? (
        <div style={{ ...styles.note, ...stack(4), padding: '12px 14px' }}>
          <p style={{ fontSize: 14, fontWeight: 600, color: palette.ink.strong }}>
            <span style={{ color: palette.accent.good }}>✓</span> Your agent proposed “{proposed.title}”
          </p>
          {problem ? (
            <p style={styles.error}>It can't be added yet; ask your agent to fix it: {problem}</p>
          ) : (
            <p style={{ fontSize: 13, color: palette.ink.body }}>
              Nothing changes in {space.name} until {adds}.
            </p>
          )}
          <button
            type="button"
            onClick={onReview}
            data-variant="primary"
            style={{
              ...styles.button,
              alignSelf: 'flex-start',
              width: 'auto',
              padding: '0 18px',
              marginTop: 6,
            }}
          >
            Review it
          </button>
        </div>
      ) : (
        <p style={{ ...stepText, color: palette.ink.muted, display: 'flex', alignItems: 'center', gap: 8 }}>
          <Loader size={10} decorative /> Its proposal shows here. Nothing changes in {space.name} until{' '}
          {adds}.
        </p>
      )}

      {onBuildByHand && (
        <button
          type="button"
          onClick={onBuildByHand}
          data-variant="ghost"
          style={{ ...styles.linkButton, fontSize: 13, padding: 0, alignSelf: 'flex-start' }}
        >
          Or build one by hand
        </button>
      )}
    </>
  );
}

const ideas = {
  listStyle: 'none',
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: '12px 14px',
  borderRadius: palette.radius.md,
  background: palette.surface.sunken,
  fontSize: 13.5,
  lineHeight: 1.5,
  color: palette.ink.strong,
} as const;
