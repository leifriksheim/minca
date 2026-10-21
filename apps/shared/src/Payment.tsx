import { useEffect, useState } from 'react';
import { message, useAction, useCopy } from './action';
import qrcode from 'qrcode-generator';
import type { FundOffer, FundPayment, PayAnswer } from '@minca/core';
import { Glyph } from './Feature';
import { styles, palette } from './styles';

type Request = Extract<PayAnswer, { request: unknown }>['request'];

/**
 * Paying a host, shown here rather than on the host's own site
 * (spec/06-nodes-and-sessions.md, Hosts): an amount into a balance, an
 * account's or a community's fund (`ChipIn`). A checkout page, at the
 * payment provider, opens in a new tab; a payment request shows here as an
 * amount, a QR code and one click for a wallet in this browser. Nothing
 * about paying passes through this page but the host's answer.
 *
 * `paid` is asked every few seconds once paying has started: the host sees
 * the payment arrive by itself, and says so in its status.
 */

type Step = 'choose' | 'checkout' | 'done' | Request;

/**
 * Paying, once a way to pay is chosen: opens the checkout page (inside the
 * click, so no popup blocker stops it) or shows the payment request, then
 * asks the host every few seconds until it says the money arrived.
 */
function usePaying(paid: () => Promise<boolean>) {
  const [step, setStep] = useState<Step>('choose');
  const { run, busy, error: problem } = useAction();

  // Once paying has started, the host's word is what moves it on.
  useEffect(() => {
    if (step === 'choose' || step === 'done') return;
    const timer = setInterval(() => {
      void paid().then(
        (yes) => yes && setStep('done'),
        () => {},
      );
    }, 4000);
    return () => clearInterval(timer);
  }, [paid, step]);

  const begin = (method: 'checkout' | 'request', start: () => Promise<PayAnswer>) => {
    const tab = method === 'checkout' ? window.open('about:blank', '_blank') : null;
    void run(async () => {
      const answer = await start().catch((error: unknown) => {
        tab?.close();
        throw error;
      });
      if ('request' in answer) {
        tab?.close();
        return setStep(answer.request);
      }
      setStep('checkout');
      if (!tab) return void window.open(answer.checkout, '_blank', 'noopener');
      // Cut the tab loose first: the provider's page can't reach back into this one.
      tab.opener = null;
      tab.location.href = answer.checkout;
    });
  };
  return { step, setStep, busy, problem, begin };
}

/** What follows choosing: the checkout tab, the payment request, or done */
function PayingSteps({ paying, onDone }: { paying: ReturnType<typeof usePaying>; onDone?: () => void }) {
  const { step, setStep } = paying;
  if (step === 'done')
    return (
      <div
        style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: '12px 0' }}
      >
        <span
          style={{
            width: 44,
            height: 44,
            borderRadius: 22,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: palette.accent.goodSoft,
            color: palette.accent.good,
          }}
        >
          <Glyph name="check" size={22} style={{ strokeWidth: 2 }} />
        </span>
        <p style={{ fontSize: 16, fontWeight: 600, color: palette.ink.strong }}>Payment received</p>
        <p style={{ fontSize: 13, color: palette.ink.muted }}>Thank you. It's already working.</p>
        {onDone && (
          <button onClick={onDone} data-variant="primary" style={{ ...styles.button, marginTop: 8 }}>
            Done
          </button>
        )}
      </div>
    );
  if (step === 'checkout')
    return (
      <Waiting
        title="Finish paying in the new tab"
        detail="This updates by itself once the payment goes through."
        onBack={() => setStep('choose')}
      />
    );
  if (step === 'choose') return null;
  return <PaymentRequest request={step} onBack={() => setStep('choose')} />;
}

/** Amounts people pick most, in dollars */
const AMOUNTS = ['5', '10', '25'] as const;

