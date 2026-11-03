import { useEffect, useMemo, useState } from 'react';
import {
  RECORD_WRITE,
  SPACE_KEEPERS,
  type NodeCollection,
  type NodeRecord,
  type SpaceSummary,
} from '@minca/core';
import { useAccount, useAsync, useNode } from '@minca/react';
import { useMay, useMayDefine } from '@minca/app-shared/may';
import { Modal } from '@minca/app-shared/Modal';
import { AddBotDialog, useSpaceBots } from '@minca/app-shared/CommunitySetup';
import { clauseFields, clauseOn, type Clause, type ClauseField } from '../../derive/conditions';
import { belonging, collectionLabel, recordLabel } from '../../derive/schema-ui';
import { useBots } from '../../bots';
import { useAction } from '@minca/app-shared/action';
import { Loader } from '@minca/app-shared/Loader';
import { nameOf, type People } from '../../derive/people';
import {
  INSTRUCT,
  SCHEDULES,
  profile,
  checkCron,
  activity as activityCollection,
  matching,
  automation as ruleCollection,
  automationOf,
  automationRun as runCollection,
  type Automation,
  type AutomationAction,
} from '@minca/core/schemas';
import {
  ACTIONS,
  COUNT_OPS,
  addAction,
  addable,
  linkToIt,
  type AddTarget,
  compile,
  noun,
  pickedOf,
  places,
  scheduleWords,
  thenWords,
  whenWords,
  type CountClause,
  type Picked,
  type PickedRule,
  type Within,
} from '../../automations';
import { usePeopleHere } from '../Person';
import { ClauseList, Pill, PlacePill, Sentence, Step, ValueInput } from './parts';

/** In the schedule picker, a time of one's own */
const OTHER = 'other';

