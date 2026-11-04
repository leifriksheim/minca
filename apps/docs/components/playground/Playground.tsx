'use client';
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { DynamicCodeBlock } from 'fumadocs-ui/components/dynamic-codeblock';
import { Check } from 'lucide-react';
import {
  addSchemas,
  listItem,
  MincaProvider,
  useAccount,
  useConnection,
  useNode,
  useQuery,
  useSpaces,
  type NodeCollection,
} from '@minca/playground';
import { HOME, PLAYGROUND_SPACE, playgroundConnection } from './minca';
import { ScreenRun } from './ScreenRun';
import {
  collectionsCode,
  connectCode,
  definitionCode,
  recordsCode,
  screenCode,
  spacesCode,
} from './snippets';

/**
 * minca.dev's playground: an app built a step at a time, each step running
 * for real against the person's own account, beside the code that does it.
 */
export function Playground() {
  const [connection] = useState(playgroundConnection);
  useEffect(() => {
    void connection.start();
  }, [connection]);
  return (
    <MincaProvider connection={connection}>
      <Connected />
    </MincaProvider>
  );
}

/** Each step, as far as the person has come. */
function Connected() {
  const { state } = useConnection();
  const ready = state.status === 'ready';
  return (
    <Steps connected={ready} connect={<ConnectPanel />}>
      {ready ? <InSpaces /> : null}
    </Steps>
  );
}

function Steps({
  connected,
  connect,
  children,
}: {
  connected: boolean;
  /** Step 1's panel: a button once the connection has started */
  connect: ReactNode;
  children?: ReactNode;
}) {
  return (
    <ol className="playground">
      <Step
        n={1}
        title="Connect"
        done={connected}
        code={connectCode}
        text={
          <>
            <p>
              A Minca app has no accounts and no database. People bring their own: their account lives in
              their <strong>account home</strong>, and their data in <strong>spaces</strong> they share with
              others.
            </p>
            <p>
              Connecting opens the home. The person sees your app’s name and what it asks for, and picks which
              spaces to give it. Your app gets a key of its own, allowed into those spaces and nowhere else.
              It never sees the person’s keys.
            </p>
            <p>
              <code>create</code> asks the home to make a space just for this app, so there’s somewhere to
              start. Here it’s called <em>{PLAYGROUND_SPACE}</em>: a test space only you are in.
            </p>
          </>
        }
      >
        {connect}
      </Step>
      {children ?? (
        <>
          <Locked n={2} title="Pick a space" />
          <Locked n={3} title="Add a standard collection" />
          <Locked n={4} title="Write and read records" />
          <Locked n={5} title="Give it a screen" />
        </>
      )}
    </ol>
  );
}

function ConnectPanel() {
  const { connection, state } = useConnection();
  if (state.status === 'ready') {
    return (
      <div className="try">
        <p className="ok">
          <Check size={16} /> Connected as <strong>{state.grant?.name ?? 'you'}</strong>
        </p>
        <button type="button" className="button-quiet" onClick={() => void connection.disconnect()}>
          Disconnect
        </button>
      </div>
    );
  }
  return (
    <div className="try">
      <button
        type="button"
        className="button-primary"
        disabled={state.status === 'starting' || state.status === 'connecting'}
        onClick={() => void connection.connect()}
      >
        {state.status === 'connecting'
          ? 'Waiting for your home…'
          : state.status === 'expired'
            ? 'Connect again'
            : 'Connect with Minca'}
      </button>
      <small>
        Opens {new URL(HOME).host}. No account yet? You can make one there in a minute.
        {state.error ? <span className="problem"> {state.error}</span> : null}
      </small>
    </div>
  );
}

