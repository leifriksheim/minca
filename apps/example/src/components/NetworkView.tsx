import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { checkRelays, MAX_RELAYS, SPACE_RELAYS } from '@minca/core';
import { useMay } from '@minca/app-shared/may';
import type { CarrierSummary, MeshStatus, RelayStatus, SpaceStatus, SpaceSummary } from '@minca/core';
import { useAccess, useAccount, useNetwork, useNode } from '@minca/react';
import { PersonFace } from './PersonFace';
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
function useCarriers(status: SpaceStatus): ReadonlyArray<CarrierSummary> {
  const node = useNode();
  const [carriers, setCarriers] = useState<ReadonlyArray<CarrierSummary>>([]);
  const carrierKeys = status.ownCarriers.join(',');
  useEffect(() => {
    if (!carrierKeys) return;
    void node.carriers
      .list()
      .then(setCarriers)
      .catch(() => {});
  }, [node, carrierKeys]);
  return carriers;
}

type Tone = 'good' | 'warn' | 'danger' | undefined;

/** The tone of each health, and of each relay state, as a dot; none is muted */
const HEALTH_TONE: Record<Health, Tone> = {
  syncing: 'good',
  alone: undefined,
  connecting: 'warn',
  offline: 'danger',
};

const RELAY_TONE: Record<RelayStatus['state'], Tone> = {
  open: 'good',
  connecting: 'warn',
  waiting: 'danger',
  stopped: undefined,
};

function Dot({ tone }: { tone: Tone }) {
  return (
    <small aria-hidden data-tone={tone}>
      ●
    </small>
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
    <>
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
    </>
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
    <aside
      aria-label="Connection"
      className="row"
      data-spread
      data-tone={health === 'offline' ? 'danger' : undefined}
    >
      <div className="stack" data-gap="tight">
        <h2>
          <Dot tone={HEALTH_TONE[health]} /> {title}
        </h2>
        <p>{text}</p>
      </div>
      {retry && (
        <button type="button" onClick={onRetry}>
          Try now
        </button>
      )}
    </aside>
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
        <small>Nobody else right now.</small>
      ) : (
        <ul role="list">
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
                <li key={group.did} className="row">
                  <PeerLine
                    did={group.did}
                    name={name}
                    meta={
                      <>
                        {KIND_LABEL[group.kind]} · <code>{short(only)}</code>
                      </>
                    }
                  />
                </li>
              );
            // An account on more than one device: one row for the account, its devices folded under it.
            return (
              <li key={group.did}>
                <details>
                  <summary className="row">
                    <PeerLine
                      did={group.did}
                      name={group.kind === 'mine' ? 'You, on other devices' : name}
                      meta={`${group.peers.length} devices online`}
                    />
                  </summary>
                  {group.peers.map((peer) => (
                    <small key={peer} className="row">
                      <Dot tone="good" />
                      {group.kind === 'mine' ? 'Your device' : 'Device'} · <code>{short(peer)}</code>
                    </small>
                  ))}
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
function PeerLine({ did, name, meta }: { did: string; name: ReactNode; meta: ReactNode }) {
  return (
    <>
      <PersonFace did={did} size={24} />
      <div className="stack truncate" data-gap="tight">
        <strong>{name}</strong>
        <small>{meta}</small>
      </div>
      <Dot tone="good" />
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
          <button type="button" onClick={onRetry}>
            Reconnect now
          </button>
        ) : null
      }
    >
      {urls.length === 0 ? (
        <small>No relay, so this device only reaches the nodes it is given directly.</small>
      ) : (
        <ul role="list">
          {urls.map((url) => {
            const relay = network.relays.find((r) => r.url === url);
            const ours = named.includes(url);
            return (
              <li key={url} className="row" data-spread>
                <div className="stack" data-gap="tight">
                  <span className="row" data-gap="tight">
                    <Dot tone={relay ? RELAY_TONE[relay.state] : undefined} />
                    <code>{relayName(url)}</code>
                    <span
                      className="tag"
                      title={
                        ours
                          ? 'Named by this space, for every member'
                          : 'Where this app meets, for all your spaces'
                      }
                    >
                      {ours ? 'This space' : 'Your app'}
                    </span>
                  </span>
                  <small>{relay ? relayLine(relay, now) : 'Not connected from this device'}</small>
                  {relay?.problem && relay.state !== 'open' && <p role="alert">{relay.problem}</p>}
                </div>
                {manages && ours && (
                  <button
                    type="button"
                    onClick={() => remove(url)}
                    disabled={busy || named.length === 1}
                    title={named.length === 1 ? 'Add another relay before removing the last one' : undefined}
                    data-intent="danger"
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
        <form onSubmit={(event) => void add(event)} className="row">
          <input
            aria-label="Relay for this space"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Add one for this space: relay.example.com"
            disabled={busy || full}
            autoComplete="off"
            spellCheck={false}
          />
          <button type="submit" disabled={busy || full || !candidate || problem !== null}>
            Add relay
          </button>
        </form>
      )}
      {manages && (error ?? problem) && <p role="alert">{error ?? problem}</p>}
      {manages && full && !error && !problem && <small>A space names at most {MAX_RELAYS} relays.</small>}
      <small>
        {network.turn
          ? 'A relay offers to pass traffic on too, so devices on strict networks can still connect.'
          : 'No relay offers to pass traffic on: two devices behind strict firewalls may not connect.'}
      </small>
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
      <ul role="list">
        {network.connecting.map((attempt) => (
          <li key={attempt.peer} className="row">
            <Dot tone={RELAY_TONE.connecting} />
            <div className="stack truncate" data-gap="tight">
              <strong>
                Connecting to <code>{short(attempt.peer)}</code>
              </strong>
              <small>
                For {duration(now - attempt.since)}
                {attempt.tries > 0 && ` · try ${attempt.tries + 1}`}
              </small>
            </div>
          </li>
        ))}
        {elsewhere.map((link) => (
          <li key={link.peer} className="row">
            <Dot tone={undefined} />
            <div className="stack truncate" data-gap="tight">
              <code>{short(link.peer)}</code>
              <small>
                {link.rooms === 0
                  ? 'Connected, proving itself'
                  : `Connected in ${link.rooms} other ${link.rooms === 1 ? 'space' : 'spaces'}`}
              </small>
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
      value: <code>{status.fingerprint.slice(0, 12)}</code>,
      about: 'Two devices showing the same code hold exactly the same space.',
    },
  ];
  return (
    <Section title="This device’s copy">
      <ul role="list">
        {facts.map((fact) => (
          <li key={fact.label} className="row" data-spread>
            <div className="stack" data-gap="tight">
              <strong>{fact.label}</strong>
              <small>{fact.about}</small>
            </div>
            <strong data-tone={fact.bad ? 'danger' : undefined}>{fact.value}</strong>
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
    <section aria-label={title}>
      <header>
        <h2>{title}</h2>
        {action}
      </header>
      {hint && <small>{hint}</small>}
      {children}
    </section>
  );
}

/** The end of an identifier: enough to tell two apart */
const short = (did: string) => `…${did.slice(-8)}`;
