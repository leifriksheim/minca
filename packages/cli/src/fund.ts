/**
 * A subscription's balance at the host (spec 08 §1 and §2): an account's,
 * or a community's fund.
 *
 * One balance per subscription, in millionths of a dollar (the same unit as
 * USDC's six decimals). Its account, or anyone for a community, adds to it,
 * by card or wallet, once or every month. Keeping its spaces online draws
 * from it by the second, at the host's monthly rate for each GB it pays for
 * (`settle` says how many: the host's to count), and each bot a community
 * runs draws its AI use as it is spent. What it lasts is an estimate from
 * that: the rate, and what its bots spent over the last week. The host's
 * status says the balance, the daily spend, and the date the estimate
 * reaches (`paidUntil`).
 *
 * Grace is lent, not given, and no longer than the payment before it lasted:
 * once it runs out the hosting goes on drawing, below zero, for that long
 * (the host's grace at most), and what is added next pays for it first. So
 * the least payment into a large space buys a short grace, and nothing is
 * drawn once the grace is over, whatever the space grows to.
 *
 * Kept in the host's store, and in its bucket when it has one, as the
 * subscriptions are: a fund is money people paid.
 */
import type { BlobStore, StorageAdapter } from '@minca/core';
import { isRecord } from './json.js';

export interface FundState {
  /** Millionths of a dollar; below zero by what its grace and a bot's last call took, owed */
  readonly balance: number;
  /** When the hosting fee was last taken, unix seconds */
  readonly at: number;
  /** What bots spent, by UTC day (`2026-09-30`), for the last two weeks */
  readonly spent: Readonly<Record<string, number>>;
  /** The same, for each bot by its DID: what the fund shows people it pays for */
  readonly byBot?: Readonly<Record<string, Readonly<Record<string, number>>>>;
  /** What it pays for, as last measured: the fee is the monthly rate for each GB. Unmeasured, one. */
  readonly bytes?: number;
  /** When something was last added, unix seconds: a grace is no longer than what it paid lasted */
  readonly added?: number;
  /** When it last ran out, and for how long from then its grace is lent, seconds; absent while above zero */
  readonly ran?: { readonly at: number; readonly lent: number };
}

export interface Funds {
  get(id: string): Promise<FundState>;
  /** Adds what someone paid */
  add(id: string, micros: number): Promise<FundState>;
  /** Takes what a bot spent; with its DID, counted as that bot's too */
  charge(id: string, micros: number, bot?: string): Promise<FundState>;
  /** Every subscription with a balance kept here */
  ids(): Promise<string[]>;
  /** Takes the hosting fee for the time since it was last taken; from then on, for this many bytes */
  settle(id: string, bytes?: number): Promise<FundState>;
  /** What the fund spends in a day, as things go: the hosting fee, and what its bots spent a day this last week */
  daily(state: FundState): number;
  /** Until when it lasts at that rate, unix seconds; when it ran out, for one in its grace */
  until(state: FundState): number;
  /** What one bot spent a day this last week */
  botDaily(state: FundState, bot: string): number;
}

const PREFIX = 'fund:';
const BUCKET_PREFIX = 'host/funds/';
const DAY = 86_400;
const MONTH = 30 * DAY;
const GB = 1e9;

