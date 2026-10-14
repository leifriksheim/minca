/**
 * What the menu bar says about the app's connection. Quiet while it lasts: a
 * date, far off. In its last two days it says when it ends and offers to
 * renew; once it has run out, what stopped and how to start it again. It says
 * what stops ("automations are off"), never why ("the note expired").
 */
import type { AppNodeState } from './app-node';

export interface MenuLine {
  readonly label: string;
  /** What clicking it does; none for a line that only says something */
  readonly action?: 'renew' | 'open';
}

export interface ConnectionMenu {
  readonly lines: ReadonlyArray<MenuLine>;
  /** The menu bar shows a dot: something here wants a click */
  readonly attention: boolean;
}

const HOUR = 3600_000;
const DAY = 24 * HOUR;
/** From when on it asks to be renewed */
const RENEW_WITHIN_MS = 2 * DAY;

const startOfDay = (time: number) => new Date(time).setHours(0, 0, 0, 0);

/** "in 3 hours", "today at 18:00", "tomorrow", "on Thursday": how soon, in words */
export function whenEnds(ends: number, now: number, locale?: string): string {
  const left = ends - now;
  if (left < HOUR) return 'within the hour';
  if (left < 6 * HOUR) {
    const hours = Math.round(left / HOUR);
    return `in ${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  }
  const days = Math.round((startOfDay(ends) - startOfDay(now)) / DAY);
  if (days === 0)
    return `today at ${new Date(ends).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}`;
  if (days === 1) return 'tomorrow';
  return `on ${new Date(ends).toLocaleDateString(locale, { weekday: 'long' })}`;
}

/** "Tue 21 Oct": a date, for an end that is far off */
function dateOf(time: number, locale?: string): string {
  return new Date(time).toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short' });
}

export function connectionMenu(state: AppNodeState, now: number, locale?: string): ConnectionMenu {
  const name = state.grant?.name;
  switch (state.status) {
    case 'starting':
      return { lines: [{ label: 'Starting…' }], attention: false };
    case 'connecting':
      return { lines: [{ label: 'Waiting for your account home…' }], attention: false };
    case 'disconnected':
      return {
        lines: [
          { label: 'Not connected' },
          ...(state.error ? [{ label: state.error }] : []),
          { label: 'Open Minca to connect…', action: 'open' as const },
        ],
        attention: false,
      };
    case 'expired':
      return {
        lines: [
          ...(name ? [{ label: name }] : []),
          { label: 'Paused: automations are off until you reconnect' },
          { label: 'Reconnect…', action: 'renew' as const },
        ],
        attention: true,
      };
    case 'ready': {
      const ends = (state.grant?.expiresAt ?? 0) * 1000;
      const soon = ends - now < RENEW_WITHIN_MS;
      return {
        lines: [
          ...(name ? [{ label: name }] : []),
          { label: 'Automations on' },
          soon
            ? { label: `Connection ends ${whenEnds(ends, now, locale)}` }
            : { label: `Connected until ${dateOf(ends, locale)}` },
          ...(soon ? [{ label: 'Renew connection…', action: 'renew' as const }] : []),
        ],
        attention: soon,
      };
    }
  }
}

/**
 * When to remind the person, once for each grant: a day before it ends, or
 * now when that is already past. Null once it has ended, or with nothing connected.
 */
export function reminderAt(state: AppNodeState, now: number): number | null {
  if (state.status !== 'ready' || !state.grant) return null;
  const ends = state.grant.expiresAt * 1000;
  return ends > now ? Math.max(ends - DAY, now) : null;
}
