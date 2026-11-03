import { useEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent, type ReactNode } from 'react';
import { parse, render } from 'sugar-high/core';
import * as json from 'sugar-high/lang/json';
import { useNode, useProfiles } from '@minca/react';
import type { NodeCollection, NodeRecord, Query, QueryRecord, QueryResult, SpaceSummary } from '@minca/core';
import { collectionLabel, fieldsOf, recordLabel, titleField } from '../derive/schema-ui';
import { nameOf, peopleFrom } from '../derive/people';
import { ago } from '@minca/ui/time';
import { message as messageOf } from '@minca/app-shared/action';
import { Loader } from '@minca/app-shared/Loader';
import styles from './QueryPlayground.module.css';
import table from './table.module.css';
import { DocsNote } from './DocsNote';

// Try the query language on this space's own data, with examples built from its real collections.

const DEBOUNCE = 250;

interface Example {
  readonly label: string;
  readonly query: Query;
}

const pretty = (value: unknown) => JSON.stringify(value, null, 2);

/** The first collections worth showing: your own collections before the shared ones, busiest first */
function ownCollections(collections: ReadonlyArray<NodeCollection>): NodeCollection[] {
  const visible = collections.filter((c) => !c.name.startsWith('sys.'));
  const own = visible.filter((c) => !c.name.startsWith('std.'));
  return [...(own.length ? own : visible)].sort((a, b) => b.records - a.records);
}

/** Example queries built from what this space really holds */
function examplesFor(collections: ReadonlyArray<NodeCollection>, me: string): Example[] {
  const ranked = ownCollections(collections);
  const first = ranked[0];
  if (!first) return [];
  const name = (c: NodeCollection) => collectionLabel(c).toLowerCase();
  const out: Example[] = [{ label: `All ${name(first)}`, query: { collection: first.name } }];

  out.push({
    label: `Newest 10 ${name(first)}`,
    query: { collection: first.name, sort: { '@createdAt': 'desc' }, limit: 10 },
  });

  // A filter on a real field: a yes/no one if there is one, else fixed choices, a number, or text.
  let filtered = false;
  for (const c of ranked) {
    const fields = fieldsOf(c.schema);
    const yesNo = fields.find((f) => f.kind === 'boolean');
    if (yesNo) {
      out.push({
        label: `${collectionLabel(c)} where ${yesNo.label.toLowerCase()} is yes`,
        query: { collection: c.name, where: { [yesNo.name]: true } },
      });
      filtered = true;
      break;
    }
    const choice = fields.find((f) => Array.isArray(f.schema.enum) && f.schema.enum.length > 1);
    if (choice) {
      const options: unknown[] = Array.isArray(choice.schema.enum) ? choice.schema.enum.slice(0, 2) : [];
      out.push({
        label: `${collectionLabel(c)} by ${choice.label.toLowerCase()}`,
        query: { collection: c.name, where: { [choice.name]: { $in: options } } },
      });
      filtered = true;
      break;
    }
  }
  if (!filtered) {
    const c = ranked.find((c) => titleField(c.schema));
    const title = c && titleField(c.schema);
    if (c && title)
      out.push({
        label: `${collectionLabel(c)} with "a" in the ${title}`,
        query: { collection: c.name, where: { [title]: { $contains: 'a' } } },
      });
  }

  out.push({
    label: 'Written by me',
    query: { collection: first.name, where: { '@createdBy': me }, sort: { '@updatedAt': 'desc' } },
  });

  const weekAgo = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);
  out.push({
    label: 'Added this week',
    query: { collection: first.name, where: { '@createdAt': { $gte: weekAgo } } },
  });

  // Whatever declares a link that may point at the first collection.
  const pointers = collections.flatMap((c) =>
    Object.entries(c.links)
      .filter(([, link]) => link.to === '*' || link.to.includes(first.name))
      .map(([rel]) => ({ from: c.name, rel, as: (c.name.split('.').pop() ?? c.name) + 's' })),
  );
  if (pointers.length) {
    out.push({
      label: 'With what points at them',
      query: {
        collection: first.name,
        include: Object.fromEntries(
          pointers.slice(0, 3).map((p) => [p.as, { rel: p.rel, from: p.from, limit: 5 }]),
        ),
      },
    });
  }

  if (collections.some((c) => c.name === 'std.comment')) {
    out.push({
      label: 'Count comments',
      query: {
        collection: first.name,
        include: { comments: { rel: 'about', from: 'std.comment', count: true } },
      },
    });
  }

  out.push({
    label: 'Five at a time',
    query: { collection: first.name, sort: { '@createdAt': 'desc' }, limit: 5 },
  });
  return out;
}

