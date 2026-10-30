import { useEffect, useRef, useState } from 'react';
import { COLLECTION_DEFINE, type SpaceHostingView } from '@minca/core';
import { useCollections, useLive, useNode } from '@minca/react';
import {
  askToConnect,
  askToDisconnect,
  connect,
  connectPage,
  connector,
  BOT_INSTRUCTIONS_MAX,
  botSettings,
  INSTRUCT,
  mayConfigure,
  type BotSettings,
  type Connector,
} from '@minca/core/schemas';
import { useMay } from './may';
import { useAction } from './action';
import { styles, palette, hstack, stack } from './styles';
import { popupFeatures } from '@minca/core/session';

/**
 * A hosted bot's connectors: the services its host offers, each connected
 * through the host's page and the service's own consent screen
 * (packages/core/docs/bots.md). What it shows is the bot's own word, its
 * `std.connector`; who may connect it is the host's check, so the buttons only
 * hide where they would surely be refused.
 */
export function BotConnectors({
  spaceId,
  bot,
  host,
  writable,
}: {
  spaceId: string;
  bot: string;
  host: SpaceHostingView;
  writable: boolean;
}) {
  const node = useNode();
  const collections = useCollections(spaceId);
  const instructs = useMay(spaceId, INSTRUCT) && writable;
  const defines = useMay(spaceId, COLLECTION_DEFINE, { collection: connect.name });
  const { run, busy, error } = useAction();
  const popup = useRef<Window | null>(null);
  const defined = (name: string) => collections.some((c) => c.name === name && c.version !== null);

  // Only the bot's own records say what it is connected to: by service.
  const said = useLive(
    spaceId,
    async (n) => {
      const found = new Map<string, Connector>();
      if (!defined(connector.name)) return found;
      for (const r of await n.records.list<Connector>(spaceId, { collection: connector.name }))
        if (r.root === bot && r.createdBy === bot && r.verified && r.body) found.set(r.body.kind, r.body);
      return found;
    },
    [bot, collections.length],
  );

  // The host's page says when it is done; the record follows by sync, so nothing more to do but stop waiting.
  useEffect(() => {
    const origin = new URL(host.url).origin;
    const heard = (event: MessageEvent) => {
      if (event.origin === origin && event.source === popup.current) popup.current = null;
    };
    globalThis.addEventListener('message', heard);
    return () => globalThis.removeEventListener('message', heard);
  }, [host.url]);

  if (!host.connectors.length) return null;

  const ready = async () => {
    for (const definition of [connect, connector])
      if (!defined(definition.name)) {
        if (!defines) throw new Error('Someone who may add collections must turn connectors on here first.');
        await node.collections.define(spaceId, definition);
      }
  };

  const connectTo = (kind: string) => {
    // Opened now, in the click, or the browser blocks it; it goes to the host once the request is written.
    const opened = globalThis.open('about:blank', 'minca-connect', popupFeatures(760, 820));
    popup.current = opened;
    void run(async () => {
      try {
        await ready();
        const page = connectPage(host.url, await askToConnect(node, spaceId, bot, kind));
        if (opened) opened.location.href = page;
        else globalThis.location.assign(page);
      } catch (e) {
        opened?.close();
        throw e;
      }
    });
  };
  const disconnect = (kind: string) =>
    void run(async () => {
      await ready();
      await askToDisconnect(host.url, await askToConnect(node, spaceId, bot, kind, { disconnect: true }));
    });

  return (
    <div style={{ ...stack(4), padding: '0 14px 10px 54px' }}>
      {host.connectors.map(({ id, name }) => {
        const connected = said?.get(id);
        return (
          <div key={id} style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            <span style={{ flex: 1, minWidth: 0, fontSize: 13, color: palette.ink.muted }}>
              {connected ? (
                <>
                  {name} · <strong style={{ color: palette.ink.body }}>{connected.account}</strong>
                  {connected.reaches?.length ? ` · ${connected.reaches.join(', ')}` : ''}
                </>
              ) : (
                `Not connected to ${name}`
              )}
            </span>
            {instructs && (
              <button
                onClick={() => (connected ? disconnect(id) : connectTo(id))}
                disabled={busy}
                data-variant="quiet"
                style={styles.smallButton}
              >
                {connected ? 'Disconnect' : `Connect ${name}`}
              </button>
            )}
          </div>
        );
      })}
      {instructs && (
        <p style={styles.faint}>
          Anyone here who can set the bot off can ask about what it reaches, and set off what your automations
          do there. {host.name} keeps what reaches each service.
        </p>
      )}
      {error && <p style={{ ...styles.error, fontSize: 12 }}>{error}</p>}
    </div>
  );
}