/** A rule picked from the space's own definitions: when a record is some way, or at set times, do one thing */
export function AutomationBuilder({
  space,
  collections,
  editing,
  copying,
  start,
  onClose,
}: {
  space: SpaceSummary;
  collections: ReadonlyArray<NodeCollection>;
  /** An automation to change, instead of making one */
  editing?: NodeRecord;
  /** Someone else's automation, which starts a new one of yours */
  copying?: NodeRecord;
  /** Where a new one starts: an idea picked from the list */
  start?: PickedRule;
  onClose: () => void;
}) {
  const node = useNode();
  const { did } = useAccount();
  const mayDefine = useMayDefine(space.id);
  const mayManage = useMay(space.id, SPACE_KEEPERS);
  const here = usePeopleHere();
  const people: People = here?.people ?? new Map();
  const from = editing ?? copying;
  const stored = from ? automationOf(from) : null;
  const picked = stored ? pickedOf(stored) : (start?.picked ?? null);
  const initial = stored ?? start;

  const offered = useMemo(
    () =>
      collections.filter(
        (c) =>
          c.schema !== null &&
          c.version !== null &&
          c.name !== ruleCollection.name &&
          c.name !== runCollection.name,
      ),
    [collections],
  );
  const [collection, setCollection] = useState(picked?.collection ?? offered[0]?.name ?? '');
  const [addingBot, setAddingBot] = useState(false);
  const [clauses, setClauses] = useState<ReadonlyArray<Clause>>(picked?.clauses ?? []);
  const [within, setWithin] = useState<ReadonlyArray<Within>>(picked?.within ?? []);
  const [count, setCount] = useState<CountClause | null>(picked?.count ?? null);
  const [then, setThen] = useState<AutomationAction>(initial?.then ?? { kind: 'notify', text: '{title}' });
  const [name, setName] = useState<string | null>(initial?.name ?? null);
  // Set off by records, or by the time: an agent or a bot runs the latter.
  const [timed, setTimed] = useState(!!stored && !stored.when && !!stored.every);
  const [every, setEvery] = useState(stored?.every ?? SCHEDULES[0]!.value);
  const [ownTime, setOwnTime] = useState(!SCHEDULES.some((s) => s.value === every));
  const everyProblem = timed ? checkCron(every) : null;
  // The bots the space's host runs, whoever says so on their own profile here, and the one an automation being changed names.
  const saidBots = useBots(space.id);
  const { bots: known } = useSpaceBots(space.id, space.writable);
  const bots = [
    ...new Set([...known.map((bot) => bot.did), ...saidBots, ...(stored?.by ? [stored.by] : [])]),
  ].map((d) => ({ did: d, name: known.find((bot) => bot.did === d)?.name ?? nameOf(d, people) }));
  // Who does it, for an automation that asks or runs at set times: their own agent, or a bot here. A new
  // automation starts with the space's bot, one the host runs first: the agent needs a computer left on.
  const [chosenBy, setBy] = useState<string | null>(stored ? (stored.by ?? '') : null);
  const by = chosenBy ?? known.find((bot) => bot.state === 'on')?.did ?? bots[0]?.did ?? '';
  const { run, busy, error, setError } = useAction();

  const chosen = offered.find((c) => c.name === collection);
  const fields = useMemo(() => (chosen ? clauseFields(chosen) : []), [chosen]);
  const countable = useMemo(
    () => (collection ? belonging(collections, collection) : []),
    [collections, collection],
  );
  const countFields = useMemo(() => {
    const counted = collections.find((c) => c.name === count?.collection);
    return counted ? clauseFields(counted) : [];
  }, [collections, count?.collection]);

  const where = useMemo(() => (collection ? places(collections, collection) : []), [collections, collection]);
  const when = useMemo(
    (): Picked => ({
      collection,
      clauses,
      ...(within.length ? { within } : {}),
      ...(count ? { count } : {}),
    }),
    [collection, clauses, within, count],
  );
  const who = (d: string) => nameOf(d, people);
  const sentence = timed
    ? `${scheduleWords(every)}, ${thenWords(then, collections, collection)}.`
    : chosen
      ? `${whenWords(when, collections, who)}, ${thenWords(then, collections, collection)}.`
      : '';
  const shownName =
    name ?? (timed ? scheduleWords(every) : chosen ? `${collectionLabel(chosen)} automation` : 'Automation');

  const has = (n: string) => collections.some((c) => c.name === n && c.version !== null);
  const settable = fields.filter((f) => ['choice', 'yesno', 'number', 'text'].includes(f.kind));
  const targets = useMemo(
    () =>
      timed
        ? // Nothing set it off, so there is nothing to link to.
          addable(collections, '').map((t) => ({ ...t, links: [] }))
        : collection
          ? addable(collections, collection)
          : [],
    [collections, collection, timed],
  );
  const agentDoes = then.kind === 'ask' || timed;
  const botName = by ? (bots.find((b) => b.did === by)?.name ?? nameOf(by, people)) : null;
  // A bot runs a member's automations only while they may instruct it here.
  const mayInstruct = useMay(space.id, INSTRUCT);
  // Whether this account may change only what it added there, by its grants.
  const changesOthers = useMay(space.id, RECORD_WRITE, { collection: chosen?.name ?? '', byCreator: false });
  const onlyTheirs = !!chosen && !changesOthers;

  // What it holds for right now: shown, never acted on — an automation acts on what changes after it's made.
  const settled = useSettled(when, 250);
  const lookup = useAsync(async () => {
    if (!settled.collection) return null;
    const matches = await matching(node, space.id, compile(settled), did, 100).catch(() => []);
    return { for: settled, matches };
  }, [node, space.id, settled, did]);
  const preview = lookup.status === 'done' && lookup.value?.for === when ? lookup.value.matches : null;

  const save = async () => {
    if (!chosen && !timed) return;
    setError(null);
    if (everyProblem) return setError(`When: ${everyProblem}`);
    if (agentDoes && by && !mayInstruct)
      return setError(`${botName ?? 'That bot'} only runs automations of people who may instruct it here.`);
    if (then.kind !== 'set' && !then.text.trim()) return setError('Say what it should say');
    if (count && !Number.isFinite(count.value)) return setError('Say how many');
    await run(async () => {
      for (const definition of [ruleCollection, runCollection]) {
        if (has(definition.name)) continue;
        if (!mayDefine)
          throw new Error(
            'Automations aren’t set up in this space yet: someone who can add collections needs to make the first one.',
          );
        await node.collections.define(space.id, definition);
      }
      // Where the agent or bot says it is working on what set the automation off, for apps to show; not needed to run.
      if (agentDoes && !has(activityCollection.name) && mayDefine)
        await node.collections.define(space.id, activityCollection).catch(() => {});
      const body: Automation = {
        name: shownName.trim() || 'Automation',
        ...(timed ? { every: every.trim() } : { when: compile(when), picked: when }),
        then,
        ...(agentDoes && by ? { by } : {}),
        // An automation made elsewhere that has both keeps its time when its records are changed here.
        ...(!timed && stored?.every ? { every: stored.every } : {}),
        ...(editing && stored?.paused ? { paused: true } : {}),
        since: new Date().toISOString(),
      };
      if (editing) await node.records.update(space.id, editing.key, body);
      else await node.records.put(space.id, ruleCollection.name, body);
      onClose();
    });
  };

  return (
    <>
      <Modal
        title={editing ? 'Change automation' : copying ? 'Copy automation' : 'New automation'}
        onClose={onClose}
        width={680}
      >
        <p>
          Something happens in {space.name}, or the time comes, and something is done about it — as you, or by
          a bot you name.
        </p>

        <article>
          <Step label="When">
            <div className="row" data-gap="tight">
              {[
                { value: false, label: 'Something happens' },
                { value: true, label: 'At set times' },
              ].map((choice) => (
                <button
                  key={choice.label}
                  type="button"
                  aria-pressed={timed === choice.value}
                  onClick={() => {
                    setTimed(choice.value);
                    // Nothing set it off, so nothing to notify about on this device, nor to change.
                    if (choice.value && (then.kind === 'set' || then.kind === 'notify'))
                      setThen({ kind: 'ask', text: '' });
                    if (choice.value && then.kind === 'add') setThen(addAction(then.collection, then.text));
                  }}
                >
                  {choice.label}
                </button>
              ))}
            </div>
            {timed ? (
              <>
                <Sentence>
                  <Pill
                    label="When"
                    value={ownTime ? OTHER : every}
                    options={[
                      ...SCHEDULES.map((s) => ({ value: s.value, label: s.label.toLowerCase() })),
                      { value: OTHER, label: 'at a time of my own' },
                    ]}
                    onChange={(picked) => {
                      setOwnTime(picked === OTHER);
                      if (picked !== OTHER) setEvery(picked);
                    }}
                  />
                </Sentence>
                {ownTime && (
                  <label>
                    <input
                      aria-label="Minute hour day month weekday"
                      value={every}
                      onChange={(e) => setEvery(e.target.value)}
                      placeholder="30 7 * * 1-5"
                    />
                    {everyProblem ? (
                      <span role="alert">{everyProblem}</span>
                    ) : (
                      <small>
                        Minute, hour, day, month, weekday, in the runner’s local time: 30 7 * * 1-5 is
                        weekdays at 7:30.
                      </small>
                    )}
                  </label>
                )}
              </>
            ) : (
              <>
                <Sentence>
                  <span>a</span>
                  <Pill
                    label="What"
                    value={collection}
                    options={offered.map((c) => ({ value: c.name, label: collectionLabel(c).toLowerCase() }))}
                    onChange={(next) => {
                      setCollection(next);
                      setClauses([]);
                      setWithin([]);
                      setCount(null);
                      if (then.kind === 'set') setThen({ kind: 'notify', text: '{title}' });
                      // What a new record can point at depends on what the automation is about
                      if (then.kind === 'add') {
                        const links = addable(collections, next).find(
                          (t) => t.collection.name === then.collection,
                        )?.links;
                        const link = linkToIt(then);
                        setThen(
                          addAction(
                            then.collection,
                            then.text,
                            link && links?.includes(link) ? link : links?.[0],
                          ),
                        );
                      }
                    }}
                  />
                  {where.map((place) => (
                    <PlacePill
                      key={place.rel}
                      spaceId={space.id}
                      collections={collections}
                      place={place}
                      picked={within.find((w) => w.rel === place.rel) ?? null}
                      onChange={(next) =>
                        setWithin([...within.filter((w) => w.rel !== place.rel), ...(next ? [next] : [])])
                      }
                    />
                  ))}
                  {count ? (
                    <>
                      <span>has</span>
                      <Pill
                        label="How many"
                        value={count.op}
                        options={COUNT_OPS.map((o) => ({ value: o.op, label: o.label }))}
                        onChange={(op) => setCount({ ...count, op })}
                      />
                      <input
                        aria-label="Number"
                        type="number"
                        min={0}
                        value={Number.isFinite(count.value) ? count.value : ''}
                        onChange={(e) =>
                          setCount({ ...count, value: e.target.value === '' ? NaN : Number(e.target.value) })
                        }
                      />
                      <Pill
                        label="Of what"
                        value={`${count.collection} ${count.rel}`}
                        options={countable.map((a) => ({
                          value: `${a.collection.name} ${a.rel}`,
                          label: noun(collections, a.collection.name, true),
                        }))}
                        onChange={(picked) => {
                          const [c, rel] = picked.split(' ');
                          if (c && rel) setCount({ ...count, collection: c, rel, clauses: [] });
                        }}
                      />
                      <button
                        type="button"
                        onClick={() => setCount(null)}
                        aria-label="Stop counting"
                        data-intent="quiet"
                        data-icon
                      >
                        ✕
                      </button>
                    </>
                  ) : (
                    <span>is added or changed</span>
                  )}
                </Sentence>
                {!count && countable.length > 0 && (
                  <div className="row" data-gap="tight">
                    {countable.slice(0, 3).map((a) => (
                      <button
                        key={`${a.collection.name} ${a.rel}`}
                        type="button"
                        onClick={() =>
                          setCount({ collection: a.collection.name, rel: a.rel, op: 'atLeast', value: 10 })
                        }
                      >
                        + gets a number of {noun(collections, a.collection.name, true)}
                      </button>
                    ))}
                  </div>
                )}
                {count && countFields.length > 0 && (
                  <details open={!!count.clauses?.length} className="stack">
                    <summary>Count only some {noun(collections, count.collection, true)}</summary>
                    <ClauseList
                      fields={countFields}
                      clauses={count.clauses ?? []}
                      onChange={(next) => setCount({ ...count, clauses: next })}
                      people={people}
                      me={did}
                      suggest={false}
                    />
                  </details>
                )}
              </>
            )}
          </Step>

          {!timed && (
            <Step label="Only if">
              <ClauseList
                fields={fields}
                clauses={clauses}
                onChange={setClauses}
                people={people}
                me={did}
                empty={`Any ${chosen ? collectionLabel(chosen).toLowerCase() : 'record'}, or narrow it down:`}
              />
            </Step>
          )}

          <Step label="Then">
            <div className="stack" data-gap="tight">
              {ACTIONS.map((action) => {
                const untimed = timed && (action.kind === 'set' || action.kind === 'notify');
                const unusable =
                  untimed ||
                  (action.kind === 'set' && settable.length === 0) ||
                  (action.kind === 'add' && targets.length === 0);
                const on = then.kind === action.kind;
                return (
                  <label
                    key={action.kind}
                    title={
                      !unusable
                        ? action.hint
                        : untimed
                          ? 'At set times nothing set it off, and an agent, not this device, runs it'
                          : action.kind === 'add'
                            ? 'Nothing in this space can be added from a line of text'
                            : 'Nothing here it could change'
                    }
                  >
                    <input
                      type="radio"
                      name="then"
                      checked={on}
                      disabled={unusable}
                      onChange={() => setThen(startAction(action.kind, settable, targets, then))}
                    />
                    <strong>{action.label}</strong>
                    <small>
                      {timed && action.kind === 'add' ? 'A record in any collection here' : action.hint}
                    </small>
                  </label>
                );
              })}
            </div>
            <ActionDetail
              then={then}
              onChange={setThen}
              settable={settable}
              counting={!!count}
              about={!timed}
              targets={targets}
              collections={collections}
              people={people}
              me={did}
            />
            {then.kind === 'set' && onlyTheirs && chosen && (
              <small>
                Only whoever made a {collectionLabel(chosen).toLowerCase()} can change it, so this works on
                the ones you made.
              </small>
            )}
            {agentDoes && (
              <Sentence>
                <span>Done by</span>
                <Pill
                  label="Who does it"
                  value={by}
                  options={[
                    { value: '', label: 'my own agent' },
                    ...bots.map((bot) => ({ value: bot.did, label: bot.name })),
                  ]}
                  onChange={setBy}
                />
                <span>
                  {by
                    ? 'as itself, while it runs'
                    : 'as you, while minca agent runs on one of your computers'}
                </span>
              </Sentence>
            )}
            {agentDoes && !has(profile.name) && (
              <small>
                A bot run with <code>minca agent --bot</code> shows up here once {space.name} keeps profiles,
                where it says it is one.{' '}
                {space.writable && mayDefine ? (
                  <button
                    type="button"
                    data-intent="inline"
                    onClick={() => void run(() => node.collections.define(space.id, profile))}
                  >
                    Turn on profiles
                  </button>
                ) : (
                  'Someone who may add collections can turn them on.'
                )}
              </small>
            )}
            {agentDoes && bots.length === 0 && has(profile.name) && (
              <small>
                No bots in {space.name} yet.{' '}
                {space.writable && mayManage ? (
                  <button type="button" data-intent="inline" onClick={() => setAddingBot(true)}>
                    Add a bot
                  </button>
                ) : (
                  'Someone who manages it can add one, under Hosting, or run one with minca agent --bot.'
                )}
              </small>
            )}
            {agentDoes && by && !mayInstruct && (
              <p role="alert">
                {botName} only runs the rules of people who may instruct it here, and you may not. Someone who
                manages {space.name} can let your role, or make this rule themselves.
              </p>
            )}
          </Step>
        </article>

        {timed ? (
          <aside className="stack" data-gap="tight">
            <strong>{sentence}</strong>
            <small>
              {by ? `${botName} does it` : 'Your agent does it'} at those times, in its local time, while it
              runs. This app doesn’t run automations at set times.
            </small>
          </aside>
        ) : (
          chosen && (
            <aside className="stack" data-gap="tight">
              <strong>{sentence}</strong>
              {preview === null ? (
                <Loader label="Looking at what's here" showLabel />
              ) : preview.length === 0 ? (
                <small>Nothing here matches yet.</small>
              ) : (
                <small>
                  Right now {preview.length === 1 ? 'one matches' : `${preview.length} match`}:{' '}
                  {preview
                    .slice(0, 3)
                    .map(
                      (m) =>
                        `“${recordLabel(m.record, chosen.schema)}”${typeof m.included.count === 'number' ? ` (${m.included.count})` : ''}`,
                    )
                    .join(', ')}
                  {preview.length > 3 ? '…' : ''}. It acts only on what changes from now on.
                </small>
              )}
            </aside>
          )
        )}

        <label>
          Name
          <input value={shownName} maxLength={120} onChange={(e) => setName(e.target.value)} />
        </label>

        <small>
          {agentDoes
            ? by
              ? `${botName} runs it, as itself.`
              : 'Your agent runs it, as you, while minca agent runs on one of your computers.'
            : 'It runs on your devices while this app is open on one of them.'}{' '}
          Everyone in {space.name} can see the rule and what it did.
        </small>
        {error && <p role="alert">{error}</p>}

        <div className="row">
          <button onClick={onClose}>Cancel</button>
          <button data-intent="primary" onClick={() => void save()} disabled={(!chosen && !timed) || busy}>
            {busy ? 'Saving…' : editing ? 'Save automation' : 'Turn on automation'}
          </button>
        </div>
      </Modal>
      {addingBot && (
        <AddBotDialog spaceId={space.id} writable={space.writable} onClose={() => setAddingBot(false)} />
      )}
    </>
  );
}

