import { useEffect, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { checkRelays, MAX_RELAYS, SPACE_RELAYS } from '@minca/core';
import { useMay } from '@minca/app-shared/may';
import type { CarrierSummary, MeshStatus, RelayStatus, SpaceStatus, SpaceSummary } from '@minca/core';
import { useAccess, useAccount, useNetwork, useNode } from '@minca/react';
import { PersonAvatar } from './std/PersonAvatar';
import {
  duration,
  groupPeers,
  healthOf,
  nextRetry,
  relayLine,
  relayName,
  type Health,
  type PeerKind,
} from '../derive/network';
import { styles, palette, hstack, stack, ui } from '../styles';
import { Person } from './Person';
import { DocsNote } from './DocsNote';
import { useAction } from '@minca/app-shared/action';
import { confirmThen } from '../confirm';

/** The time now, a second at a time, for countdowns and "for 4 min" */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** The carriers this account has, read again when the ones syncing the space change */
export function useCarriers(status: SpaceStatus): ReadonlyArray<CarrierSummary> {
  const node = useNode();
  const [carriers, setCarriers] = useState<ReadonlyArray<CarrierSummary>>([]);
  const carrierKeys = status.carriers.join(',');
  useEffect(() => {
    if (!carrierKeys) return;
    void node.carriers
      .list()
      .then(setCarriers)
      .catch(() => {});
  }, [node, carrierKeys]);
  return carriers;
}

/** The colour of each health, and of each relay state, as a dot */
export const HEALTH_COLOR: Record<Health, string> = {
  syncing: palette.accent.good,
  alone: palette.ink.faint,
  connecting: palette.accent.warn,
  offline: palette.accent.danger,
};

const RELAY_COLOR: Record<RelayStatus['state'], string> = {
  open: palette.accent.good,
  connecting: palette.accent.warn,
  waiting: palette.accent.danger,
  stopped: palette.ink.faint,
};

export function Dot({ color, size = 8 }: { color: string; size?: number }) {
  return (
    <span
      aria-hidden
      style={{
        display: 'inline-block',
        flexShrink: 0,
        width: size,
        height: size,
        borderRadius: '50%',
        backgroundColor: color,
      }}
    />
  );
}

/** How this space reaches other devices, made to answer "why isn't my other device here?" */
export function NetworkView({ space, status }: { space: SpaceSummary; status: SpaceStatus | undefined }) {
  const node = useNode();
  const network = useNetwork();
  const access = useAccess(space.id);
  const mayNameRelays = useMay(space.id, SPACE_RELAYS);
  const now = useNow();
  const health = healthOf(status, network);

  return (
    <div style={stack(36)}>
      <Summary
        health={health}
        status={status}
        network={network}
        now={now}
        onRetry={() => node.network.reconnect()}
      />
      {status && <Peers status={status} />}
      <Relays
        space={space}
        named={access?.relays ?? []}
        manages={!!access && mayNameRelays}
        network={network}
        now={now}
        onRetry={() => node.network.reconnect()}
      />
      <Connections network={network} status={status} now={now} />
      {status && <SyncFacts status={status} />}
      <DocsNote path="spec/04-network.md">
        Devices meet through a relay, then connect directly and introduce each other.
      </DocsNote>
    </div>
  );
}

// ─── The one sentence ───────────────────────────────────────────────

function Summary({
  health,
  status,
  network,
  now,
  onRetry,
}: {
  health: Health;
  status: SpaceStatus | undefined;
  network: MeshStatus;
  now: number;
  onRetry: () => void;
}) {
  const retry = nextRetry(network);
  const peers = status?.peers.length ?? 0;
  const copy: Record<Health, [string, ReactNode]> = {
    syncing: [
      `Syncing with ${peers} ${peers === 1 ? 'device' : 'devices'}`,
      'Changes here reach them within a moment, and theirs reach you.',
    ],
    alone: [
      'Online, waiting for others',
      'The relay is reachable, but none of your other devices or the people in this space have it open right now. They will connect as soon as one does.',
    ],
    connecting: [
      network.connecting.length > 0 ? `Connecting to ${network.connecting.length} …` : 'Connecting…',
      'Finding the relay and the devices in this space.',
    ],
    offline: [
      "Can't reach the relay",
      network.relays.length === 0
        ? 'No relay is configured, so this device cannot find any other.'
        : retry?.retryAt
          ? `Nothing leaves this device until it can. Trying again in ${duration(retry.retryAt - now)}. Your changes are saved here and go out once it's back.`
          : 'Nothing leaves this device until it can. Your changes are saved here and go out once it is back.',
    ],
  };
  const [title, text] = copy[health];

  return (
    <section
      aria-label="Connection"
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 14,
        padding: 18,
        borderRadius: palette.radius.lg,
        border: `1px solid ${health === 'offline' ? palette.accent.danger : palette.surface.line}`,
        backgroundColor: health === 'offline' ? palette.accent.dangerSoft : palette.surface.sunken,
      }}
    >
      <span style={{ paddingTop: 7 }}>
        <Dot color={HEALTH_COLOR[health]} size={10} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <h2 style={{ ...styles.appTitle, fontSize: 18 }}>{title}</h2>
        <p style={{ fontSize: 14, color: palette.ink.body, marginTop: 4, lineHeight: 1.6 }}>{text}</p>
      </div>
      {retry && (
        <button type="button" onClick={onRetry} style={styles.smallButton}>
          Try now
        </button>
      )}
    </section>
  );
}

