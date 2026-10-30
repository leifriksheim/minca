import { Link } from '@tanstack/react-router';
import { APP, Band, ChromeMark, DownloadMark, EXTERNAL, Marked, Page } from './Site';
import { Converge } from './converge';
import { Castle, Middle } from './castle';
import { PHOTO_CREDITS, Pens, Tower } from './pens';
import { Hosting, Sealed } from './trust';
import { HeroSpace } from './HeroSpace';
import { Loader } from '@minca/app-shared/Loader';
import { MARK_BANDS } from '@minca/app-shared/mark';
import { Shape } from '@minca/app-shared/shapes';
import { type ShapeKind } from '@minca/ui/shapes';
import type { ShapeColour } from '@minca/ui/tokens';
import { usePlatform } from './downloads';
import { downloadLink } from './Install';

/**
 * The front page, for community builders who are tired of billionaires
 * owning every place we meet. A minca (minka) is the Andean custom of
 * everyone turning out to build what serves them all. The page's argument:
 * our social spaces are infrastructure, like water and power, yet a few
 * companies own them, rebuild the same app in silos and take a cut of
 * everything. Software is nearly free to make now, so groups can build on
 * shared ground instead, and every group that improves a tool improves it
 * for the next.
 *
 * The product comes first and the argument under it: the apps a group juggles
 * streaming into one (`converge.tsx`), making and changing tools,
 * how it stays private and online (`trust.tsx`), then why it matters. It
 * shows rather than tells: each band is the product doing one thing, drawn
 * as the app draws it (`demos.tsx`).
 * The brand draws a space as a ruled grid and every tool as a shape in it
 * (`shapes.tsx`).
 */

/** What a private space promises, beside the picture of a message locked on the way */
const YOURS: ReadonlyArray<{ title: string; body: string; shape: ShapeKind }> = [
  {
    title: 'Nobody’s watching',
    body: 'Nobody’s selling your attention, so nothing is tuned to keep you scrolling.',
    shape: 'eyeShut',
  },
  { title: 'Your rules', body: 'Your group decides who can do what, and who gets in.', shape: 'group' },
  {
    title: 'Works offline',
    body: 'It keeps going on the bus and in the basement, and catches up when you’re back.',
    shape: 'signal',
  },
  {
    title: 'Yours to take',
    body: 'Everything lives on your own devices, so you can pick it all up and leave.',
    shape: 'stack',
  },
];

/** What groups asked for, in their own words, and the tool each became */
const ASKS: ReadonlyArray<{ ask: string; tool: string; kind: ShapeKind; colour: ShapeColour }> = [
  {
    ask: 'A list of everything the landlord said he’d fix next week.',
    tool: 'Repairs',
    kind: 'star',
    colour: 'peach',
  },
  {
    ask: 'A sign-up sheet for the potluck. Joe says he’s bringing the rich.',
    tool: 'Potluck',
    kind: 'flower',
    colour: 'cobalt',
  },
  {
    ask: 'A chore rota, so the dishes stop being a political issue.',
    tool: 'Chore rota',
    kind: 'squircle',
    colour: 'sage',
  },
  {
    ask: 'A vote on the protest signs. Max two puns per person.',
    tool: 'Sign vote',
    kind: 'clover',
    colour: 'coral',
  },
  {
    ask: 'Who needs groceries this week, and whose car actually starts?',
    tool: 'Mutual aid',
    kind: 'burst',
    colour: 'lilac',
  },
  {
    ask: 'Somewhere to swap kids’ clothes before they outgrow them again.',
    tool: 'Clothes swap',
    kind: 'sparkle',
    colour: 'peach',
  },
];

/** The mark's canvas, cropped to the bands so they stand on the panel's bottom edge */
const RAINBOW_VIEWBOX = '0.5 1 23 11.5';

