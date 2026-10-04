/**
 * Times as `std.event` keeps them: RFC 3339 moments, or whole days
 * (`YYYY-MM-DD`). Shown in the reader's own time zone and words.
 */

const WHOLE_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The start or end of something that happens */
export interface Happening {
  readonly start: string;
  readonly end?: string | undefined;
  readonly allDay?: boolean | undefined;
}

/** Whether a time is a whole day rather than a moment */
export const isWholeDay = (when: string) => WHOLE_DAY.test(when);

/** A time as a Date: a whole day is its first moment where the reader is */
export function dateOf(when: string): Date {
  const day = WHOLE_DAY.exec(when);
  return day ? new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])) : new Date(when);
}

/** Midnight at the start of the day `date` is in, where the reader is */
export const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());

/** The same moment `days` later, by the calendar rather than by 24 hours */
export const addDays = (date: Date, days: number) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate() + days, date.getHours(), date.getMinutes());

/** A day as `YYYY-MM-DD`, where the reader is */
export const dayKey = (date: Date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * When it is over. Without an end, at the end of the day it starts on, so an
 * evening event stays "today" for the whole evening.
 */
export function endOf(event: Happening): Date {
  if (event.end) return isWholeDay(event.end) ? addDays(dateOf(event.end), 1) : dateOf(event.end);
  return addDays(startOfDay(dateOf(event.start)), 1);
}

/** Whether an event is on a given day, any part of it */
export function isOn(event: Happening, day: Date): boolean {
  const from = startOfDay(day);
  const to = addDays(from, 1);
  return dateOf(event.start) < to && endOf(event) > from;
}

const time = (date: Date) => date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
const timed = (event: Happening) => !event.allDay && !isWholeDay(event.start);

/** "Sat 12 Oct · 19:00", short enough for a card */
export function shortWhen(event: Happening): string {
  const start = dateOf(event.start);
  const day = start.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  return timed(event) ? `${day} · ${time(start)}` : `${day} · All day`;
}

/** "Saturday 12 October 2026, 19:00 – 23:00", every part of it, for an event's own page */
export function longWhen(event: Happening): string {
  const start = dateOf(event.start);
  const full: Intl.DateTimeFormatOptions = {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  };
  const startDay = start.toLocaleDateString(undefined, full);
  if (!event.end) return timed(event) ? `${startDay}, ${time(start)}` : startDay;
  const end = dateOf(event.end);
  const sameDay = dayKey(start) === dayKey(end);
  if (!timed(event)) {
    return sameDay ? startDay : `${startDay} – ${end.toLocaleDateString(undefined, full)}`;
  }
  return sameDay
    ? `${startDay}, ${time(start)} – ${time(end)}`
    : `${startDay}, ${time(start)} – ${end.toLocaleDateString(undefined, full)}, ${time(end)}`;
}

/** Which stretch of days ahead something falls in, for headings over a list */
export function horizon(date: Date, now = new Date()): string {
  const today = startOfDay(now);
  const days = Math.round((startOfDay(date).getTime() - today.getTime()) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  // Weeks start on Monday.
  const untilWeekEnd = 7 - ((today.getDay() + 6) % 7);
  if (days < untilWeekEnd) return 'This week';
  if (days < untilWeekEnd + 7) return 'Next week';
  if (date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth())
    return 'Later this month';
  return date.toLocaleDateString(undefined, {
    month: 'long',
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
}

/** A moment as RFC 3339 with the reader's own offset: `2026-10-12T19:00:00+02:00` */
export function rfc3339(date: Date): string {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return (
    `${dayKey(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}:00` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/** A time as an `<input type="time">` holds it, `19:00` */
export const clockOf = (date: Date) => `${pad(date.getHours())}:${pad(date.getMinutes())}`;

/** A day and a clock time from a form, as a Date where the reader is */
export function fromInputs(day: string, clock: string): Date {
  const [h = 0, m = 0] = clock.split(':').map(Number);
  const d = dateOf(day);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m);
}

/** The reader's own time zone, as IANA names it */
export const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * An event as an iCalendar file (RFC 5545), for adding it to a calendar
 * outside Weave. Times go in UTC, so no time zone table is needed.
 */
export function icsOf(
  uid: string,
  event: Happening & {
    readonly title: string;
    readonly description?: string | undefined;
    readonly location?: string | undefined;
    readonly url?: string | undefined;
  },
): string {
  const escape = (text: string) => text.replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\r?\n/g, '\\n');
  const utc = (date: Date) =>
    date
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d{3}/, '');
  const compact = (date: Date) => dayKey(date).replace(/-/g, '');
  const start = dateOf(event.start);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Weave//Events//EN',
    'BEGIN:VEVENT',
    `UID:${uid}@weave`,
    `DTSTAMP:${utc(new Date())}`,
    ...(timed(event)
      ? [`DTSTART:${utc(start)}`, ...(event.end ? [`DTEND:${utc(dateOf(event.end))}`] : [])]
      : [`DTSTART;VALUE=DATE:${compact(start)}`, `DTEND;VALUE=DATE:${compact(endOf(event))}`]),
    `SUMMARY:${escape(event.title)}`,
    ...(event.description ? [`DESCRIPTION:${escape(event.description)}`] : []),
    ...(event.location ? [`LOCATION:${escape(event.location)}`] : []),
    ...(event.url ? [`URL:${event.url}`] : []),
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.join('\r\n') + '\r\n';
}
