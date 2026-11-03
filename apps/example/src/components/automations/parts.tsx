import type { ReactNode } from 'react';
import type { NodeCollection } from '@minca/core';
import { useQuery } from '@minca/react';
import {
  clauseOn,
  clauseWords,
  needsValue,
  opsFor,
  type Clause,
  type ClauseField,
} from '../../derive/conditions';
import { nameOf, type People } from '../../derive/people';
import { recordLabel } from '../../derive/schema-ui';
import { noun, type Within } from '../../automations';

/** One choice inside a sentence, drawn as a word you can change */
export function Pill<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: ReadonlyArray<{ value: T; label: string; disabled?: boolean }>;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(event) => {
        const picked = options.find((option) => option.value === event.target.value);
        if (picked) onChange(picked.value);
      }}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value} disabled={option.disabled}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

/** A value to compare against, in the form its field takes */
export function ValueInput({
  field,
  clause,
  people,
  me,
  onChange,
}: {
  field: ClauseField;
  clause: Clause;
  people: People;
  me: string | null;
  onChange: (patch: Pick<Clause, 'value' | 'me'>) => void;
}) {
  const label = `${field.label}: value`;
  switch (field.kind) {
    case 'choice': {
      const choices = field.choices ?? [];
      const at = choices.findIndex((choice) => choice.value === clause.value);
      return (
        <Pill
          label={label}
          value={at < 0 ? '' : String(at)}
          options={[
            ...(at < 0 ? [{ value: '', label: 'pick one' }] : []),
            ...choices.map((choice, i) => ({ value: String(i), label: choice.label })),
          ]}
          onChange={(picked) => {
            const value = choices[Number(picked)]?.value;
            if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
              onChange({ value });
          }}
        />
      );
    }
    case 'person':
    case 'people': {
      const others = [...people.keys()].filter((did) => did !== me);
      return (
        <Pill
          label={label}
          value={clause.me ? 'me' : typeof clause.value === 'string' ? clause.value : 'me'}
          options={[
            { value: 'me', label: 'me' },
            ...others.map((did) => ({ value: did, label: nameOf(did, people) })),
          ]}
          onChange={(picked) => onChange(picked === 'me' ? { me: true } : { value: picked })}
        />
      );
    }
    case 'yesno':
      return (
        <Pill
          label={label}
          value={clause.value === false ? 'no' : 'yes'}
          options={[
            { value: 'yes', label: 'yes' },
            { value: 'no', label: 'no' },
          ]}
          onChange={(picked) => onChange({ value: picked === 'yes' })}
        />
      );
    case 'number':
      return (
        <input
          aria-label={label}
          type="number"
          value={typeof clause.value === 'number' ? clause.value : ''}
          onChange={(event) =>
            onChange(event.target.value === '' ? { value: undefined } : { value: Number(event.target.value) })
          }
          placeholder="0"
        />
      );
    case 'date':
      return (
        <input
          aria-label={label}
          type="date"
          value={typeof clause.value === 'string' ? clause.value : ''}
          onChange={(event) => onChange({ value: event.target.value || undefined })}
        />
      );
    default:
      return (
        <input
          aria-label={label}
          value={typeof clause.value === 'string' ? clause.value : ''}
          onChange={(event) => onChange({ value: event.target.value })}
          placeholder="some text"
        />
      );
  }
}