/**
 * Adding to a balance, an account's or a community's fund: an amount (a few
 * to pick, or any other), by card or from a wallet, and by card every month
 * if the host offers it. A community's fund pays for keeping it online and
 * for its bots, so this is the one way anyone pays for either. What a grace
 * left owing is paid first, and the estimate says so.
 */
export function ChipIn({
  fund,
  start,
  paid,
  onDone,
  cta,
  rate,
}: {
  fund: FundOffer;
  start: (payment: FundPayment) => Promise<PayAnswer>;
  paid: () => Promise<boolean>;
  onDone?: () => void;
  /** The button's words before the amount: "Add" */
  cta?: string;
  /**
   * What the balance spends now, from the host's status: its daily rate in
   * millionths of a dollar, what is in it (below zero: owed), and the bots it
   * pays for. Without it, the rate is keeping a GB online alone. `adding`
   * names a bot about to start, whose use nothing says yet.
   */
  rate?: {
    readonly daily?: number;
    readonly balance?: number;
    readonly bots?: ReadonlyArray<{ readonly name: string }>;
    readonly adding?: string;
  };
}) {
  const [preset, setPreset] = useState<string>(AMOUNTS[1]);
  const [other, setOther] = useState('');
  const [method, setMethod] = useState<'checkout' | 'request'>(fund.methods[0] ?? 'checkout');
  const [monthly, setMonthly] = useState(false);
  const paying = usePaying(paid);
  const amount = preset === 'other' ? other.trim() : preset;
  const valid = /^\d{1,5}(\.\d{1,2})?$/.test(amount) && Number(amount) >= Number(fund.min);
  // At the rate it spends now: keeping it online, and its bots as they have been spending.
  // Unknown, a space pays for one GB, the least it does.
  const daily = rate?.daily && rate.daily > 0 ? rate.daily : (Number(fund.perGb) * 1e6) / 30;
  const owed = Math.max(0, -(rate?.balance ?? 0));
  const months = valid ? Math.max(0, Number(amount) * 1e6 - owed) / daily / 30 : 0;
  const bots = rate?.bots ?? [];

  if (paying.step !== 'choose') return <PayingSteps paying={paying} onDone={onDone} />;
  const chip = (on: boolean) => ({
    flex: 1,
    height: 44,
    borderRadius: 10,
    fontSize: 15,
    fontWeight: 600,
    background: on ? palette.surface.sunken : palette.surface.card,
    color: palette.ink.strong,
    border: `1px solid ${on ? palette.ink.strong : palette.surface.line}`,
    boxShadow: on ? `0 0 0 1px ${palette.ink.strong}` : 'none',
  });
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div role="radiogroup" aria-label="Amount" style={{ display: 'flex', gap: 8 }}>
        {AMOUNTS.map((dollars) => (
          <button
            key={dollars}
            role="radio"
            aria-checked={preset === dollars}
            onClick={() => setPreset(dollars)}
            style={chip(preset === dollars)}
          >
            ${dollars}
          </button>
        ))}
        <button
          role="radio"
          aria-checked={preset === 'other'}
          onClick={() => setPreset('other')}
          style={{ ...chip(preset === 'other'), fontWeight: 500 }}
        >
          Other
        </button>
      </div>
      {preset === 'other' && (
        <input
          value={other}
          onChange={(event) => setOther(event.target.value.replace(/^\$/, ''))}
          inputMode="decimal"
          placeholder={`Dollars, at least ${fund.min}`}
          aria-label="Amount in dollars"
          autoFocus
          style={styles.input}
        />
      )}
      {fund.methods.length > 1 && (
        <div
          role="radiogroup"
          aria-label="Pay with"
          style={{ display: 'flex', padding: 3, borderRadius: 10, background: palette.surface.sunken }}
        >
          {fund.methods.map((known) => (
            <button
              key={known}
              role="radio"
              aria-checked={method === known}
              onClick={() => setMethod(known)}
              style={{
                flex: 1,
                height: 34,
                borderRadius: 8,
                border: 'none',
                fontSize: 13,
                fontWeight: 500,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
                background: method === known ? palette.surface.card : 'transparent',
                color: method === known ? palette.ink.strong : palette.ink.muted,
                boxShadow: method === known ? palette.shadow.small : 'none',
              }}
            >
              <Glyph name={known === 'checkout' ? 'card' : 'wallet'} size={14} />
              {known === 'checkout' ? 'Card' : 'Crypto'}
            </button>
          ))}
        </div>
      )}
      {fund.recurring && method === 'checkout' && (
        <label
          style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, color: palette.ink.body }}
        >
          <input type="checkbox" checked={monthly} onChange={(event) => setMonthly(event.target.checked)} />
          Add this every month
        </label>
      )}
      <button
        onClick={() =>
          paying.begin(method, () =>
            start({ amount, method, ...(monthly && method === 'checkout' ? { monthly: true } : {}) }),
          )
        }
        disabled={paying.busy || !valid}
        data-variant="primary"
        style={styles.button}
      >
        {paying.busy
          ? 'One moment…'
          : `${cta ?? 'Add'} ${valid ? `$${amount}` : ''}${monthly && method === 'checkout' ? ' a month' : ''}`}
      </button>
      <p style={{ fontSize: 12, color: palette.ink.faint, textAlign: 'center' }}>
        {valid && owed > 0
          ? Number(amount) * 1e6 <= owed
            ? `Pays ${dollars(Number(amount) * 1e6)} of the ${dollars(owed)} owed: it turns on past that.`
            : `Pays the ${dollars(owed)} owed first, then keeps it online for about ${lastsFor(months)}.`
          : valid
            ? rate?.adding
              ? `About ${lastsFor(months)} online, less what ${rate.adding} uses${fund.botTypical ? `: ${perReply(fund.botTypical)}` : ''}.`
              : bots.length
                ? `Lasts about ${lastsFor(months)} at the current rate, with ${bots.map((bot) => bot.name).join(' and ')}.`
                : `Keeps it online for about ${lastsFor(months)}.`
            : `At least $${fund.min}.`}
      </p>
      {paying.problem && <p style={{ fontSize: 13, color: palette.accent.danger }}>{paying.problem}</p>}
    </div>
  );
}