// ─── Who is here ───────────────────────────────────────────────────

const KIND_LABEL: Record<PeerKind, string> = {
  mine: 'Your device',
  person: 'Member',
  carrier: 'Carrier · keeps the space online, cannot read it',
  server: "Server · didn't say whose it is",
};

function Peers({ status }: { status: SpaceStatus }) {
  const { did: me } = useAccount();
  const carriers = useCarriers(status);

  const groups = groupPeers(status, me);
  return (
    <Section title="In this space" hint="Devices syncing this space with you right now, and whose they are.">
      {groups.length === 0 ? (
        <p style={empty}>Nobody else right now.</p>
      ) : (
        <ul className="rows" style={ui.list}>
          {groups.map((group) => {
            const name =
              group.kind === 'mine' ? (
                'You, on another device'
              ) : group.kind === 'carrier' ? (
                (carriers.find((c) => c.did === group.did)?.name ?? 'A carrier')
              ) : group.kind === 'person' ? (
                <Person did={group.did} />
              ) : (
                'A server'
              );
            const [only] = group.peers;
            if (only !== undefined && group.peers.length === 1)
              return (
                <li key={group.did} style={row}>
                  <PeerLine
                    spaceId={status.space}
                    did={group.did}
                    name={name}
                    meta={
                      <>
                        {KIND_LABEL[group.kind]} · <Mono>{short(only)}</Mono>
                      </>
                    }
                  />
                </li>
              );
            // An account on more than one device: one row for the account, its devices folded under it.
            return (
              <li key={group.did}>
                <details className="peer-fold">
                  <summary style={{ ...row, cursor: 'pointer' }}>
                    <PeerLine
                      spaceId={status.space}
                      did={group.did}
                      name={group.kind === 'mine' ? 'You, on other devices' : name}
                      meta={`${group.peers.length} devices online`}
                    />
                  </summary>
                  <ul style={{ listStyle: 'none', margin: 0, padding: '0 14px 8px 50px' }}>
                    {group.peers.map((peer) => (
                      <li
                        key={peer}
                        style={{ ...meta, display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}
                      >
                        <span style={{ flex: 1 }}>
                          {group.kind === 'mine' ? 'Your device' : 'Device'} · <Mono>{short(peer)}</Mono>
                        </span>
                        <Dot color={palette.accent.good} size={6} />
                      </li>
                    ))}
                  </ul>
                </details>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

/** Whose a peer is, in one row: the account's avatar, a name, and what it is */
function PeerLine({
  spaceId,
  did,
  name,
  meta: line,
}: {
  spaceId: string;
  did: string;
  name: ReactNode;
  meta: ReactNode;
}) {
  return (
    <>
      <PersonAvatar spaceId={spaceId} did={did} size={24} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, color: palette.ink.strong }}>{name}</div>
        <div style={meta}>{line}</div>
      </div>
      <Dot color={palette.accent.good} />
    </>
  );
}

// ─── Relays ────────────────────────────────────────────────────────

/**
 * Every relay in play here, in one list: the ones this space names for its members, which someone
 * who runs it can change, and the ones this app meets on for all your spaces.
 */
function Relays({
  space,
  named,
  manages,
  network,
  now,
  onRetry,
}: {
  space: SpaceSummary;
  named: ReadonlyArray<string>;
  manages: boolean;
  network: MeshStatus;
  now: number;
  onRetry: () => void;
}) {
  const node = useNode();
  const [draft, setDraft] = useState('');
  const { run, busy, error } = useAction();

  const candidate = relayUrl(draft);
  const problem = candidate ? checkRelays([...named, candidate]) : null;
  const full = named.length >= MAX_RELAYS;
  const waiting = network.relays.some((relay) => relay.state === 'waiting');
  // The space's own first, then the app's.
  const urls = [...new Set([...named, ...network.relays.map((relay) => relay.url)])];

  const save = (relays: ReadonlyArray<string>) => run(() => node.spaces.setRelays(space.id, relays));
  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (!candidate || problem) return;
    if (await save([...named, candidate])) setDraft('');
  };
  const remove = (url: string) =>
    confirmThen(
      'Members still on only that relay lose touch until their apps pick up the change from someone else.',
      { title: `Stop meeting on ${relayName(url)}?`, yes: 'Stop' },
      () => save(named.filter((u) => u !== url)),
    );

  return (
    <Section
      title="Relays"
      hint="A relay introduces devices to each other, then steps aside: they talk directly, and it never sees what is in the space. The ones this space names let every member find the others, whatever app they use."
      action={
        waiting ? (
          <button type="button" onClick={onRetry} style={styles.smallButton}>
            Reconnect now
          </button>
        ) : null
      }
    >
      {urls.length === 0 ? (
        <p style={empty}>No relay, so this device only reaches the nodes it is given directly.</p>
      ) : (
        <ul className="rows" style={ui.list}>
          {urls.map((url) => {
            const relay = network.relays.find((r) => r.url === url);
            const ours = named.includes(url);
            return (
              <li key={url} style={{ ...row, alignItems: 'flex-start' }}>
                <span style={{ paddingTop: 6 }}>
                  <Dot color={relay ? RELAY_COLOR[relay.state] : palette.ink.faint} />
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 14, color: palette.ink.strong, overflowWrap: 'anywhere' }}>
                      <Mono>{relayName(url)}</Mono>
                    </span>
                    <span
                      style={tag}
                      title={
                        ours
                          ? 'Named by this space, for every member'
                          : 'Where this app meets, for all your spaces'
                      }
                    >
                      {ours ? 'This space' : 'Your app'}
                    </span>
                  </div>
                  <div style={meta}>{relay ? relayLine(relay, now) : 'Not connected from this device'}</div>
                  {relay?.problem && relay.state !== 'open' && (
                    <div style={{ ...meta, color: palette.accent.danger }}>{relay.problem}</div>
                  )}
                </div>
                {manages && ours && (
                  <button
                    type="button"
                    onClick={() => remove(url)}
                    disabled={busy || named.length === 1}
                    title={named.length === 1 ? 'Add another relay before removing the last one' : undefined}
                    data-variant="danger"
                    style={{ ...styles.smallButton, flexShrink: 0, color: palette.accent.danger }}
                  >
                    Remove
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {manages && (
        <form onSubmit={(event) => void add(event)} style={{ ...hstack(8), flexWrap: 'wrap' }}>
          <label htmlFor="space-relay" style={visuallyHidden}>
            Relay for this space
          </label>
          <input
            id="space-relay"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Add one for this space: relay.example.com"
            disabled={busy || full}
            autoComplete="off"
            spellCheck={false}
            style={{ ...styles.input, flex: '1 1 240px', minWidth: 0 }}
          />
          <button
            type="submit"
            disabled={busy || full || !candidate || problem !== null}
            data-variant="quiet"
            style={styles.smallButton}
          >
            Add relay
          </button>
        </form>
      )}
      {manages && (full || problem || error) && (
        <p
          role="alert"
          style={{ ...meta, color: full && !error ? palette.ink.muted : palette.accent.danger }}
        >
          {error ?? problem ?? `A space names at most ${MAX_RELAYS} relays.`}
        </p>
      )}
      <p style={meta}>
        {network.turn
          ? 'A relay offers to pass traffic on too, so devices on strict networks can still connect.'
          : 'No relay offers to pass traffic on: two devices behind strict firewalls may not connect.'}
      </p>
    </Section>
  );
}

/** What someone typed as a relay, as a URL: "relay.example" means wss://relay.example */
function relayUrl(typed: string): string | null {
  const text = typed.trim().replace(/\/+$/, '');
  if (!text) return null;
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `wss://${text}`;
}

// ─── Connections ───────────────────────────────────────────────────

function Connections({
  network,
  status,
  now,
}: {
  network: MeshStatus;
  status: SpaceStatus | undefined;
  now: number;
}) {
  const here = new Set(status?.peers ?? []);
  const elsewhere = network.links.filter((link) => !here.has(link.peer));
  if (network.connecting.length === 0 && elsewhere.length === 0) return null;
  return (
    <Section
      title="On this device"
      hint="Connections this device holds for all your spaces, and the ones it is still trying to make. A connection that doesn't open within a while is given up and tried again."
    >
      <ul className="rows" style={ui.list}>
        {network.connecting.map((attempt) => (
          <li key={attempt.peer} style={row}>
            <Dot color={RELAY_COLOR.connecting} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, color: palette.ink.strong }}>
                Connecting to <Mono>{short(attempt.peer)}</Mono>
              </div>
              <div style={meta}>
                For {duration(now - attempt.since)}
                {attempt.tries > 0 && ` · try ${attempt.tries + 1}`}
              </div>
            </div>
          </li>
        ))}
        {elsewhere.map((link) => (
          <li key={link.peer} style={row}>
            <Dot color={palette.ink.faint} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, color: palette.ink.strong }}>
                <Mono>{short(link.peer)}</Mono>
              </div>
              <div style={meta}>
                {link.rooms === 0
                  ? 'Connected, proving itself'
                  : `Connected in ${link.rooms} other ${link.rooms === 1 ? 'space' : 'spaces'}`}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </Section>
  );
}

// ─── Sync ──────────────────────────────────────────────────────────

/** This device's copy of the space, in plain words: whether what you changed went out, and what came in broken */
function SyncFacts({ status }: { status: SpaceStatus }) {
  const facts: ReadonlyArray<{ label: string; value: ReactNode; about: string; bad?: boolean }> = [
    status.pending === 0
      ? { label: 'Sent', value: 'All of it', about: 'Every change you made here has reached another device.' }
      : {
          label: 'Not sent yet',
          value: `${status.pending} ${status.pending === 1 ? 'change' : 'changes'}`,
          about: 'Saved here, and sent as soon as another device in the space is online.',
        },
    {
      label: 'Turned away',
      value: status.rejected === 0 ? 'Nothing' : String(status.rejected),
      about:
        status.rejected === 0
          ? 'Everything others sent checked out.'
          : 'Things others sent that broke the space’s rules, so this device didn’t keep them.',
      bad: status.rejected > 0,
    },
    {
      label: 'Keeps',
      value:
        status.holds === 'all'
          ? 'Everything'
          : `${status.holds.length} ${status.holds.length === 1 ? 'collection' : 'collections'}`,
      about: 'What this device keeps a copy of.',
    },
    {
      label: 'Version',
      value: <Mono>{status.fingerprint.slice(0, 12)}</Mono>,
      about: 'Two devices showing the same code hold exactly the same space.',
    },
  ];
  return (
    <Section title="This device’s copy">
      <ul className="rows" style={ui.list}>
        {facts.map((fact) => (
          <li key={fact.label} style={{ ...row, alignItems: 'flex-start' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, color: palette.ink.strong }}>{fact.label}</div>
              <div style={meta}>{fact.about}</div>
            </div>
            <span
              style={{
                fontSize: 14,
                fontWeight: 600,
                color: fact.bad ? palette.accent.danger : palette.ink.strong,
                whiteSpace: 'nowrap',
              }}
            >
              {fact.value}
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

// ─── Pieces ────────────────────────────────────────────────────────

function Section({
  title,
  hint,
  action,
  children,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} style={stack(10)}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, justifyContent: 'space-between' }}>
        <h2 style={{ ...styles.appTitle, fontSize: 20 }}>{title}</h2>
        {action}
      </div>
      {hint && <p style={{ ...styles.quiet, margin: 0, lineHeight: 1.6 }}>{hint}</p>}
      {children}
    </section>
  );
}

function Mono({ children }: { children: ReactNode }) {
  return <span style={{ fontFamily: palette.mono, fontSize: 12 }}>{children}</span>;
}

/** The end of an identifier: enough to tell two apart */
const short = (did: string) => `…${did.slice(-8)}`;

const row: CSSProperties = { display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px' };
/** A small label beside a relay's name: whose it is */
const tag: CSSProperties = { ...styles.badge, color: palette.ink.body, background: palette.surface.sunken };
const meta: CSSProperties = { fontSize: 12, color: palette.ink.muted, marginTop: 2 };
const empty: CSSProperties = { fontSize: 13, color: palette.ink.faint, margin: 0 };
const visuallyHidden: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
};
