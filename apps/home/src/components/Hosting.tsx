import { useCallback, useEffect, useState } from 'react';
import { useAsync, useSession } from '@minca/react';
import { describeHost, type HostDescription, type OverSpace } from '@minca/core';
import type { HostingView, P2PNode } from '@minca/core/node';
import { DEFAULT_HOST } from '@minca/app-shared/relay';
import { Modal } from '@minca/app-shared/Modal';
import { Loader } from '@minca/app-shared/Loader';
import { useWanted, type Wanted } from '@minca/app-shared/HostAddress';
import {
  HostOfferPicker,
  HostStatusRow,
  StopFooter,
  hostTerms,
  size,
  stillFree,
  useAskAgain,
  useOffer,
} from '@minca/app-shared/HostOffer';
import { ChipIn, RemindMe, dollars } from '@minca/app-shared/Payment';
import { Benefit, FeatureIcon, StatusPill, shortDate, timeLeft, type Tone } from '@minca/app-shared/Feature';
import { message, useAction } from '@minca/app-shared/action';
import { styles, palette, hstack, stack } from '../styles';

const DAY = 86_400;
/** A balance is worth topping up this long before it runs out */
const TOP_UP_DAYS = 30;
/** Days before a balance runs out that the home says so at the top */
const DUE_DAYS = 14;

/**
 * "Keep my spaces online": one host carrying every space of the account
 * without being able to read them, free up to its room and paid by the GB
 * past it, from a balance the account adds to. Choosing and paying happen
 * here, not on the host's site (spec/06-nodes-and-sessions.md, Hosts).
 */
export function Hosting({ node }: { node: P2PNode }) {
  const [hosts, setHosts] = useState<ReadonlyArray<HostingView> | null>(null);
  const { offer } = useOffer();
  const [dialog, setDialog] = useState<{ url: string | null } | null>(null);
  const [stopping, setStopping] = useState<HostingView | null>(null);
  const [doing, setDoing] = useState<string | null>(null);
  const { run, busy: acting, error, setError } = useAction();
  const busy = acting ? doing : null;

  const load = useCallback(
    () => node.hosting.list().then(setHosts, (reason: unknown) => setError(message(reason))),
    [node, setError],
  );
  useAskAgain(load);

  const act = (what: string, work: () => Promise<void>) => {
    setDoing(what);
    return run(work);
  };
  const again = () => act('again', load);

  return (
    <section id="hosting" style={{ ...styles.settingsSection, gap: 16 }}>
      {hosts === null && !error ? (
        <Loader label="Asking your host" showLabel />
      ) : hosts?.length ? (
        <>
          <h2 style={styles.sectionHeading}>Always online</h2>
          {hosts.map((host) => (
            <HostRow
              key={host.url}
              node={node}
              host={host}
              busy={busy}
              onAddTime={() => setDialog({ url: host.url })}
              onAgain={() => void again()}
              onStop={() => setStopping(host)}
              remind={(email) => node.hosting.remind(host.url, email)}
            />
          ))}
        </>
      ) : (
        <Offer offer={offer} onTurnOn={() => setDialog({ url: null })} />
      )}

      {error && <p style={styles.dangerText}>{error}</p>}

      {dialog && (
        <HostingDialog
          node={node}
          url={dialog.url}
          offer={offer}
          onClose={() => {
            setDialog(null);
            void load();
          }}
        />
      )}
      {stopping && (
        <StopDialog
          node={node}
          host={stopping}
          onClose={() => {
            setStopping(null);
            void load();
          }}
        />
      )}
    </section>
  );
}

