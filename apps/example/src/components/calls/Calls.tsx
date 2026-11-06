import { useEffect, useRef, useState } from 'react';
import { PersonFace } from '../PersonFace';
import { createPortal } from 'react-dom';
import type { SpaceSummary } from '@minca/core';
import type { CallAround, CallPeer, CurrentCall, IncomingCall } from '@minca/calls';
import { useCalls } from '@minca/calls/react';
import { useAccount, useConnection, useProfiles } from '@minca/react';
import { nameOf, peopleFrom } from '../../derive/people';
import { Icon, type IconName } from '@minca/app-shared/Icon';
import { ask } from '@minca/app-shared/Ask';
import { useNow } from '../NetworkView';
import { notify } from '../../notifications';
import { play, RING } from '../../sound';
import styles from './Calls.module.css';

/** Calls, drawn once above every space, so moving between spaces never touches one. */
export function CallLayer({
  spaces,
  onGoTo,
}: {
  spaces: ReadonlyArray<SpaceSummary>;
  onGoTo: (space: SpaceSummary) => void;
}) {
  const { state } = useCalls();
  const { connection } = useConnection();
  // In a call, this tab keeps its node while put away: the call's presence and setup go through it.
  const inCall = state.current !== null;
  useEffect(() => (inCall ? connection.keepAwake() : undefined), [connection, inCall]);
  const spaceNamed = (id: string) => spaces.find((s) => s.id === id)?.name ?? 'a space';
  const goTo = (id: string) => {
    const space = spaces.find((s) => s.id === id);
    if (space) onGoTo(space);
  };
  useRingTone(state.ringing.length > 0);

  return (
    <>
      {state.ringing.length > 0 && (
        <div className={styles.overlay}>
          {state.ringing.map((ring, i) => (
            <Ringing
              key={ring.id}
              ring={ring}
              spaceName={spaceNamed(ring.space)}
              inCall={state.current}
              first={i === 0}
              onGoTo={() => goTo(ring.space)}
            />
          ))}
        </div>
      )}
      <div className={styles.stack} aria-live="polite">
        {state.rejoin && !state.current && (
          <Rejoin call={state.rejoin} spaceName={spaceNamed(state.rejoin.space)} />
        )}
      </div>
      {state.current && (
        <CallPanel
          call={state.current}
          spaceName={spaceNamed(state.current.space)}
          onGoTo={() => goTo(state.current!.space)}
        />
      )}
    </>
  );
}

/** Asks before leaving one call for another. True to go ahead. */
async function mayLeaveFor(current: CurrentCall | null, what: string): Promise<boolean> {
  return (
    !current || ask(`Leave the call you're in and ${what}?`, { title: 'You are in a call', yes: 'Leave it' })
  );
}

// ─── The call you're in ──────────────────────────────────────────────

