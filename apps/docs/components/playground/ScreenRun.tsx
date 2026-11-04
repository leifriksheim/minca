'use client';
import { useEffect, useRef, useState } from 'react';
import { createScreenBridge, screenDocument, useAccount, useNode } from '@minca/playground';

/** The kit every screen gets, which scripts/sync.mjs bundles into public/. Fetched once. */
let kit: Promise<string> | null = null;
const loadKit = () => (kit ??= fetch('/minca-ui.js').then((response) => response.text()));

const isLoadRequest = (data: unknown): boolean =>
  typeof data === 'object' && data !== null && 'minca' in data && data.minca === 'ready';

/**
 * A screen, run as the Minca app runs one: a sandboxed frame with no network,
 * reading and writing these collections over one message port, as the person
 * looking. The page around it does nothing else for it.
 */
export function ScreenRun({
  space,
  collections,
  screen,
}: {
  space: string;
  collections: ReadonlyArray<string>;
  screen: string;
}) {
  const node = useNode();
  const account = useAccount();
  const frame = useRef<HTMLIFrameElement>(null);
  const [drawn, setDrawn] = useState(false);
  const names = collections.join('|');
  // A new frame for each run: a changed screen starts afresh.
  const run = [space, names, screen].join('\n');

  useEffect(() => {
    let closed = false;
    let stop: (() => void) | null = null;
    const onMessage = (event: MessageEvent) => {
      const target = frame.current?.contentWindow;
      if (!target || event.source !== target || !isLoadRequest(event.data) || stop) return;
      const channel = new MessageChannel();
      const bridge = createScreenBridge({
        node,
        spaceId: space,
        collections: names.split('|'),
        app: 'playground',
        port: channel.port1,
      });
      stop = () => bridge.close();
      void loadKit().then((ui) => {
        if (closed) return;
        target.postMessage(
          {
            minca: 'load',
            // Drawn as this page is: at night.
            document: screenDocument(screen, [], ui, document.documentElement.dataset.theme),
            me: { did: node.did, name: account.name },
            collections: names.split('|'),
            settings: {},
          },
          // The frame's origin is opaque; the port carries what matters.
          '*',
          [channel.port2],
        );
        setDrawn(true);
      });
    };
    globalThis.addEventListener('message', onMessage);
    return () => {
      closed = true;
      globalThis.removeEventListener('message', onMessage);
      stop?.();
      setDrawn(false);
    };
  }, [node, space, names, screen, account.name]);

  return (
    <iframe
      ref={frame}
      key={run}
      className="screen-frame"
      title="The screen"
      src="/screen.html"
      // No allow-same-origin: it must not be this site.
      sandbox="allow-scripts allow-forms"
      referrerPolicy="no-referrer"
      data-drawn={drawn || undefined}
    />
  );
}