/** Off: what it gives, the price, and one button */
function Offer({ offer, onTurnOn }: { offer: HostDescription | null; onTurnOn: () => void }) {
  return (
    <div style={stack(16)}>
      <div style={{ ...hstack(14), alignItems: 'center' }}>
        <FeatureIcon kind="online" size={44} />
        <div style={{ flex: 1 }}>
          <h2 style={styles.sectionHeading}>Keep your spaces online</h2>
          <p style={{ ...styles.quiet, marginTop: 2 }}>
            {offer ? `${offer.name} · ${hostTerms(offer)}` : 'With a host you choose'}
          </p>
        </div>
      </div>
      <ul style={{ listStyle: 'none', ...stack(10) }}>
        <Benefit glyph="clock">Reachable when all your devices are off</Benefit>
        <Benefit glyph="restore">Everything back on a new device, from your recovery code alone</Benefit>
        <Benefit glyph="shield">Encrypted end to end: the host keeps it and can't read it</Benefit>
      </ul>
      <button onClick={onTurnOn} data-variant="primary" style={styles.addButton}>
        Turn on
      </button>
    </div>
  );
}

/** On: the host, how it stands, and what can be done */
function HostRow({
  node,
  host,
  busy,
  onAddTime,
  onAgain,
  onStop,
  remind,
}: {
  node: P2PNode;
  host: HostingView;
  busy: string | null;
  onAddTime: () => void;
  /** Asks a host that didn't answer once more */
  onAgain: () => void;
  onStop: () => void;
  remind: (email: string) => Promise<void>;
}) {
  const state = standing(host);
  const status = host.status;
  const room =
    status?.bytes !== undefined && status.quota !== undefined
      ? Math.min(1, status.bytes / status.quota)
      : null;
  return (
    <div style={stack(12)}>
      <div style={{ ...hstack(14), alignItems: 'center', flexWrap: 'wrap' }}>
        <HostStatusRow size={40} name={host.name} pill={state} line={state.line}>
          {!host.live && (
            <button
              onClick={onAgain}
              disabled={busy !== null}
              data-variant="quiet"
              style={styles.smallButton}
            >
              {busy === 'again' ? 'Asking…' : 'Try again'}
            </button>
          )}
          {host.fund && (
            <button
              onClick={onAddTime}
              data-variant={needsPaying(host) ? 'primary' : 'quiet'}
              style={needsPaying(host) ? styles.darkSmall : styles.smallButton}
            >
              {status?.plan === 'free' ? 'More room' : 'Add money'}
            </button>
          )}
          <button onClick={onStop} disabled={busy !== null} data-variant="danger" style={styles.smallButton}>
            Stop
          </button>
        </HostStatusRow>
      </div>
      {room !== null && status?.bytes !== undefined && status.quota !== undefined && (
        <div style={stack(6)}>
          <div
            style={{
              height: 4,
              borderRadius: palette.radius.pill,
              background: palette.surface.sunken,
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                width: `${Math.max(room * 100, 1)}%`,
                height: '100%',
                background: room >= 1 ? palette.accent.danger : palette.accent.base,
              }}
            />
          </div>
          <p style={styles.faint}>
            {size(status.bytes)} of {size(status.quota)} used
            {status.full
              ? stillFree(status.full)
                ? ` · over your room: make some, or get more, by ${shortDate(status.full.until)}`
                : ` · over your room: ${host.name} keeps your spaces online again once they fit`
              : room >= 1
                ? ' · a new space waits until there is room'
                : ''}
          </p>
        </div>
      )}
      {room === null && status?.bytes !== undefined && status.daily !== undefined && status.daily > 0 && (
        <p style={styles.faint}>
          {size(status.bytes)} kept · about {dollars(status.daily * 30)} a month as they are now
        </p>
      )}
      {status?.over && status.over.length > 0 && (
        <OverSpaces node={node} host={host.name} over={status.over} />
      )}
      {host.reminds && status && status.plan !== 'free' && status.paidUntil > 0 && (
        <RemindMe remind={remind} />
      )}
    </div>
  );
}

/**
 * The communities the host keeps for free only a while longer: more people
 * write in each than it keeps for free, so each needs a fund of its own,
 * which its members start in the space. Nothing leaves anyone's devices.
 */
