import { useEffect, useState, type ReactNode } from 'react';
import { Shape } from '@minca/app-shared/shapes';
import { Face, Meetup } from './demos';
import type { ShapeKind } from '@minca/ui/shapes';
import type { ShapeColour } from '@minca/ui/tokens';
import { Building, PromptBox, SpaceBadge, Typed } from './HeroSpace';

/**
 * How a change gets made, told as one story in five steps: Maya asks her
 * agent for a waitlist, it drafts a proposal saying what the change adds and
 * what it can see, someone the group picked says yes, it is live for
 * everyone, and other groups take it and make it theirs. The steps play in turn; picking one stops them there.
 */

const ASK = 'Add a waitlist to hack night for when it’s full';

const ASKED = (
  <div className="story-ask">
    <PromptBox className="is-inline">
      <Typed text={ASK} />
    </PromptBox>
    <div className="story-reply">
      <Building>Drafting a proposal for Riverside Makers</Building>
    </div>
  </div>
);

const DRAFTED = (
  <div className="proposal">
    <div className="proposal-head">
      <b>Hack night, with a waitlist</b>
      <span className="tag">Draft</span>
    </div>
    <div className="by">From Maya · written by Claude</div>
    <ul>
      <li>Anyone can join the waitlist when it’s full</li>
      <li>The first in line gets a spot that opens</li>
    </ul>
    <dl className="story-facts">
      <div>
        <dt>Adds</dt>
        <dd>
          <span className="chip is-new">+ Waitlist</span>
        </dd>
      </div>
      <div>
        <dt>Uses</dt>
        <dd>
          <span className="chip">Events</span>
          <span className="chip">RSVPs</span>
          <span className="chip">People</span>
        </dd>
      </div>
      <div>
        <dt>Can see</dt>
        <dd>
          <span className="chip">Hack night</span>
          <span className="chip is-no">Not your chats</span>
        </dd>
      </div>
    </dl>
  </div>
);

const APPROVED = (
  <div className="proposal">
    <div className="proposal-head">
      <b>Hack night, with a waitlist</b>
      <span className="tag good story-passed">Added</span>
    </div>
    <div className="by">From Maya</div>
    <div className="story-approver">
      <Face who="joe" />
      <span>
        <b>Joe</b>
        <small>Looks after Riverside Makers</small>
      </span>
    </div>
    <div className="proposal-actions">
      <span className="mini-btn primary story-press">Add it</span>
      <span className="mini-btn">Ask everyone</span>
    </div>
  </div>
);

/** Groups that took the waitlist and made it theirs */
const SPREAD: ReadonlyArray<{ group: string; did: string; kind: ShapeKind; colour: ShapeColour }> = [
  { group: 'Pixel Pals Discord', did: 'Took it for game night', kind: 'scallop', colour: 'coral' },
  { group: 'Northside Open Mic', did: 'Turned it into slots for acts', kind: 'flower', colour: 'peach' },
  { group: 'Oak Street Tenants', did: 'Use it for the laundry room', kind: 'leaf', colour: 'sage' },
];

const SHARED = (
  <div className="story-share">
    <div className="story-link">
      <SpaceBadge letter="R" kind="clover" colour="cobalt" />
      <span>
        <b>Hack night waitlist</b>
        <small>Made by Riverside Makers</small>
      </span>
      <span className="mini-btn primary">Copy link</span>
    </div>
    <ol className="story-spread">
      {SPREAD.map((each, i) => (
        <li key={each.group} style={{ animationDelay: `${0.6 + i * 0.7}s` }}>
          <SpaceBadge letter={each.group[0] ?? ''} kind={each.kind} colour={each.colour} />
          <span>
            <b>{each.group}</b>
            <small>{each.did}</small>
          </span>
        </li>
      ))}
    </ol>
    <p className="story-count">Taken by 214 groups so far</p>
  </div>
);

const STEPS: ReadonlyArray<{
  title: string;
  text: string;
  tag: string;
  ms: number;
  view: ReactNode;
  /** Whether it is done, so the tag says so in green */
  done?: boolean;
  /** What the change left alone, under the view */
  kept?: readonly string[];
}> = [
  {
    title: 'Ask your agent',
    text: 'Maya says what she wants in her own words, in Minca or in Claude, ChatGPT or any AI she already uses.',
    tag: 'Asking',
    ms: 4400,
    view: ASKED,
  },
  {
    title: 'It drafts a proposal',
    text: 'Her agent writes the change up for the group in plain words, saying what it adds and what it’s allowed to see.',
    tag: 'Draft',
    ms: 5200,
    view: DRAFTED,
  },
  {
    title: 'Someone says yes',
    text: 'Usually one of the people your group picked to look after things just adds it. For bigger changes, ask everyone.',
    tag: 'Review',
    ms: 4600,
    view: APPROVED,
  },
  {
    title: 'Everyone has it',
    text: 'The moment it passes, hack night has a waitlist on everyone’s devices.',
    tag: 'Live',
    ms: 5000,
    view: <Meetup change="waitlist" />,
    done: true,
    kept: ['Who’s in the group', 'Your chats', 'Who can change the event'],
  },
  {
    title: 'Share it',
    text: 'Good tools travel like memes. Another group takes yours, tweaks it and passes it on, and nobody takes a cut.',
    tag: 'Shared',
    ms: 5200,
    view: SHARED,
    done: true,
  },
];

export function Story() {
  const still = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  const [at, setAt] = useState(0);
  const [playing, setPlaying] = useState(!still);
  const step = STEPS[at] ?? STEPS[0]!;

  useEffect(() => {
    if (!playing) return;
    const timer = setTimeout(() => setAt((i) => (i + 1) % STEPS.length), step.ms);
    return () => clearTimeout(timer);
  }, [at, playing, step.ms]);

  return (
    <div className="mend story">
      <div>
        <ol className="mend-asks story-steps">
          {STEPS.map((each, i) => (
            <li key={each.title}>
              <button
                type="button"
                className="mend-ask"
                aria-pressed={i === at}
                onClick={() => {
                  setPlaying(false);
                  setAt(i);
                }}
              >
                <span className="story-num">0{i + 1}</span>
                <span>
                  {each.title}
                  <small>{each.text}</small>
                </span>
                {playing && i === at ? (
                  <i className="story-progress" style={{ animationDuration: `${each.ms}ms` }} />
                ) : null}
              </button>
            </li>
          ))}
        </ol>
        {/* On a phone the steps are only their numbers, and the chosen one is told here */}
        <p className="story-now">
          <b>{step.title}</b>
          {step.text}
        </p>
      </div>
      <div className="mend-view">
        <div className="frame-head">
          <span className="frame-title">
            <Shape kind="clover" colour="coral" />
            <b>Hack night</b>
          </span>
          <span className={step.done ? 'tag good' : 'tag'}>{step.tag}</span>
        </div>
        <div className="frame-body story-body" key={at}>
          {step.view}
        </div>
        {step.kept ? (
          <div className="frame-foot">
            <span>Stays as it was</span>
            {step.kept.map((kept) => (
              <span key={kept} className="kept">
                {kept}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