/** A new action of a kind, keeping the words already typed */
function startAction(
  kind: AutomationAction['kind'],
  settable: ReadonlyArray<ClauseField>,
  targets: ReadonlyArray<AddTarget>,
  was: AutomationAction,
): AutomationAction {
  const text = 'text' in was ? was.text : '{title}';
  if (kind === 'notify' || kind === 'ask') return { kind, text };
  if (kind === 'add') {
    const target = targets[0]!;
    return addAction(target.collection.name, text, target.links[0]);
  }
  const field = settable[0]!;
  const first = clauseOn(field);
  return { kind, field: field.name, value: first.value ?? (field.kind === 'number' ? 0 : '') };
}

/** What the picked action needs said: its words, or which field to set to what */
function ActionDetail({
  then,
  onChange,
  settable,
  counting,
  about,
  targets,
  collections,
  people,
  me,
}: {
  then: AutomationAction;
  onChange: (then: AutomationAction) => void;
  settable: ReadonlyArray<ClauseField>;
  counting: boolean;
  /** A record set it off, so its name can go in the words */
  about: boolean;
  targets: ReadonlyArray<AddTarget>;
  collections: ReadonlyArray<NodeCollection>;
  people: People;
  me: string;
}) {
  if (then.kind === 'set') {
    const field = settable.find((f) => f.name === then.field) ?? settable[0];
    if (!field) return null;
    return (
      <Sentence>
        <span>Set its</span>
        <Pill
          label="Field to set"
          value={field.name}
          options={settable.map((f) => ({ value: f.name, label: f.label.toLowerCase() }))}
          onChange={(name) => {
            const next = settable.find((f) => f.name === name);
            if (next) onChange(startAction('set', [next], [], then));
          }}
        />
        <span>to</span>
        <ValueInput
          field={field}
          clause={{ field: field.name, op: 'is', value: then.value }}
          people={people}
          me={me}
          onChange={(patch) => {
            if (patch.value !== undefined) onChange({ ...then, value: patch.value });
          }}
        />
      </Sentence>
    );
  }
  const insert = (token: string) =>
    onChange({ ...then, text: `${then.text}${then.text.endsWith(' ') || !then.text ? '' : ' '}${token}` });
  const target = then.kind === 'add' ? targets.find((t) => t.collection.name === then.collection) : undefined;
  return (
    <div className="stack">
      {then.kind === 'add' && (
        <Sentence>
          <span>Add a</span>
          <Pill
            label="What to add"
            value={then.collection}
            options={targets.map((t) => ({
              value: t.collection.name,
              label: collectionLabel(t.collection).toLowerCase(),
            }))}
            onChange={(name) => {
              const next = targets.find((t) => t.collection.name === name);
              if (next) onChange(startAction('add', [], [next], then));
            }}
          />
          {target && target.links.length > 0 && (
            <Pill
              label="Linked"
              value={linkToIt(then) ?? ''}
              options={[
                ...target.links.map((rel) => ({ value: rel, label: `about it (${rel})` })),
                { value: '', label: 'on its own' },
              ]}
              onChange={(rel) => onChange(addAction(then.collection, then.text, rel || undefined))}
            />
          )}
          {target === undefined && (
            <span>({noun(collections, then.collection, true)} can’t be added here)</span>
          )}
        </Sentence>
      )}
      <input
        aria-label="What it says"
        value={then.text}
        onChange={(e) => onChange({ ...then, text: e.target.value })}
        placeholder="What it says"
        maxLength={500}
      />
      {about && (
        <div className="row" data-gap="tight">
          <small>Insert</small>
          <button type="button" onClick={() => insert('{title}')} className="tag">
            its name
          </button>
          {counting && (
            <button type="button" onClick={() => insert('{count}')} className="tag">
              the count
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** The value once it has stopped changing for `ms` */
function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}