/** Steps 2 to 5: they need the node. */
function InSpaces() {
  const { spaces, loading } = useSpaces();
  const [chosen, setChosen] = useState<string | null>(null);
  const space = spaces.find((s) => s.id === chosen) ?? null;

  return (
    <>
      <Step
        n={2}
        title="Pick a space"
        done={space !== null}
        code={spacesCode}
        text={
          <>
            <p>
              Everything your app keeps lives in a space: a shared folder of signed records that syncs between
              everyone in it. <code>useSpaces</code> lists the ones the person gave you.
            </p>
            <p>
              Pick <em>{PLAYGROUND_SPACE}</em>, the one made for you as you connected, or any other you gave
              the playground.
            </p>
          </>
        }
      >
        <div className="try">
          {loading && spaces.length === 0 ? <small>Looking for your spaces…</small> : null}
          {!loading && spaces.length === 0 ? (
            <small>No spaces yet. Your new one may take a moment to arrive.</small>
          ) : null}
          <div className="choices">
            {spaces.map((s) => (
              <button
                key={s.id}
                type="button"
                className="choice"
                aria-pressed={s.id === chosen}
                onClick={() => setChosen(s.id)}
              >
                {s.name}
                <small>{s.writable ? s.visibility : 'read only'}</small>
              </button>
            ))}
          </div>
        </div>
      </Step>
      {space ? (
        <InSpace key={space.id} space={space.id} name={space.name} />
      ) : (
        <>
          <Locked n={3} title="Add a standard collection" />
          <Locked n={4} title="Write and read records" />
          <Locked n={5} title="Give it a screen" />
        </>
      )}
    </>
  );
}

const ITEM = listItem.name;

