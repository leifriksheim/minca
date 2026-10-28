import { useState } from 'react';
import type { NodeCollection, NodeRecord, SpaceSummary } from '@minca/core';
import { useAccount, useLive, useNode } from '@minca/react';
import { nameOf } from '../../derive/people';
import { ago } from '@minca/ui/time';
import {
  automation as ruleCollection,
  automationOf,
  automationRun as runCollection,
  type AutomationRun,
} from '@minca/core/schemas';
import { ideas, ruleWords, type PickedRule } from '../../automations';
import { Person, usePeopleHere } from '../Person';
import { Icon } from '../Icon';
import { styles, palette } from '../../styles';
import { AutomationBuilder } from './AutomationBuilder';
import { Empty, SectionHead, iconDot, list, section } from './parts';
import { SpaceBots } from '@minca/app-shared/CommunitySetup';
import { useAction } from '@minca/app-shared/action';
import { useActivityOff } from '../../activity';
import { ask } from '@minca/app-shared/Ask';

type Open = {
  readonly kind: 'automation';
  readonly editing?: NodeRecord;
  /** Someone else's automation, to save as one of your own */
  readonly copying?: NodeRecord;
  readonly start?: PickedRule;
} | null;

/** The space's automations in sentences, what each did lately, and the bots that run them; only an automation's maker changes it */
export function AutomationsView({
  space,
  collections,
}: {
  space: SpaceSummary;
  collections: ReadonlyArray<NodeCollection>;
}) {
  const node = useNode();
  const { did } = useAccount();
  const here = usePeopleHere();
  const people = here?.people ?? new Map();
  const [open, setOpen] = useState<Open>(null);
  const { run, error } = useAction();

  const defined = collections.some((c) => c.name === ruleCollection.name && c.version !== null);
  const rules = useLive(
    space.id,
    async (n) => {
      if (!defined)
        return {
          rules: [],
          runs: new Map<string, NodeRecord<AutomationRun>[]>(),
          deletable: new Set<string>(),
        };
      const [rules, runs] = await Promise.all([
        n.records.list(space.id, { collection: ruleCollection.name }),
        n.records.list<AutomationRun>(space.id, { collection: runCollection.name, newestFirst: true }),
      ]);
      const byRule = new Map<string, NodeRecord<AutomationRun>[]>();
      for (const run of runs) {
        const automation = run.links.find((l) => l.rel === 'automation')?.to;
        if (automation) byRule.set(automation, [...(byRule.get(automation) ?? []), run]);
      }
      const shown = rules.filter((r) => automationOf(r) !== null);
      // Someone else's automation can't be changed, since it runs as them; one who may moderate can still delete it.
      const deletable = new Set<string>();
      for (const r of shown) if (await n.records.can(space.id, 'delete', r.key)) deletable.add(r.key);
      return { rules: shown, runs: byRule, deletable };
    },
    [defined],
  );
  // An idea already turned on is not offered again.
  const made = new Set((rules?.rules ?? []).map((r) => automationOf(r)?.name));
  const starters = ideas(collections).filter((idea) => !made.has(idea.rule.name));
  const who = (d: string) => nameOf(d, people);

  const shows = useActivityOff(space.id, space.writable);
  const act = (work: () => Promise<unknown>) => void run(work);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 36, maxWidth: 760 }}>
      <header style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <h2 style={{ ...styles.appTitle, fontSize: 22 }}>Automations</h2>
        <p style={{ fontSize: 14, color: palette.ink.muted, lineHeight: 1.55 }}>
          Let {space.name} look after itself: close a poll once enough people voted, tell the chat when a task
          is done, have a bot sum up the week.
        </p>
      </header>

      <SpaceBots spaceId={space.id} writable={space.writable} />
      {shows.off && (
        <p
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 8,
            padding: '10px 12px',
            borderRadius: palette.radius.lg,
            background: palette.surface.sunken,
            fontSize: 13,
            color: palette.ink.muted,
          }}
        >
          <span style={{ flex: 1, minWidth: 200 }}>
            Nobody sees when a bot or agent is working on something here, so its answers arrive unannounced.
          </span>
          {shows.turnOn ? (
            <button
              type="button"
              data-variant="ghost"
              style={styles.linkButton}
              onClick={() => shows.turnOn && act(shows.turnOn)}
            >
              Show it
            </button>
          ) : (
            <span>Someone who may add collections can show it.</span>
          )}
        </p>
      )}

      <section style={section}>
        <SectionHead
          title="Automations"
          about="Everyone here sees these. Each runs as its maker, on their devices or agent, or as the bot it names."
          action="New automation"
          onAction={() => setOpen({ kind: 'automation' })}
          disabled={!space.writable}
        />
        {rules === undefined ? null : rules.rules.length === 0 ? (
          <Empty>No rules in {space.name} yet.</Empty>
        ) : (
          <ul style={list}>
            {rules.rules.map((record) => {
              const automation = automationOf(record)!;
              const mine = record.createdBy === did;
              // An automation written under a records-only note (an agent's) waits for its person to save it themselves.
              const suggested = record.recordsOnly === true;
              const off = automation.paused || suggested;
              const agentOnly = automation.then.kind === 'ask' || (!automation.when && !!automation.every);
              const runs = rules.runs.get(record.key) ?? [];
              return (
                <li key={record.key} style={{ ...ruleCard, opacity: off ? 0.65 : 1 }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                    <span
                      style={{
                        ...iconDot,
                        background: off ? palette.surface.sunken : palette.accent.base,
                        color: off ? palette.ink.muted : palette.surface.card,
                      }}
                    >
                      <Icon name="bolt" size={14} />
                    </span>
                    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
                      <strong style={{ color: palette.ink.strong, fontSize: 14.5 }}>{automation.name}</strong>
                      <span style={{ fontSize: 14, color: palette.ink.body, lineHeight: 1.5 }}>
                        {ruleWords(automation, collections, who)}
                      </span>
                      <span style={{ fontSize: 12.5, color: palette.ink.muted }}>
                        {suggested ? 'Suggested by an agent' : automation.paused ? 'Paused' : 'On'} · made by{' '}
                        {mine ? 'you' : <Person did={record.createdBy} />} ·{' '}
                        {automation.by ? (
                          <>
                            run by <Person did={automation.by} />
                          </>
                        ) : agentOnly ? (
                          `runs while ${mine ? 'your' : 'their'} agent does (minca agent)`
                        ) : mine ? (
                          'runs while this app is open on one of your devices'
                        ) : (
                          'runs while they have this app open'
                        )}
                      </span>
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                      {mine && (
                        <button
                          onClick={() =>
                            act(() =>
                              node.records.update(space.id, record.key, {
                                ...automation,
                                paused: !off,
                                since: off ? new Date().toISOString() : automation.since,
                              }),
                            )
                          }
                          data-variant="quiet"
                          style={styles.smallButton}
                        >
                          {off ? 'Turn on' : 'Pause'}
                        </button>
                      )}
                      {mine ? (
                        <button
                          onClick={() => setOpen({ kind: 'automation', editing: record })}
                          data-variant="quiet"
                          style={styles.smallButton}
                        >
                          Change
                        </button>
                      ) : (
                        space.writable && (
                          <button
                            onClick={() => setOpen({ kind: 'automation', copying: record })}
                            data-variant="quiet"
                            title="Save it as an automation of your own, which you can change"
                            style={styles.smallButton}
                          >
                            Make a copy
                          </button>
                        )
                      )}
                      {rules.deletable.has(record.key) && (
                        <button
                          onClick={() => {
                            void ask('It stops running, for everyone in the space.', {
                              title: `Delete the automation “${automation.name}”?`,
                              yes: 'Delete',
                              danger: true,
                            }).then((sure) => {
                              if (sure) act(() => node.records.delete(space.id, record.key));
                            });
                          }}
                          data-variant="danger"
                          aria-label={`Delete ${automation.name}`}
                          style={{ ...styles.smallButton, color: palette.accent.danger }}
                        >
                          Delete
                        </button>
                      )}
                    </div>
                  </div>
                  {runs.length > 0 && (
                    <ul
                      style={{
                        listStyle: 'none',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 3,
                        paddingLeft: 38,
                      }}
                    >
                      {runs.slice(0, 3).map((run) => (
                        <li
                          key={run.key}
                          style={{ fontSize: 12.5, display: 'flex', gap: 6, color: palette.ink.muted }}
                        >
                          <span style={{ color: run.body?.ok ? palette.accent.good : palette.accent.danger }}>
                            {run.body?.ok ? '✓' : '!'}
                          </span>
                          <span style={{ flex: 1, minWidth: 0 }}>{run.body?.did ?? 'Ran'}</span>
                          <span style={{ color: palette.ink.faint }}>{ago(run.updatedAt)}</span>
                        </li>
                      ))}
                      {runs.length > 3 && (
                        <li style={{ fontSize: 12, color: palette.ink.faint }}>
                          and {runs.length - 3} earlier
                        </li>
                      )}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {error && <p style={{ ...styles.error, fontSize: 13 }}>{error}</p>}

        {space.writable && starters.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
            <p style={styles.fieldLabel}>Ideas for {space.name}</p>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
                gap: 8,
              }}
            >
              {starters.map((idea) => (
                <button
                  key={idea.title}
                  onClick={() => setOpen({ kind: 'automation', start: idea.rule })}
                  data-tile
                  style={ideaTile}
                >
                  <Icon name="bolt" size={14} />
                  <span style={{ fontSize: 13.5, color: palette.ink.strong, lineHeight: 1.4 }}>
                    {idea.title}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </section>

      {open?.kind === 'automation' && (
        <AutomationBuilder
          space={space}
          collections={collections}
          {...(open.editing ? { editing: open.editing } : {})}
          {...(open.copying ? { copying: open.copying } : {})}
          {...(open.start ? { start: open.start } : {})}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}

const ruleCard = {
  ...styles.tile,
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  padding: 14,
} as const;
const ideaTile = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 10,
  padding: '12px 14px',
  // A suggestion to pick, as the site draws one: a softer edge than a card that is yours.
  borderRadius: palette.radius.lg,
  border: `1px solid ${palette.surface.lineStrong}`,
  background: palette.surface.card,
  color: palette.ink.muted,
  textAlign: 'left',
} as const;