/** Months as people say them: "3 weeks", "2 months", "a year" */
export function lastsFor(months: number): string {
  const days = months * 30;
  if (days < 14) return `${Math.max(1, Math.round(days))} days`;
  // Weeks up to three months: two and a half months is neither 2 nor 3, and two estimates must not disagree.
  if (days < 91) return `${Math.round(days / 7)} weeks`;
  if (months < 23) return `${Math.round(months)} months`;
  return `${Math.round(months / 12)} years`;
}

/** What a usual bot reply costs, from a fund's `botTypical` dollars: "about 4¢ a reply" */
export function perReply(typical: string): string {
  const cents = Number(typical) * 100;
  if (cents < 1) return 'under 1¢ a reply';
  return cents < 99.5 ? `about ${Math.round(cents)}¢ a reply` : `about $${(cents / 100).toFixed(2)} a reply`;
}

/** Millionths of a dollar as dollars: $23.40 */
export function dollars(micros: number): string {
  return `$${(micros / 1e6).toFixed(2)}`;
}

function Waiting({ title, detail, onBack }: { title: string; detail: string; onBack: () => void }) {
  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: '16px 0' }}
    >
      <Pulse />
      <p style={{ fontSize: 15, fontWeight: 600, color: palette.ink.strong }}>{title}</p>
      <p style={{ fontSize: 13, color: palette.ink.muted, textAlign: 'center' }}>{detail}</p>
      <button onClick={onBack} style={{ ...styles.linkButton, marginTop: 4 }}>
        Choose another way to pay
      </button>
    </div>
  );
}

