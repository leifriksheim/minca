import { Mark } from '@minca/app-shared/Wordmark';
import { Shape } from '@minca/app-shared/shapes';
import { Link } from '@tanstack/react-router';
import { APP, ChromeMark, EXTERNAL, Page } from './Site';
import { RELEASES, usePlatform } from './downloads';
import { downloadLink } from './Install';

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
            <div className="platform c-peach">
              <Shape kind="flower" className="platform-art" />
              <h2>Mac</h2>
              <p>Apple silicon · macOS 14+</p>
              <Link {...downloadLink('mac')} className="btn btn-primary">
                Download
              </Link>
            </div>
            <div className="platform c-sage">
              <Shape kind="clover" className="platform-art" />
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
          <div className="extension c-cobalt">
            <div>
              <div className="kicker-inline">
                <ChromeMark size={14} />
                Chrome extension
              </div>
              <h2>Never miss a thing.</h2>
              <p>Your spaces stay in sync while Chrome is open, even with Minca closed.</p>
              <Link {...downloadLink('chrome')} className="btn btn-primary">
                <ChromeMark />
                Get the extension
              </Link>
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
