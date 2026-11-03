import { useState, type ReactNode } from 'react';
import { useNode } from '@minca/react';
import { Modal } from '@minca/app-shared/Modal';
import type { Assembly, ProposalView, RollView } from './model';
import {
  CHOICES,
  MAX_CITED,
  MAX_VOTERS,
  proposal as proposalCollection,
  support,
  vote,
  type Choice,
} from './schema';
import {
  RULES,
  majority,
  needed,
  ruleName,
  trail,
  type Next,
  type PartyStand,
  type Result,
  type RuleId,
  type Step,
  type Tally,
} from './tally';
import {
  CHOICE_LABEL,
  Empty,
  Meter,
  PartyChip,
  PathView,
  Problem,
  TopicChip,
  TopicPicker,
  Upvote,
  Who,
  ago,
} from './ui';
import { useAction } from '@minca/app-shared/action';
import styles from './Proposals.module.css';

type Sort = 'top' | 'new' | 'decided';

export function Proposals({ a, writable }: { a: Assembly; writable: boolean }) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [filter, setFilter] = useState<string | null>(null);
  const [sort, setSort] = useState<Sort>('top');
  const [composing, setComposing] = useState(false);

  const opened = openKey ? a.proposals.find((p) => p.key === openKey) : undefined;
  if (opened) return <ProposalPage a={a} p={opened} writable={writable} onBack={() => setOpenKey(null)} />;

  const shown = a.proposals
    .filter((p) => (sort === 'decided' ? p.result !== 'open' : p.result === 'open'))
    .filter((p) => filter === null || p.topic === filter)
    .sort((x, y) =>
      sort === 'top'
        ? y.supporters.size - x.supporters.size || y.createdAt.localeCompare(x.createdAt)
        : y.createdAt.localeCompare(x.createdAt),
    );

  return (
    <div className="stack" data-gap="loose">
      <div className="row" data-spread>
        <div role="group" aria-label="Sort" className="row" data-gap="tight">
          {(
            [
              ['top', 'Top'],
              ['new', 'New'],
              ['decided', 'Decided'],
            ] as const
          ).map(([id, label]) => (
            <button key={id} aria-pressed={sort === id} onClick={() => setSort(id)}>
              {label}
            </button>
          ))}
        </div>
        {writable && (
          <button data-intent="primary" onClick={() => setComposing(true)}>
            New proposal
          </button>
        )}
      </div>

      {a.topics.length > 0 && (
        <div className={styles.scroll} role="group" aria-label="Topic">
          <button aria-pressed={filter === null} onClick={() => setFilter(null)}>
            All topics
          </button>
          <TopicPicker
            topics={a.topics}
            on={(t) => filter === t.key}
            onToggle={(t) => setFilter(filter === t.key ? null : t.key)}
          />
        </div>
      )}

      {shown.length === 0 ? (
        <Empty title={sort === 'decided' ? 'Nothing decided yet' : 'No open proposals'}>
          {sort !== 'decided' && writable && (
            <>
              <p>Put something to the assembly. Anyone can support it, so the important ones rise.</p>
              <button onClick={() => setComposing(true)}>Write a proposal</button>
            </>
          )}
        </Empty>
      ) : (
        <div className="stack">
          {shown.map((p) => (
            <ProposalCard key={p.key} a={a} p={p} writable={writable} onOpen={() => setOpenKey(p.key)} />
          ))}
        </div>
      )}

      {composing && (
        <Compose
          a={a}
          initialTopic={filter}
          onClose={() => setComposing(false)}
          onDone={(key) => {
            setComposing(false);
            setOpenKey(key);
          }}
        />
      )}
    </div>
  );
}

/** Supporting a proposal, or taking it back */
function Support({ a, p, writable }: { a: Assembly; p: ProposalView; writable: boolean }) {
  const node = useNode();
  const action = useAction();
  const toggle = () =>
    void action.run(() =>
      p.mySupportKey
        ? node.records.delete(a.spaceId, p.mySupportKey)
        : node.records.put(a.spaceId, support, {}, { links: [{ rel: 'about', to: p.key }] }),
    );
  return (
    <Upvote
      count={p.supporters.size}
      pressed={p.mySupportKey !== null}
      disabled={!writable || action.busy || p.result !== 'open'}
      onToggle={toggle}
    />
  );
}

