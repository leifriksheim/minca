import { useState, type FormEvent, type ReactNode } from 'react';
import type { JsonSchema } from '@minca/core';
import {
  choicesOf,
  emptyValue,
  fieldsOf,
  isObject,
  textOf,
  itemKindOf,
  valueKindOf,
  type Field,
  type LinkedByRel,
} from '../derive/schema-ui';
import { FileInput, FileListInput, MoneyInput, WhenInput } from './KindInputs';
import { fieldTypeOf } from '../derive/field-types';
import { nameOf } from '../derive/people';
import { usePeopleHere } from './Person';
import { useAction } from '@minca/app-shared/action';

/**
 * A form for a record, drawn from its collection's schema. Without a schema,
 * the body is edited as JSON. The node checks the result against the schema
 * when it is written, so the form only has to be helpful, not strict.
 */
export function SchemaForm({
  schema,
  initial,
  submitLabel,
  onSubmit,
  onCancel,
  linked = {},
}: {
  schema: JsonSchema | null;
  initial?: unknown;
  /** The records this one links to, by role — where `x-choicesFrom` finds its options */
  linked?: LinkedByRel;
  submitLabel: string;
  onSubmit: (body: unknown) => Promise<void>;
  onCancel?: () => void;
}) {
  const fields = fieldsOf(schema);
  const [value, setValue] = useState<Record<string, unknown>>(() =>
    isObject(initial) ? initial : Object.fromEntries(fields.map((f) => [f.name, emptyValue(f)])),
  );
  const [json, setJson] = useState(() => JSON.stringify(initial ?? {}, null, 2));
  const { run, busy, error } = useAction();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    return run(async () => {
      let body: unknown;
      try {
        body = fields.length > 0 ? clean(value) : JSON.parse(json);
      } catch {
        throw new Error('That is not valid JSON.');
      }
      await onSubmit(body);
    });
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="stack" data-gap="loose">
      {fields.length === 0 ? (
        <label>
          <span>Body (JSON) — this collection has no schema</span>
          <textarea value={json} onChange={(e) => setJson(e.target.value)} rows={6} />
        </label>
      ) : (
        fields.map((field) => (
          <FieldInput
            key={field.name}
            field={field}
            linked={linked}
            value={value[field.name]}
            onChange={(v) => setValue((old) => ({ ...old, [field.name]: v }))}
          />
        ))
      )}
      {error && <p role="alert">{error}</p>}
      <div className="row">
        <button type="submit" data-intent="primary" disabled={busy}>
          {submitLabel}
        </button>
        {onCancel && (
          <button type="button" data-intent="quiet" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

export function FieldInput({
  field,
  value,
  onChange,
  linked = {},
}: {
  field: Field;
  value: unknown;
  onChange: (value: unknown) => void;
  linked?: LinkedByRel;
}) {
  const here = usePeopleHere();
  const type = fieldTypeOf(field.schema);
  const label = (
    <span>
      {field.label}
      {field.required && ' *'}
      {typeof field.schema.description === 'string' && <span> — {field.schema.description}</span>}
    </span>
  );
  /** One control under the field's label */
  const labelled = (control: ReactNode) => (
    <label>
      {label}
      {control}
    </label>
  );
  const text = typeof value === 'string' ? value : '';

  // What the field says it holds, as the standard library's fragments label it.
  const kind = valueKindOf(field.schema);
  if (kind === 'when') return <WhenInput label={label} value={value} onChange={onChange} />;
  if (kind === 'money') return <MoneyInput label={label} value={value} onChange={onChange} />;
  if (kind === 'file' || kind === 'image')
    return <FileInput label={label} picture={kind === 'image'} value={value} onChange={onChange} />;
  const items = itemKindOf(field.schema);
  if (items === 'file' || items === 'image')
    return <FileListInput label={label} picture={items === 'image'} value={value} onChange={onChange} />;
  if (kind === 'day')
    return labelled(
      <input type="date" value={text} onChange={(e) => onChange(e.target.value || undefined)} />,
    );
  if (kind === 'url')
    return labelled(
      <input
        type="url"
        value={text}
        onChange={(e) => onChange(e.target.value || undefined)}
        placeholder="https://"
      />,
    );
  if ((type === 'person' || type === 'people') && here && here.people.size > 0) {
    const everyone = [...here.people.keys()];
    const name = (did: string) =>
      did === here.me ? `${nameOf(did, here.people)} (you)` : nameOf(did, here.people);
    if (type === 'person')
      return labelled(
        <select value={text} onChange={(e) => onChange(e.target.value || undefined)}>
          <option value="">—</option>
          {everyone.map((did) => (
            <option key={did} value={did}>
              {name(did)}
            </option>
          ))}
        </select>,
      );
    const picked: ReadonlyArray<unknown> = Array.isArray(value) ? value : [];
    return (
      <fieldset>
        <legend>{label}</legend>
        <div className="row">
          {everyone.map((did) => (
            <label key={did}>
              <input
                type="checkbox"
                checked={picked.includes(did)}
                onChange={(e) =>
                  onChange(e.target.checked ? [...picked, did] : picked.filter((p) => p !== did))
                }
              />
              {name(did)}
            </label>
          ))}
        </div>
      </fieldset>
    );
  }

  switch (field.kind) {
    case 'boolean':
      return (
        <label>
          <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
          {label}
        </label>
      );
    case 'choice': {
      const choices = choicesOf(field, linked);
      // Choices from a linked record that is not here: fall back to a plain input for the type.
      if (!choices)
        return (
          <FieldInput
            field={{
              ...field,
              kind:
                field.schema.type === 'integer'
                  ? 'integer'
                  : field.schema.type === 'number'
                    ? 'number'
                    : 'text',
            }}
            value={value}
            onChange={onChange}
          />
        );
      const selected = choices.findIndex((c) => c.value === value);
      return labelled(
        <select
          value={selected < 0 ? '' : String(selected)}
          onChange={(e) =>
            onChange(e.target.value === '' ? undefined : choices[Number(e.target.value)]?.value)
          }
        >
          <option value="">—</option>
          {choices.map((choice, i) => (
            <option key={i} value={String(i)}>
              {choice.label}
            </option>
          ))}
        </select>,
      );
    }
    case 'number':
    case 'integer':
      return labelled(
        <input
          type="number"
          step={field.kind === 'integer' ? 1 : 'any'}
          value={typeof value === 'number' ? value : ''}
          onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
        />,
      );
    case 'longText':
      return labelled(<textarea value={text} onChange={(e) => onChange(e.target.value)} rows={4} />);
    case 'list':
      return (
        <ListInput
          field={field}
          label={label}
          value={Array.isArray(value) ? value : []}
          onChange={onChange}
        />
      );
    case 'object':
      return (
        <fieldset>
          <legend>{label}</legend>
          {fieldsOf(field.schema).map((sub) => (
            <FieldInput
              key={sub.name}
              field={sub}
              value={isObject(value) ? value[sub.name] : undefined}
              onChange={(v) => onChange({ ...(isObject(value) ? value : {}), [sub.name]: v })}
            />
          ))}
        </fieldset>
      );
    case 'json':
      return <JsonInput label={label} value={value} onChange={onChange} />;
    default:
      return labelled(<input type="text" value={text} onChange={(e) => onChange(e.target.value)} />);
  }
}

/** A list of short values: one box each, plus one to add */
function ListInput({
  field,
  label,
  value,
  onChange,
}: {
  field: Field;
  label: ReactNode;
  value: unknown[];
  onChange: (value: unknown) => void;
}) {
  const numeric = (isObject(field.schema.items) ? field.schema.items.type : undefined) !== 'string';
  const parse = (raw: string) => (numeric ? Number(raw) : raw);
  return (
    <fieldset>
      <legend>{label}</legend>
      {value.map((item, index) => (
        <div key={index} className="row" data-gap="tight">
          <input
            aria-label={`${field.label} ${index + 1}`}
            type={numeric ? 'number' : 'text'}
            value={textOf(item ?? '')}
            onChange={(e) => onChange(value.map((old, i) => (i === index ? parse(e.target.value) : old)))}
          />
          <button
            type="button"
            data-intent="quiet"
            data-icon
            onClick={() => onChange(value.filter((_, i) => i !== index))}
            aria-label={`Remove ${field.label} ${index + 1}`}
          >
            ✕
          </button>
        </div>
      ))}
      <div>
        <button type="button" data-intent="quiet" onClick={() => onChange([...value, numeric ? 0 : ''])}>
          + Add {field.label.toLowerCase()}
        </button>
      </div>
    </fieldset>
  );
}

function JsonInput({
  label,
  value,
  onChange,
}: {
  label: ReactNode;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const [raw, setRaw] = useState(() => (value === undefined ? '' : JSON.stringify(value, null, 2)));
  return (
    <label>
      {label}
      <textarea
        value={raw}
        rows={3}
        onChange={(e) => {
          setRaw(e.target.value);
          try {
            onChange(e.target.value.trim() ? JSON.parse(e.target.value) : undefined);
          } catch {
            /* keep typing */
          }
        }}
      />
    </label>
  );
}

/** Drops fields left empty, so an optional field is absent rather than "" */
function clean(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined && v !== ''));
}
