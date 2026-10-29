import { useEffect, useRef, useState } from 'react';
import type { NodeRecord } from '@minca/core';
import { useAccount, useLive, useNode } from '@minca/react';
import { Modal } from '@minca/app-shared/Modal';
import ui from 'virtual:minca-ui';
import { placeAt, searchPlaces, whereAmI } from '@minca/app-shared/places';
import { createScreenBridge, offLimits, screenDocument, type ScreenBridge, type ScreenHost } from './screens';
import { PersonCardHere } from '../Person';
import { RecordFinder } from '../RecordFinder';
import { saveFile } from '../../files';
import { isObject } from '../../derive/schema-ui';
import { styles, palette, hstack } from '../../styles';
import { LinkButton, QuietButton } from '../Buttons';

/**
 * An app's own screen, run sealed: a sandboxed frame with no network, talking to this app's collections
 * over one message port. Origins it names (`network`) are reached only once the person looking agrees.
 */
export function ScreenFrame({
  spaceId,
  appKey,
  collections,
  screen,
  network,
  title,
  onOpen,
  shows = [],
  shown,
  onShown,
}: {
  spaceId: string;
  /** The app's launcher record, which carries the screen */
  appKey: string;
  collections: ReadonlyArray<string>;
  screen: string;
  network: ReadonlyArray<string>;
  title: string;
  /** Shows a record the screen asked to open (`minca.open`) */
  onOpen: (record: NodeRecord) => void;
  /** The collections whose records it is the place to open (`launcher.app`'s `shows`) */
  shows?: ReadonlyArray<string> | undefined;
  /** A record of a collection this app shows that it was asked to show (`minca.onShow`) */
  shown?: string | undefined;
  /** Called once `shown` is handed to the screen */
  onShown?: (() => void) | undefined;
}) {
  const node = useNode();
  const account = useAccount();
  const frame = useRef<HTMLIFrameElement>(null);
  // The person whose card the screen asked for
  const [person, setPerson] = useState<string | null>(null);
  // The screen waiting on the person to choose a record (`minca.pick`), and what they started from
  const [picking, setPicking] = useState<{
    readonly text: string;
    readonly done: (record: NodeRecord | null) => void;
  } | null>(null);
  const pickingNow = useRef(false);
  // Read when the screen asks, so a new handler doesn't start the frame again.
  const opens = useRef(onOpen);
  useEffect(() => {
    opens.current = onOpen;
  }, [onOpen]);
  // The bridge of the running screen, and a record to show once there is one.
  const live = useRef<ScreenBridge | null>(null);
  const pending = useRef<string | undefined>(undefined);
  const handed = useRef(onShown);
  useEffect(() => {
    handed.current = onShown;
  }, [onShown]);
  // Only a record of a collection it shows: the address is anyone's to write, and a screen
  // handed any key would learn which records exist and which the person opens.
  const showing = shows.join('|');
  useEffect(() => {
    if (!shown) return;
    let current = true;
    void node.records.get(spaceId, shown).then((record) => {
      if (!current) return;
      if (!record || !showing.split('|').includes(record.collection)) return void handed.current?.();
      if (live.current) {
        live.current.show(shown);
        handed.current?.();
      } else pending.current = shown;
    });
    return () => {
      current = false;
    };
  }, [node, spaceId, shown, showing]);
  // A new screen, or a new app, starts a new frame.
  const [generation, setGeneration] = useState(0);
  const origins = [...network].sort().join(' ');
  // Compared by value, so a new array with the same names changes nothing.
  const names = collections.join('|');
  const allowed = network.join(' ');
  const consentKey = `minca.screen-network:${node.did}:${spaceId}:${appKey}`;
  const [answer, setAnswer] = useState<'yes' | 'no' | null>(() =>
    origins ? readConsent(consentKey, origins) : 'no',
  );
  // Another list of origins asks again, unless this device kept an answer for it.
  const [askedFor, setAskedFor] = useState(`${consentKey}\n${origins}`);
  if (askedFor !== `${consentKey}\n${origins}`) {
    setAskedFor(`${consentKey}\n${origins}`);
    setAnswer(origins ? readConsent(consentKey, origins) : 'no');
  }
  const answerWith = (value: 'yes' | 'no') => {
    try {
      globalThis.localStorage?.setItem(consentKey, JSON.stringify({ origins, answer: value }));
    } catch {
      // Not remembered: it asks again next time.
    }
    setAnswer(value);
  };

  // The run of the frame that navigated away, if this one did; any change runs it afresh.
  const run = [spaceId, screen, names, account.name, generation, answer, allowed].join('\n');
  const [stoppedRun, setStoppedRun] = useState<string | null>(null);
  const stopped = stoppedRun === run;

  useEffect(() => {
    if (answer === null) return;
    const list = names.split('|');
    let bridge: ScreenBridge | null = null;
    let handedOver = false;
    const onMessage = (event: MessageEvent) => {
      const target = frame.current?.contentWindow;
      if (!target || event.source !== target || !isObject(event.data) || event.data.minca !== 'ready') return;
      if (handedOver) {
        // Only the page we loaded says ready, and only once. Anything after that navigated the frame.
        bridge?.close();
        bridge = null;
        live.current = null;
        setStoppedRun(run);
        return;
      }
      handedOver = true;
      const channel = new MessageChannel();
      bridge = createScreenBridge({
        node,
        spaceId,
        collections: list,
        app: appKey,
        port: channel.port1,
        host: screenHost(`minca.screen:${node.did}:${spaceId}:${appKey}:`, {
          open: (open) => ('record' in open ? opens.current(open.record) : setPerson(open.person)),
          // One choice at a time, asked of the person in this page, never the screen's to make.
          pick: (text) => {
            if (pickingNow.current)
              return Promise.reject(new Error('The person is already choosing a record'));
            pickingNow.current = true;
            return new Promise((resolve) =>
              setPicking({
                text,
                done: (record) => {
                  pickingNow.current = false;
                  setPicking(null);
                  // Back to where the person was typing, as any dialog gives focus back
                  frame.current?.focus();
                  resolve(record);
                },
              }),
            );
          },
        }),
      });
      target.postMessage(
        {
          minca: 'load',
          document: screenDocument(screen, answer === 'yes' && allowed ? allowed.split(' ') : [], ui),
          me: { did: node.did, name: account.name },
          collections: list,
          // Handed over with the document, since a message on the port before it is written in is lost
          shown: pending.current,
        },
        // The frame's origin is opaque, so it can't be named. The port is what carries anything that matters.
        '*',
        [channel.port2],
      );
      live.current = bridge;
      if (pending.current) {
        pending.current = undefined;
        handed.current?.();
      }
    };
    globalThis.addEventListener('message', onMessage);
    return () => {
      globalThis.removeEventListener('message', onMessage);
      bridge?.close();
      live.current = null;
    };
  }, [node, spaceId, appKey, screen, names, account.name, generation, answer, allowed, run]);

  if (answer === null) {
    return (
      <div
        style={{
          ...styles.note,
          margin: 16,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        <p style={{ fontSize: 14, color: palette.ink.strong, lineHeight: 1.5 }}>
          This screen wants to connect to{' '}
          <strong>{network.map((origin) => origin.replace(/^[a-z]+:\/\//, '')).join(', ')}</strong>.
        </p>
        <p style={{ fontSize: 13, color: palette.ink.body, lineHeight: 1.5 }}>
          It runs as you, so it could send there anything you can see in it. Nothing else on the internet is
          reachable. Without it, the screen runs sealed and may do less.
        </p>
        <div style={hstack(8)}>
          <QuietButton onClick={() => answerWith('yes')}>Allow</QuietButton>
          <QuietButton onClick={() => answerWith('no')}>Keep it sealed</QuietButton>
        </div>
      </div>
    );
  }

  if (stopped) {
    return (
      <div
        style={{
          ...styles.errorBox,
          margin: 16,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
      >
        <p style={styles.error}>This screen tried to open another page, so it was stopped.</p>
        <p style={styles.errorHint}>It can't reach your data from there. Reload it to try again.</p>
        <QuietButton onClick={() => setGeneration((n) => n + 1)} style={{ alignSelf: 'flex-start' }}>
          Reload the screen
        </QuietButton>
      </div>
    );
  }

  const hosts = network.map((origin) => origin.replace(/^[a-z]+:\/\//, '')).join(', ');
  // It takes whatever height it is given: the app is the whole window (`.space-content[data-fill]`).
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      {origins && (
        <p
          style={{
            padding: '6px 16px',
            fontSize: 12,
            color: palette.ink.muted,
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            flexWrap: 'wrap',
          }}
        >
          {answer === 'yes' ? `Connects to ${hosts}.` : `Sealed: not connecting to ${hosts}.`}
          <LinkButton
            onClick={() => answerWith(answer === 'yes' ? 'no' : 'yes')}
            style={{ fontSize: 12, padding: 0 }}
          >
            {answer === 'yes' ? 'Seal it' : 'Allow'}
          </LinkButton>
        </p>
      )}
      <iframe
        ref={frame}
        title={title}
        src="/screen.html"
        // No allow-same-origin: it must not be this site. No popups, modals or navigation of this page.
        // Forms only fire their submit event: the policy's form-action 'none' sends them nowhere.
        sandbox="allow-scripts allow-forms"
        referrerPolicy="no-referrer"
        key={`${generation}:${answer}`}
        style={{
          width: '100%',
          flex: 1,
          minHeight: 420,
          border: 'none',
          background: palette.surface.card,
        }}
      />
      {person && <PersonCardHere did={person} onClose={() => setPerson(null)} />}
      {picking && <SharePicker spaceId={spaceId} app={title} text={picking.text} onDone={picking.done} />}
    </div>
  );
}

/**
 * A record for a screen, chosen by the person: the screen gets only this one,
 * as a page gets only the file a person picks for it.
 */
function SharePicker({
  spaceId,
  app,
  text,
  onDone,
}: {
  spaceId: string;
  app: string;
  text: string;
  onDone: (record: NodeRecord | null) => void;
}) {
  const collections = useLive(spaceId, (n) => n.collections.list(spaceId), [spaceId]) ?? [];
  return (
    <Modal title={`Share with ${app}`} onClose={() => onDone(null)}>
      <p style={{ ...styles.quiet, lineHeight: 1.5 }}>{app} gets only the one you choose.</p>
      <RecordFinder
        spaceId={spaceId}
        collections={collections}
        accepts={(r) => !offLimits(r.collection)}
        onPick={onDone}
        initialText={text}
      />
    </Modal>
  );
}

/**
 * What this page does for a screen when it asks (`ScreenHost`): finds places
 * and where the person is the way the rest of the app does, opens pages and
 * saves files, asks the person to choose a record, and keeps the app's own
 * small things under `kept`, a prefix for this person, space and app.
 */
function screenHost(kept: string, { open, pick }: Pick<ScreenHost, 'open' | 'pick'>): ScreenHost {
  return {
    open,
    pick,
    searchPlaces: (text, near) => searchPlaces(text, near ? { near } : {}),
    here: async () => {
      const at = await whereAmI();
      if (!at) return null;
      const found = await placeAt(at.lat, at.lon).catch(() => null);
      return found
        ? { ...found, lat: at.lat, lon: at.lon }
        : { name: 'My location', detail: '', lat: at.lat, lon: at.lon, kind: 'point' };
    },
    link: (url) => void globalThis.open(url, '_blank', 'noopener,noreferrer'),
    save: (name, bytes, type) => saveFile(bytes, name, type),
    recall: (key) => {
      try {
        const value: unknown = JSON.parse(globalThis.localStorage?.getItem(kept + key) ?? 'null');
        return value;
      } catch {
        return null;
      }
    },
    remember: (key, value) => {
      try {
        if (value === null) globalThis.localStorage?.removeItem(kept + key);
        else globalThis.localStorage?.setItem(kept + key, JSON.stringify(value));
      } catch {
        // Private windows can refuse: it is kept until the page closes, or not at all.
      }
    },
  };
}

/** What this person said to a screen's list of origins, when it was this same list */
function readConsent(key: string, origins: string): 'yes' | 'no' | null {
  try {
    const kept: unknown = JSON.parse(globalThis.localStorage?.getItem(key) ?? 'null');
    return isObject(kept) && kept.origins === origins && (kept.answer === 'yes' || kept.answer === 'no')
      ? kept.answer
      : null;
  } catch {
    return null;
  }
}