function CallPanel({
  call,
  spaceName,
  onGoTo,
}: {
  call: CurrentCall;
  spaceName: string;
  onGoTo: () => void;
}) {
  const { calls } = useCalls();
  const people = peopleFrom(useProfiles(call.space));
  const [stage, setStage] = useState(false);
  const pip = usePictureInPicture();
  const elapsed = useElapsed(call.joinedAt);
  const canShare = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia;
  const act = (fn: () => Promise<void> | void) => () => void Promise.resolve(fn()).catch(() => {});

  const outgoing = call.outgoing && (
    <small>
      {call.outgoing.state === 'ringing'
        ? `Ringing ${nameOf(call.outgoing.to, people)}…`
        : call.outgoing.state === 'declined'
          ? `${nameOf(call.outgoing.to, people)} can't talk right now.`
          : `${nameOf(call.outgoing.to, people)} didn't answer.`}
    </small>
  );

  const tiles = <Tiles call={call} people={people} large={stage || pip.window !== null} />;

  return (
    <article aria-label={`Call in ${spaceName}`} className={styles.panel} data-stage={stage || undefined}>
      <header>
        <span>
          <small data-tone="good">●</small>{' '}
          <button onClick={onGoTo} data-intent="inline" title="Go to this space">
            {spaceName}
          </button>{' '}
          <small>{elapsed}</small>
        </span>
        {pip.supported && (
          <RoundButton
            icon="pip"
            label={pip.window ? 'Back from picture-in-picture' : 'Picture-in-picture'}
            on={pip.window !== null}
            onClick={pip.toggle}
          />
        )}
        <RoundButton
          icon={stage ? 'shrink' : 'expand'}
          label={stage ? 'Make smaller' : 'Make bigger'}
          onClick={() => setStage(!stage)}
        />
      </header>

      {/* Voices play here, apart from the tiles: a video element with no picture yet may never start, and moving the tiles to picture-in-picture shouldn't cut anyone off. */}
      {call.people.map((person) =>
        person.stream ? <Voice key={person.peer} stream={person.stream} /> : null,
      )}

      {outgoing}
      {call.problem && <p role="alert">{call.problem}</p>}

      {pip.window ? (
        <>
          <small>Showing in picture-in-picture.</small>
          {createPortal(<div className={styles.pip}>{tiles}</div>, pip.window.document.body)}
        </>
      ) : (
        tiles
      )}

      <footer>
        <RoundButton
          icon={call.muted ? 'micOff' : 'mic'}
          label={call.muted ? 'Unmute' : 'Mute'}
          on={call.muted}
          onClick={() => calls?.setMuted(!call.muted)}
        />
        <RoundButton
          icon={call.camera && !call.sharing ? 'camera' : 'cameraOff'}
          label={call.camera ? 'Turn camera off' : 'Turn camera on'}
          on={!call.camera}
          onClick={act(() => calls?.setCamera(!call.camera || call.sharing))}
        />
        {canShare && (
          <RoundButton
            icon="screen"
            label={call.sharing ? 'Stop sharing' : 'Share your screen'}
            on={call.sharing}
            onClick={act(() => (call.sharing ? calls?.stopSharing() : calls?.shareScreen()))}
          />
        )}
        <RoundButton icon="hangUp" label="Leave the call" danger onClick={act(() => calls?.leave())} />
      </footer>
    </article>
  );
}

function Tiles({
  call,
  people,
  large,
}: {
  call: CurrentCall;
  people: ReturnType<typeof peopleFrom>;
  large: boolean;
}) {
  const { did: me } = useAccount();
  const others = call.people;
  return (
    <div className={styles.tiles} data-count={Math.min(others.length + 1, 6)} data-large={large || undefined}>
      {others.map((person) => (
        <Tile
          key={person.peer}
          name={nameOf(person.account, people)}
          did={person.account}
          stream={person.stream}
          camera={person.camera}
          muted={person.muted}
          note={noteFor(person)}
        />
      ))}
      <Tile name="You" did={me} stream={call.local} camera={call.camera} muted={call.muted} self />
      {others.length === 0 && !call.outgoing && <small>Nobody else here yet.</small>}
    </div>
  );
}

const noteFor = (person: CallPeer) =>
  person.connection === 'connecting'
    ? 'Connecting…'
    : person.connection === 'failed'
      ? "Can't connect"
      : null;

function Tile({
  name,
  did,
  stream,
  camera,
  muted,
  self = false,
  note = null,
}: {
  name: string;
  did: string;
  stream: MediaStream | null;
  camera: boolean;
  muted: boolean;
  self?: boolean;
  note?: string | null;
}) {
  const showVideo = camera && !!stream?.getVideoTracks().length;
  return (
    <figure className={styles.tile}>
      {/* Picture only: voices play in the panel (Voice). */}
      {stream && <Video stream={stream} mirror={self} hidden={!showVideo} />}
      {!showVideo && (
        <span>
          <PersonFace did={did} size={40} />
        </span>
      )}
      <figcaption className="tag">
        {muted && <Icon name="micOff" size={12} />}
        {name}
        {note && ` · ${note}`}
      </figcaption>
    </figure>
  );
}

function Video({ stream, mirror, hidden }: { stream: MediaStream; mirror: boolean; hidden: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = ref.current;
    if (video && video.srcObject !== stream) video.srcObject = stream;
  }, [stream]);
  // Hidden by opacity, not display, so the picture keeps playing and shows the moment a camera turns on.
  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted
      data-mirror={mirror || undefined}
      data-off={hidden || undefined}
    />
  );
}

/**
 * One person's voice. Its own element, holding only their sound, so it starts
 * whether or not their camera is on. Where the browser won't play sound before
 * the page has been touched, it starts at the next click or key.
 */