/** Steps 3 to 5, in the chosen space. */
function InSpace({ space, name }: { space: string; name: string }) {
  const node = useNode();
  const [collections, setCollections] = useState<ReadonlyArray<NodeCollection> | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [onScreen, setOnScreen] = useState(false);

  const look = useCallback(() => node.collections.list(space).then(setCollections), [node, space]);
  useEffect(() => {
    void look();
    // A definition arriving from another device counts too.
    return node.subscribe((event) => {
      if (event.type === 'records' && event.space === space) void look();
    });
  }, [node, space, look]);

  const defined = collections?.some((c) => c.name === ITEM && c.schema !== null) ?? false;
  const add = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await addSchemas(node, space, [listItem]);
      await look();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const own = (collections ?? []).filter((c) => !c.name.startsWith('sys.'));

  return (
    <>
      <Step
        n={3}
        title="Add a standard collection"
        done={defined}
        code={collectionsCode}
        definition={{ title: `What ${ITEM} is`, code: definitionCode }}
        text={
          <>
            <p>
              Records live in <strong>collections</strong>, like rows in a table. A collection’s definition,
              its schema and rules, is stored in the space itself, so every app that opens the space knows
              what its records are, and every device checks them.
            </p>
            <p>
              The <strong>standard library</strong> has collections for what most apps keep: messages, events,
              tasks, files. Use one, and other apps read your records and you read theirs. Here we add{' '}
              <code>{ITEM}</code>: one thing on a list.
            </p>
            <p>
              A standard collection is nothing special: a name and a schema, like one of your own. Write the
              schema in Zod or any Standard Schema library; the space stores it as plain JSON Schema.
            </p>
          </>
        }
      >
        <div className="try">
          {defined ? (
            <p className="ok">
              <Check size={16} /> {name} knows <code>{ITEM}</code>
            </p>
          ) : (
            <button
              type="button"
              className="button-primary"
              disabled={busy || !collections}
              onClick={() => void add()}
            >
              {busy ? 'Adding…' : `Add ${ITEM} to ${name}`}
            </button>
          )}
          {problem ? <small className="problem">{problem}</small> : null}
          {own.length ? (
            <div className="collections">
              <small>In {name} now</small>
              <ul>
                {own.map((c) => (
                  <li key={c.name}>
                    <code>{c.name}</code>
                    {c.title ? <span>{c.title}</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </Step>
      {defined ? (
        <>
          <Step
            n={4}
            title="Write and read records"
            done={onScreen}
            code={recordsCode}
            text={
              <>
                <p>
                  <code>records.put</code> writes a record. It’s signed by the person through your app’s key,
                  checked against the collection’s schema, and synced to everyone in the space.
                </p>
                <p>
                  <code>useQuery</code> reads them, and runs again whenever they change: here, or on someone
                  else’s device. Add a few things, and tick one.
                </p>
              </>
            }
          >
            <ListDemo space={space} />
            {!onScreen ? (
              <button type="button" className="button-quiet next" onClick={() => setOnScreen(true)}>
                Next: give it a screen
              </button>
            ) : null}
          </Step>
          {onScreen ? <ScreenStep space={space} /> : <Locked n={5} title="Give it a screen" />}
        </>
      ) : (
        <>
          <Locked n={4} title="Write and read records" />
          <Locked n={5} title="Give it a screen" />
        </>
      )}
    </>
  );
}

/** Step 4's list, in React: what the code beside it does. */
function ListDemo({ space }: { space: string }) {
  const node = useNode();
  const { name } = useAccount();
  const { result, error } = useQuery(space, { collection: listItem, sort: { '@createdAt': 'asc' } });
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const add = (event: FormEvent) => {
    event.preventDefault();
    const value = text.trim();
    if (!value) return;
    setText('');
    node.records.put(space, listItem, { text: value }).catch((e: unknown) => setProblem(String(e)));
  };
  const items = result?.records ?? [];

  return (
    <div className="try">
      <ul className="items">
        {items.map((item) => (
          <li key={item.key}>
            <label>
              <input
                type="checkbox"
                checked={item.body.checked === true}
                onChange={() =>
                  void node.records
                    .update(space, item.key, { ...item.body, checked: item.body.checked !== true })
                    .catch((e: unknown) => setProblem(String(e)))
                }
              />
              <span>{item.body.text ?? '(no text)'}</span>
            </label>
            <small>{item.createdBy === node.did ? name : 'someone else'}</small>
          </li>
        ))}
      </ul>
      <form onSubmit={add} className="add">
        <input
          value={text}
          onChange={(e) => setText(e.currentTarget.value)}
          placeholder="Add something, like “Buy milk”"
          aria-label="Add something"
          maxLength={1000}
        />
        <button type="submit" className="button-primary" disabled={!text.trim()}>
          Add
        </button>
      </form>
      {problem || error ? <small className="problem">{problem ?? String(error)}</small> : null}
    </div>
  );
}

/** Step 5: the same records, drawn by a screen of plain HTML, run sealed. */
function ScreenStep({ space }: { space: string }) {
  const [draft, setDraft] = useState(screenCode);
  const [running, setRunning] = useState(screenCode);
  return (
    <Step
      n={5}
      title="Give it a screen"
      done={false}
      text={
        <>
          <p>
            An app doesn’t have to be a site of its own. In the Minca app, a space’s apps are{' '}
            <strong>screens</strong>: one small HTML document each, kept in the space and run in a sealed
            frame. It has no network and no storage. All it has is <code>minca</code>, to read and write its
            collections as the person looking, and <code>ui</code>, a kit with Minca’s look and hooks that
            keep records current.
          </p>
          <p>
            This one draws the list from step 4. Add something here, and it shows up there too: they read the
            same records. Edit the code and run it again.
          </p>
        </>
      }
    >
      <div className="screen-step">
        <div className="editor">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.currentTarget.value)}
            spellCheck={false}
            aria-label="The screen’s HTML"
          />
          <div className="editor-bar">
            <small>HTML, run sealed</small>
            <button
              type="button"
              className="button-primary"
              disabled={draft === running}
              onClick={() => setRunning(draft)}
            >
              Run
            </button>
          </div>
        </div>
        <div className="window">
          <div className="window-bar" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <ScreenRun space={space} collections={[ITEM]} screen={running} />
        </div>
      </div>
    </Step>
  );
}

function Step({
  n,
  title,
  text,
  code,
  definition,
  done,
  children,
}: {
  n: number;
  title: string;
  text: ReactNode;
  code?: string;
  /** A definition to show under the code */
  definition?: { title: string; code: string };
  done: boolean;
  children: ReactNode;
}) {
  return (
    <li className="step" data-done={done || undefined} data-wide={code ? undefined : true}>
      <div className="step-text">
        <h2>
          <span className="step-n">{done ? <Check size={18} /> : n}</span>
          {title}
        </h2>
        {text}
        {children}
      </div>
      {code ? (
        <div className="step-code">
          <DynamicCodeBlock lang="tsx" code={code} />
          {definition ? (
            <>
              <h3>{definition.title}</h3>
              <DynamicCodeBlock lang="ts" code={definition.code} />
            </>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function Locked({ n, title }: { n: number; title: string }) {
  return (
    <li className="step" data-locked>
      <h2>
        <span className="step-n">{n}</span>
        {title}
      </h2>
    </li>
  );
}
