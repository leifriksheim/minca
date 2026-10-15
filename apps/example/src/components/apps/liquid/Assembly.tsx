import { useState, type ReactNode } from 'react';
import type { SpaceSummary } from '@minca/core';
import { useNode } from '@minca/core/react';
import { Modal } from '@minca/app-shared/Modal';
import { useAssembly, type Assembly } from './model';
import { Proposals } from './Proposals';
import { Delegations } from './Delegations';
import { People } from './People';
import { topic as topicCollection } from './schema';
import { Problem, TopicChip } from './ui';
import { useAction } from '@minca/app-shared/action';
import { useDuties } from './duties';
import { palette } from './styles';
import { Loader } from '@minca/app-shared/Loader';
import { ask } from '@minca/app-shared/Ask';

type Tab = 'proposals' | 'trust' | 'people';

/** Whether this browser has seen how Liquid works, so it opens by itself only the first time */
const SEEN_KEY = 'liquid:seen-how';
const seenHow = () => {
  try {
    return globalThis.localStorage.getItem(SEEN_KEY) === '1';
  } catch {
    return true;
  }
};

/**
 * One assembly, in the example's frame for an app: the example brings the
 * space's name, its members and its invites.
 */
export function AssemblySpace({ space }: { space: SpaceSummary }) {
  return <AssemblyBody space={space} a={useAssembly(space.id)} />;
}

/** The tabs, and what each shows */
function AssemblyBody({ space, a }: { space: SpaceSummary; a: Assembly }) {
  const [tab, setTab] = useState<Tab>('proposals');
  const [how, setHow] = useState(() => !seenHow());
  const [topics, setTopics] = useState(false);

  const closeHow = () => {
    setHow(false);
    try {
      globalThis.localStorage.setItem(SEEN_KEY, '1');
    } catch {
      // Only the "first time" memory is lost.
    }
  };

  const open = a.proposals.filter((p) => p.result === 'open').length;
  useDuties(a, space.writable);
  const mine = a.mine.length;

  return (
    <div className="lq-space">
      <div className="lq-tabbar">
        <nav className="lq-tabs" role="tablist" aria-label="Assembly">
          <TabButton id="proposals" tab={tab} onPick={setTab} count={open}>
            Proposals
          </TabButton>
          <TabButton id="trust" tab={tab} onPick={setTab} count={mine || undefined}>
            Your vote
          </TabButton>
          <TabButton id="people" tab={tab} onPick={setTab} count={a.members.length}>
            People
          </TabButton>
        </nav>
        <span style={{ flex: 1 }} />
        {a.mayModerate && (
          <button
            className="lq-btn lq-hide-phone"
            data-variant="ghost"
            data-size="sm"
            onClick={() => setTopics(true)}
          >
            Topics
          </button>
        )}
        <button
          className="lq-icon-btn"
          style={{ width: 28, height: 28, fontSize: 13 }}
          onClick={() => setHow(true)}
          aria-label="How Liquid works"
          title="How it works"
        >
          ?
        </button>
      </div>

      {space.joining ? (
        <Waiting />
      ) : !a.ready ? (
        <p className="lq-faint lq-fade">
          <Loader label="Opening the assembly" showLabel />
        </p>
      ) : (
        <>
          {!space.writable && (
            <div className="lq-note" style={{ marginBottom: 20 }}>
              You can read this assembly, but you hold no role in it, so you can’t vote, propose or delegate.
            </div>
          )}
          {tab === 'proposals' && <Proposals a={a} writable={space.writable} />}
          {tab === 'trust' && <Delegations a={a} writable={space.writable} />}
          {tab === 'people' && <People a={a} writable={space.writable} />}
        </>
      )}

      {how && <HowItWorks onClose={closeHow} />}
      {topics && <Topics a={a} onClose={() => setTopics(false)} />}
    </div>
  );
}

function TabButton({
  id,
  tab,
  onPick,
  count,
  children,
}: {
  id: Tab;
  tab: Tab;
  onPick: (tab: Tab) => void;
  count?: number;
  children: ReactNode;
}) {
  return (
    <button className="lq-tab" role="tab" aria-selected={tab === id} onClick={() => onPick(id)}>
      {children}
      {count !== undefined && <span className="lq-tab-count">{count}</span>}
    </button>
  );
}

function Waiting() {
  return (
    <div className="lq-empty lq-fade">
      <Loader label="Joining" showLabel />
      <p style={{ fontSize: 13.5, maxWidth: 380, lineHeight: 1.55 }}>
        Your invite is on its way to the assembly. It opens as soon as someone who is already in it comes
        online.
      </p>
    </div>
  );
}

