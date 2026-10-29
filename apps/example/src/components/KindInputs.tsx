/**
 * Inputs for fields that say what they hold (`x-kind`): a time with "all
 * day", an amount of money, a file or a picture added to the space.
 */
import { useRef, useState, type ReactNode } from 'react';
import { useNode } from '@minca/react';
import { clockOf, dateOf, dayKey, fromInputs, isWholeDay, rfc3339 } from '@minca/ui/when';
import { fitImage } from '@minca/ui/image';
import { useAction } from '@minca/app-shared/action';
import { fileRefOf } from '../derive/kinds';
import { isObject } from '../derive/schema-ui';
import { useSpaceHere } from './Person';
import { FileValue } from './KindValue';
import { styles, hstack } from '../styles';

const labelStyle = { display: 'flex', flexDirection: 'column' as const, gap: 4, fontSize: 13 };
const row = { ...hstack(8), alignItems: 'center', flexWrap: 'wrap' as const };

/** What a timed value starts at when "all day" is turned off */
const MORNING = '09:00';
/** A day as a date input gives one once it is whole: a four-digit year from 1000 */
const COMPLETE_DAY = /^[1-9]\d{3}-\d{2}-\d{2}$/;

/** A moment, or a whole day: a day, and a time unless "all day" is ticked */
export function WhenInput({
  label,
  value,
  onChange,
}: {
  label: ReactNode;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  // What is typed is kept here, not read back from the value: a day half typed
  // (year 0020) is no time yet, and a Date would make it 1920.
  const [typed, setTyped] = useState(() => {
    const stored = typeof value === 'string' && value ? value : null;
    const date = stored ? dateOf(stored) : null;
    const whole = stored ? isWholeDay(stored) : false;
    return {
      day: date ? dayKey(date) : '',
      clock: date && !whole ? clockOf(date) : MORNING,
      allDay: whole,
    };
  });
  const { day, clock, allDay } = typed;
  const write = (next: typeof typed) => {
    setTyped(next);
    if (!next.day) return onChange(undefined);
    if (!COMPLETE_DAY.test(next.day)) return;
    onChange(next.allDay ? next.day : rfc3339(fromInputs(next.day, next.clock)));
  };
  return (
    <div style={labelStyle}>
      {label}
      <div style={row}>
        <input
          type="date"
          aria-label="Day"
          value={day}
          onChange={(e) => write({ ...typed, day: e.target.value })}
          style={{ ...styles.input, width: 'auto' }}
        />
        {!allDay && (
          <input
            type="time"
            aria-label="Time"
            value={clock}
            disabled={!day}
            onChange={(e) => write({ ...typed, clock: e.target.value || MORNING })}
            style={{ ...styles.input, width: 'auto' }}
          />
        )}
        <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={allDay}
            onChange={(e) => write({ ...typed, allDay: e.target.checked })}
          />
          All day
        </label>
      </div>
    </div>
  );
}

/** Currencies offered first; any ISO 4217 code can be typed */
const CURRENCIES = ['EUR', 'USD', 'GBP', 'NOK', 'SEK', 'DKK', 'CHF', 'JPY', 'CAD', 'AUD'];

/** An amount as a decimal string, never a float, and its currency */
export function MoneyInput({
  label,
  value,
  onChange,
}: {
  label: ReactNode;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const amount = isObject(value) && typeof value.amount === 'string' ? value.amount : '';
  const currency = isObject(value) && typeof value.currency === 'string' ? value.currency : '';
  const write = (nextAmount: string, nextCurrency: string) =>
    onChange(
      nextAmount || nextCurrency
        ? { amount: nextAmount.replace(',', '.'), currency: nextCurrency.toUpperCase() }
        : undefined,
    );
  return (
    <div style={labelStyle}>
      {label}
      <div style={row}>
        <input
          inputMode="decimal"
          aria-label="Amount"
          placeholder="12.50"
          value={amount}
          onChange={(e) => write(e.target.value, currency)}
          style={{ ...styles.input, flex: 1 }}
        />
        <input
          aria-label="Currency"
          placeholder="EUR"
          list="currencies"
          maxLength={3}
          value={currency}
          onChange={(e) => write(amount, e.target.value)}
          style={{ ...styles.input, width: 96 }}
        />
        <datalist id="currencies">
          {CURRENCIES.map((code) => (
            <option key={code} value={code} />
          ))}
        </datalist>
      </div>
    </div>
  );
}

/**
 * A file added to the space, or a picture and what it shows. Pictures are
 * made smaller first, as attachments are.
 */
export function FileInput({
  label,
  picture,
  value,
  onChange,
}: {
  label: ReactNode;
  /** An `image`: `{ blob, alt }` rather than the file alone */
  picture: boolean;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const node = useNode();
  const space = useSpaceHere();
  const input = useRef<HTMLInputElement>(null);
  const { run, busy, error } = useAction();
  const current = picture ? (isObject(value) ? value : {}) : null;
  const ref = fileRefOf(current ? current.blob : value);
  const alt = current && typeof current.alt === 'string' ? current.alt : '';

  const add = (files: FileList | null) => {
    const picked = files?.[0];
    if (!picked || !space) return;
    return run(async () => {
      const file = await fitImage(picked);
      const blob = await node.records.addFile(space.id, new Uint8Array(await file.arrayBuffer()), {
        mime: file.type || 'application/octet-stream',
        name: file.name,
      });
      onChange(current ? { ...current, blob } : blob);
      if (input.current) input.current.value = '';
    });
  };

  return (
    <div style={labelStyle}>
      {label}
      {ref && <FileValue value={ref} alt={alt} />}
      <div style={row}>
        <input
          ref={input}
          type="file"
          hidden
          aria-label={picture ? 'A picture' : 'A file'}
          accept={picture ? 'image/*' : undefined}
          onChange={(e) => void add(e.target.files)}
        />
        <button
          type="button"
          data-variant="ghost"
          style={styles.smallButton}
          disabled={busy || !space}
          onClick={() => input.current?.click()}
        >
          {busy ? 'Adding…' : ref ? 'Replace' : picture ? 'Add a picture' : 'Add a file'}
        </button>
        {ref && (
          <button
            type="button"
            data-variant="ghost"
            style={styles.linkButton}
            onClick={() => onChange(undefined)}
          >
            Remove
          </button>
        )}
      </div>
      {current && ref && (
        <input
          aria-label="What it shows"
          placeholder="What it shows, for people who can't see it"
          value={alt}
          onChange={(e) => onChange({ ...current, alt: e.target.value || undefined })}
          style={styles.input}
        />
      )}
      {error && <p style={styles.error}>{error}</p>}
    </div>
  );
}

/** Files or pictures, as a list: each one as it is, and a picker for one more */
export function FileListInput({
  label,
  picture,
  value,
  onChange,
}: {
  label: ReactNode;
  picture: boolean;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const items: ReadonlyArray<unknown> = Array.isArray(value) ? value : [];
  const write = (next: ReadonlyArray<unknown>) => onChange(next.length ? next : undefined);
  return (
    <div style={labelStyle}>
      {label}
      {items.map((item, index) => (
        <FileInput
          key={index}
          label={null}
          picture={picture}
          value={item}
          onChange={(next) =>
            write(
              next === undefined
                ? items.filter((_, i) => i !== index)
                : items.map((old, i) => (i === index ? next : old)),
            )
          }
        />
      ))}
      <FileInput
        label={null}
        picture={picture}
        value={undefined}
        onChange={(next) => write([...items, next])}
      />
    </div>
  );
}
