import { useEffect, useState, type ReactNode } from 'react';
import { describeHost, type HostDescription } from '@minca/core';
import { DEFAULT_HOST } from './relay';
import { HostAddressForm, type Wanted } from './HostAddress';
import { FeatureIcon, StatusPill, type Tone } from './Feature';
import { styles, palette, hstack } from './styles';

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
          <button onClick={() => setOther(false)} style={{ ...styles.linkButton, alignSelf: 'center' }}>
            Use {offer.name} instead
          </button>
        )}
      </>
    );
  return (
    <>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          gap: 12,
          padding: '12px 14px',
          borderRadius: 10,
          background: palette.surface.sunken,
        }}
      >
        <span style={{ fontSize: 14, fontWeight: 500, color: palette.ink.strong }}>{offer.name}</span>
        <span style={styles.quiet}>{price}</span>
      </div>
      <button onClick={onContinue} disabled={busy} data-variant="primary" style={styles.button}>
        {busy ? 'One moment…' : 'Continue'}
      </button>
      <button onClick={() => setOther(true)} style={{ ...styles.linkButton, alignSelf: 'center' }}>
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
      {error && (
        <p role="alert" style={styles.dangerText}>
          {error}
        </p>
      )}
      <div style={{ ...hstack(8), justifyContent: 'flex-end', flexWrap: 'wrap', marginTop: 4 }}>
        <button onClick={onKeep} disabled={busy} data-variant="quiet" style={styles.smallButton}>
          Keep it
        </button>
        <button
          onClick={onStop}
          disabled={busy}
          data-variant="danger"
          style={{ ...styles.smallButton, color: palette.accent.danger }}
        >
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
      <div style={{ flex: '1 1 200px', minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <strong style={{ fontSize: 14, color: palette.ink.strong }}>{name}</strong>
          {pill && <StatusPill tone={pill.tone}>{pill.pill}</StatusPill>}
        </div>
        <p style={{ ...styles.quiet, marginTop: 2, overflowWrap: 'anywhere' }}>{line}</p>
      </div>
      <span style={{ ...hstack(8), flexWrap: 'wrap' }}>{children}</span>
    </>
  );
}