/** Moderators set what proposals are sorted into, and what delegations can be limited to */
function Topics({ a, onClose }: { a: Assembly; onClose: () => void }) {
  const node = useNode();
  const [name, setName] = useState('');
  const action = useAction();
  const inUse = (key: string) =>
    a.proposals.some((p) => p.topic === key) || a.delegations.some((d) => d.topic === key);
  return (
    <Modal title="Topics" onClose={onClose} width={440}>
      <p className="lq-muted" style={{ fontSize: 13.5, lineHeight: 1.55 }}>
        Every proposal belongs to one topic, and people can trust someone with just that topic.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {a.topics.map((t) => (
          <div key={t.key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <TopicChip topic={t} />
            <span style={{ flex: 1 }} />
            <button
              className="lq-btn"
              data-variant="ghost"
              data-size="sm"
              disabled={action.busy}
              title={
                inUse(t.key) ? 'Proposals or delegations use it: they would lose their topic' : undefined
              }
              onClick={() => {
                const sure = inUse(t.key)
                  ? ask('Proposals and delegations on it lose their topic.', {
                      title: `Remove ${t.name}?`,
                      yes: 'Remove',
                      danger: true,
                    })
                  : Promise.resolve(true);
                void sure.then(async (yes) => {
                  if (yes) await action.run(() => node.records.delete(a.spaceId, t.key));
                });
              }}
            >
              Remove
            </button>
          </div>
        ))}
        {a.topics.length === 0 && <p className="lq-faint">No topics yet.</p>}
      </div>
      <form
        style={{ display: 'flex', gap: 8 }}
        onSubmit={(event) => {
          event.preventDefault();
          const trimmed = name.trim();
          if (!trimmed) return;
          void action
            .run(() =>
              node.records.put(a.spaceId, topicCollection, {
                name: trimmed,
                hue: (a.topics.length * 67 + 17) % 360,
              }),
            )
            .then((done) => done && setName(''));
        }}
      >
        <input
          className="lq-input"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="New topic"
          maxLength={60}
        />
        <button className="lq-btn" disabled={!name.trim() || action.busy}>
          Add
        </button>
      </form>
      <Problem>{action.error}</Problem>
    </Modal>
  );
}

/**
 * How the count works, and what this app can't promise. Opens by itself the
 * first time, and from the ? in the header after that.
 */
function HowItWorks({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="How Liquid works" onClose={onClose} width={560}>
      <Section title="Your vote">
        <Li>
          Each proposal lists who votes on it: everyone in the assembly when it was proposed. People who join
          later vote on later proposals.
        </Li>
        <Li>
          <strong>Votes are final.</strong> Once cast, a vote can’t be changed or taken back. That’s what lets
          a result, once reached, stay reached.
        </Li>
        <Li>
          When you don’t vote, your device follows whoever you trust with the proposal’s topic, or else
          whoever you trust with everything: once they vote, it casts the same vote for you, signed by you.
          Vote first and your own vote counts instead.
        </Li>
        <Li>
          Following goes along a chain, one device at a time: if you trust Ada and Ada trusts Bo, Bo’s vote
          reaches Ada first, then you. A chain that loops back round never casts anything; Liquid warns you.
        </Li>
        <Li>
          A party decides how it takes a position: once more than half, two-thirds, three-quarters or all of
          its members vote the same way themselves, or as its representative votes. Its stewards’ devices
          freeze its members and that rule for each proposal.
        </Li>
      </Section>
      <Section title="How a proposal is settled">
        <Li>
          Whoever proposes picks its voters and what it takes to pass: more than half, two-thirds, everyone,
          or a number. Bots vote only when they’re picked.
        </Li>
        <Li>
          <strong>Passed</strong> once that many voters voted for. <strong>Rejected</strong> once so many
          voted against or abstained that it can no longer pass.
        </Li>
        <Li>
          Whichever device sees that first writes a decision citing the votes, and every device checks it.
          Nobody closes a vote and nobody adds up, so every device reaches the same result, in any order.
        </Li>
        <Li>
          <strong>Disputed</strong> when someone is caught signing two different versions of a vote, or a
          party’s members. That proof spreads like any record, and no later vote takes it back.
        </Li>
      </Section>
      <Section title="What this app can’t promise">
        <Li>
          <strong>A proposal can stay open.</strong> There’s no deadline: devices don’t share a trusted clock.
          If too few people vote, it stays open.
        </Li>
        <Li>
          <strong>Following needs a device.</strong> Your vote follows your delegate only while Liquid is open
          on one of your devices.
        </Li>
        <Li>
          <strong>Votes are not secret.</strong> Everyone in the assembly can see who voted what, and who
          trusts whom. That’s how delegates stay accountable, but it rules out a secret ballot.
        </Li>
        <Li>
          <strong>Whoever proposes picks the voters.</strong> Every voter must be a member, and everyone sees
          the list, but nothing stops a proposer leaving people out. Check who votes before you vote.
        </Li>
        <Li>
          <strong>One account, one vote.</strong> Nothing proves an account is a different person. Whoever can
          invite decides who votes, so invite with care.
        </Li>
        <Li>
          <strong>Liquid on its own asks for your whole Minca account.</strong> Making or joining an assembly
          after connecting needs it. It only shows the spaces that are assemblies.
        </Li>
        <Li>
          <strong>Private isn’t invisible.</strong> In a private assembly nobody outside can read the votes,
          but someone holding the encrypted copies can still tell who voted on which proposal.
        </Li>
      </Section>
      <button className="lq-btn" onClick={onClose} style={{ alignSelf: 'flex-end' }}>
        Got it
      </button>
    </Modal>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <p className="lq-display" style={{ fontSize: 17 }}>
        {title}
      </p>
      <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 8 }}>{children}</ul>
    </section>
  );
}

function Li({ children }: { children: ReactNode }) {
  return (
    <li style={{ display: 'flex', gap: 10, fontSize: 13.5, lineHeight: 1.55, color: palette.ink.body }}>
      <span aria-hidden style={{ color: palette.ink.faint, flexShrink: 0 }}>
        –
      </span>
      <span>{children}</span>
    </li>
  );
}
