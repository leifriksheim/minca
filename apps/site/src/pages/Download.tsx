import { Link } from '@tanstack/react-router';
import { APP, Band, EXTERNAL, Page } from './Site';
import { DOWNLOADS, RELEASES, usePlatform } from './downloads';

/**
 * Every way to run Minca: the desktop app, the browser, and the Chrome
 * extension beside the browser. None of them is signed or in a store yet, so
 * each says how to get past the warning the first time it opens.
 */
export function Download() {
  const platform = usePlatform();
  const windowsFirst = platform === 'windows';
  const mac = (
    <div className="platform" key="mac">
      <h3>Mac</h3>
      <p>For Macs with Apple silicon (M1 and later).</p>
      <a href={DOWNLOADS.mac} className={`btn ${windowsFirst ? 'btn-secondary' : 'btn-primary'}`}>
        Download for Mac
      </a>
    </div>
  );
  const windows = (
    <div className="platform" key="windows">
      <h3>
        Windows <span className="tag">Preview</span>
      </h3>
      <p>For 64-bit Windows. Built with every release, but not yet tried as widely as the Mac app.</p>
      <a href={DOWNLOADS.windows} className={`btn ${windowsFirst ? 'btn-primary' : 'btn-secondary'}`}>
        Download for Windows
      </a>
    </div>
  );

  return (
    <Page page="download">
      <section className="hero">
        <div className="wrap">
          <h1>Get Minca.</h1>
          <p>
            On your desktop, it keeps your spaces online from the menu bar, even with the window closed. In
            your browser, it’s one click away.
          </p>
          <div className="actions">
            {platform === 'mobile' ? (
              <a href={APP} className="btn btn-primary btn-lg">
                Open Minca
              </a>
            ) : (
              <>
                {/* The file itself on a Mac or a PC; how to open it is just below. */}
                <a
                  href={platform === 'mac' ? DOWNLOADS.mac : windowsFirst ? DOWNLOADS.windows : '#desktop'}
                  className="btn btn-primary btn-lg"
                >
                  {platform === 'mac'
                    ? 'Download for Mac'
                    : windowsFirst
                      ? 'Download for Windows'
                      : 'Download for desktop'}
                </a>
                <a href={APP} className="btn btn-secondary btn-lg">
                  Open in your browser
                </a>
              </>
            )}
          </div>
        </div>
      </section>

      <Band
        id="desktop"
        kicker="Desktop"
        title="Minca in a window of its own."
        intro={
          <p>
            The app, with its own place in the dock and the menu bar. Close the window and it keeps your
            spaces online, and still tells you when something you care about happens.
          </p>
        }
      >
        <div className="platforms">{windowsFirst ? [windows, mac] : [mac, windows]}</div>

        <div className="split" style={{ marginTop: 72 }}>
          <div>
            <div className="kicker-inline">Opening it the first time</div>
            <h3>Your computer will ask if you’re sure.</h3>
          </div>
          <div>
            <p>
              Minca isn’t signed by Apple or Microsoft yet, so the first time it opens, your computer warns
              you that it doesn’t know who made it. After that it opens like any other app.
            </p>
            <ul>
              <li>
                <b>Mac:</b> open the .dmg and drag Minca to Applications. Open it once; when macOS says it
                can’t check it, click <b>Done</b>. Then go to <b>System Settings → Privacy &amp; Security</b>,
                scroll down to “Minca was blocked”, click <b>Open Anyway</b> and confirm.
              </li>
              <li>
                <b>Windows:</b> unzip the download and run the installer. When SmartScreen says it protected
                your PC, click <b>More info</b>, then <b>Run anyway</b>.
              </li>
            </ul>
          </div>
        </div>
      </Band>

      <Band
        id="browser"
        tone="sunken"
        kicker="In your browser"
        title="Nothing to install."
        intro={
          <p>
            Minca runs in any modern browser, on your computer or your phone. Your spaces move while the tab
            is open.
          </p>
        }
      >
        <div className="actions" style={{ justifyContent: 'flex-start' }}>
          <a href={APP} className="btn btn-primary">
            Open Minca in your browser
          </a>
        </div>

        <div className="split" id="chrome" style={{ marginTop: 72 }}>
          <div>
            <div className="kicker-inline">Chrome extension</div>
            <h3>Keep your spaces online with every tab closed.</h3>
          </div>
          <div>
            <p>
              Use Minca in Chrome? The extension keeps your spaces moving while Chrome is open, so your other
              devices and your friends reach you even when no Minca tab is. It can’t read them. You don’t need
              it with the desktop app, which does this itself.
            </p>
            <p>
              Until it’s in the Chrome Web Store, Chrome loads it from a folder: download the zip and unzip
              it, open <code>chrome://extensions</code>, turn on <b>Developer mode</b>, click{' '}
              <b>Load unpacked</b> and choose the folder.
            </p>
            <div className="actions" style={{ justifyContent: 'flex-start', marginTop: 20 }}>
              <a href={DOWNLOADS.chrome} className="btn btn-secondary" download>
                Download for Chrome
              </a>
              <Link to="/extension" className="btn btn-secondary">
                More about the extension
              </Link>
            </div>
          </div>
        </div>
      </Band>

      <Band
        id="verify"
        kicker="Check your download"
        title="Built in the open."
        intro={
          <p>
            Every download is built from Minca’s public source by GitHub, for the release it belongs to, and
            nowhere else.
          </p>
        }
      >
        <div className="split">
          <div>
            <div className="kicker-inline">Checksums and provenance</div>
            <h3>See exactly where a file came from.</h3>
          </div>
          <div>
            <p>
              Each release lists the{' '}
              <a href={DOWNLOADS.checksums} {...EXTERNAL}>
                SHA-256 of every file
              </a>
              , and GitHub vouches for which build made it. With the GitHub CLI:
            </p>
            <p>
              <code>gh attestation verify Minca-mac-arm64.dmg -R leifriksheim/minca</code>
            </p>
            <p>
              Older versions, and what changed in each, are on the{' '}
              <a href={RELEASES} {...EXTERNAL}>
                releases page
              </a>
              .
            </p>
          </div>
        </div>
      </Band>
    </Page>
  );
}