/** A condition per row and a way to add one on any field; with none yet, `suggest` offers likely ones */
export function ClauseList({
  fields,
  clauses,
  onChange,
  people,
  me,
  suggest = true,
  empty,
  add = '+ Only when…',
}: {
  fields: ReadonlyArray<ClauseField>;
  clauses: ReadonlyArray<Clause>;
  onChange: (clauses: ReadonlyArray<Clause>) => void;
  people: People;
  me: string | null;
  suggest?: boolean;
  /** Said when there are no conditions: what that means */
  empty?: string;
  add?: string;
}) {
  const set = (i: number, next: Clause) => onChange(clauses.map((c, j) => (j === i ? next : c)));
  const suggestions = suggest && clauses.length === 0 ? suggestionsFor(fields) : [];

  return (
    <div className="stack">
      {clauses.length === 0 && empty && <small>{empty}</small>}
      {clauses.map((clause, i) => {
        const field = fields.find((f) => f.name === clause.field);
        if (!field) return null;
        const ops = opsFor(field.kind);
        return (
          <aside key={`${clause.field}-${i}`} className="row" data-gap="tight">
            <small>{i === 0 ? 'where' : 'and'}</small>
            <Pill
              label={`Condition ${i + 1}: field`}
              value={clause.field}
              options={fields.map((f) => ({ value: f.name, label: f.label.toLowerCase() }))}
              onChange={(name) => {
                const next = fields.find((f) => f.name === name);
                if (next) set(i, clauseOn(next));
              }}
            />
            {ops.length > 1 ? (
              <Pill
                label={`Condition ${i + 1}: comparison`}
                value={clause.op}
                options={ops.map((o) => ({ value: o.op, label: o.label }))}
                onChange={(op) => set(i, { ...clause, op })}
              />
            ) : (
              <span>is</span>
            )}
            {needsValue(clause.op) && (
              <ValueInput
                field={field}
                clause={clause}
                people={people}
                me={me}
                onChange={(patch) => {
                  const { value: _value, me: _me, ...rest } = clause;
                  set(i, { ...rest, ...patch });
                }}
              />
            )}
            <button
              type="button"
              onClick={() => onChange(clauses.filter((_, j) => j !== i))}
              aria-label={`Remove condition ${i + 1}`}
              data-intent="quiet"
              data-icon
            >
              ✕
            </button>
          </aside>
        );
      })}

      <div className="row" data-gap="tight">
        {fields.length > 0 && (
          <select
            aria-label="Add a condition on"
            value=""
            onChange={(event) => {
              const field = fields.find((f) => f.name === event.target.value);
              if (field) onChange([...clauses, clauseOn(field)]);
            }}
          >
            <option value="">{add}</option>
            {fields.map((f) => (
              <option key={f.name} value={f.name}>
                {f.label}
              </option>
            ))}
          </select>
        )}
        {suggestions.map((clause) => (
          <button key={clauseWords(clause, fields)} type="button" onClick={() => onChange([clause])}>
            {clauseWords(clause, fields)}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Conditions worth one click: "for me" on each people field, and the first option of each choice */
function suggestionsFor(fields: ReadonlyArray<ClauseField>): ReadonlyArray<Clause> {
  const mine = fields.filter((f) => f.kind === 'person' || f.kind === 'people').map(clauseOn);
  const choice = fields
    .filter((f) => f.kind === 'choice')
    .slice(0, 1)
    .flatMap((f) =>
      (f.choices ?? [])
        .slice(-1)
        .flatMap((c) =>
          typeof c.value === 'string' || typeof c.value === 'number'
            ? [{ ...clauseOn(f), value: c.value }]
            : [],
        ),
    );
  return [...mine, ...choice].slice(0, 3);
}

/** A step of a builder: its short name over what is picked */
export function Step({ label, children }: { label: string; children: ReactNode }) {
  return (
    <fieldset className="stack">
      <legend>{label}</legend>
      {children}
    </fieldset>
  );
}

/** Text with pills inside it, wrapping like a sentence */
export function Sentence({ children }: { children: ReactNode }) {
  return (
    <div className="row" data-gap="tight">
      {children}
    </div>
  );
}

/** "in any channel", or one of them: where an automation's or notification's records must be */
export function PlacePill({
  spaceId,
  collections,
  place,
  picked,
  onChange,
}: {
  spaceId: string;
  collections: ReadonlyArray<NodeCollection>;
  place: { rel: string; to: string };
  picked: Within | null;
  onChange: (next: Within | null) => void;
}) {
  const found = useQuery(spaceId, { collection: place.to, limit: 200 }).result;
  const schema = collections.find((c) => c.name === place.to)?.schema ?? null;
  const options = (found?.records ?? []).map((r) => ({ value: r.key, label: recordLabel(r, schema) }));
  // One picked before that this device can't see now still shows, by the name it had.
  if (picked && !options.some((o) => o.value === picked.to))
    options.unshift({ value: picked.to, label: picked.label });
  return (
    <>
      <span>in</span>
      <Pill
        label={`Which ${noun(collections, place.to)}`}
        value={picked?.to ?? ''}
        options={[{ value: '', label: `any ${noun(collections, place.to)}` }, ...options]}
        onChange={(key) => {
          const option = options.find((o) => o.value === key);
          onChange(option ? { rel: place.rel, to: option.value, label: option.label } : null);
        }}
      />
    </>
  );
}
