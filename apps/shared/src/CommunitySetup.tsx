import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { COLLECTION_DEFINE, SPACE_KEEPERS, type SpaceHostingView } from '@minca/core';
import { useCollections, useNode } from '@minca/core/react';
import { useAssignable, useMay } from './may';
import { activity, INSTRUCT, profile } from '@minca/core/schemas';
import { Modal } from './Modal';
import { Benefit, FeatureIcon, Glyph, StatusPill } from './Feature';
import { KeepOnline, onlineHost, useSpaceHosts } from './SpaceHosting';
import { BotConnectors, BotInstructions } from './BotConnectors';
import { message, useAction, useCopy } from './action';
import { styles, palette } from './styles';

/** Where running a bot on a server is explained */
const SERVER_GUIDE =
  'https://github.com/leifriksheim/minca/blob/main/packages/cli/README.md#always-on-on-a-server';
/** How the CLI is run where this app is built, from the connect command (`VITE_MINCA_CONNECT`) */
const CLI = (import.meta.env.VITE_MINCA_CONNECT ?? 'npx @minca/cli connect').replace(/\s+connect$/, '');

/**
 * Adding a bot, hosting first: a bot runs where the community is kept online,
 * from the same fund, so a community without one adds to the fund here. Then
 * its name and role; then what to tell it to do.
 */
