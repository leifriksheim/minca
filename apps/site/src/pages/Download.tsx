import { Mark } from '@minca/app-shared/Wordmark';
import { Shape } from '@minca/app-shared/shapes';
import { APP, EXTERNAL, Page } from './Site';
import { DOWNLOADS, RELEASES, usePlatform } from './downloads';

/**
 * Every way to get Minca: the desktop app, the browser, and the Chrome
 * extension. None is signed or in a store yet, so each says how to get past
 * the warning the first time.
 */
export function Download() {
  const platform = usePlatform();
  const ownDownload =
    platform === 'mac'
      ? { href: DOWNLOADS.mac, label: 'Download for Mac' }
      : platform === 'windows'
        ? { href: DOWNLOADS.windows, label: 'Download for Windows' }
        : null;

  return (
    <Page page="download">
      <section className="hero">
        <div className="wrap">
          <h1>Get Minca.</h1>
          <p>Your people, your plans, one click away.</p>
          <div className="actions">
            {ownDownload ? (
              <a href={ownDownload.href} className="btn btn-primary btn-lg">
                {ownDownload.label}
              </a>
            ) : null}
            <a
              href={APP}
              {...EXTERNAL}
              className={`btn btn-lg ${ownDownload ? 'btn-secondary' : 'btn-primary'}`}
            >
              Open in your browser
            </a>
          </div>
        </div>
      </section>

      <section className="band downloads" id="desktop">
        <div className="wrap">
          <div className="platforms">
            <div className="platform c-peach">
              <Shape kind="flower" className="platform-art" />
              <h2>Mac</h2>
              <p>Apple silicon · macOS 14+</p>
              <a href={DOWNLOADS.mac} className="btn btn-primary">
                Download
              </a>
            </div>
            <div className="platform c-sage">
              <Shape kind="clover" className="platform-art" />
              <h2>
                Windows <span className="tag">Preview</span>
              </h2>
              <p>64-bit</p>
              <a href={DOWNLOADS.windows} className="btn btn-primary">
                Download
              </a>
            </div>
          </div>
          <details className="first-time">
            <summary>First time opening it?</summary>
            <p>
              Minca isn’t signed yet, so your computer double-checks once. On a Mac, go to{' '}
              <b>System Settings → Privacy &amp; Security</b> and click <b>Open Anyway</b>. On Windows, click{' '}
              <b>More info → Run anyway</b>.
            </p>
          </details>
        </div>
      </section>

      <section className="band downloads" id="chrome">
        <div className="wrap">
          <div className="extension c-cobalt">
            <div>
              <div className="kicker-inline">Chrome extension</div>
              <h2>Never miss a thing.</h2>
              <p>Your spaces stay in sync while Chrome is open, even with Minca closed.</p>
              <a href={DOWNLOADS.chrome} className="btn btn-primary">
                Get the extension
              </a>
              <details className="first-time">
                <summary>How to install</summary>
                <ol>
                  <li>Unzip it somewhere it can stay.</li>
                  <li>
                    Open <code>chrome://extensions</code> and turn on <b>Developer mode</b>.
                  </li>
                  <li>
                    Click <b>Load unpacked</b> and pick the folder.
                  </li>
                </ol>
              </details>
            </div>
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
          </div>
        </div>
      </section>

      <p className="verify">
        Built in the open on GitHub, with checksums for every file.{' '}
        <a href={RELEASES} {...EXTERNAL}>
          See releases →
        </a>
      </p>
    </Page>
  );
}