function ProposalCard({
  a,
  p,
  writable,
  onOpen,
}: {
  a: Assembly;
  p: ProposalView;
  writable: boolean;
  onOpen: () => void;
}) {
  const totals = a.countOf(p);
  const topic = a.topicOf(p.topic);

  return (
    <article
      className={styles.card}
      onClick={onOpen}
      onKeyDown={(event) => event.key === 'Enter' && onOpen()}
      tabIndex={0}
      aria-label={p.title}
    >
      <Support a={a} p={p} writable={writable} />
      <div className="stack">
        <div className="row">
          {topic && <TopicChip topic={topic} />}
          <small>
            {a.name(p.createdBy)} · {ago(p.createdAt)}
          </small>
          <Verdict result={p.result} />
        </div>
        <h2>{p.title}</h2>
        <Meter tally={totals} />
        <div className="row" data-spread>
          <Numbers tally={totals} />
          {writable && <MyVotePill a={a} p={p} />}
        </div>
      </div>
    </article>
  );
}

function Numbers({ tally }: { tally: Tally }) {
  const voters = tally.for + tally.against + tally.abstain + tally.uncast;
  return (
    <small className={styles.numbers}>
      <span>
        <b data-choice="for">{tally.for}</b> for
      </span>
      <span>
        <b data-choice="against">{tally.against}</b> against
      </span>
      {tally.abstain > 0 && <span>{tally.abstain} abstain</span>}
      <span>
        of {voters} {voters === 1 ? 'voter' : 'voters'}
      </span>
    </small>
  );
}

const VERDICT: Readonly<Record<Exclude<Result, 'open'>, { label: string; tone: string }>> = {
  passed: { label: 'Passed', tone: 'good' },
  rejected: { label: 'Rejected', tone: 'danger' },
  disputed: { label: 'Disputed', tone: 'warn' },
};

function Verdict({ result }: { result: Result }) {
  if (result === 'open') return null;
  const v = VERDICT[result];
  return (
    <span className="tag" data-tone={v.tone}>
      {v.label}
    </span>
  );
}

/** Where your vote stands on a proposal, in a few words */
function MyVotePill({ a, p }: { a: Assembly; p: ProposalView }) {
  const mine = p.votes.get(a.me);
  if (!p.voters.includes(a.me)) return <span className="tag">Not a voter</span>;
  if (!mine)
    return <span className="tag">{p.result === 'open' ? 'You haven’t voted' : 'You didn’t vote'}</span>;
  const last = trail(a.me, p.votes)[0];
  const via = !last
    ? null
    : last.kind === 'person'
      ? a.name(last.did)
      : (a.partyOf(last.key)?.name ?? 'a party');
  return (
    <span className="tag" data-choice={mine.choice}>
      <span className={styles.dot} />
      {via ? `${CHOICE_LABEL[mine.choice]} via ${via}` : `You: ${CHOICE_LABEL[mine.choice]}`}
    </span>
  );
}

function ProposalPage({
  a,
  p,
  writable,
  onBack,
}: {
  a: Assembly;
  p: ProposalView;
  writable: boolean;
  onBack: () => void;
}) {
  const node = useNode();
  const action = useAction();
  const [confirming, setConfirming] = useState<Choice | null>(null);
  const topic = a.topicOf(p.topic);

  const cast = (choice: Choice) =>
    void action.run(async () => {
      await node.records.put(a.spaceId, vote, { choice }, { links: [{ rel: 'about', to: p.key }] });
      setConfirming(null);
    });

  return (
    <div className="stack" data-gap="loose">
      <button className={styles.back} data-intent="ghost" onClick={onBack}>
        ← All proposals
      </button>
      <div className={styles.two}>
        <div className="stack" data-gap="loose">
          <div className={styles.head}>
            <Support a={a} p={p} writable={writable} />
            <div className="stack">
              <div className="row">
                {topic && <TopicChip topic={topic} />}
                <Verdict result={p.result} />
              </div>
              <h1>{p.title}</h1>
              {p.createdBy && (
                <small className="row" data-gap="tight">
                  <Who did={p.createdBy} a={a} size={18} /> · {ago(p.createdAt)}
                </small>
              )}
            </div>
          </div>
          {p.body && <p className={styles.body}>{p.body}</p>}

          {p.result === 'disputed' && <Disputes a={a} p={p} />}
          {writable && <VotePanel a={a} p={p} busy={action.busy} onPick={setConfirming} />}
          <Problem>{action.error}</Problem>
          <PartyStands a={a} p={p} />
          <Breakdown a={a} p={p} />
        </div>

        <div className={styles.side}>
          <Results a={a} p={p} />
        </div>
      </div>

      {confirming && (
        <Modal
          title={`Vote ${CHOICE_LABEL[confirming].toLowerCase()}?`}
          onClose={() => setConfirming(null)}
          width={420}
        >
          <p>
            Votes are final. Once cast, you can’t change it or take it back, so that a result, once reached,
            stays reached on every device.
          </p>
          <div className={`row ${styles.actions}`}>
            <button data-intent="ghost" onClick={() => setConfirming(null)}>
              Cancel
            </button>
            <button data-intent="primary" disabled={action.busy} onClick={() => cast(confirming)}>
              Vote {CHOICE_LABEL[confirming].toLowerCase()}
            </button>
          </div>
          <Problem>{action.error}</Problem>
        </Modal>
      )}
    </div>
  );
}

