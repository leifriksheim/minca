import { useEffect, useState } from 'react';
import type { SpaceSummary } from '@minca/core';
import { Modal } from '@minca/app-shared/Modal';
import { ConnectAgent, useKnownAgent } from '../ConnectAgent';
import { Icon } from '../Icon';
import { useNode } from '@minca/core/react';
import { useLauncherRecords } from './entries';
import { prepareLauncher } from './launcher';
import { styles, palette, ui, variants } from '../../styles';

/** Things a group might ask for, to start from */
const IDEAS = [
  { label: 'Potluck sign-up', text: 'a potluck sign-up, where everyone says what they bring' },
  {
    label: 'Reading list',
    text: 'a reading list: what we are reading, when we meet, and a rating from each of us',
  },
  { label: 'Shopping list', text: 'a shared shopping list we can tick off in the shop' },
  { label: 'Chore rota', text: 'a chore rota that takes turns, week by week' },
] as const;

/**
 * Making an app by describing it to an agent, which proposes it as the guide
 * the launcher writes in the space says: a blueprint, and a `launcher.app`
 * record to add.
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
  const known = useKnownAgent();
  const node = useNode();
  const apps = useLauncherRecords(space.id);
  // The guide the agent reads is in the space before it looks, when this person may write it.
  useEffect(() => {
    if (mayDefine) void prepareLauncher(node, space.id).catch(() => {});
  }, [node, space.id, mayDefine]);
  const [idea, setIdea] = useState('');
  const [connecting, setConnecting] = useState(false);
  // The apps there were when the prompt was copied; one not among them is the answer.
  const [before, setBefore] = useState<ReadonlySet<string> | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  if (connecting) return <ConnectAgent onClose={() => setConnecting(false)} />;

  const what = idea.trim().replace(/[.\s]+$/, '');
  const prompt = `In my Minca space "${space.name}", make an app: ${what}. Use the standard collections where they fit, and propose it to the space the way the space's guide on launcher.app says (collections_list points at it), saying what is worth being notified about.`;
  const agent = known ?? 'your agent';
  const adds = mayDefine ? 'you add it' : 'someone who runs the space adds it';
  const byHand = mayDefine ? onBuildByHand : undefined;

  const copy = () => {
    setBefore(new Set(apps.map((one) => one.key)));
    const clipboard = globalThis.navigator.clipboard;
    if (!clipboard) return setCopyFailed(true);
    clipboard.writeText(prompt).then(
      () => {
        setCopyFailed(false);
        setCopied(true);
        globalThis.setTimeout(() => setCopied(false), 2000);
      },
      () => setCopyFailed(true),
    );
  };
  const proposed = before && apps.find((one) => !before.has(one.key) && one.body && !one.body.builtIn)?.body;

  return (
    <Modal title="Create an app" onClose={onClose} width={560}>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: palette.ink.strong }}>
          What should {space.name} have?
        </span>
        <textarea
          value={idea}
          onChange={(event) => setIdea(event.target.value)}
          placeholder="A place to plan our summer trip, with a packing list and who's driving"
          rows={3}
          style={styles.textarea}
        />
      </label>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {IDEAS.map((one) => (
          <button
            key={one.label}
            type="button"
            onClick={() => setIdea(one.text)}
            data-variant="quiet"
            style={chip}
          >
            {one.label}
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <button
          onClick={copy}
          disabled={!what}
          data-variant="primary"
          style={{ ...styles.button, ...action }}
        >
          {copied ? (
            '✓ Copied'
          ) : (
            <>
              <Icon name="sparkle" size={14} /> Copy prompt for {agent}
            </>
          )}
        </button>
        {!known && (
          <button
            type="button"
            onClick={() => setConnecting(true)}
            data-variant="quiet"
            style={{ ...variants.quiet, ...action }}
          >
            <Icon name="terminal" size={14} /> Connect an agent
          </button>
        )}
      </div>
      {copyFailed && <p style={promptBox}>{prompt}</p>}

      {proposed && (
        <div style={note}>
          <p style={{ fontSize: 14, fontWeight: 600, color: palette.ink.strong }}>
            <span style={{ color: palette.accent.good }}>✓</span> {known ?? 'Your agent'} proposed “
            {proposed.title}”
          </p>
          <p style={{ fontSize: 13, color: palette.ink.body }}>
            Nothing changes in {space.name} until {adds}.{' '}
            <button
              type="button"
              onClick={() => {
                onClose();
                onReview();
              }}
              data-variant="ghost"
              style={{ ...styles.linkButton, fontSize: 13, padding: 0 }}
            >
              Review it
            </button>
          </p>
        </div>
      )}

      {(known || byHand) && (
        <div style={footer}>
          {known && (
            <span>
              <span style={{ color: palette.accent.good }}>✓</span> {known} connected ·{' '}
              <button
                type="button"
                onClick={() => setConnecting(true)}
                data-variant="ghost"
                style={{ ...styles.linkButton, fontSize: 13, padding: 0 }}
              >
                Change
              </button>
            </span>
          )}
          {byHand && (
            <button
              type="button"
              onClick={() => {
                onClose();
                byHand();
              }}
              data-variant="ghost"
              style={{ ...styles.linkButton, fontSize: 13, padding: 0 }}
            >
              Build one by hand
            </button>
          )}
        </div>
      )}
    </Modal>
  );
}

const note = {
  ...styles.note,
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  padding: '12px 14px',
} as const;

const chip = { ...ui.chip, fontWeight: 400 };

const action = {
  width: '100%',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  padding: '0 14px',
} as const;

const footer = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 8,
  paddingTop: 12,
  borderTop: `1px solid ${palette.surface.line}`,
  fontSize: 13,
  color: palette.ink.muted,
} as const;

const promptBox = {
  padding: '10px 12px',
  borderRadius: palette.radius.md,
  background: palette.surface.sunken,
  fontSize: 13,
  lineHeight: 1.5,
  color: palette.ink.body,
  userSelect: 'all',
} as const;