function OverSpaces({ node, host, over }: { node: P2PNode; host: string; over: ReadonlyArray<OverSpace> }) {
  const spaces = useAsync(() => node.spaces.list(), [node]);
  const names = new Map(spaces.status === 'done' ? spaces.value.map((space) => [space.id, space.name]) : []);
  return (
    <ul style={styles.todoList}>
      {over.map((one) => (
        <li
          key={one.space}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '10px 12px',
            borderRadius: palette.radius.md,
            border: `1px solid ${palette.surface.line}`,
          }}
        >
          <StatusPill tone={stillFree(one) ? 'warn' : 'bad'}>
            {stillFree(one) ? `Free until ${shortDate(one.until)}` : 'Needs a fund'}
          </StatusPill>
          <span style={{ flex: 1, fontSize: 13, color: palette.ink.muted }}>
            {names.get(one.space) ?? 'A community you’re in'} has outgrown free hosting.{' '}
            {stillFree(one)
              ? `Start a fund in it to keep it at ${host} after that.`
              : `Its own fund keeps it at ${host} now; it stays on members' devices either way.`}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Turning it on, or adding money: choosing a host, then how much */
function HostingDialog({
  node,
  url,
  offer,
  onClose,
}: {
  node: P2PNode;
  url: string | null;
  offer: HostDescription | null;
  onClose: () => void;
}) {
  const [host, setHost] = useState<HostingView | null>(null);
  const { run, busy, error: problem } = useAction();
  const wanted = useWanted();

  useEffect(() => {
    if (!url) return;
    void node.hosting.list().then((hosts) => setHost(hosts.find((known) => known.url === url) ?? null));
  }, [node, url]);

  /** Starts using the host at an address, once it answered as one and is still wanted */
  const start = async (where: string, stillWanted: Wanted) => {
    await describeHost(where);
    if (!stillWanted()) return;
    const view = await node.hosting.use(where);
    if (!stillWanted()) return;
    if (!view.fund || !needsPaying(view)) return onClose();
    setHost(view);
  };
  const balance = host?.status?.balance ?? 0;

  return (
    <Modal title="Keep your spaces online" onClose={onClose} width={460}>
      <div style={stack(18)}>
        <div style={{ ...hstack(14), alignItems: 'center' }}>
          <FeatureIcon kind="online" size={44} />
          <div>
            <p style={styles.sectionHeading}>{host ? host.name : 'Always online'}</p>
            <p style={styles.quiet}>
              {host
                ? `$${host.fund?.perGb ?? ''} a GB a month, from what you add`
                : 'Your spaces, reachable around the clock'}
            </p>
          </div>
        </div>

        {host?.fund ? (
          <ChipIn
            fund={host.fund}
            start={(payment) => node.hosting.pay(host.url, payment)}
            paid={async () =>
              ((await node.hosting.list()).find((known) => known.url === host.url)?.status?.balance ?? 0) >
              balance
            }
            onDone={onClose}
            {...(host.status ? { rate: host.status } : {})}
          />
        ) : url ? (
          <Loader label="One moment" showLabel />
        ) : (
          <HostOfferPicker
            offer={offer}
            price={offer ? hostTerms(offer) : ''}
            busy={busy}
            onContinue={() => void run(() => start(DEFAULT_HOST ?? '', wanted))}
            onAddress={start}
            addressLabel="Continue"
          />
        )}
        {problem && (
          <p role="alert" style={styles.dangerText}>
            {problem}
          </p>
        )}
        <p style={{ ...styles.faint, lineHeight: 1.5, textAlign: 'center' }}>
          The host sees which spaces exist, how big they are and when they change, never what's in them.
        </p>
      </div>
    </Modal>
  );
}

/** Stopping a host, said before it happens; a card that adds every month is stopped at the provider */
function StopDialog({ node, host, onClose }: { node: P2PNode; host: HostingView; onClose: () => void }) {
  const { run, busy, error } = useAction();
  const status = host.status;
  const stop = () => void run(() => node.hosting.stop(host.url).then(onClose));
  const said = { fontSize: 14, color: palette.ink.body, lineHeight: 1.5 };
  return (
    <Modal title={`Stop using ${host.name}?`} onClose={onClose} width={460}>
      <div style={stack(12)}>
        <p style={said}>
          {host.name} forgets your spaces. They stay on your devices, and are reachable only while one of them
          is online.
        </p>
        {host.fund?.recurring && host.fund.manage && (
          <p style={said}>
            A card that adds every month keeps adding until it is stopped.{' '}
            <a
              href={host.fund.manage}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: palette.ink.strong }}
            >
              Stop it at the payment provider
            </a>
          </p>
        )}
        {status && (status.balance ?? 0) > 0 && (
          <p style={said}>The {dollars(status.balance ?? 0)} left isn't paid back.</p>
        )}
        {!host.live && (
          <p style={said}>
            {host.name} isn't answering right now, so it may be a while before it drops what it has.
          </p>
        )}
        <StopFooter name={host.name} busy={busy} error={error} onKeep={onClose} onStop={stop} />
      </div>
    </Modal>
  );
}

/** Above everything else, when a balance runs out soon or has: from the host's signed `paidUntil` */
export function HostingDue() {
  const { node } = useSession();
  const asked = useAsync(async () => {
    const now = Date.now() / 1000;
    return (await node.hosting.list()).filter((host) => {
      const status = host.status;
      // On a free plan nothing runs out: a balance ending only means less room.
      if (!status || status.paidUntil === 0 || status.plan === 'free') return false;
      return status.state === 'grace' || status.paidUntil - now < DUE_DAYS * DAY;
    });
  }, [node]);
  const due = asked.status === 'done' ? asked.value : [];
  return due.map((host) => {
    const state = standing(host);
    return (
      <div
        key={host.url}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          marginBottom: 16,
          padding: '10px 12px 10px 14px',
          // A row inside the section: the row corner, a hairline.
          borderRadius: palette.radius.md,
          border: `1px solid ${palette.surface.line}`,
          background: palette.surface.card,
        }}
      >
        <StatusPill tone={state.tone}>{state.pill}</StatusPill>
        <span style={{ flex: 1, fontSize: 13, color: palette.ink.muted }}>
          Your spaces at {host.name}. They stay on your devices either way.
        </span>
        <a
          href="#hosting"
          style={{
            ...styles.smallButton,
            display: 'inline-flex',
            alignItems: 'center',
            textDecoration: 'none',
          }}
        >
          Add money
        </a>
      </div>
    );
  });
}