/** Your vote: cast it, see the one you cast, or see whom your device will follow */
function VotePanel({
  a,
  p,
  busy,
  onPick,
}: {
  a: Assembly;
  p: ProposalView;
  busy: boolean;
  onPick: (choice: Choice) => void;
}) {
  const mine = p.votes.get(a.me) ?? null;
  const voter = p.voters.includes(a.me);
  const topic = a.topicOf(p.topic);

  if (!voter)
    return (
      <aside>
        You’re not one of its {p.voters.length} voters. They were picked from the members when it was
        proposed, and stay fixed.
      </aside>
    );

  return (
    <article>
      <h2>Your vote</h2>
      <div className={styles.votes} role="group" aria-label="Cast your vote">
        {CHOICES.map((choice) => {
          const pressed = mine?.choice === choice;
          return (
            <button
              key={choice}
              data-choice={choice}
              aria-pressed={pressed}
              disabled={busy || mine !== null || p.result !== 'open'}
              onClick={() => onPick(choice)}
            >
              <span className="row" data-gap="tight">
                <span className={styles.dot} />
                {CHOICE_LABEL[choice]}
              </span>
              <small>{pressed ? (mine?.via ? 'Followed' : 'Your vote') : ' '}</small>
            </button>
          );
        })}
      </div>
      {mine ? (
        <CastNote a={a} p={p} />
      ) : p.result !== 'open' ? (
        <SettledNote next={a.nextFor(p)} />
      ) : (
        <NextNote a={a} next={a.nextFor(p)} topicName={topic?.name ?? null} />
      )}
    </article>
  );
}

/** A vote's way, and a sentence about it */
function PathNote({
  a,
  path,
  warn,
  children,
}: {
  a: Assembly;
  path: ReadonlyArray<Step>;
  warn?: boolean;
  children: string;
}) {
  return (
    <aside className="stack" data-tone={warn ? 'warn' : undefined}>
      <PathView path={path} a={a} from={a.me} />
      <span>{children}</span>
    </aside>
  );
}

function Quiet({ children }: { children: ReactNode }) {
  return <small>{children}</small>;
}

/** The vote you cast, and the way it came */
function CastNote({ a, p }: { a: Assembly; p: ProposalView }) {
  const path = trail(a.me, p.votes);
  if (path.length === 0) return <Quiet>You voted yourself. It’s final.</Quiet>;
  return (
    <PathNote a={a} path={path}>
      Your device cast this for you, following who you trust. It’s final.
    </PathNote>
  );
}

/** Settled before you voted: your device may still follow, for the record, but nothing changes it */
function SettledNote({ next }: { next: Next }) {
  if (next.kind === 'cast')
    return (
      <Quiet>
        It was settled before your vote arrived. Your device is casting{' '}
        {CHOICE_LABEL[next.choice].toLowerCase()} for you, following who you trust, so the record shows where
        you stood. It doesn’t change the result.
      </Quiet>
    );
  return <Quiet>It was settled before you voted. Votes cast now don’t change it.</Quiet>;
}

