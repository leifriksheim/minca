import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { Mark } from '@minca/app-shared/Wordmark';
import { Shape, type ShapeKind } from '@minca/app-shared/shapes';
import { Band, ChromeMark, EXTERNAL, GITHUB, Marked, Page } from './Site';
import { downloadLink } from './Install';

/**
 * The Chrome extension (`apps/extension`), and how to install it by hand until
 * it is in the Chrome Web Store. Its download lands on /install/chrome.
 */

const SOURCE = `${GITHUB}/tree/main/apps/extension`;

/** Chrome's toolbar with Minca pinned in it, its popup open: the download page shows it too */
export function BrowserMock() {
  return (
    <div className="browser" aria-hidden>
      <div className="toolbar">
        <span className="toolbar-dots">
          <i />
          <i />
          <i />
        </span>
        <span className="toolbar-url">minca.social</span>
        <span className="toolbar-icon">
          <Mark size={26} />
          <span className="toolbar-badge" />
        </span>
      </div>
      <div className="popup">
        <span className="toolbar-badge" />4 spaces in sync
      </div>
    </div>
  );
}

/** The install steps, a colour tile each */
const STEPS: ReadonlyArray<{ colour: string; shape: ShapeKind; title: string; body: ReactNode }> = [
  {
    colour: 'c-peach',
    shape: 'flower',
    title: 'Download and unzip',
    body: (
      <>
        <Link {...downloadLink('chrome')}>Get the zip</Link> and unzip it somewhere it can stay, like
        Documents.
      </>
    ),
  },
  {
    colour: 'c-sage',
    shape: 'clover',
    title: 'Load it in Chrome',
    body: (
      <>
        Open <code>chrome://extensions</code>, turn on <b>Developer mode</b>, click <b>Load unpacked</b> and
        pick the folder.
      </>
    ),
  },
  {
    colour: 'c-lilac',
    shape: 'burst',
    title: 'Connect your account',
    body: <>Approve it in your account home, then pin it. A green dot means it’s on.</>,
  },
];

export function Extension() {
  return (
    <Page page="extension">
      <section className="band ext-hero">
        <div className="wrap">
          <div className="tile tile-panel extension c-cobalt">
            <div>
              <div className="kicker-inline">
                <ChromeMark size={14} />
                Chrome extension
              </div>
              <h1>Your spaces, awake while Chrome is.</h1>
              <p>Everything keeps moving with every app closed, and you hear when something happens.</p>
              <div className="actions">
                <Link {...downloadLink('chrome')} className="btn btn-primary btn-lg">
                  <ChromeMark />
                  Download for Chrome
                </Link>
                <a href="#install" className="quiet-link">
                  How to install ↓
                </a>
              </div>
            </div>
            <BrowserMock />
          </div>
        </div>
      </section>

      <Band
        title="Without it, things only move while an app is open."
        intro={<p>There’s no server holding your spaces. With the extension, Chrome passes them on.</p>}
      >
        <Marked
          columns={3}
          items={[
            {
              title: 'Always in sync',
              body: 'Your phone gets your laptop’s changes, even with the laptop’s tabs long closed.',
              shape: 'signal',
            },
            {
              title: 'Your pod, kept current',
              body: 'Everything that arrives is written into your folder.',
              shape: 'stack',
            },
            {
              title: 'Friends reach you',
              body: 'Messages arrive now, not when you next open the app.',
              shape: 'group',
            },
            {
              title: 'It can’t read them',
              body: 'It carries your spaces still locked, the way they travel.',
              shape: 'lock',
            },
            {
              title: 'Hands off your sites',
              body: 'It never touches the websites you visit, so Chrome shows no warning.',
              shape: 'shield',
            },
            {
              title: 'Open source',
              body: 'Every line is on GitHub, and it checks everything like every other device.',
              shape: 'tick',
            },
          ]}
        />
      </Band>

      <Band id="install" tone="sunken" title="Three steps, until it’s in the Chrome Web Store.">
        <div className="tiles">
          {STEPS.map((step, i) => (
            <div key={step.title} className={`tile ${step.colour}`}>
              <Shape kind={step.shape} className="tile-art" />
              <div className="tile-num">{i + 1}</div>
              <h3>{step.title}</h3>
              <p>{step.body}</p>
            </div>
          ))}
        </div>
        <div className="split" style={{ marginTop: 72 }}>
          <div>
            <h3 className="split-title">Updating?</h3>
          </div>
          <div>
            <p>
              Unzip the new one over the same folder, then press reload on Minca’s card in{' '}
              <code>chrome://extensions</code>. You stay connected.
            </p>
            <p>
              Want to build it yourself?{' '}
              <a href={SOURCE} {...EXTERNAL}>
                Source and build steps
              </a>{' '}
              are on GitHub.
            </p>
          </div>
        </div>
      </Band>
    </Page>
  );
}