/** "Unexpected token } in JSON at position 42" → where that is, as a line and column */
function jsonProblem(text: string, error: unknown): string {
  const message = messageOf(error);
  const at = /position (\d+)/.exec(message);
  let where = '';
  if (at && !/\(line \d+/.test(message)) {
    const before = text.slice(0, Number(at[1]));
    const lines = before.split('\n');
    where = ` (line ${lines.length}, column ${(lines[lines.length - 1]?.length ?? 0) + 1})`;
  }
  return `${message.replace(/^JSON\.parse: /, '')}${where}`;
}

type Parsed = { ok: true; query: Query; text: string } | { ok: false; problem: string } | null;

export function QueryPlayground({
  space,
  collections,
  onOpen,
}: {
  space: SpaceSummary;
  collections: ReadonlyArray<NodeCollection>;
  onOpen: (record: NodeRecord) => void;
}): JSX.Element {
  const node = useNode();
  const people = peopleFrom(useProfiles(space.id));
  const examples = useMemo(() => examplesFor(collections, node.did), [collections, node.did]);
  const schemas = useMemo(() => new Map(collections.map((c) => [c.name, c])), [collections]);

  const [text, setText] = useState<string | null>(null);
  const [parsed, setParsed] = useState<Parsed>(null);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [queryError, setQueryError] = useState<string | null>(null);
  // Which query, in which space, has answered at least once; until it has, it is still running.
  const [ranFor, setRanFor] = useState<string | null>(null);
  const [raw, setRaw] = useState(false);

  // Start from the first example, once there is one — and never overwrite what you typed.
  if (text === null && examples[0]) setText(pretty(examples[0].query));

  // Parse a moment after typing stops.
  useEffect(() => {
    if (text === null) return;
    const timer = setTimeout(() => {
      if (!text.trim())
        return setParsed({
          ok: false,
          problem: 'The editor is empty. Pick an example above, or write a query.',
        });
      try {
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the node checks the query itself (checkQuery) and says what is wrong, shown as the query's error
        const query = JSON.parse(text) as Query;
        setParsed({ ok: true, query, text: JSON.stringify(query) });
      } catch (error) {
        setParsed({ ok: false, problem: jsonProblem(text, error) });
      }
    }, DEBOUNCE);
    return () => clearTimeout(timer);
  }, [text]);

  // Run it, and again whenever the space's records change.
  const runKey = parsed?.ok ? parsed.text : null;
  const running = runKey !== null && ranFor !== `${space.id}\n${runKey}`;
  useEffect(() => {
    if (!parsed?.ok) return;
    const key = `${space.id}\n${parsed.text}`;
    return node.records.watch(
      space.id,
      parsed.query,
      (next) => {
        setResult(next);
        setQueryError(null);
        setRanFor(key);
      },
      (error) => {
        setQueryError(error.message.replace(/^Invalid query: /, ''));
        setRanFor(key);
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node, space.id, runKey]);

  /** Changes one top-level part of the query in the editor: the next page, or back to the first */
  const setCursor = (cursor: string | null) => {
    if (!parsed?.ok) return;
    const { cursor: _old, ...rest } = parsed.query;
    setText(pretty(cursor ? { ...rest, cursor } : rest));
  };

  const jsonError = parsed && !parsed.ok ? parsed.problem : null;
  const stale = Boolean(jsonError || queryError);
  const records = result?.records ?? [];

  if (examples.length === 0 && text === null) {
    return (
      <section aria-label="Try a query">
        <Header />
        <p className="empty">Nothing here to look through yet. Add something to this space first.</p>
      </section>
    );
  }

  return (
    <section aria-label="Try a query">
      <Header />

      <div role="group" aria-label="Examples" className="row" data-gap="tight">
        {examples.map((example) => {
          const current = text !== null && text === pretty(example.query);
          return (
            <button key={example.label} onClick={() => setText(pretty(example.query))} aria-pressed={current}>
              {example.label}
            </button>
          );
        })}
      </div>

      <div className={styles.columns}>
        <div className={`stack ${styles.column}`}>
          <label htmlFor="query-editor">Your query</label>
          <Editor value={text ?? ''} onChange={setText} />
          {jsonError && (
            <Problem title="This isn't valid JSON yet">
              {jsonError}. Check for a missing comma, a missing quote around a name, or a comma after the last
              item.
            </Problem>
          )}
          {!jsonError && queryError && <Problem title="The query can't run">{queryError}</Problem>}
          <DocsNote path="packages/core/docs/query-format.md">
            A query is one JSON object; only “collection” is required.
          </DocsNote>
        </div>

        <div className={`stack ${styles.column} ${stale ? styles.stale : ''}`}>
          <div className="row" data-spread>
            <small className="row" data-gap="tight">
              {result ? `${records.length} found${result.cursor ? ', and more after these' : ''}` : 'Results'}
              {running && <Loader size={9} label="Running the query" />}
              {stale && result && ' · from the last query that worked'}
            </small>
            <div role="tablist" aria-label="Show results as">
              {(['Table', 'JSON'] as const).map((mode) => (
                <button
                  key={mode}
                  role="tab"
                  aria-selected={(mode === 'JSON') === raw}
                  onClick={() => setRaw(mode === 'JSON')}
                >
                  {mode}
                </button>
              ))}
            </div>
          </div>

          {result && records.length === 0 && <p className="empty">Nothing matches this query.</p>}
          {result && records.length > 0 && !raw && (
            <ResultTable
              records={records}
              label={(r) => recordLabel(r, schemas.get(r.collection)?.schema ?? null)}
              collection={(name) => {
                const c = schemas.get(name);
                return c ? collectionLabel(c) : name;
              }}
              author={(r) => nameOf(r.createdBy ?? r.root, people)}
              onOpen={onOpen}
            />
          )}
          {result && raw && <Highlighted code={pretty(result)} />}

          {parsed?.ok && (result?.cursor || parsed.query.cursor) && (
            <div className="row">
              {parsed.query.cursor && (
                <button data-intent="quiet" onClick={() => setCursor(null)}>
                  Back to the first page
                </button>
              )}
              {result?.cursor && (
                <button data-intent="quiet" onClick={() => setCursor(result.cursor)}>
                  Next page →
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function Header() {
  return (
    <div className="stack" data-gap="tight">
      <h2>Try a query</h2>
      <small>
        Ask this space for exactly the records you want, written as plain JSON. It runs as you type, on the
        data on this device, and nothing you do here changes anything.
      </small>
    </div>
  );
}

// ─── Editor ────────────────────────────────────────────────────────

const highlight = (code: string) => render(parse(code, { ...json }));

/** A textarea with the highlighted text drawn exactly underneath it */
function Editor({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  const under = useRef<HTMLPreElement>(null);
  const html = useMemo(() => highlight(value), [value]);

  // Tab indents rather than leaving the editor.
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Tab' || e.shiftKey) return;
    e.preventDefault();
    const el = e.currentTarget;
    const { selectionStart: start, selectionEnd: end } = el;
    onChange(value.slice(0, start) + '  ' + value.slice(end));
    requestAnimationFrame(() => el.setSelectionRange(start + 2, start + 2));
  };

  return (
    <div className={styles.editor}>
      <pre
        ref={under}
        aria-hidden
        className={`${styles.code} ${styles.under}`}
        dangerouslySetInnerHTML={{ __html: `${html}\n ` }}
      />
      <textarea
        id="query-editor"
        className={`${styles.code} ${styles.input}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onScroll={(e) => {
          if (!under.current) return;
          under.current.scrollTop = e.currentTarget.scrollTop;
          under.current.scrollLeft = e.currentTarget.scrollLeft;
        }}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        wrap="off"
      />
    </div>
  );
}

/** Read-only highlighted JSON */
function Highlighted({ code }: { code: string }) {
  const html = useMemo(() => highlight(code), [code]);
  return (
    <pre className={`${styles.code} ${styles.highlighted}`} dangerouslySetInnerHTML={{ __html: html }} />
  );
}

function Problem({ title, children }: { title: string; children: ReactNode }) {
  return (
    <aside role="alert" data-tone="danger" className="stack" data-gap="tight">
      <strong>{title}</strong>
      <small>{children}</small>
    </aside>
  );
}

// ─── Results ───────────────────────────────────────────────────────

function ResultTable({
  records,
  label,
  collection,
  author,
  onOpen,
}: {
  records: ReadonlyArray<QueryRecord>;
  label: (r: QueryRecord) => string;
  collection: (name: string) => string;
  author: (r: QueryRecord) => string;
  onOpen: (record: NodeRecord) => void;
}) {
  const anyIncluded = records.some((r) => r.included && Object.keys(r.included).length > 0);
  return (
    <div className={table.table}>
      <table>
        <thead>
          <tr>
            <th>What</th>
            <th>Collection</th>
            <th>By</th>
            <th>Added</th>
            {anyIncluded && <th>Pulled in</th>}
          </tr>
        </thead>
        <tbody className={table.opens}>
          {records.map((record) => (
            <tr
              key={record.key}
              tabIndex={0}
              onClick={() => onOpen(record)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onOpen(record);
              }}
              aria-label={`Open ${label(record)}`}
            >
              <td>
                <strong>{label(record)}</strong>
              </td>
              <td>{collection(record.collection)}</td>
              <td>{author(record)}</td>
              <td title={record.createdAt}>{ago(record.createdAt)}</td>
              {anyIncluded && (
                <td>
                  <Included record={record} label={label} />
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** What an `include` found, in a few words: "3 comments · reactions: 👍, 🎉" */
function Included({ record, label }: { record: QueryRecord; label: (r: QueryRecord) => string }) {
  const entries = Object.entries(record.included ?? {});
  if (entries.length === 0) return <span>—</span>;
  return (
    <span className="stack" data-gap="tight">
      {entries.map(([name, found]) => {
        if (typeof found === 'number') {
          return (
            <span key={name}>
              <small>{name}</small> {found}
            </span>
          );
        }
        const shown = found.slice(0, 3).map(label).join(', ');
        return (
          <span key={name} className="truncate">
            <small>{name}</small> {found.length}
            {found.length > 0 && `: ${shown}${found.length > 3 ? '…' : ''}`}
          </span>
        );
      })}
    </span>
  );
}