export function AddBotDialog({
  spaceId,
  writable,
  cli = CLI,
  running = [],
  onAutomations,
  onClose,
}: {
  spaceId: string;
  writable: boolean;
  cli?: string;
  /** Names of the bots already there: the dialog then opens on what to tell them */
  running?: ReadonlyArray<string>;
  onAutomations?: (() => void) | undefined;
  onClose: () => void;
}) {
  const node = useNode();
  const collections = useCollections(spaceId);
  const { hosts, look } = useSpaceHosts(spaceId, writable);
  const host = onlineHost(hosts);
  const profiles = collections.some((c) => c.name === profile.name && c.version !== null);
  const mayDefine = useMay(spaceId, COLLECTION_DEFINE, { collection: profile.name });
  // The roles one may give and holds every grant of, `member` first: a bot does what members
  // ask, so it holds no more than whoever adds it, and needs no more than it must.
  // A bot never gets the grant to instruct bots: no integration reprograms another.
  const roles = useAssignable(spaceId, { held: true, without: INSTRUCT });
  const [role, setRole] = useState<string | null>(null);
  const [name, setName] = useState('');
  const { run, busy, error: problem, setError: setProblem } = useAction();
  const [started, setStarted] = useState<{ bot: string; name: string } | null>(null);
  const [chosenView, setView] = useState<'add' | 'done' | 'yourself'>(running.length ? 'done' : 'add');
  const chosen = role ?? roles[0]?.name ?? null;
  const called = name.trim() || 'Club Bot';
  // Until the community is kept online, adding to its fund comes first.
  const view = hosts === null ? 'wait' : !host && chosenView === 'add' ? 'fund' : chosenView;
  const cap = host?.fund?.botDailyCap;

  const add = () =>
    run(async () => {
      if (!host) return;
      // Profiles first: a bot says on its own that it is one, which is how "Done by" finds it;
      // and activity, where it says what it is working on, for apps to show.
      for (const definition of [profile, activity])
        if (mayDefine && !collections.some((c) => c.name === definition.name && c.version !== null))
          await node.collections.define(spaceId, definition).catch(() => {});
      const { bot } = await node.hosting.startBot(spaceId, host.url, {
        name: called,
        ...(chosen ? { role: chosen } : {}),
      });
      setStarted({ bot, name: called });
      setView('done');
    });

  return (
    <Modal title="Add an AI helper" onClose={onClose} width={460}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
          <FeatureIcon kind="bot" size={44} />
          <div>
            <p style={{ fontSize: 16, fontWeight: 600, color: palette.ink.strong }}>
              {started ? started.name : called}
            </p>
            <p style={{ fontSize: 13, color: palette.ink.muted }}>
              {view === 'fund'
                ? 'Runs from the community fund'
                : host
                  ? `Runs at ${host.name}${host.fund ? `, from the community fund` : ', at no cost'}`
                  : 'Runs where the community is kept online'}
            </p>
          </div>
        </div>

        {view === 'fund' && (
          <>
            <p style={{ fontSize: 14, color: palette.ink.body, lineHeight: 1.5 }}>
              One fund keeps the community online and runs its bots. Add to it to start; anyone in the
              community can top it up.
            </p>
            <KeepOnline spaceId={spaceId} writable={writable} onClose={look} hero={false} />
          </>
        )}

        {view === 'add' && host && (
          <>
            <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 10 }}>
              <Benefit glyph="chat">Answers when someone mentions it</Benefit>
              <Benefit glyph="clock">Posts summaries and reminders on a schedule</Benefit>
              <Benefit glyph="shield">Holds a role like any member, and can do only what it allows</Benefit>
            </ul>
            <div style={{ display: 'flex', gap: 10 }}>
              <label style={{ ...field, flex: 1 }}>
                Name
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Club Bot"
                  style={styles.input}
                />
              </label>
              {roles.length > 0 && (
                <label style={field}>
                  Role
                  <select
                    value={chosen ?? ''}
                    onChange={(event) => setRole(event.target.value)}
                    style={{ ...styles.input, width: 'auto' }}
                  >
                    {roles.map((known) => (
                      <option key={known.name} value={known.name}>
                        {known.title ?? known.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            <button onClick={() => void add()} disabled={busy} data-variant="primary" style={styles.button}>
              {busy ? 'Adding…' : `Add ${called}`}
            </button>
            {problem && <p style={{ fontSize: 13, color: palette.accent.danger }}>{problem}</p>}
            <p style={{ display: 'flex', gap: 8, fontSize: 12, color: palette.ink.faint, lineHeight: 1.5 }}>
              <Glyph name="lock" size={12} style={{ marginTop: 2 }} />
              {host.fund
                ? `Its AI use comes from the community fund, up to $${cap ?? '1'} a day and usually far less. `
                : ''}
              {host.name} runs the bot's account, so it can read what the bot can read
              {host.connectors.length
                ? `, and act for your community in the services you connect it to (${host.connectors.map((one) => one.name).join(', ')}).`
                : '.'}
            </p>
            <button
              onClick={() => setView('yourself')}
              style={{ ...styles.linkButton, alignSelf: 'center', fontSize: 12 }}
            >
              Run it on your own computer instead
            </button>
          </>
        )}

        {view === 'done' && (
          <>
            <p style={{ fontSize: 14, color: palette.ink.body, lineHeight: 1.5 }}>
              {started
                ? `${started.name} is in the community.`
                : `${running.join(', ')} ${running.length === 1 ? 'is' : 'are'} on.`}{' '}
              Tell it what to do in Automations: answer when mentioned, sum up the week every Friday.
            </p>
            {!profiles && (
              <div
                style={{
                  padding: 12,
                  borderRadius: palette.radius.lg,
                  background: palette.surface.sunken,
                  fontSize: 13,
                  color: palette.ink.muted,
                  lineHeight: 1.5,
                }}
              >
                This community keeps no profiles yet, so nobody can see it's a bot or pick it under "Done by".{' '}
                {mayDefine ? (
                  <button
                    onClick={() =>
                      void node.collections
                        .define(spaceId, profile)
                        .catch((error: unknown) => setProblem(message(error)))
                    }
                    style={{ ...styles.linkButton, padding: 0, color: palette.ink.strong }}
                  >
                    Turn on profiles
                  </button>
                ) : (
                  'Someone who may add collections can turn them on.'
                )}
              </div>
            )}
            {onAutomations ? (
              <button onClick={onAutomations} data-variant="primary" style={styles.button}>
                Open Automations
              </button>
            ) : (
              <button onClick={onClose} data-variant="primary" style={styles.button}>
                Done
              </button>
            )}
            <button
              onClick={() => setView('add')}
              style={{ ...styles.linkButton, alignSelf: 'center', fontSize: 12 }}
            >
              Add another bot
            </button>
          </>
        )}

        {view === 'yourself' && (
          <>
            <RunItYourself spaceId={spaceId} cli={cli} name={called} role={chosen} />
            <button
              onClick={() => setView('add')}
              style={{ ...styles.linkButton, alignSelf: 'center', fontSize: 12 }}
            >
              Let the community's host run it instead
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}

/** For those who run the bot themselves: an invite for its role, and the command that joins with it */
function RunItYourself({
  spaceId,
  cli,
  name,
  role,
}: {
  spaceId: string;
  cli: string;
  name: string;
  role: string | null;
}) {
  const node = useNode();
  const [invite, setInvite] = useState<string | null>(null);
  const { run, error: problem } = useAction();
  // Single quotes around what the person typed: nothing in it is read by the shell.
  const quoted = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;
  const make = () => run(async () => setInvite(await node.spaces.invite(spaceId, role ? { role } : {})));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <p style={{ fontSize: 13, color: palette.ink.muted, lineHeight: 1.5 }}>
        Run {name} on your own computer or server, with your own AI key. It works while it runs; to keep it
        on,{' '}
        <a
          href={SERVER_GUIDE}
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: palette.ink.strong }}
        >
          run it on a server
        </a>
        .
      </p>
      {invite ? (
        <>
          <Copyable text={`${cli} agent --bot --name ${quoted(name)} --invite ${quoted(invite)}`} secret />
          <p style={{ fontSize: 12, color: palette.ink.faint, lineHeight: 1.5 }}>
            Paste it into a terminal. It asks for a password for the bot and an AI key, then joins. Keep it to
            yourself: whoever has it can join as the bot.
          </p>
        </>
      ) : (
        <button
          onClick={() => void make()}
          data-variant="quiet"
          style={{ ...styles.smallButton, alignSelf: 'flex-start' }}
        >
          Make the command
        </button>
      )}
      {problem && <p style={{ fontSize: 13, color: palette.accent.danger }}>{problem}</p>}
    </div>
  );
}

/** A line to copy, in full or, for a secret, shortened on screen */
function Copyable({ text, secret = false }: { text: string; secret?: boolean }) {
  const { copied, copy } = useCopy();
  return (
    <div
      style={{
        display: 'flex',
        gap: 8,
        alignItems: 'center',
        padding: '6px 6px 6px 10px',
        borderRadius: palette.radius.lg,
        border: `1px solid ${palette.surface.line}`,
        background: palette.surface.sunken,
      }}
    >
      <code
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 12.5,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: secret ? 'nowrap' : 'normal',
          overflowWrap: 'anywhere',
          color: palette.ink.strong,
        }}
      >
        {text}
      </code>
      <button
        data-variant="quiet"
        style={{ ...styles.smallButton, flexShrink: 0 }}
        onClick={() => copy(text)}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

/** The community's AI helpers, each with how it stands, and Add a bot for those who may manage the space */
export function SpaceBots({
  spaceId,
  writable,
  cli = CLI,
  onAutomations,
}: {
  spaceId: string;
  writable: boolean;
  cli?: string;
  onAutomations?: () => void;
}) {
  const { bots: listed, look, lookBots } = useSpaceBots(spaceId, writable);
  const [adding, setAdding] = useState(false);
  const mayManage = useMay(spaceId, SPACE_KEEPERS) && writable;
  if (!listed.length && !mayManage) return null;
  return (
    <section aria-label="AI helpers" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <h3 style={styles.sectionTitle}>AI helpers</h3>
        {mayManage && (
          <button onClick={() => setAdding(true)} data-variant="quiet" style={styles.smallButton}>
            Add a bot
          </button>
        )}
      </div>
      {listed.length === 0 ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            padding: 14,
            borderRadius: palette.radius.lg,
            border: `1px dashed ${palette.surface.lineStrong}`,
          }}
        >
          <FeatureIcon kind="bot" size={36} />
          <p style={{ fontSize: 13, color: palette.ink.muted, lineHeight: 1.45 }}>
            A bot answers when mentioned, sums up long threads and posts reminders. It holds a role like any
            member.
          </p>
        </div>
      ) : (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            borderRadius: palette.radius.lg,
            border: `1px solid ${palette.surface.line}`,
          }}
        >
          {listed.map((bot, i) => (
            <div key={bot.did} style={{ borderTop: i ? `1px solid ${palette.surface.line}` : 'none' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px' }}>
                <FeatureIcon kind="bot" size={28} />
                <strong style={{ flex: 1, fontSize: 14, color: palette.ink.strong }}>{bot.name}</strong>
                {bot.state === 'on' ? (
                  <StatusPill tone="good">Running</StatusPill>
                ) : bot.state === 'waiting' ? (
                  <StatusPill tone="warn">Fund empty</StatusPill>
                ) : (
                  <StatusPill tone="neutral">Run by a member</StatusPill>
                )}
              </div>
              <BotInstructions spaceId={spaceId} bot={bot.did} writable={writable} />
              {bot.host && (
                <BotConnectors spaceId={spaceId} bot={bot.did} host={bot.host} writable={writable} />
              )}
            </div>
          ))}
        </div>
      )}
      {adding && (
        <AddBotDialog
          spaceId={spaceId}
          writable={writable}
          cli={cli}
          {...(onAutomations
            ? {
                onAutomations: () => {
                  setAdding(false);
                  onAutomations();
                },
              }
            : {})}
          onClose={() => {
            setAdding(false);
            look();
            lookBots();
          }}
        />
      )}
    </section>
  );
}

/**
 * A space's bots: those its host runs, as the host's signed status names
 * them (`on`, or `waiting` for the fund), and those run elsewhere that say
 * so on their own profile (`own`).
 */
export function useSpaceBots(spaceId: string, writable: boolean) {
  const node = useNode();
  const { hosts, look } = useSpaceHosts(spaceId, writable);
  const [own, setOwn] = useState<ReadonlyArray<{ did: string; name: string }>>([]);
  const lookBots = useCallback(() => {
    void botsIn(node, spaceId).then(setOwn, () => setOwn([]));
  }, [node, spaceId]);
  useEffect(() => lookBots(), [lookBots]);
  const hosted = hosts?.flatMap((host) => host.bots.map((bot) => ({ ...bot, host }))) ?? [];
  const bots: ReadonlyArray<{
    did: string;
    name: string;
    state: 'on' | 'waiting' | 'own';
    /** The host that runs it, for a hosted bot */
    host?: SpaceHostingView;
  }> = [
    ...hosted.map((bot) => ({
      did: bot.bot,
      name: bot.name,
      state: bot.running ? ('on' as const) : ('waiting' as const),
      host: bot.host,
    })),
    ...own
      .filter((bot) => !hosted.some((h) => h.bot === bot.did))
      .map((bot) => ({ ...bot, state: 'own' as const })),
  ];
  return { hosts, bots, look, lookBots };
}

/** The bots holding a role in a space: members whose own profile there says `bot: true` */
async function botsIn(
  node: ReturnType<typeof useNode>,
  spaceId: string,
): Promise<ReadonlyArray<{ did: string; name: string }>> {
  const collections = await node.collections.list(spaceId);
  if (!collections.some((c) => c.name === profile.name && c.version !== null)) return [];
  const members = new Set((await node.spaces.access(spaceId)).members.map((member) => member.did));
  const names = new Map((await node.spaces.profiles(spaceId)).map((known) => [known.did, known.name]));
  const profiles = await node.records.list<{ bot?: unknown }>(spaceId, { collection: profile.name });
  return profiles.flatMap((record) =>
    !record.deleted &&
    record.body?.bot === true &&
    // Their own word: only a profile its own account wrote says it is a bot.
    record.root === record.createdBy &&
    record.root &&
    members.has(record.root)
      ? [{ did: record.root, name: names.get(record.root) ?? 'A bot' }]
      : [],
  );
}

const field: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  fontSize: 12.5,
  color: palette.ink.muted,
};
