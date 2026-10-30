import { useEffect, useState } from 'react';
import type { SpaceSummary } from '@minca/core';
import { Loader } from '@minca/app-shared/Loader';
import { ConnectAgent, stepText } from '../ConnectAgent';
import { useNode } from '@minca/react';
import { useLauncherRecords } from './entries';
import { checkLauncherTool, prepareLauncher } from './launcher';
import { styles, palette, stack } from '../../styles';
import { LinkButton, PrimaryButton } from '../Buttons';

const TITLE = 'Add your own tool';

/**
 * Making a tool by asking an agent for it: connect one, then ask it in your
 * own words. It proposes the tool as
 * the guide the launcher writes in the space says, and the proposal shows
 * here when it arrives.
 */
export function CreateTool({
  space,
  mayDefine,
  onClose,
  onReview,
  onBuildByHand,
}: {
  space: SpaceSummary;
  mayDefine: boolean;
  onClose: () => void;
  /** Shows the space's tools, where proposals are added */
  onReview: () => void;
  onBuildByHand?: () => void;
}) {
  const node = useNode();
  // The guide the agent reads is in the space before it looks, when this person may write it.
  useEffect(() => {
    if (mayDefine) void prepareLauncher(node, space.id).catch(() => {});
  }, [node, space.id, mayDefine]);
  const ask = (
    <AskForTool
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

/** The last step: what to say to the agent, and the tool it proposes once it has */
function AskForTool({
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
  const tools = useLauncherRecords(space.id);
  // A proposal made since this opened is the answer. The creator's clock only shows the way; it decides nothing.
  const [since] = useState(() => new Date(Date.now() - 60_000).toISOString());
  const proposed = tools.find((one) => one.createdAt >= since && one.body && !one.body.template)?.body;
  const adds = mayDefine ? 'you add it' : 'someone who runs the space adds it';
  // Said here too, so the person can tell the agent while its chat is still open.
  const problem = proposed ? checkLauncherTool(proposed) : null;

  return (
    <>
      <p style={stepText}>
        In a new chat with your agent, say what {space.name} should have, or what to change in a tool it has.
        For example:
      </p>
      <p style={example}>
        “In Minca, add a potluck sign-up to {space.name}, where everyone says what they bring.”
      </p>

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
          <PrimaryButton
            type="button"
            onClick={onReview}
            style={{ alignSelf: 'flex-start', width: 'auto', padding: '0 18px', marginTop: 6 }}
          >
            Review it
          </PrimaryButton>
        </div>
      ) : (
        <p style={{ ...stepText, color: palette.ink.muted, display: 'flex', alignItems: 'center', gap: 8 }}>
          <Loader size={10} decorative /> Its proposal shows here. Nothing changes in {space.name} until{' '}
          {adds}.
        </p>
      )}

      {onBuildByHand && (
        <LinkButton
          type="button"
          onClick={onBuildByHand}
          style={{ fontSize: 13, padding: 0, alignSelf: 'flex-start' }}
        >
          Or build one by hand
        </LinkButton>
      )}
    </>
  );
}

const example = {
  padding: '10px 14px',
  borderRadius: palette.radius.md,
  background: palette.surface.sunken,
  fontSize: 14,
  lineHeight: 1.5,
  color: palette.ink.strong,
} as const;
