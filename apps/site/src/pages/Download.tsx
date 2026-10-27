import { Shape } from '@minca/app-shared/shapes';
import { Link } from '@tanstack/react-router';
import { APP, ChromeMark, DownloadMark, EXTERNAL, Page } from './Site';
import { RELEASES, usePlatform } from './downloads';
import { downloadLink } from './Install';
import { BrowserMock } from './Extension';

/**
 * Every way to get Minca: the desktop app, the browser, and the Chrome
 * extension. Each download lands on /install, which says how to get past the
 * warning the first time, since none is signed or in a store yet.
 */
export function Download() {
  const platform = usePlatform();
  const ownDownload =
    platform === 'mac'
      ? ({ kind: 'mac', label: 'Download for Mac' } as const)
      : platform === 'windows'
        ? ({ kind: 'windows', label: 'Download for Windows' } as const)
        : null;

  return (
    <Page page="download">
      <section className="hero">
        <div className="wrap">
          <h1>Get Minca.</h1>
          <p>Your people, your plans, one click away.</p>
          <div className="actions">
            {ownDownload ? (
              <Link {...downloadLink(ownDownload.kind)} className="btn btn-primary btn-lg">
                <DownloadMark />
                {ownDownload.label}
              </Link>
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
            <div className="tile platform c-peach">
              <Shape kind="flower" className="tile-art" />
              <h2>Mac</h2>
              <p>Apple silicon · macOS 14+</p>
              <Link {...downloadLink('mac')} className="btn btn-primary">
                Download
              </Link>
            </div>
            <div className="tile platform c-sage">
              <Shape kind="clover" className="tile-art" />
              <h2>
                Windows <span className="tag">Preview</span>
              </h2>
              <p>64-bit</p>
              <Link {...downloadLink('windows')} className="btn btn-primary">
                Download
              </Link>
            </div>
          </div>
        </div>
      </section>

      <section className="band downloads" id="chrome">
        <div className="wrap">
          <div className="tile tile-panel extension c-cobalt">
            <div>
              <div className="kicker-inline">
                <ChromeMark size={14} />
                Chrome extension
              </div>
              <h2>Your spaces keep syncing.</h2>
              <p>Your spaces stay in sync while Chrome is open, even with Minca closed.</p>
              <div className="actions">
                <Link {...downloadLink('chrome')} className="btn btn-primary">
                  <ChromeMark />
                  Get the extension
                </Link>
                <Link to="/extension" className="quiet-link">
                  Read more →
                </Link>
              </div>
            </div>
            <BrowserMock />
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