function Voice({ stream }: { stream: MediaStream }) {
  const ref = useRef<HTMLAudioElement>(null);
  const track = stream.getAudioTracks()[0] ?? null;
  useEffect(() => {
    const audio = ref.current;
    if (!audio || !track || typeof MediaStream === 'undefined') return;
    audio.srcObject = new MediaStream([track]);
    const play = () => void audio.play().then(stopWaiting, () => {});
    const stopWaiting = () => {
      document.removeEventListener('pointerdown', play);
      document.removeEventListener('keydown', play);
    };
    audio.play().catch(() => {
      document.addEventListener('pointerdown', play);
      document.addEventListener('keydown', play);
    });
    return () => {
      stopWaiting();
      audio.srcObject = null;
    };
  }, [track]);
  return <audio ref={ref} autoPlay hidden />;
}

// ─── Someone ringing ─────────────────────────────────────────────────

function Ringing({
  ring,
  spaceName,
  inCall,
  first,
  onGoTo,
}: {
  ring: IncomingCall;
  spaceName: string;
  inCall: CurrentCall | null;
  first: boolean;
  onGoTo: () => void;
}) {
  const { calls } = useCalls();
  const people = peopleFrom(useProfiles(ring.space));
  const [busy, setBusy] = useState(false);
  const name = nameOf(ring.from, people);
  useCallNotice(ring.id, `${name} is calling`, `In ${spaceName}`, onGoTo);
  const answer = async (video: boolean) => {
    if (!calls || !(await mayLeaveFor(inCall, 'answer this one'))) return;
    setBusy(true);
    void calls.answer(ring.id, { video }).catch(() => setBusy(false));
  };
  return (
    <article
      className={styles.incoming}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={`ring-${ring.id}`}
    >
      <span className={styles.ringing}>
        <PersonFace did={ring.from} size={72} />
      </span>
      <div>
        <h2 id={`ring-${ring.id}`}>{name}</h2>
        <small>is calling you · {spaceName}</small>
      </div>
      <div className="row" data-gap="loose">
        <Choice
          icon="hangUp"
          label="Decline"
          tone="danger"
          disabled={busy}
          onClick={() => void calls?.decline(ring.id)}
        />
        <Choice
          icon="phone"
          label="Answer"
          tone="good"
          disabled={busy}
          autoFocus={first}
          onClick={() => void answer(false)}
        />
        <Choice
          icon="camera"
          label="With video"
          tone="good"
          disabled={busy}
          onClick={() => void answer(true)}
        />
      </div>
    </article>
  );
}

/** A big round button with its word under it, for answering */
function Choice({
  icon,
  label,
  tone,
  disabled,
  autoFocus = false,
  onClick,
}: {
  icon: IconName;
  label: string;
  tone: 'good' | 'danger';
  disabled: boolean;
  autoFocus?: boolean;
  onClick: () => void;
}) {
  return (
    <label>
      <button
        onClick={onClick}
        disabled={disabled}
        autoFocus={autoFocus}
        data-icon
        data-intent={tone === 'good' ? 'primary' : 'danger'}
      >
        <Icon name={icon} size={20} />
      </button>
      {label}
    </label>
  );
}

function Rejoin({ call, spaceName }: { call: CallAround; spaceName: string }) {
  const { calls } = useCalls();
  return (
    <article className={styles.card}>
      <p>
        You were in a call in <strong>{spaceName}</strong>. It's still going on.
      </p>
      <div className="row">
        <button onClick={() => calls?.forgetRejoin()}>Dismiss</button>
        <button
          data-intent="primary"
          onClick={() => void calls?.start(call.space, { call: call.id }).catch(() => {})}
        >
          Rejoin
        </button>
      </div>
    </article>
  );
}

// ─── In a space ──────────────────────────────────────────────────────

const whoCanJoin = (space: SpaceSummary) =>
  space.visibility === 'public'
    ? 'Anyone who joins this space with a role can join the call'
    : 'Only people in this space can join';