/**
 * A bot's instructions: how its community wants it to be. Each person who may
 * configure it keeps their own `std.bot`; the bot follows the newest of those,
 * so this shows and edits that one.
 */
export function BotInstructions({
  spaceId,
  bot,
  writable,
}: {
  spaceId: string;
  bot: string;
  writable: boolean;
}) {
  const node = useNode();
  const collections = useCollections(spaceId);
  const instructs = useMay(spaceId, INSTRUCT) && writable;
  const defines = useMay(spaceId, COLLECTION_DEFINE, { collection: botSettings.name });
  const defined = collections.some((c) => c.name === botSettings.name && c.version !== null);
  const { run, busy, error } = useAction();
  const [draft, setDraft] = useState<string | null>(null);
  const newest = useLive(
    spaceId,
    async (n) => {
      if (!defined) return null;
      const records = await n.records.list<BotSettings>(spaceId, { collection: botSettings.name });
      // The ones the bot follows: the newest from someone who may configure it, as the bot picks them.
      const candidates = records
        .filter((r) => r.verified && !r.deleted && !r.recordsOnly && r.root && r.body?.bot === bot)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      for (const record of candidates)
        if (record.root && (await mayConfigure(n, spaceId, bot, record.root)))
          return record.body?.instructions ?? null;
      return null;
    },
    [bot, defined],
  );
  if (!instructs && !newest) return null;

  const save = (text: string) =>
    void run(async () => {
      if (!defined) {
        if (!defines)
          throw new Error('Someone who may add collections must turn bot instructions on here first.');
        await node.collections.define(spaceId, botSettings);
      }
      await node.records.put(spaceId, botSettings, {
        bot,
        instructions: text.slice(0, BOT_INSTRUCTIONS_MAX),
      });
      setDraft(null);
    });

  return (
    <div style={{ ...stack(6), padding: '0 14px 10px 54px' }}>
      {draft === null ? (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <p
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 13,
              color: newest ? palette.ink.body : palette.ink.muted,
            }}
          >
            {newest ?? 'No instructions: it goes by its name and its own rules.'}
          </p>
          {instructs && (
            <button onClick={() => setDraft(newest ?? '')} data-variant="quiet" style={styles.smallButton}>
              {newest ? 'Edit' : 'Add instructions'}
            </button>
          )}
        </div>
      ) : (
        <>
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            maxLength={BOT_INSTRUCTIONS_MAX}
            rows={4}
            placeholder="You are Ferris, the team’s helper. Answer briefly, and link issues as #N."
            style={{ ...styles.input, resize: 'vertical' }}
          />
          <div style={{ ...hstack(8), justifyContent: 'flex-end' }}>
            <button onClick={() => setDraft(null)} data-variant="quiet" style={styles.smallButton}>
              Cancel
            </button>
            <button onClick={() => save(draft)} disabled={busy || !draft.trim()} style={styles.smallButton}>
              Save
            </button>
          </div>
          <p style={styles.faint}>
            Everyone here can read these. The bot follows them after its own rules, which they can’t change.
          </p>
        </>
      )}
      {error && <p style={{ ...styles.error, fontSize: 12 }}>{error}</p>}
    </div>
  );
}
