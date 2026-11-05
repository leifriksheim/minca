/**
 * Debug mode's report: this browser, its storage, what the app says about
 * itself, and the log, as plain text to paste into an issue or a chat. Holds
 * no secrets: stored values are listed by name and size only, and the app's
 * own details are its to keep clean.
 */
import { logEntries, loadedAt, type LogEntry } from './debugLog';

/** What an app adds about itself, by heading */
export type DebugDetails = () => Record<string, unknown> | Promise<Record<string, unknown>>;

/** Gives up on what never answers: a stuck IndexedDB is one of the things this is for */
function within<T>(promise: Promise<T>, ms = 1500): Promise<T | string> {
  return Promise.race([
    promise,
    new Promise<string>((resolve) => setTimeout(() => resolve(`(no answer in ${ms} ms)`), ms)),
  ]);
}

async function attempt(read: () => unknown): Promise<unknown> {
  try {
    const value = read();
    return value instanceof Promise ? await within(value) : value;
  } catch (error) {
    return `(failed: ${error instanceof Error ? error.message : String(error)})`;
  }
}

const has = (name: string) => (name in globalThis ? 'yes' : 'no');
const time = (at: number) => new Date(at).toISOString().slice(11, 23);
const megabytes = (bytes: number | undefined) =>
  bytes === undefined ? '?' : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

function browser(): Record<string, unknown> {
  const standalone = globalThis.matchMedia?.('(display-mode: standalone)').matches;
  return {
    'User agent': navigator.userAgent,
    Vendor: navigator.vendor || '(none)',
    Languages: navigator.languages.join(', '),
    Online: navigator.onLine,
    'Installed (standalone)': standalone,
    Viewport: `${innerWidth}×${innerHeight} @${devicePixelRatio}x`,
    'Shared workers': has('SharedWorker'),
    Workers: has('Worker'),
    BroadcastChannel: has('BroadcastChannel'),
    'Web locks': 'locks' in navigator ? 'yes' : 'no',
    IndexedDB: has('indexedDB'),
    'Service workers': 'serviceWorker' in navigator ? 'yes' : 'no',
    'Cross-origin isolated': globalThis.crossOriginIsolated,
  };
}

async function storage(): Promise<Record<string, unknown>> {
  const estimate = await attempt(async () => {
    const { usage, quota } = await navigator.storage.estimate();
    return `${megabytes(usage)} of ${megabytes(quota)}`;
  });
  const databases = await attempt(() => indexedDB.databases?.());
  const locks = await attempt(() => navigator.locks?.query());
  const workers = await attempt(() => navigator.serviceWorker?.getRegistrations());
  const kept: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key !== null) kept.push(`${key} (${localStorage.getItem(key)?.length ?? 0} chars)`);
    }
  } catch (error) {
    kept.push(`(failed: ${String(error)})`);
  }
  return {
    Persisted: await attempt(() => navigator.storage?.persisted()),
    Usage: estimate,
    'IndexedDB databases': Array.isArray(databases)
      ? databases.map((db: IDBDatabaseInfo) => `${db.name ?? '?'} v${db.version ?? '?'}`)
      : databases,
    'Web locks held': lockNames(locks, 'held'),
    'Web locks waiting': lockNames(locks, 'pending'),
    'Service workers': Array.isArray(workers)
      ? workers.map((registration: ServiceWorkerRegistration) => registration.scope)
      : workers,
    localStorage: kept,
  };
}

function lockNames(snapshot: unknown, which: 'held' | 'pending'): unknown {
  if (typeof snapshot !== 'object' || snapshot === null || !(which in snapshot)) return snapshot;
  const list: unknown = Reflect.get(snapshot, which);
  return Array.isArray(list) ? list.map((lock: LockInfo) => `${lock.name} (${lock.mode})`) : list;
}

function section(title: string, values: Record<string, unknown>): string {
  const lines = Object.entries(values).map(([key, value]) => {
    if (Array.isArray(value))
      return `${key}:${value.length ? value.map((item) => `\n  - ${String(item)}`).join('') : ' (none)'}`;
    if (typeof value === 'object' && value !== null) return `${key}: ${JSON.stringify(value, null, 2)}`;
    return `${key}: ${String(value)}`;
  });
  return `## ${title}\n${lines.join('\n')}`;
}

function log(entries: ReadonlyArray<LogEntry>): string {
  const lines = entries.map(
    (entry) =>
      `${time(entry.at)} +${((entry.at - loadedAt) / 1000).toFixed(2)}s ${entry.from} ${entry.level.toUpperCase()} ${entry.text}`,
  );
  return `## Log (${entries.length}, times UTC, +seconds since this page loaded)\n${lines.join('\n') || '(nothing yet)'}`;
}

/** The whole report, as text */
export async function debugReport(app: string, build: string, details?: DebugDetails): Promise<string> {
  const now = Date.now();
  const own = details ? await attempt(details) : null;
  const ownSections =
    typeof own === 'object' && own !== null
      ? Object.entries(own).map(([title, values]: [string, unknown]) =>
          typeof values === 'object' && values !== null && !Array.isArray(values)
            ? section(title, Object.fromEntries(Object.entries(values)))
            : section(title, { [title]: values }),
        )
      : own === null
        ? []
        : [section(app, { Details: own })];
  return [
    `# Minca debug report: ${app}`,
    section('Page', {
      Build: build,
      Address: `${location.origin}${location.pathname}`,
      'Loaded at': new Date(loadedAt).toISOString(),
      Now: `${new Date(now).toISOString()} (+${((now - loadedAt) / 1000).toFixed(1)}s)`,
    }),
    ...ownSections,
    section('Browser', browser()),
    section('Storage', await storage()),
    log(logEntries()),
  ].join('\n\n');
}
