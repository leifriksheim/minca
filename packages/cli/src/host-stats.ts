/**
 * What a host carries and takes in, for anyone to see at `/host/stats`:
 * totals only, rounded, and taken once an hour, so while a host is small
 * they can't be watched for what one community does. Never a space id or an
 * account. Not protocol: only this host's code reads or writes it
 * (packages/cli/HOSTING.md, Stats).
 */

/** What the host counts when a snapshot is due, unrounded */
export interface HostCounts {
  /** Communities whose own fund keeps them online, and accounts the host carries for */
  readonly communities: number;
  readonly accounts: number;
  /** Spaces it carries, and the bytes they take */
  readonly spaces: number;
  readonly bytes: number;
  /** Bots running now; absent when the host runs none */
  readonly bots?: number;
  /** Absent on a host that takes no payments: in millionths of a dollar */
  readonly funds?: {
    readonly balance: number;
    readonly hostingDaily: number;
    readonly aiDaily: number;
  };
}

/** What `/host/stats` answers */
export interface HostStats {
  readonly name: string;
  /** When it was counted, and how often it is, in seconds */
  readonly at: number;
  readonly every: number;
  /** Counts to the nearest 5 */
  readonly communities: number;
  readonly accounts: number;
  readonly spaces: number;
  /** To the nearest 0.1 GB */
  readonly gb: number;
  readonly bots?: number;
  /** Whole dollars: what all balances and funds hold, and what they spend a month as things go */
  readonly funds?: {
    readonly balance: number;
    readonly monthly: { readonly hosting: number; readonly ai: number };
  };
  /** Days since the host started */
  readonly upDays: number;
}

const HOUR = 3600;
const count = (n: number) => Math.round(n / 5) * 5;
const dollars = (micros: number) => Math.round(micros / 1e6);

/**
 * The host's stats, counted at most once an hour: asking more often gets the
 * same snapshot, so polling learns nothing between counts.
 */
export function createHostStats(options: {
  readonly name: string;
  readonly collect: () => Promise<HostCounts>;
  readonly now?: () => number;
  readonly everySeconds?: number;
}) {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const every = options.everySeconds ?? HOUR;
  const started = now();
  let last: Promise<HostStats> | null = null;
  let at = -Infinity;

  const take = async (): Promise<HostStats> => {
    const counted = await options.collect();
    const funds = counted.funds;
    return {
      name: options.name,
      at: now(),
      every,
      communities: count(counted.communities),
      accounts: count(counted.accounts),
      spaces: count(counted.spaces),
      gb: Math.round(counted.bytes / 1e8) / 10,
      ...(counted.bots !== undefined ? { bots: count(counted.bots) } : {}),
      ...(funds
        ? {
            funds: {
              balance: dollars(funds.balance),
              monthly: { hosting: dollars(funds.hostingDaily * 30), ai: dollars(funds.aiDaily * 30) },
            },
          }
        : {}),
      upDays: Math.floor((now() - started) / 86_400),
    };
  };

  return {
    get(): Promise<HostStats> {
      if (!last || now() - at >= every) {
        at = now();
        // A failed count is tried again on the next ask, not kept for the hour.
        last = take().catch((error: unknown) => {
          last = null;
          throw error;
        });
      }
      return last;
    },
  };
}

/** Whether an answer is a host's stats, as far as a terminal shows them */
export function isHostStats(value: unknown): value is HostStats {
  if (typeof value !== 'object' || value === null) return false;
  const given: Record<string, unknown> = { ...value };
  const numbers = ['at', 'every', 'communities', 'accounts', 'spaces', 'gb', 'upDays'];
  if (typeof given.name !== 'string' || !numbers.every((key) => typeof given[key] === 'number')) return false;
  if (given.bots !== undefined && typeof given.bots !== 'number') return false;
  if (given.funds === undefined) return true;
  if (typeof given.funds !== 'object' || given.funds === null) return false;
  const funds: Record<string, unknown> = { ...given.funds };
  if (typeof funds.balance !== 'number' || typeof funds.monthly !== 'object' || funds.monthly === null)
    return false;
  const monthly: Record<string, unknown> = { ...funds.monthly };
  return typeof monthly.hosting === 'number' && typeof monthly.ai === 'number';
}

/** Stats as lines for a terminal: "Communities    about 15" */
export function statsLines(stats: HostStats): string[] {
  const about = (n: number) => (n === 0 ? 'fewer than 3' : `about ${n}`);
  const rows: Array<[string, string]> = [
    ['Communities', about(stats.communities)],
    ['Accounts', about(stats.accounts)],
    ['Spaces', about(stats.spaces)],
    ['Data kept', `${stats.gb} GB`],
  ];
  if (stats.bots !== undefined) rows.push(['Bots running', about(stats.bots)]);
  if (stats.funds) {
    rows.push(['In funds', `$${stats.funds.balance}`]);
    rows.push(['Spent a month', `$${stats.funds.monthly.hosting} hosting, $${stats.funds.monthly.ai} AI`]);
  }
  rows.push(['Up for', `${stats.upDays} days`]);
  const counted = new Date(stats.at * 1000).toISOString().slice(0, 16).replace('T', ' ');
  return [
    `${stats.name}, counted ${counted} UTC`,
    ...rows.map(([label, value]) => `  ${label.padEnd(15)}${value}`),
  ];
}