/** What your device will do, in words */
function NextNote({ a, next, topicName }: { a: Assembly; next: Next; topicName: string | null }) {
  if (next.kind === 'cast')
    return (
      <Quiet>
        Your device is casting {CHOICE_LABEL[next.choice].toLowerCase()} for you, following who you trust.
      </Quiet>
    );
  if (next.how === 'unset')
    return (
      <Quiet>
        You don’t trust anyone {topicName ? `on ${topicName}` : 'on this'}, so nobody votes for you. Set that
        up under <b>Your vote</b>.
      </Quiet>
    );
  return (
    <PathNote a={a} path={next.path} warn={next.how !== 'waiting'}>
      {NEXT_SAYS[next.how]}
    </PathNote>
  );
}

const NEXT_SAYS = {
  waiting:
    'When they vote, your device casts the same vote for you, unless you vote first. Liquid has to be open on one of your devices for that.',
  loop: 'These delegations loop back round, so unless someone on it votes themselves, nobody does. Vote yourself, or trust someone else.',
  stopped: 'It reaches someone who doesn’t vote on this proposal, so nobody votes for you.',
  disputed: 'The party said two different things about who its members are here, so nobody follows it.',
};

/** Who said two things, and what that means */
function Disputes({ a, p }: { a: Assembly; p: ProposalView }) {
  return (
    <aside className="stack" data-tone="warn">
      <span>
        <b>Disputed.</b> Someone signed two different versions of something this proposal counts. Every device
        shows it as disputed, whatever the count says:
      </span>
      {p.conflicts.map((c) => (
        <span key={c.record} className="row" data-gap="tight">
          {c.voter ? (
            <>
              <Who did={c.voter} a={a} size={18} /> voted two ways.
            </>
          ) : c.party && a.partyOf(c.party) ? (
            <>
              <PartyChip party={a.partyOf(c.party)!} /> froze two different member lists.
            </>
          ) : (
            'A vote or a party’s members, written two ways.'
          )}
        </span>
      ))}
    </aside>
  );
}

/** The count among the proposal's voters, and what it needs */
function Results({ a, p }: { a: Assembly; p: ProposalView }) {
  const shown = a.countOf(p);
  const coming = a.comingOf(p);
  const voters = p.voters.length;
  const need = needed(shown, p.toPass);
  const followed = [...p.votes.values()].filter((v) => v.via).length;
  const own = p.votes.size - followed;
  const comingCount = coming.for + coming.against + coming.abstain;
  return (
    <article>
      <div className="row" data-spread>
        <h3>{p.result === 'open' ? 'Standing now' : 'Result'}</h3>
        <small>
          {voters} {voters === 1 ? 'voter' : 'voters'}, as of {ago(p.createdAt)}
        </small>
      </div>
      <small>
        To pass:{' '}
        <b>
          {p.toPass} of {voters}
        </b>{' '}
        for{ruleName(p.toPass, voters) && ` (${ruleName(p.toPass, voters)?.toLowerCase()})`}
      </small>
      <Meter tally={shown} size="lg" />
      <div className={styles.counts}>
        {CHOICES.map((c) => (
          <div key={c} data-choice={c}>
            <strong>{shown[c]}</strong>
            <small>{CHOICE_LABEL[c]}</small>
          </div>
        ))}
      </div>
      <small>
        {own} voted themselves, {followed} by following someone, {shown.uncast} not yet.
        {comingCount > 0 && ` ${comingCount} more will follow once their devices are online.`}
      </small>
      {p.result === 'open' && voters > 0 && (
        <small>
          Passes with {need.toPass} more for. Fails with {need.toFail} more against or abstaining. Until one
          of those happens it stays open: there’s no deadline.
        </small>
      )}
      {p.result === 'passed' || p.result === 'rejected' ? (
        <aside data-tone="good">
          ✓ Settled, with a proof every device checks. No later vote can change it.
        </aside>
      ) : null}
    </article>
  );
}

/** Where each party stands on it, and how far it is from a position, by the rule its roll froze */
function PartyStands({ a, p }: { a: Assembly; p: ProposalView }) {
  const rolls = [...p.rolls].flatMap(([key, roll]) => {
    const party = a.partyOf(key);
    return party ? [{ party, roll, stand: p.stands.get(key) ?? null }] : [];
  });
  if (rolls.length === 0) return null;
  return (
    <section>
      <h3>Parties</h3>
      <ul role="list">
        {rolls.map(({ party, roll, stand }) => (
          <li key={party.key} className="row">
            <PartyChip party={party} />
            <small>{standText(a, roll, stand, p.votes)}</small>
            {stand && stand !== 'disputed' && <ChoicePill choice={stand} />}
          </li>
        ))}
      </ul>
    </section>
  );
}

