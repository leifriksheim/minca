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
import { AutomationBuilder } from './AutomationBuilder';
import { SpaceBots } from '@minca/app-shared/CommunitySetup';
import { useAction } from '@minca/app-shared/action';
import { useActivityOff } from '../../activity';
import { confirmThen } from '../../confirm';

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
    <>
      <div className="stack" data-gap="tight">
        <h2>Automations</h2>
        <p>
          Let {space.name} look after itself: close a poll once enough people voted, tell the chat when a task
          is done, have a bot sum up the week.
        </p>
      </div>

      <SpaceBots spaceId={space.id} writable={space.writable} />
      {shows.off && (
        <aside className="row" data-spread>
          <span>
            Nobody sees when a bot or agent is working on something here, so its answers arrive unannounced.
          </span>
          {shows.turnOn ? (
            <button type="button" data-intent="ghost" onClick={() => shows.turnOn && act(shows.turnOn)}>
              Show it
            </button>
          ) : (
            <small>Someone who may add collections can show it.</small>
          )}
        </aside>
      )}

      <section>
        <header>
          <div>
            <h3>Automations</h3>
            <small>
              Everyone here sees these. Each runs as its maker, on their devices or agent, or as the bot it
              names.
            </small>
          </div>
          <button
            data-intent="primary"
            onClick={() => setOpen({ kind: 'automation' })}
            disabled={!space.writable}
          >
            <Icon name="plus" size={13} /> New automation
          </button>
        </header>
        {rules === undefined ? null : rules.rules.length === 0 ? (
          <div className="empty">
            <p>No rules in {space.name} yet.</p>
          </div>
        ) : (
          <ul role="list">
            {rules.rules.map((record) => {
              const automation = automationOf(record)!;
              const mine = record.createdBy === did;
              // An automation written under a records-only note (an agent's) waits for its person to save it themselves.
              const suggested = record.recordsOnly === true;
              const off = automation.paused || suggested;
              const agentOnly = automation.then.kind === 'ask' || (!automation.when && !!automation.every);
              const runs = rules.runs.get(record.key) ?? [];
              return (
                <li key={record.key} className="stack">
                  <div className="row" data-spread>
                    <div className="stack" data-gap="tight">
                      <strong className="row" data-gap="tight">
                        <Icon name="bolt" size={14} />
                        {automation.name}
                      </strong>
                      <span>{ruleWords(automation, collections, who)}</span>
                      <small>
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
                      </small>
                    </div>
                    <div className="row" data-gap="tight">
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
                        >
                          {off ? 'Turn on' : 'Pause'}
                        </button>
                      )}
                      {mine ? (
                        <button onClick={() => setOpen({ kind: 'automation', editing: record })}>
                          Change
                        </button>
                      ) : (
                        space.writable && (
                          <button
                            onClick={() => setOpen({ kind: 'automation', copying: record })}
                            title="Save it as an automation of your own, which you can change"
                          >
                            Make a copy
                          </button>
                        )
                      )}
                      {rules.deletable.has(record.key) && (
                        <button
                          onClick={() =>
                            confirmThen(
                              'It stops running, for everyone in the space.',
                              { title: `Delete the automation “${automation.name}”?`, yes: 'Delete' },
                              () => act(() => node.records.delete(space.id, record.key)),
                            )
                          }
                          data-intent="danger"
                          aria-label={`Delete ${automation.name}`}
                        >
                          Delete
                        </button>
                      )}
                    </div>
                  </div>
                  {runs.length > 0 && (
                    <div className="stack" data-gap="tight">
                      {runs.slice(0, 3).map((run) => (
                        <small key={run.key}>
                          <span data-tone={run.body?.ok ? 'good' : 'danger'}>{run.body?.ok ? '✓' : '!'}</span>{' '}
                          {run.body?.did ?? 'Ran'} · {ago(run.updatedAt)}
                        </small>
                      ))}
                      {runs.length > 3 && <small>and {runs.length - 3} earlier</small>}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {error && <p role="alert">{error}</p>}

        {space.writable && starters.length > 0 && (
          <div className="stack">
            <h3>Ideas for {space.name}</h3>
            <div className="grid">
              {starters.map((idea) => (
                <button
                  key={idea.title}
                  onClick={() => setOpen({ kind: 'automation', start: idea.rule })}
                  data-intent="open"
                  className="row"
                >
                  <Icon name="bolt" size={14} />
                  {idea.title}
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
    </>
  );
}