/** How the account stands at a host, as a pill and one line */
function standing(host: HostingView): { tone: Tone; pill: string; line: string } {
  const status = host.status;
  const offline = host.live ? '' : ` · can't reach it right now`;
  if (!status) return { tone: 'bad', pill: "Can't reach host", line: host.error ?? 'Try again in a while' };
  const room =
    status.bytes !== undefined && status.quota !== undefined && status.bytes >= status.quota ? ' · full' : '';
  if (status.state === 'active' && (status.paidUntil === 0 || status.plan === 'free'))
    return { tone: 'good', pill: 'Online', line: `${status.plan ? 'Free plan' : 'Free'}${room}${offline}` };
  if (status.state === 'active') {
    const soon = status.paidUntil - Date.now() / 1000 < DUE_DAYS * DAY;
    return {
      tone: soon ? 'warn' : 'good',
      pill: soon ? `Runs out ${timeLeft(status.paidUntil)}` : 'Online',
      line: `${dollars(status.balance ?? 0)} left · lasts until about ${shortDate(status.paidUntil)}${room}${offline}`,
    };
  }
  if (status.state === 'grace')
    return {
      tone: 'bad',
      pill: 'Needs money',
      line: `Ran out ${shortDate(status.paidUntil)}. Your spaces stay online a little longer, paid for from what you add next${offline}`,
    };
  return {
    tone: 'neutral',
    pill: host.fund ? 'Not paid yet' : 'Off',
    line: host.fund ? `Add money to turn it on${offline}` : `This host isn't taking new accounts${offline}`,
  };
}

/** Not paid, running out, or a balance that ends within a month */
function needsPaying(host: HostingView): boolean {
  const status = host.status;
  if (!status || status.state !== 'active') return true;
  if (status.plan === 'free' || status.paidUntil === 0) return false;
  return status.paidUntil - Date.now() / 1000 < TOP_UP_DAYS * DAY;
}