/** The mark's rainbow, large, rising from the bottom of a panel */
function Rainbow() {
  return (
    <svg className="rainbow" viewBox={RAINBOW_VIEWBOX} aria-hidden>
      {MARK_BANDS.map((band) => (
        <path key={band.d} d={band.d} fill={band.fill} />
      ))}
    </svg>
  );
}

/**
 * The hero's buttons: the desktop app for the computer the visitor is on, and
 * the browser beside it. A download lands on /install, which says how to open
 * an app that isn't signed yet. A phone gets the app in the browser.
 */
function HeroActions() {
  const platform = usePlatform();
  if (platform === 'mobile') {
    return (
      <div className="actions">
        <a href={APP} className="btn btn-primary btn-lg">
          Start a minca
        </a>
        <a href="#why" className="btn btn-secondary btn-lg">
          Why this matters
        </a>
      </div>
    );
  }
  const desktop = platform === 'mac' || platform === 'windows' ? platform : null;
  return (
    <>
      <div className="actions">
        {desktop ? (
          <Link {...downloadLink(desktop)} className="btn btn-primary btn-lg">
            <DownloadMark />
            {desktop === 'mac' ? 'Download for Mac' : 'Download for Windows'}
          </Link>
        ) : null}
        <a href={APP} {...EXTERNAL} className={`btn btn-lg ${desktop ? 'btn-secondary' : 'btn-primary'}`}>
          Open Minca in your browser
        </a>
      </div>
      <Link {...downloadLink('chrome')} className="hero-aside">
        <ChromeMark />
        Get the Chrome extension
      </Link>
    </>
  );
}

/** Questions people ask before they bring their group, each opening to its answer */
const QUESTIONS: ReadonlyArray<{ q: string; a: string }> = [
  {
    q: 'Is it free?',
    a: 'Yes. The app is free and open source, and Minca’s host keeps your own spaces and most groups online for free. A group that grows big chips in for what it uses.',
  },
  {
    q: 'Can you read our messages?',
    a: 'Not in a private space. It’s locked on your device, and only people in the space hold the key. That goes for us and for whoever hosts it.',
  },
  {
    q: 'Do I need to code?',
    a: 'No. Tell Claude, ChatGPT or any AI what you need in plain words. It acts as you, with the permissions you have.',
  },
  {
    q: 'What if Minca goes away?',
    a: 'Your spaces live on your devices, and the protocol is open, so anyone can keep it running.',
  },
  {
    q: 'Can I build a business on it?',
    a: 'Yes. Make apps, run hosts or help groups get set up, and charge for it. You just can’t lock anyone in.',
  },
  {
    q: 'What if a billionaire buys Minca?',
    a: 'There’s nothing to buy. Your space lives on your devices and the rules are public, so all they’d get is a logo.',
  },
  {
    q: 'Is it ready?',
    a: 'It works, and it’s early. Try it with a group that doesn’t mind a few bugs, and tell us what breaks.',
  },
];

