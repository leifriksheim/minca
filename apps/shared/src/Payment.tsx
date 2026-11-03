import { useEffect, useState } from 'react';
import { message, useAction, useCopy } from './action';
import type { FundOffer, FundPayment, PayAnswer } from '@minca/core';
import { Glyph } from './Feature';
import { QrCode } from './QrCode';
import styles from './Payment.module.css';

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
      <div className="empty">
        <span data-tone="good">
          <Glyph name="check" size={22} />
        </span>
        <h3>Payment received</h3>
        <p>Thank you. It's already working.</p>
        {onDone && (
          <button onClick={onDone} data-intent="primary">
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
  rate,
}: {
  fund: FundOffer;
  start: (payment: FundPayment) => Promise<PayAnswer>;
  paid: () => Promise<boolean>;
  onDone?: () => void;
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
  return (
    <div className="stack" data-gap="loose">
      <div role="group" aria-label="Amount" className="row">
        {AMOUNTS.map((dollars) => (
          <button key={dollars} aria-pressed={preset === dollars} onClick={() => setPreset(dollars)}>
            ${dollars}
          </button>
        ))}
        <button aria-pressed={preset === 'other'} onClick={() => setPreset('other')}>
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
        />
      )}
      {fund.methods.length > 1 && (
        <div role="group" aria-label="Pay with" className="row">
          {fund.methods.map((known) => (
            <button key={known} aria-pressed={method === known} onClick={() => setMethod(known)}>
              <Glyph name={known === 'checkout' ? 'card' : 'wallet'} size={14} />
              {known === 'checkout' ? 'Card' : 'Crypto'}
            </button>
          ))}
        </div>
      )}
      {fund.recurring && method === 'checkout' && (
        <label>
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
        data-intent="primary"
      >
        {paying.busy
          ? 'One moment…'
          : `Add ${valid ? `$${amount}` : ''}${monthly && method === 'checkout' ? ' a month' : ''}`}
      </button>
      <small>
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
      </small>
      {paying.problem && <p role="alert">{paying.problem}</p>}
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
    <div className="empty">
      <Pulse />
      <h3>{title}</h3>
      <p>{detail}</p>
      <button onClick={onBack} data-intent="ghost">
        Choose another way to pay
      </button>
    </div>
  );
}

/** A dot that breathes while waiting for the host */
function Pulse() {
  return <span aria-hidden className={styles.pulse} />;
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
  if (asked) return <small>Check your inbox for a link to confirm.</small>;
  if (!open)
    return (
      <button onClick={() => setOpen(true)} data-intent="ghost">
        Email me before it runs out
      </button>
    );
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void run(() => remind(email.trim()).then(() => setAsked(true)));
      }}
      className="stack"
    >
      <div className="row">
        <input
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="you@example.com"
          aria-label="Email for reminders"
          autoComplete="email"
          autoFocus
        />
        <button type="submit" disabled={busy || !email.trim()}>
          Remind me
        </button>
      </div>
      {problem && <p role="alert">{problem}</p>}
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
    <div className="stack" data-gap="loose">
      <div className="row" data-gap="loose">
        <QrCode text={request.uri} label="QR code for the payment" />
        <div className="stack" data-gap="tight">
          <small>Send exactly</small>
          <h2>{amount}</h2>
          {network && <small>on {network}</small>}
          {to && (
            <button onClick={() => copy(to)} data-intent="inline">
              To <code>{`${to.slice(0, 6)}…${to.slice(-4)}`}</code> · {copied ? 'Copied' : 'Copy address'}
            </button>
          )}
        </div>
      </div>
      <div className="stack">
        {wallet && request.evm && (
          <button onClick={() => void send()} disabled={sending !== 'idle'} data-intent="primary">
            {sending === 'sending'
              ? 'Confirm in your wallet…'
              : sending === 'sent'
                ? 'Sent'
                : 'Pay with your browser wallet'}
          </button>
        )}
        <a href={request.uri} data-intent>
          Open in a wallet app
        </a>
      </div>
      <p className="row">
        <Pulse />
        <small>
          {sending === 'sent' ? 'Sent. ' : ''}Waiting for it to arrive. The last digits mark it as yours.
        </small>
      </p>
      {problem && <p role="alert">{problem}</p>}
      <button onClick={onBack} data-intent="ghost">
        Choose another way to pay
      </button>
    </div>
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
