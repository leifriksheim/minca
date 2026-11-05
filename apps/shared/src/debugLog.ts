/**
 * What this page or worker says to the console, kept in memory for debug mode
 * (`?debug`, see `DebugMode.tsx`), so it can show what was said before it was
 * opened. Importing this starts keeping it: import it before anything else.
 *
 * A worker's console can't be read from the page, and the node's worker may be
 * ended before anyone looks, so workers send each line to the pages as they
 * say it, and answer a page that asks for what they said before it opened.
 */

export interface LogEntry {
  /** Milliseconds since the epoch */
  readonly at: number;
  /** Which page or worker said it, such as `worker·3f2a` */
  readonly from: string;
  readonly level: string;
  readonly text: string;
}

const LIMIT = 1000;
const CHANNEL = 'minca-debug';
const LEVELS = ['debug', 'log', 'info', 'warn', 'error'] as const;

const worker = 'DedicatedWorkerGlobalScope' in globalThis || 'SharedWorkerGlobalScope' in globalThis;
const self = `${'SharedWorkerGlobalScope' in globalThis ? 'shared worker' : worker ? 'worker' : 'page'}·${globalThis.crypto.randomUUID().slice(0, 4)}`;
const entries: LogEntry[] = [];
const seen = new Set<string>();

const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(CHANNEL) : null;

const idOf = (entry: LogEntry) => `${entry.from}|${entry.at}|${entry.text}`;

function add(entry: LogEntry): void {
  if (seen.has(idOf(entry))) return;
  seen.add(idOf(entry));
  entries.push(entry);
  const dropped = entries.length > LIMIT ? entries.shift() : undefined;
  if (dropped) seen.delete(idOf(dropped));
}

function keep(level: string, args: ReadonlyArray<unknown>): void {
  const text = args.map(show).join(' ').slice(0, 4000);
  const entry = Object.freeze({ at: Date.now(), from: self, level, text });
  add(entry);
  if (worker) channel?.postMessage({ entries: [entry] });
}

function show(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) {
    const stack = value.stack?.split('\n').slice(0, 6).join('\n');
    return `${value.name}: ${value.message}${stack ? `\n${stack}` : ''}`;
  }
  try {
    return (
      JSON.stringify(value, (_key, inner: unknown) =>
        typeof inner === 'bigint'
          ? `${inner}n`
          : inner instanceof Uint8Array
            ? `<${inner.length} bytes>`
            : inner,
      ) ?? String(value)
    );
  } catch {
    return String(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEntry(value: unknown): value is LogEntry {
  return (
    isRecord(value) &&
    typeof value.at === 'number' &&
    typeof value.from === 'string' &&
    typeof value.level === 'string' &&
    typeof value.text === 'string'
  );
}

for (const level of LEVELS) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    keep(level, args);
    original(...args);
  };
}

globalThis.addEventListener?.('error', (event: Event) => {
  const error: unknown = event instanceof ErrorEvent ? (event.error ?? event.message) : event.type;
  keep('error', ['Uncaught', error]);
});
globalThis.addEventListener?.('unhandledrejection', (event: Event) => {
  keep('error', ['Unhandled rejection:', Reflect.get(event, 'reason')]);
});

if (channel)
  channel.onmessage = (event: MessageEvent) => {
    const message: unknown = event.data;
    if (!isRecord(message)) return;
    // A page asks; a worker answers with all it kept, since the page may have opened late.
    if (message.ask === true && worker) channel.postMessage({ entries });
    if (!worker && Array.isArray(message.entries))
      for (const entry of message.entries) if (isEntry(entry) && entry.from !== self) add(entry);
  };

/** Asks the workers for what they said before this page heard them */
export function askWorkers(): void {
  channel?.postMessage({ ask: true });
}

/** Everything kept here, oldest first */
export function logEntries(): ReadonlyArray<LogEntry> {
  return [...entries].sort((a, b) => a.at - b.at);
}

/** Where this page or worker started, for showing log times from it */
export const loadedAt = Math.round(performance.timeOrigin);
