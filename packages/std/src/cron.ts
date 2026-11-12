/**
 * When a rule runs by itself (`every`): five cron fields, minute hour day
 * month weekday, in the runner's local time.
 */

const CRON_FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'weekday', min: 0, max: 7 },
] as const;

/** The values one cron field allows, or a reason it can't be read */
function cronField(text: string, min: number, max: number): Set<number> | string {
  const allowed = new Set<number>();
  for (const part of text.split(',')) {
    const found = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!found) return `"${part}" is not a number, a range, * or a step`;
    const [, all, from, to, step] = found;
    const start = all === '*' ? min : Number(from);
    const end = all === '*' ? max : to !== undefined ? Number(to) : step !== undefined ? max : start;
    const by = step !== undefined ? Number(step) : 1;
    if (start < min || end > max || start > end || by < 1) return `"${part}" is outside ${min}–${max}`;
    for (let value = start; value <= end; value += by) allowed.add(value);
  }
  return allowed;
}

type FieldName = (typeof CRON_FIELDS)[number]['name'];

/** Why a cron version can't be read, or null */
export function checkCron(version: string): string | null {
  const read = readCron(version);
  return typeof read === 'string' ? read : null;
}

/** Whether a cron version names this minute, in local time. As in cron, a day and a weekday both given means either. */
export function cronMatches(version: string, at: Date): boolean {
  const read = readCron(version);
  return typeof read !== 'string' && read(at);
}

/** A schedule as a test for a minute, or why it can't be read */
function readCron(version: string): ((at: Date) => boolean) | string {
  const parts = version.trim().split(/\s+/);
  if (parts.length !== 5) return 'A schedule is five fields: minute hour day month weekday';
  const allowed = new Map<FieldName, Set<number>>();
  for (const [index, field] of CRON_FIELDS.entries()) {
    const read = cronField(parts[index] ?? '', field.min, field.max);
    if (typeof read === 'string') return `${field.name}: ${read}`;
    allowed.set(field.name, read);
  }
  // Sunday is 0 or 7.
  if (allowed.get('weekday')?.has(7)) allowed.get('weekday')?.add(0);
  const has = (name: FieldName, value: number) => allowed.get(name)?.has(value) ?? false;
  // Only when both are narrowed does either one do.
  const narrowed = parts[2] !== '*' && parts[4] !== '*';
  return (at) => {
    const onDay = has('day', at.getDate());
    const onWeekday = has('weekday', at.getDay());
    const dayMatches = narrowed ? onDay || onWeekday : onDay && onWeekday;
    return (
      has('minute', at.getMinutes()) &&
      has('hour', at.getHours()) &&
      has('month', at.getMonth() + 1) &&
      dayMatches
    );
  };
}

/** Times people pick most, in words, for a builder to offer before five cron fields */
export const SCHEDULES: ReadonlyArray<{ readonly value: string; readonly label: string }> = [
  { value: '0 8 * * 1-5', label: 'Weekday mornings at 8' },
  { value: '0 9 * * 1', label: 'Mondays at 9' },
  { value: '0 18 * * *', label: 'Every evening at 6' },
  { value: '0 * * * *', label: 'Every hour' },
];
