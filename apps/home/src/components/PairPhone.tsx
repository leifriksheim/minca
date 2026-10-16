import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import type { PairingOffer, PairingStage } from '@minca/core/session';
import { useAuth } from '@minca/core/react';
import { servedOverLan, relayProblem, relayOnlyLocal } from '@minca/app-shared/relay';
import { Info } from '@minca/app-shared/Info';
import { styles, palette } from '../styles';

/** What each stage of the handover should say out loud. */
function describe(stage: PairingStage): string {
  switch (stage.kind) {
    case 'waiting':
      return 'Waiting for your phone…';
    case 'confirm':
    case 'compare':
      return 'Does your phone show the same code?';
    // Only the phone joins.
    case 'joining':
    case 'sending':
      return 'Sending your account…';
    case 'sent':
      return stage.spaces === 1 ? 'Sent 1 space. Done.' : `Sent ${stage.spaces} spaces. Done.`;
    case 'received':
      return 'Done.';
    case 'failed':
      return stage.reason;
  }
}

/**
 * Hands this account to a phone.
 *
 * The QR is a link, not data — phone cameras open links natively, so there is
 * no scanner here and it works on iOS as well as Android. The link carries a
 * one-time secret, not the account: both devices then show six digits, and
 * the account goes over only once the person says they match.
 */
export function PairPhone() {
  const { auth } = useAuth();
  const [offer, setOffer] = useState<PairingOffer | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [stage, setStage] = useState<PairingStage | null>(null);
  const [starting, setStarting] = useState(false);
  const offerRef = useRef<PairingOffer | null>(null);

  // Stop listening when this panel goes away, or the relay connection leaks.
  useEffect(() => () => offerRef.current?.stop(), []);

  const start = async () => {
    setStarting(true);
    try {
      const started = await auth.offerToPhone(setStage);
      offerRef.current = started;
      setOffer(started);
      setQr(await QRCode.toDataURL(started.url, { width: 260, margin: 1 }));
    } catch (error) {
      setStage({ kind: 'failed', reason: error instanceof Error ? error.message : 'Could not start' });
    } finally {
      setStarting(false);
    }
  };

  const stop = () => {
    offerRef.current?.stop();
    offerRef.current = null;
    setOffer(null);
    setQr(null);
    setStage(null);
  };

  return (
    <details style={{ ...styles.panel, marginTop: 0 }}>
      <summary
        data-variant="ghost"
        style={{ ...styles.panelSummary, ...styles.sectionHeading, padding: '18px 20px' }}
      >
        Add your phone
      </summary>
      <div style={{ ...styles.panelBody, padding: '0 20px 20px' }}>
        {!offer ? (
          <>
            <p style={styles.errorHint}>
              Show a code and point your phone's camera at it.
              <Info label="What your phone becomes">
                The same account, with its own copy of every space — a peer in its own right rather than a
                screen for this one. It keeps working after you close this, and syncs with anyone in the
                space, not just this computer.
              </Info>
            </p>
            {(relayProblem() ?? relayOnlyLocal()) && (
              <p style={styles.error}>{relayProblem() ?? relayOnlyLocal()}</p>
            )}
            {!relayProblem() && !relayOnlyLocal() && !servedOverLan() && (
              <p style={styles.error}>
                This page is on localhost, which your phone cannot reach. Restart with{' '}
                <code>npm run dev -- --host</code> and open the network address it prints.
              </p>
            )}
            <button
              onClick={() => void start()}
              disabled={starting}
              data-variant="primary"
              style={styles.addButton}
            >
              {starting ? 'Starting…' : 'Show pairing code'}
            </button>
          </>
        ) : (
          <>
            {qr && (
              <img
                src={qr}
                alt="Pairing code"
                width={260}
                height={260}
                style={{
                  display: 'block',
                  margin: '14px auto',
                  padding: 12,
                  // A light quiet zone is part of the code, not decoration:
                  // a camera needs the contrast to find the pattern.
                  background: palette.surface.card,
                  border: `1px solid ${palette.surface.line}`,
                  borderRadius: palette.radius.md,
                }}
              />
            )}
            {stage?.kind === 'compare' && (
              <p
                style={{
                  ...styles.hint,
                  fontFamily: palette.mono,
                  fontSize: 28,
                  letterSpacing: '0.15em',
                  textAlign: 'center',
                  color: palette.ink.strong,
                }}
              >
                {stage.code.slice(0, 3)} {stage.code.slice(3)}
              </p>
            )}
            {stage && <p style={stage.kind === 'failed' ? styles.error : styles.hint}>{describe(stage)}</p>}
            {stage?.kind === 'compare' && (
              <div style={styles.linkRow}>
                <button onClick={stage.same} data-variant="primary" style={styles.addButton}>
                  Same code — send
                </button>
                <button onClick={stage.different} data-variant="ghost" style={styles.linkButton}>
                  Different
                </button>
              </div>
            )}
            <p style={styles.errorHint}>
              Works once, for a couple of minutes.
              <Info label="What is in the code">
                A one-time secret and the address of the relay that introduces the two devices — nothing about
                your account. Your account goes to the phone only after you confirm the six digits match, so a
                photo of this code is no use to anyone.
              </Info>
            </p>
            <div style={styles.linkRow}>
              <button onClick={stop} data-variant="ghost" style={styles.linkButton}>
                {stage?.kind === 'sent' || stage?.kind === 'failed' ? 'Done' : 'Stop'}
              </button>
            </div>
          </>
        )}
      </div>
    </details>
  );
}
