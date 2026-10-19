import { useEffect, useRef, type ReactNode } from 'react';
import { Link, useRouterState } from '@tanstack/react-router';
import { APP, EXTERNAL, Page } from './Site';
import { DOWNLOADS } from './downloads';

/**
 * Where every download link lands: the file starts downloading, and the page
 * says how to open it. A download link passes `state={{ download: true }}`;
 * someone who comes here another way gets the steps and a link instead.
 */

export type InstallKind = 'mac' | 'windows' | 'chrome';

const INSTALLS: Record<InstallKind, { title: string; file: string; steps: ReadonlyArray<ReactNode> }> = {
  mac: {
    title: 'Minca for Mac is on its way.',
    file: DOWNLOADS.mac,
    steps: [
      <>
        Open the download and drag <b>Minca</b> into <b>Applications</b>.
      </>,
      <>Open Minca from Applications.</>,
      <>
        Mac asks once: go to <b>System Settings → Privacy &amp; Security</b> and click <b>Open Anyway</b>.
      </>,
    ],
  },
  windows: {
    title: 'Minca for Windows is on its way.',
    file: DOWNLOADS.windows,
    steps: [
      <>Unzip the download.</>,
      <>Open Minca.</>,
      <>
        Windows asks once: click <b>More info → Run anyway</b>.
      </>,
    ],
  },
  chrome: {
    title: 'The extension is on its way.',
    file: DOWNLOADS.chrome,
    steps: [
      <>Unzip it somewhere it can stay, like Documents.</>,
      <>
        Open <code>chrome://extensions</code> and turn on <b>Developer mode</b>.
      </>,
      <>
        Click <b>Load unpacked</b> and pick the folder.
      </>,
    ],
  },
};

/** Props for a link that downloads `kind` and lands on its steps */
export function downloadLink(kind: InstallKind) {
  return { to: `/install/${kind}`, state: { download: true } } as const;
}

export function Install({ kind }: { kind: InstallKind }) {
  const { title, file, steps } = INSTALLS[kind];
  const download = useRouterState({ select: (state) => state.location.state.download === true });
  const started = useRef(false);

  useEffect(() => {
    if (!download || started.current) return;
    started.current = true;
    // The file is served as an attachment, so the page stays where it is.
    window.location.assign(file);
  }, [download, file]);

  return (
    <Page page="download">
      <section className="hero install-page">
        <div className="wrap">
          <h1>{download ? title : 'Three steps and you’re in.'}</h1>
          <div className="steps">
            {steps.map((step, i) => (
              // eslint-disable-next-line react/no-array-index-key -- the steps are fixed
              <div className="step" key={i}>
                <p>{step}</p>
              </div>
            ))}
          </div>
          <p className="install-again">
            {download ? 'Didn’t start? ' : null}
            <a href={file}>{download ? 'Download again' : 'Download'}</a>
            {kind === 'chrome' ? (
              <>
                {' · '}
                <Link to="/extension">What it does</Link>
              </>
            ) : (
              <>
                {' · '}
                <a href={APP} {...EXTERNAL}>
                  Or use it in your browser
                </a>
              </>
            )}
          </p>
        </div>
      </section>
    </Page>
  );
}
