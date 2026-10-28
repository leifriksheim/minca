/**
 * Values by what their field holds, as its `x-kind` says
 * (packages/core/docs/collections.md): a time in the reader's words, money
 * in their format, a link only when it is safe to open.
 */
import type { FileRef } from '@minca/core';
import { dateOf, isWholeDay } from '@minca/ui/when';
import { isObject } from './schema-ui';

const valid = (date: Date) => !Number.isNaN(date.getTime());

/** "Sat 12 Oct 2026, 19:00", or "Sat 12 Oct 2026" for a whole day; null when it isn't a time */
export function whenText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const date = dateOf(value);
  if (!valid(date)) return null;
  const day = date.toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
  return isWholeDay(value)
    ? day
    : `${day}, ${date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
}

/** "€12.50" in the reader's format; the amount and code as they are for a currency it doesn't know */
export function moneyText(value: unknown): string | null {
  if (!isObject(value) || typeof value.amount !== 'string' || typeof value.currency !== 'string') return null;
  const amount = Number(value.amount);
  if (!Number.isFinite(amount)) return `${value.amount} ${value.currency}`;
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: value.currency }).format(amount);
  } catch {
    return `${value.amount} ${value.currency}`;
  }
}

/** A web address to open, only when it is http or https: a body can hold `javascript:` too */
export function safeHref(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

/** The file a value names, when it is one `records.addFile` gave */
export function fileRefOf(value: unknown): FileRef | null {
  if (!isObject(value)) return null;
  const { hash, size, key, salt, mime, name } = value;
  return typeof hash === 'string' &&
    typeof size === 'number' &&
    typeof key === 'string' &&
    typeof salt === 'string' &&
    typeof mime === 'string'
    ? { hash, size, key, salt, mime, ...(typeof name === 'string' ? { name } : {}) }
    : null;
}
