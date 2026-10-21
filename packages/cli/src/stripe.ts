/**
 * Payments through Stripe: Checkout for paying, and a webhook that says how
 * much reached which balance.
 *
 * Plain `fetch` against Stripe's REST API, no SDK. Card, Apple Pay and Google
 * Pay show up in Checkout by themselves; stablecoin payments too, where they
 * are turned on in the Stripe dashboard. Nothing here stores anything about
 * the payer.
 *
 * Every payment is an amount into a subscription's balance, an account's or
 * a community's fund: Checkout with the amount inline (`price_data`), so no
 * prices are set up in Stripe, once, or every month as a subscription of the
 * payer's own. Its webhook says how much reached which balance, with the
 * session's or invoice's id, which the host counts once.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Billing } from './host.js';
import { isRecord } from './json.js';

export interface StripeConfig {
  readonly secretKey: string;
  readonly webhookSecret: string;
  /** For tests */
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly api?: string;
}

/** Where the balance a payment goes into travels inside Stripe */
const FUND_KEY = 'minca_fund';
/** How old a webhook's signature may be, as Stripe's own libraries allow */
const TOLERANCE_SECONDS = 300;

/** Stripe's form encoding: nested keys in brackets */
function form(params: Record<string, string | undefined>): string {
  return Object.entries(params)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
}

/**
 * Whether a webhook body is Stripe's: `Stripe-Signature: t=…,v1=…`, an
 * HMAC-SHA256 of `t.body` under the webhook secret, made recently.
 */
export function verifyStripeSignature(
  body: string,
  header: string | undefined,
  secret: string,
  now = Math.floor(Date.now() / 1000),
): boolean {
  if (!header) return false;
  const parts = header.split(',').map((part) => part.split('='));
  const at = Number(parts.find(([key]) => key === 't')?.[1]);
  if (!Number.isFinite(at) || Math.abs(now - at) > TOLERANCE_SECONDS) return false;
  const expected = createHmac('sha256', secret).update(`${at}.${body}`).digest();
  return parts
    .filter(([key]) => key === 'v1')
    .some(([, value]) => {
      const given = Buffer.from(value ?? '', 'hex');
      return given.length === expected.length && timingSafeEqual(given, expected);
    });
}

export function createStripeBilling(config: StripeConfig): Billing {
  const call = config.fetch ?? fetch;
  const api = config.api ?? 'https://api.stripe.com';
  const now = config.now ?? (() => Math.floor(Date.now() / 1000));

  async function stripe(
    method: 'GET' | 'POST',
    path: string,
    params: Record<string, string | undefined> = {},
  ): Promise<Record<string, unknown>> {
    const response = await call(`${api}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${config.secretKey}`,
        ...(method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      },
      ...(method === 'POST' ? { body: form(params) } : {}),
    });
    const answer: unknown = await response.json();
    if (!response.ok) {
      const message = isRecord(answer) && isRecord(answer.error) ? answer.error.message : undefined;
      throw new Error(`Stripe: ${typeof message === 'string' ? message : response.status}`);
    }
    if (!isRecord(answer)) throw new Error('Stripe: an answer that is not an object');
    return answer;
  }

  /** Where Checkout sends the person */
  async function sessionUrl(path: string, params: Record<string, string | undefined>): Promise<string> {
    const { url } = await stripe('POST', path, params);
    if (typeof url !== 'string') throw new Error('Stripe: a session without a url');
    return url;
  }

  const billing: Billing = {
    async fund({ fund, name, cents, monthly, returnUrl }) {
      const recurring = monthly ? { 'line_items[0][price_data][recurring][interval]': 'month' } : {};
      return sessionUrl('/v1/checkout/sessions', {
        mode: monthly ? 'subscription' : 'payment',
        'line_items[0][price_data][currency]': 'usd',
        'line_items[0][price_data][unit_amount]': String(cents),
        'line_items[0][price_data][product_data][name]': name,
        ...recurring,
        'line_items[0][quantity]': '1',
        success_url: returnUrl,
        cancel_url: returnUrl,
        client_reference_id: fund,
        // Where Stripe keeps it: on the session when paid once, on the payer's subscription when monthly.
        ...(monthly ? { 'subscription_data[metadata][minca_fund]': fund } : { 'metadata[minca_fund]': fund }),
      });
    },

    async webhook(body: string, headers: IncomingMessage['headers']) {
      const signature = headers['stripe-signature'];
      if (
        !verifyStripeSignature(
          body,
          Array.isArray(signature) ? signature[0] : signature,
          config.webhookSecret,
          now(),
        )
      )
        return null;
      const event: unknown = JSON.parse(body);
      if (!isRecord(event)) return null;
      const object = isRecord(event.data) && isRecord(event.data.object) ? event.data.object : {};
      // Once: how much, and the session, so the host adds it once.
      if (event.type === 'checkout.session.completed' && object.mode === 'payment') {
        const metadata = isRecord(object.metadata) ? object.metadata : {};
        const fund = metadata[FUND_KEY];
        if (
          object.payment_status !== 'paid' ||
          typeof fund !== 'string' ||
          typeof object.amount_total !== 'number' ||
          typeof object.id !== 'string'
        )
          return null;
        return { subscription: fund, cents: object.amount_total, id: object.id };
      }
      if (event.type === 'invoice.paid') {
        const { parent } = object;
        // Every month: the payer's subscription says which balance, the invoice how much.
        const details =
          isRecord(parent) && isRecord(parent.subscription_details) ? parent.subscription_details : null;
        const older = isRecord(object.subscription_details) ? object.subscription_details : null;
        const metadata = [details?.metadata, older?.metadata].find(isRecord);
        const fund = metadata?.[FUND_KEY];
        if (
          typeof fund !== 'string' ||
          typeof object.amount_paid !== 'number' ||
          typeof object.id !== 'string'
        )
          return null;
        return { subscription: fund, cents: object.amount_paid, id: object.id };
      }
      return null;
    },
  };
  return Object.freeze(billing);
}