export function Home() {
  return (
    <Page page="home">
      <section className="hero home-hero">
        <div className="wrap">
          <h1>
            Many hands
            <br />
            make it happen.
          </h1>
          <p>
            A home for your group’s chats and plans, where you can ask for any tool you need. You own it
            together, with no Silicon Valley tech billionaires involved.
          </p>
          <HeroActions />
        </div>
        <div className="wrap">
          <HeroSpace />
        </div>
      </section>

      <Band
        id="pieces"
        title="Let’s stop building the same thing."
        intro={
          <p>
            Nearly every app you use is the same few pieces with a different logo on top, and each one keeps
            your group to itself. On Minca the pieces are shared, so your group builds what it needs and no
            tech oligarch gets a cut.
          </p>
        }
      >
        <Converge />
      </Band>

      <Band
        id="asks"
        tone="sunken"
        title="If you can say it, you can have it."
        intro={<p>Tell Claude, ChatGPT or any AI what your group needs, and it’s there by tonight.</p>}
      >
        <ul className="asks">
          {ASKS.map((item) => (
            <li key={item.tool} className={`tile c-${item.colour}`}>
              <q>{item.ask}</q>
              <span className="asks-tool">
                <Shape kind={item.kind} colour={item.colour} />
                {item.tool}
              </span>
            </li>
          ))}
        </ul>
      </Band>

      <Band
        id="outside"
        title="AI builds the tools. It doesn’t get the keys."
        intro={
          <p>
            Elsewhere, AI sits between you and every app you use, and reads it all on the way. On Minca it
            builds outside the walls, and your group decides what comes in.
          </p>
        }
      >
        <div className="castle-pair">
          <figure className="tile c-coral">
            <Middle />
            <figcaption>
              <h3>Everywhere else</h3>
              <p>
                The AI sits in the middle. Your notes, files and plans all pass through it, and can end up
                training the next model.
              </p>
            </figcaption>
          </figure>
          <figure className="tile c-sage">
            <Castle />
            <figcaption>
              <h3>On Minca</h3>
              <p>The AI leaves what it built by the bridge. Only your group lets it in.</p>
            </figcaption>
          </figure>
        </div>
      </Band>

      <Band
        id="private"
        tone="sunken"
        title="What’s said in the group stays in the group."
        intro={
          <p>
            Private spaces are locked on your device before anything leaves it. Only the people in the space
            hold the key, so anything in between only sees scrambled text.
          </p>
        }
      >
        <Sealed />
        <div className="private-points">
          <Marked items={YOURS} />
        </div>
      </Band>

      <Band
        id="hosting"
        title="Online while everyone’s asleep."
        intro={
          <p>
            Your devices sync with each other directly. A host keeps your spaces reachable when they’re all
            off, and it holds everything locked, so it can’t read it either.
          </p>
        }
      >
        <Hosting />
      </Band>

      <Band
        id="why"
        tone="sunken"
        title="Start with your group, not with an app."
        intro={
          <p>
            Every company wants your group inside its own app, behind its own fence. On Minca your group comes
            first. Tools get passed from group to group like a good meme, and when you see one you like, you
            add it to yours.
          </p>
        }
      >
        <div className="castle-pair">
          <figure className="tile c-peach">
            <Pens />
            <figcaption>
              <h3>Every company</h3>
              <p>
                Each one builds a pen, puts your group inside and guards the gate. Your friends are stuck in
                the one next door.
              </p>
              <small className="pens-credit">
                Photos:{' '}
                {PHOTO_CREDITS.map((credit, i) => (
                  <span key={credit.who}>
                    {i ? ', ' : ''}
                    <a href={credit.href}>{credit.by}</a> ({credit.licence})
                  </span>
                ))}
                , via Wikimedia Commons.
              </small>
            </figcaption>
          </figure>
          <figure className="tile c-sage">
            <Tower />
            <figcaption>
              <h3>On Minca</h3>
              <p>Groups pass each other bricks. Whatever one group makes, the next can pick up and use.</p>
            </figcaption>
          </figure>
        </div>
      </Band>

      <Band id="questions" title="Fair questions.">
        <div className="faq">
          {QUESTIONS.map((item) => (
            <details key={item.q}>
              <summary>{item.q}</summary>
              <p>{item.a}</p>
            </details>
          ))}
        </div>
      </Band>

      <section className="cta">
        <div className="wrap">
          <div className="cta-panel">
            <Loader decorative size={34} style={{ marginBottom: 28 }} />
            <h2>Call your people.</h2>
            <p className="cta-minka">
              <i>Minka</i> is the Quechua word for work done together. When something would help everyone,
              everyone turns up and builds it.
            </p>
            <HeroActions />
            <Link to="/developers" className="aside-link">
              Building apps? Minca is an open protocol too →
            </Link>
            <Rainbow />
          </div>
        </div>
      </section>
    </Page>
  );
}