/** Starts a call in the space, or joins the one going, with sound only or with the camera on: in the row atop its Overview, which draws it */
export function CallButton({ space, video = false }: { space: SpaceSummary; video?: boolean }) {
  const { state, calls } = useCalls();
  const [busy, setBusy] = useState(false);
  if (!calls || !space.writable) return null;
  const here = state.current?.space === space.id;
  const going = state.around.find((c) => c.space === space.id);
  const startHere = async () => {
    if (!(await mayLeaveFor(state.current, going ? 'join this one' : 'start one here'))) return;
    setBusy(true);
    void calls.start(space.id, { video }).finally(() => setBusy(false));
  };
  return (
    <button
      data-intent="ghost"
      onClick={() => void startHere()}
      disabled={busy || here}
      title={going ? `Join the call · ${going.people.length}` : whoCanJoin(space)}
      // Green while a call is going here, so joining it is plain.
      className={here || going ? styles.going : undefined}
    >
      <Icon name={video ? 'camera' : 'phone'} size={20} />
      {video ? 'Video' : 'Voice'}
    </button>
  );
}

/** Rings one person in a space — beside their name */
export function RingButton({ space, did, name }: { space: SpaceSummary; did: string; name: string }) {
  const { state, calls } = useCalls();
  if (!calls || !space.writable) return null;
  const ringing = state.current?.outgoing?.to === did && state.current.outgoing.state === 'ringing';
  const withThem = state.current?.people.some((p) => p.account === did);
  return (
    <button
      onClick={() =>
        void mayLeaveFor(state.current?.space === space.id ? null : state.current, `call ${name}`).then(
          (go) => {
            if (go) void calls.ring(space.id, did).catch(() => {});
          },
        )
      }
      disabled={ringing || withThem}
      aria-label={withThem ? `In a call with ${name}` : ringing ? `Ringing ${name}` : `Call ${name}`}
      title={
        withThem
          ? `In a call with ${name}`
          : ringing
            ? `Ringing ${name}…`
            : `Call ${name}. It rings wherever they have this space open.`
      }
      data-icon
      className={ringing || withThem ? styles.going : undefined}
    >
      <Icon name="phone" size={14} />
    </button>
  );
}

// ─── Pieces ──────────────────────────────────────────────────────────

function RoundButton({
  icon,
  label,
  onClick,
  on = false,
  danger = false,
}: {
  icon: IconName;
  label: string;
  onClick: () => void;
  on?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      aria-pressed={on || undefined}
      data-icon
      data-intent={danger ? 'danger' : undefined}
    >
      <Icon name={icon} size={18} />
    </button>
  );
}

function useElapsed(since: number): string {
  const now = useNow();
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  const two = (n: number) => String(n).padStart(2, '0');
  return seconds >= 3600
    ? `${Math.floor(seconds / 3600)}:${two(Math.floor(seconds / 60) % 60)}:${two(seconds % 60)}`
    : `${two(Math.floor(seconds / 60))}:${two(seconds % 60)}`;
}

/**
 * A window of its own that stays on top when you switch tabs, where the
 * browser has Document Picture-in-Picture (Chrome, Edge). The page's styles
 * are copied in, so the tiles look the same there.
 */
function usePictureInPicture(): { supported: boolean; window: Window | null; toggle: () => void } {
  const api = globalThis.documentPictureInPicture;
  const [pip, setPip] = useState<Window | null>(null);
  useEffect(() => () => pip?.close(), [pip]);
  const toggle = () => {
    if (pip) {
      pip.close();
      setPip(null);
      return;
    }
    void api
      ?.requestWindow({ width: 360, height: 260 })
      .then((opened) => {
        for (const sheet of document.querySelectorAll('style, link[rel="stylesheet"]'))
          opened.document.head.appendChild(sheet.cloneNode(true));
        opened.document.body.className = styles.pipBody ?? '';
        opened.addEventListener('pagehide', () => setPip(null));
        setPip(opened);
      })
      .catch(() => {});
  };
  return { supported: !!api, window: pip, toggle };
}

/** A call ringing while you look elsewhere: a notification that stays until it stops ringing */
function useCallNotice(id: string, title: string, body: string, onGoTo: () => void) {
  const goTo = useRef(onGoTo);
  goTo.current = onGoTo;
  useEffect(() => {
    const shown = notify(title, { body, tag: id, sticky: true, onClick: () => goTo.current() });
    return () => shown?.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once for the call: a name that loads later doesn't show it again
  }, [id]);
}

/** A soft two-note ring while someone is calling */
function useRingTone(ringing: boolean) {
  useEffect(() => {
    if (!ringing) return;
    play(RING);
    const timer = setInterval(() => play(RING), 2000);
    return () => clearInterval(timer);
  }, [ringing]);
}