export function createFunds(options: {
  readonly store: StorageAdapter;
  /** What keeping spaces online costs a month for each GB, in millionths of a dollar */
  readonly perGb: number;
  /** Days it is carried on after it ran out, at most: the host's grace */
  readonly graceDays?: number;
  readonly mirror?: BlobStore | null;
  readonly now?: () => number;
}): Funds {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const grace = (options.graceDays ?? 30) * DAY;
  /** The hosting fee a second, in millionths of a dollar */
  const fee = (state: FundState) => (options.perGb / MONTH) * ((state.bytes ?? GB) / GB);
  const empty = (): FundState => ({ balance: 0, at: now(), spent: {} });

  const read = async (id: string): Promise<FundState> => {
    const bytes =
      (await options.store.get(`${PREFIX}${id}`)) ??
      (await options.mirror?.get(`${BUCKET_PREFIX}${encodeURIComponent(id)}.json`));
    if (!bytes) return empty();
    const kept: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!isRecord(kept) || typeof kept.balance !== 'number' || typeof kept.at !== 'number') return empty();
    const days = (value: unknown): Record<string, number> => {
      const found: Record<string, number> = {};
      if (isRecord(value))
        for (const [day, micros] of Object.entries(value))
          if (typeof micros === 'number') found[day] = micros;
      return found;
    };
    const byBot: Record<string, Record<string, number>> = {};
    if (isRecord(kept.byBot)) for (const [bot, spent] of Object.entries(kept.byBot)) byBot[bot] = days(spent);
    const size = typeof kept.bytes === 'number' && kept.bytes >= 0 ? { bytes: kept.bytes } : {};
    return {
      balance: kept.balance,
      at: kept.at,
      spent: days(kept.spent),
      byBot,
      ...size,
      ...(typeof kept.added === 'number' ? { added: kept.added } : {}),
      ...(isRecord(kept.ran) && typeof kept.ran.at === 'number' && typeof kept.ran.lent === 'number'
        ? { ran: { at: kept.ran.at, lent: kept.ran.lent } }
        : {}),
    };
  };
  const write = async (id: string, state: FundState): Promise<FundState> => {
    const bytes = new TextEncoder().encode(JSON.stringify(state));
    await options.store.put(`${PREFIX}${id}`, bytes);
    await options.mirror?.put(`${BUCKET_PREFIX}${encodeURIComponent(id)}.json`, bytes);
    return state;
  };
  /** Running out now: lent a grace as long as what was last added lasted, the host's at most */
  const runOut = (state: FundState, at: number): FundState['ran'] => ({
    at,
    lent: state.added === undefined ? 0 : Math.max(0, Math.min(grace, at - state.added)),
  });
  /** The fee for the time since it was last taken, taken: down to zero, then through its lent grace only */
  const settled = (state: FundState): FundState => {
    const at = now();
    const rate = fee(state);
    let { balance, ran } = state;
    let from = state.at;
    if (balance > 0) {
      const lasts = rate > 0 ? balance / rate : Infinity;
      if (at - from < lasts) return { ...state, balance: balance - (at - from) * rate, at };
      from += lasts;
      balance = 0;
      ran = runOut(state, Math.round(from));
    }
    // One nobody ever paid into, or whose grace is over, owes nothing more.
    if (ran) balance -= Math.max(0, Math.min(at, ran.at + ran.lent) - Math.max(from, ran.at)) * rate;
    return { ...state, balance, at, ...(ran ? { ran } : {}) };
  };
  const day = (seconds: number) => new Date(seconds * 1000).toISOString().slice(0, 10);
  /** What a record of spending by day adds up to this last week, a day */
  const week = (spent: Readonly<Record<string, number>>) =>
    Object.entries(spent)
      .filter(([when]) => now() - Date.parse(when) / 1000 < 7 * DAY)
      .reduce((sum, [, micros]) => sum + micros, 0) / 7;
  const daily = (state: FundState) => fee(state) * DAY + week(state.spent);
  /** Two weeks of spending is all the estimate needs */
  const recent = (spent: Readonly<Record<string, number>>) =>
    Object.fromEntries(Object.entries(spent).filter(([when]) => now() - Date.parse(when) / 1000 < 14 * DAY));

  // One change at a time: two payments landing together must both count.
  let queue: Promise<unknown> = Promise.resolve();
  const change = (id: string, work: (state: FundState) => FundState): Promise<FundState> => {
    const next = queue.then(async () => write(id, work(settled(await read(id)))));
    queue = next.catch(() => {});
    return next;
  };

  return Object.freeze({
    get: read,
    ids: async () => (await options.store.list(PREFIX)).map((key) => key.slice(PREFIX.length)),
    add: (id: string, micros: number) =>
      // What its grace took is paid first; above zero again, it has not run out.
      change(id, (state) => {
        const { ran, ...rest } = state;
        const balance = state.balance + Math.round(micros);
        return { ...rest, balance, added: now(), ...(balance <= 0 && ran ? { ran } : {}) };
      }),
    charge: (id: string, micros: number, bot?: string) =>
      change(id, (state) => {
        const today = day(now());
        const cost = Math.round(micros);
        const kept = recent(state.spent);
        const byBot = { ...state.byBot };
        if (bot) {
          const its = recent(byBot[bot] ?? {});
          byBot[bot] = { ...its, [today]: (its[today] ?? 0) + cost };
        }
        const balance = state.balance - cost;
        // A bot's call that empties it: it ran out now.
        const ran = state.balance > 0 && balance <= 0 ? runOut(state, now()) : state.ran;
        return {
          ...state,
          balance,
          spent: { ...kept, [today]: (kept[today] ?? 0) + cost },
          byBot,
          ...(ran ? { ran } : {}),
        };
      }),
    settle: (id: string, bytes?: number) =>
      change(id, (state) => (bytes === undefined || bytes === state.bytes ? state : { ...state, bytes })),
    daily,
    botDaily: (state: FundState, bot: string) => week(state.byBot?.[bot] ?? {}),
    until(state: FundState) {
      // Run out: dated so that the host's grace from then ends where its lent grace does.
      if (state.balance <= 0) return state.ran ? state.ran.at + state.ran.lent - grace : state.at;
      const rate = daily(state);
      if (rate <= 0) return now() + 10 * 365 * DAY;
      return now() + Math.floor((state.balance / rate) * DAY);
    },
  });
}
