import { useEffect, useState, type ReactNode } from 'react';
import { describeHost, type HostDescription, type HostingView } from '@minca/core';
import { DEFAULT_HOST } from './relay';
import { HostAddressForm, type Wanted } from './HostAddress';
import { FeatureIcon, StatusPill, shortDate, timeLeft, type Tone } from './Feature';
import { dollars } from './Payment';

const DAY = 86_400;
/** Days before a balance runs out that it is said to run out soon */
export const DUE_DAYS = 14;

/** Bytes as people read them: 12 KB, 3.4 MB, 10 GB */
export function size(bytes: number): string {
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${unit === 0 || value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/**
 * What a host keeps an account's spaces for, in a few words: free, free up
 * to some room and its price by the GB past it, or its price. What hosts are
 * compared by when one is chosen.
 */
export function hostTerms(offer: HostDescription): string {
  if (offer.free) return 'Free';
  const perGb = offer.fund ? `$${offer.fund.perGb} a GB a month` : (offer.price ?? '');
  const limits = offer.limits;
  if (!limits) return perGb;
  const free = `Free up to ${size(limits.accountBytes)}`;
  return offer.fund ? `${free} · then ${perGb}` : free;
}

/** Whether a space over a host's free line is still kept there for free */
export const stillFree = (over: { readonly until: number }): boolean => over.until > Date.now() / 1000;

/** The host this build offers, with its name and price; `asked` once it answered or failed to */
export function useOffer() {
  const [offer, setOffer] = useState<HostDescription | null>(null);
  const [asked, setAsked] = useState(!DEFAULT_HOST);
  useEffect(() => {
    if (!DEFAULT_HOST) return;
    void describeHost(DEFAULT_HOST)
      .then(setOffer, () => {})
      .finally(() => setAsked(true));
  }, []);
  return { offer, asked };
}

/** Calls `ask` now, and again when the tab comes back (from a checkout page in another tab) */
export function useAskAgain(ask: () => unknown) {
  useEffect(() => {
    void ask();
    const again = () => document.visibilityState === 'visible' && void ask();
    document.addEventListener('visibilitychange', again);
    return () => document.removeEventListener('visibilitychange', again);
  }, [ask]);
}

/**
 * Choosing a host: the one this build offers with its price and Continue, or
 * another by its address.
 */
export function HostOfferPicker({
  offer,
  price,
  busy,
  onContinue,
  onAddress,
  addressLabel,
}: {
  offer: HostDescription | null;
  price: string;
  busy: boolean;
  onContinue: () => void;
  onAddress: (url: string, wanted: Wanted) => Promise<void>;
  addressLabel?: string;
}) {
  const [other, setOther] = useState(false);
  if (other || !offer)
    return (
      <>
        <HostAddressForm onAddress={onAddress} {...(addressLabel ? { label: addressLabel } : {})} />
        {offer && (
          <button onClick={() => setOther(false)} data-intent="ghost">
            Use {offer.name} instead
          </button>
        )}
      </>
    );
  return (
    <>
      <aside className="row" data-spread>
        <strong>{offer.name}</strong>
        <small>{price}</small>
      </aside>
      <button onClick={onContinue} disabled={busy} data-intent="primary">
        {busy ? 'One moment…' : 'Continue'}
      </button>
      <button onClick={() => setOther(true)} data-intent="ghost">
        Use another host
      </button>
    </>
  );
}

/** What went wrong, then Keep it and Stop using, at the foot of a dialog that stops a host */
export function StopFooter({
  name,
  busy,
  error,
  onKeep,
  onStop,
}: {
  name: string;
  busy: boolean;
  error: string | null;
  onKeep: () => void;
  onStop: () => void;
}) {
  return (
    <>
      {error && <p role="alert">{error}</p>}
      <div className="row" data-spread>
        <button onClick={onKeep} disabled={busy}>
          Keep it
        </button>
        <button onClick={onStop} disabled={busy} data-intent="danger">
          {busy ? 'Stopping…' : `Stop using ${name}`}
        </button>
      </div>
    </>
  );
}

/** A host's name with a pill for how it stands, a line under it, and its actions to the right */
export function HostStatusRow({
  name,
  pill,
  line,
  size,
  children,
}: {
  name: ReactNode;
  pill: { tone: Tone; pill: string } | null;
  line: ReactNode;
  size: number;
  children: ReactNode;
}) {
  return (
    <>
      <FeatureIcon kind="online" size={size} />
      <div className="stack" data-gap="tight">
        <div className="row">
          <strong>{name}</strong>
          {pill && <StatusPill tone={pill.tone}>{pill.pill}</StatusPill>}
        </div>
        <small>{line}</small>
      </div>
      <span className="row">{children}</span>
    </>
  );
}

/** How the account stands at a host, as a pill and one line */
export function accountStanding(host: HostingView): { tone: Tone; pill: string; line: string } {
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

/**
 * How much the host keeps for the account: a bar against its room where it
 * has one, else what that costs a month. Nothing when the host doesn't say.
 */
export function HostRoom({ host }: { host: HostingView }) {
  const status = host.status;
  if (status?.bytes === undefined) return null;
  if (status.quota !== undefined) {
    const room = Math.min(1, status.bytes / status.quota);
    return (
      <div className="stack" data-gap="tight">
        <progress value={Math.max(room, 0.01)} />
        <small>
          {size(status.bytes)} of {size(status.quota)} used
          {status.full
            ? stillFree(status.full)
              ? ` · over your room: make some, or get more, by ${shortDate(status.full.until)}`
              : ` · over your room: ${host.name} keeps your spaces online again once they fit`
            : room >= 1
              ? ' · a new space waits until there is room'
              : ''}
        </small>
      </div>
    );
  }
  if (status.daily === undefined || status.daily <= 0) return null;
  return (
    <small>
      {size(status.bytes)} kept · about {dollars(status.daily * 30)} a month as they are now
    </small>
  );
}