/** A dot that breathes while waiting for the host */
function Pulse() {
  return (
    <span
      aria-hidden
      style={{
        width: 10,
        height: 10,
        borderRadius: 5,
        background: palette.accent.good,
        animation: 'minca-fade 0.9s ease-in-out infinite alternate',
      }}
    />
  );
}

/**
 * Asking the host to email a reminder before paid time runs out: a small
 * link that opens into one field. The host mails a link to confirm first,
 * so the address is only used once its owner says yes.
 */
export function RemindMe({ remind }: { remind: (email: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [asked, setAsked] = useState(false);
  const { run, busy, error: problem } = useAction();
  if (asked)
    return <p style={{ fontSize: 13, color: palette.ink.muted }}>Check your inbox for a link to confirm.</p>;
  if (!open)
    return (
      <button onClick={() => setOpen(true)} style={{ ...styles.linkButton, padding: 0 }}>
        Email me before it runs out
      </button>
    );
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void run(() => remind(email.trim()).then(() => setAsked(true)));
      }}
      style={{ display: 'flex', flexDirection: 'column', gap: 6 }}
    >
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="you@example.com"
          aria-label="Email for reminders"
          autoComplete="email"
          autoFocus
          style={{ ...styles.input, flex: 1, height: 36 }}
        />
        <button
          type="submit"
          disabled={busy || !email.trim()}
          data-variant="quiet"
          style={{ ...styles.smallButton, height: 36 }}
        >
          Remind me
        </button>
      </div>
      {problem && <p style={{ fontSize: 13, color: palette.accent.danger }}>{problem}</p>}
    </form>
  );
}

/** A payment to send from a wallet: the amount, a QR code, and one click for a wallet in this browser */
function PaymentRequest({ request, onBack }: { request: Request; onBack: () => void }) {
  const [wallet, setWallet] = useState<Eip1193 | null>(null);
  const [sending, setSending] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [problem, setProblem] = useState<string | null>(null);
  const { copied, copy } = useCopy();

  useEffect(() => {
    void browserWallet().then(setWallet);
  }, []);

  const send = async () => {
    if (!wallet || !request.evm) return;
    setSending('sending');
    setProblem(null);
    try {
      await sendTransfer(wallet, request.evm);
      setSending('sent');
    } catch (error) {
      setSending('idle');
      setProblem(walletError(error));
    }
  };
  const [amount, network] = request.amount.split(' on ');
  const to = request.evm?.to;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', gap: 20, alignItems: 'center', flexWrap: 'wrap' }}>
        <div
          style={{
            padding: 8,
            border: `1px solid ${palette.surface.rule}`,
            background: palette.ink.inverse,
            lineHeight: 0,
          }}
        >
          <QrCode text={request.uri} />
        </div>
        <div style={{ flex: 1, minWidth: 180, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span
            style={{ fontSize: 12, color: palette.ink.muted, textTransform: 'uppercase', letterSpacing: 0.5 }}
          >
            Send exactly
          </span>
          <span
            style={{ fontSize: 24, fontWeight: 600, letterSpacing: '-0.02em', color: palette.ink.strong }}
          >
            {amount}
          </span>
          {network && <span style={{ fontSize: 13, color: palette.ink.muted }}>on {network}</span>}
          {to && (
            <button
              onClick={() => copy(to)}
              style={{ ...styles.linkButton, padding: 0, marginTop: 6, textAlign: 'left', fontSize: 12 }}
            >
              To <code>{`${to.slice(0, 6)}…${to.slice(-4)}`}</code> · {copied ? 'Copied' : 'Copy address'}
            </button>
          )}
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {wallet && request.evm && (
          <button
            onClick={() => void send()}
            disabled={sending !== 'idle'}
            data-variant="primary"
            style={styles.button}
          >
            {sending === 'sending'
              ? 'Confirm in your wallet…'
              : sending === 'sent'
                ? 'Sent'
                : 'Pay with your browser wallet'}
          </button>
        )}
        <a
          href={request.uri}
          data-variant="quiet"
          style={{
            ...styles.button,
            background: palette.surface.card,
            color: palette.ink.strong,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            textDecoration: 'none',
          }}
        >
          Open in a wallet app
        </a>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'center' }}>
        <Pulse />
        <span style={{ fontSize: 13, color: palette.ink.muted }}>
          {sending === 'sent' ? 'Sent. ' : ''}Waiting for it to arrive. The last digits mark it as yours.
        </span>
      </div>
      {problem && (
        <p style={{ fontSize: 13, color: palette.accent.danger, textAlign: 'center' }}>{problem}</p>
      )}
      <button onClick={onBack} style={{ ...styles.linkButton, alignSelf: 'center' }}>
        Choose another way to pay
      </button>
    </div>
  );
}