function standText(a: Assembly, roll: RollView, stand: PartyStand, votes: ProposalView['votes']): string {
  if (stand === 'disputed') return 'disputed';
  const rep = roll.decides.representative;
  if (rep !== undefined) return stand ? `as ${a.name(rep)} voted` : `waiting for ${a.name(rep)} to vote`;
  const n = new Set(roll.members).size;
  if (stand) return `${roll.decides.toTake} of its ${n} members agreed`;
  const own = roll.members.flatMap((did) => {
    const v = votes.get(did);
    return v && v.via === null ? [v.choice] : [];
  });
  const most = Math.max(0, ...CHOICES.map((c) => own.filter((x) => x === c).length));
  return `${most} of the ${roll.decides.toTake} it needs agree so far, of ${n} members`;
}

/** Who voted, and through whom */
function Breakdown({ a, p }: { a: Assembly; p: ProposalView }) {
  const rows = [...p.votes]
    .filter(([did]) => p.voters.includes(did))
    .map(([did, cast]) => ({ did, cast, path: trail(did, p.votes) }))
    .sort((x, y) => x.path.length - y.path.length || a.name(x.did).localeCompare(a.name(y.did)));

  if (rows.length === 0) return <small>Nobody has voted yet.</small>;

  return (
    <section>
      <h3>How the votes came in</h3>
      <ul role="list">
        {rows.map(({ did, cast, path }) => (
          <li key={did} className="row">
            {path.length > 0 ? <PathView path={path} a={a} from={did} /> : <Who did={did} a={a} />}
            <ChoicePill choice={cast.choice} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function ChoicePill({ choice }: { choice: Choice }) {
  return (
    <span className={`tag ${styles.choice}`} data-choice={choice}>
      <span className={styles.dot} />
      {CHOICE_LABEL[choice]}
    </span>
  );
}

function Compose({
  a,
  initialTopic,
  onClose,
  onDone,
}: {
  a: Assembly;
  initialTopic: string | null;
  onClose: () => void;
  onDone: (key: string) => void;
}) {
  const node = useNode();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [topicKey, setTopicKey] = useState<string | null>(initialTopic ?? a.topics[0]?.key ?? null);
  // People vote unless left out; bots only when added. Kept as changes, so a bot list that loads late still applies.
  const [left, setLeft] = useState<ReadonlySet<string>>(new Set());
  const [added, setAdded] = useState<ReadonlySet<string>>(new Set());
  const [rule, setRule] = useState<RuleId | 'custom'>('majority');
  const [custom, setCustom] = useState(1);
  const action = useAction();

  const byName = (x: string, y: string) =>
    x === a.me ? -1 : y === a.me ? 1 : a.name(x).localeCompare(a.name(y));
  const everyone = a.members.map((m) => m.did);
  const people = everyone.filter((did) => !a.bots.has(did)).sort(byName);
  const bots = everyone.filter((did) => a.bots.has(did)).sort(byName);
  const picks = (did: string) => (a.bots.has(did) ? added.has(did) : !left.has(did));
  const voters = everyone.filter(picks).sort();
  const n = voters.length;
  const toPass =
    rule === 'custom'
      ? Math.min(Math.max(1, custom), n)
      : (RULES.find((r) => r.id === rule)?.toPass(n) ?? majority(n));
  const problem =
    n === 0
      ? 'Pick at least one voter.'
      : n > MAX_VOTERS
        ? `A proposal can have at most ${MAX_VOTERS} voters for now.`
        : toPass > MAX_CITED || n - toPass + 1 > MAX_CITED
          ? `With this many voters, a rule must settle it with at most ${MAX_CITED} votes either way.`
          : null;

  const toggle = (did: string) => {
    const flip = (set: ReadonlySet<string>) => {
      const next = new Set(set);
      if (!next.delete(did)) next.add(did);
      return next;
    };
    if (a.bots.has(did)) setAdded(flip);
    else setLeft(flip);
  };

  return (
    <Modal title="New proposal" onClose={onClose} width={560}>
      <form
        className="stack"
        data-gap="loose"
        onSubmit={(event) => {
          event.preventDefault();
          if (!title.trim() || problem) return;
          void action.run(async () => {
            const made = await node.records.put(
              a.spaceId,
              proposalCollection,
              {
                title: title.trim(),
                ...(body.trim() ? { body: body.trim() } : {}),
                voters,
                toPass,
              },
              topicKey ? { links: [{ rel: 'topic', to: topicKey }] } : {},
            );
            onDone(made.key);
          });
        }}
      >
        <label>
          What should the assembly decide?
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Install bike racks by the entrance"
            maxLength={200}
            autoFocus
          />
        </label>
        {a.topics.length > 0 && (
          <fieldset>
            <legend>Topic</legend>
            <div className="row" data-gap="tight">
              <TopicPicker
                topics={a.topics}
                on={(t) => topicKey === t.key}
                onToggle={(t) => setTopicKey(topicKey === t.key ? null : t.key)}
              />
            </div>
            <small>People who don’t vote themselves follow whoever they trust with this topic.</small>
          </fieldset>
        )}
        <label>
          Details
          <textarea
            rows={5}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            placeholder="Why it matters, what it costs, what happens if it passes."
            maxLength={20000}
          />
        </label>

        <fieldset>
          <header>
            <legend>
              Who votes · {n} of {a.members.length}
            </legend>
            <button
              type="button"
              data-intent="ghost"
              onClick={() => {
                setLeft(new Set());
                setAdded(new Set());
              }}
            >
              Everyone but bots
            </button>
            <button
              type="button"
              data-intent="ghost"
              onClick={() => {
                setLeft(new Set(people));
                setAdded(new Set());
              }}
            >
              Nobody
            </button>
          </header>
          <ul role="list" className={styles.voters}>
            {people.map((did) => (
              <VoterRow key={did} a={a} did={did} on={picks(did)} onToggle={() => toggle(did)} />
            ))}
            {bots.length > 0 && (
              <li>
                <small>Bots don’t vote unless you add them.</small>
              </li>
            )}
            {bots.map((did) => (
              <VoterRow key={did} a={a} did={did} bot on={picks(did)} onToggle={() => toggle(did)} />
            ))}
          </ul>
          <small>Fixed once proposed. People who join later vote on later proposals.</small>
        </fieldset>

        <fieldset>
          <legend>What it takes to pass</legend>
          <div className="row" data-gap="tight" role="group" aria-label="Rule">
            {RULES.map((r) => (
              <button key={r.id} type="button" aria-pressed={rule === r.id} onClick={() => setRule(r.id)}>
                {r.label}
              </button>
            ))}
            <button
              type="button"
              aria-pressed={rule === 'custom'}
              onClick={() => {
                setCustom(toPass);
                setRule('custom');
              }}
            >
              A number
            </button>
            {rule === 'custom' && (
              <span className="row" data-gap="tight">
                <input
                  className={styles.number}
                  type="number"
                  min={1}
                  max={Math.max(1, n)}
                  value={custom}
                  onChange={(event) => setCustom(Math.round(Number(event.target.value)) || 1)}
                  aria-label="Votes for it needs"
                />
                <small>of {n}</small>
              </span>
            )}
          </div>
          {n > 0 && (
            <small>
              Passes once {toPass} of the {n} {n === 1 ? 'voter votes' : 'voters vote'} for. Fails once{' '}
              {n - toPass + 1} vote against or abstain, since it can no longer pass. Until then it stays open:
              there’s no deadline.
              {toPass * 2 <= n && ' Fewer than half can pass it.'}
            </small>
          )}
        </fieldset>

        <Problem>{problem ?? action.error}</Problem>
        <div className={`row ${styles.actions}`}>
          <button type="button" data-intent="ghost" onClick={onClose}>
            Cancel
          </button>
          <button data-intent="primary" disabled={!title.trim() || action.busy || problem !== null}>
            {action.busy ? 'Proposing…' : 'Propose'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** One member to pick as a voter, or leave out */
function VoterRow({
  a,
  did,
  bot,
  on,
  onToggle,
}: {
  a: Assembly;
  did: string;
  bot?: boolean;
  on: boolean;
  onToggle: () => void;
}) {
  return (
    <li>
      <label>
        <input type="checkbox" checked={on} onChange={onToggle} />
        <Who did={did} a={a} size={22} />
        {bot && <span className="tag">bot</span>}
      </label>
    </li>
  );
}
