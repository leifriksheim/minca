import { useCallback, useEffect, useState } from 'react';
import { COLLECTION_DEFINE, SPACE_KEEPERS, type SpaceHostingView } from '@minca/core';
import { useCollections, useNode } from '@minca/react';
import { useAssignable, useMay } from './may';
import { activity, INSTRUCT } from '@minca/core/schemas';
import { profile } from '@minca/std';
import { Modal } from './Modal';
import { Icon } from './Icon';
import { Benefit, FeatureIcon, StatusPill } from './Feature';
import { KeepOnline, onlineHost, useSpaceHosts } from './SpaceHosting';
import { BotConnectors, BotInstructions } from './BotConnectors';
import { message, useAction } from './action';
import { perReply } from './Payment';
import { Terminal } from './Terminal';

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
  onAutomations,
  onClose,
}: {
  spaceId: string;
  writable: boolean;
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
  const [chosenView, setView] = useState<'add' | 'done' | 'yourself'>('add');
  const chosen = role ?? roles[0]?.name ?? null;
  const called = name.trim() || 'Club Bot';
  // Until the community is kept online, adding to its fund comes first.
  const view = hosts === null ? 'wait' : !host && chosenView === 'add' ? 'fund' : chosenView;
  const cap = host?.fund?.botDailyCap;
  const model = host?.fund?.lines?.find((one) => one.for === 'bots');

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
      <div className="stack" data-gap="loose">
        <div className="row" data-gap="loose">
          <FeatureIcon kind="bot" size={44} />
          <div>
            <h3>{started ? started.name : called}</h3>
            <small>
              {view === 'fund'
                ? 'Runs from the community fund'
                : host
                  ? `Runs at ${host.name}${host.fund ? `, from the community fund` : ', at no cost'}`
                  : 'Runs where the community is kept online'}
            </small>
          </div>
        </div>

        {view === 'fund' && (
          <>
            <p>
              One fund keeps the community online and runs its bots. Add to it to start; anyone in the
              community can top it up.
            </p>
            <KeepOnline spaceId={spaceId} writable={writable} onClose={look} hero={false} adding={called} />
          </>
        )}

        {view === 'add' && host && (
          <>
            <ul role="list">
              <Benefit glyph="chat">Answers when someone mentions it</Benefit>
              <Benefit glyph="clock">Posts summaries and reminders on a schedule</Benefit>
              <Benefit glyph="shield">Holds a role like any member, and can do only what it allows</Benefit>
            </ul>
            <div className="stack">
              <label>
                Name
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Club Bot"
                />
              </label>
              {roles.length > 0 && (
                <label>
                  Role
                  <select value={chosen ?? ''} onChange={(event) => setRole(event.target.value)}>
                    {roles.map((known) => (
                      <option key={known.name} value={known.name}>
                        {known.title ?? known.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            <button onClick={() => void add()} disabled={busy} data-intent="primary">
              {busy ? 'Adding…' : `Add ${called}`}
            </button>
            {problem && <p role="alert">{problem}</p>}
            <small className="row" data-gap="tight">
              <Icon name="lock" size={12} />
              <p>
                {host.fund
                  ? `Its AI use comes from the community fund${model ? `: ${model.name}` : ''}${host.fund.botTypical ? `, ${perReply(host.fund.botTypical)}` : ''}, up to $${cap ?? '1'} a day. `
                  : ''}
                {host.name} runs the bot's account, so it can read what the bot can read
                {host.connectors.length
                  ? `, and act for your community in the services you connect it to (${host.connectors.map((one) => one.name).join(', ')}).`
                  : '.'}
              </p>
            </small>
            <button onClick={() => setView('yourself')} data-intent="ghost">
              Run it on your own computer instead
            </button>
          </>
        )}

        {view === 'done' && (
          <>
            <p>
              {started?.name ?? called} is in the community. Tell it what to do in Automations: answer when
              mentioned, sum up the week every Friday.
            </p>
            {!profiles && (
              <aside>
                This community keeps no profiles yet, so nobody can see it's a bot or pick it under "Done by".{' '}
                {mayDefine ? (
                  <button
                    onClick={() =>
                      void node.collections
                        .define(spaceId, profile)
                        .catch((error: unknown) => setProblem(message(error)))
                    }
                    data-intent="ghost"
                  >
                    Turn on profiles
                  </button>
                ) : (
                  'Someone who may add collections can turn them on.'
                )}
              </aside>
            )}
            {onAutomations ? (
              <button onClick={onAutomations} data-intent="primary">
                Open Automations
              </button>
            ) : (
              <button onClick={onClose} data-intent="primary">
                Done
              </button>
            )}
            <button onClick={() => setView('add')} data-intent="ghost">
              Add another bot
            </button>
          </>
        )}

        {view === 'yourself' && (
          <>
            <RunItYourself spaceId={spaceId} name={called} role={chosen} />
            <button onClick={() => setView('add')} data-intent="ghost">
              Let the community's host run it instead
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}

/** For those who run the bot themselves: an invite for its role, and the command that joins with it */
function RunItYourself({ spaceId, name, role }: { spaceId: string; name: string; role: string | null }) {
  const node = useNode();
  const [invite, setInvite] = useState<string | null>(null);
  const { run, error: problem } = useAction();
  // Single quotes around what the person typed: nothing in it is read by the shell.
  const quoted = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;
  const make = () =>
    run(async () =>
      setInvite(await node.spaces.invite(spaceId, role ? { role, short: true } : { short: true })),
    );
  return (
    <div className="stack">
      <p>
        Run {name} on your own computer or server, with your own AI key. It works while it runs; to keep it
        on,{' '}
        <a href={SERVER_GUIDE} target="_blank" rel="noopener noreferrer">
          run it on a server
        </a>
        .
      </p>
      {invite ? (
        <>
          <Terminal text={`${CLI} agent --bot --name ${quoted(name)} --invite ${quoted(invite)}`} />
          <small>
            Paste it into a terminal. It asks for a password for the bot and an AI key, then joins. Keep it to
            yourself: whoever has it can join as the bot.
          </small>
        </>
      ) : (
        <button onClick={() => void make()}>Make the command</button>
      )}
      {problem && <p role="alert">{problem}</p>}
    </div>
  );
}

/** The community's AI helpers, each with how it stands, and Add a bot for those who may manage the space */
export function SpaceBots({
  spaceId,
  writable,
  onAutomations,
}: {
  spaceId: string;
  writable: boolean;
  onAutomations?: () => void;
}) {
  const { bots: listed, look, lookBots } = useSpaceBots(spaceId, writable);
  const [adding, setAdding] = useState(false);
  const mayManage = useMay(spaceId, SPACE_KEEPERS) && writable;
  if (!listed.length && !mayManage) return null;
  return (
    <section aria-label="AI helpers" className="stack">
      <header>
        <h3>AI helpers</h3>
        {mayManage && <button onClick={() => setAdding(true)}>Add a bot</button>}
      </header>
      {listed.length === 0 ? (
        <aside className="row" data-gap="loose">
          <FeatureIcon kind="bot" size={36} />
          <p>
            <small>
              A bot answers when mentioned, sums up long threads and posts reminders. It holds a role like any
              member.
            </small>
          </p>
        </aside>
      ) : (
        <ul role="list">
          {listed.map((bot) => (
            <li key={bot.did} className="stack">
              <div className="row">
                <FeatureIcon kind="bot" size={28} />
                <strong className="truncate">{bot.name}</strong>
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
            </li>
          ))}
        </ul>
      )}
      {adding && (
        <AddBotDialog
          spaceId={spaceId}
          writable={writable}
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