/** A QR code, drawn as one SVG path, dark on light whatever the theme so every camera reads it */
function QrCode({ text }: { text: string }) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  let path = '';
  for (let row = 0; row < count; row++)
    for (let col = 0; col < count; col++) if (qr.isDark(row, col)) path += `M${col + 2} ${row + 2}h1v1h-1z`;
  const side = count + 4;
  return (
    <svg
      viewBox={`0 0 ${side} ${side}`}
      width={148}
      height={148}
      role="img"
      aria-label="QR code for the payment"
    >
      {/* A wallet's camera wants the strongest contrast there is: white and navy. */}
      <rect width={side} height={side} fill={palette.ink.inverse} />
      <path d={path} fill={palette.ink.strong} shapeRendering="crispEdges" />
    </svg>
  );
}

// ─── A wallet in this browser (EIP-1193, found through EIP-6963) ───

interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

const isEip1193 = (value: unknown): value is Eip1193 =>
  typeof value === 'object' && value !== null && 'request' in value && typeof value.request === 'function';

/** The first wallet this browser announces (EIP-6963), or the old `window.ethereum`; null when there is none */
function browserWallet(): Promise<Eip1193 | null> {
  return new Promise((resolve) => {
    let found: Eip1193 | null = null;
    const announced = (event: Event) => {
      const detail: unknown = 'detail' in event ? event.detail : null;
      const provider =
        typeof detail === 'object' && detail !== null && 'provider' in detail ? detail.provider : null;
      if (!found && isEip1193(provider)) found = provider;
    };
    window.addEventListener('eip6963:announceProvider', announced);
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    setTimeout(() => {
      window.removeEventListener('eip6963:announceProvider', announced);
      const legacy: unknown = Reflect.get(window, 'ethereum');
      resolve(found ?? (isEip1193(legacy) ? legacy : null));
    }, 300);
  });
}

/** Asks the wallet to send the token: `transfer(to, units)` on its contract, on its network */
async function sendTransfer(wallet: Eip1193, evm: NonNullable<Request['evm']>): Promise<void> {
  const accounts = await wallet.request({ method: 'eth_requestAccounts' });
  const from: unknown = Array.isArray(accounts) ? accounts[0] : null;
  if (typeof from !== 'string') throw new Error('The wallet shared no account');
  const chain = await wallet.request({ method: 'eth_chainId' });
  if (Number(chain) !== evm.chainId) {
    try {
      await wallet.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: `0x${evm.chainId.toString(16)}` }],
      });
    } catch {
      throw new Error(`Switch your wallet to ${evm.chainName} first, or scan the code with a phone wallet`);
    }
  }
  // ERC-20 transfer(to, amount): a 4-byte selector and two 32-byte words.
  const data =
    '0xa9059cbb' +
    evm.to.slice(2).toLowerCase().padStart(64, '0') +
    BigInt(evm.units).toString(16).padStart(64, '0');
  await wallet.request({ method: 'eth_sendTransaction', params: [{ from, to: evm.token, data }] });
}

function walletError(error: unknown): string {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
  if (code === 4001) return 'Cancelled in the wallet';
  return message(error);
}
