import { useCallback, useRef, useState } from 'react';
import type { SpaceSummary } from '@minca/core';
import {
  inviteFromLink,
  useAccess,
  useAccount,
  useConnection,
  useInviteLink,
  useMyName,
  useQuery,
  useSpaces,
} from '@minca/core/react';
import { Avatar } from '@minca/app-shared/Avatar';
import { Shape, shapeFor } from '@minca/app-shared/shapes';
import { Loader } from '@minca/app-shared/Loader';
import { useDismiss } from '@minca/app-shared/useDismiss';
import { delegation, proposal } from './schema';
import { AssemblyView } from './Assembly';
import { NewAssembly } from './NewAssembly';
import { Logo, Welcome } from './Welcome';
import { Problem, ago } from './ui';
import { palette } from './styles';

/** Which assembly was open, so a reload lands back in it */
const OPEN_KEY = 'liquid:open';
const remembered = (): string | null => {
  try {
    return globalThis.localStorage.getItem(OPEN_KEY);
  } catch {
    return null;
  }
};
const remember = (id: string | null) => {
  try {
    if (id) globalThis.localStorage.setItem(OPEN_KEY, id);
    else globalThis.localStorage.removeItem(OPEN_KEY);
  } catch {
    // Private windows may refuse storage; only the reload convenience is lost.
  }
};

export function App() {
  const { state } = useConnection();
  return state.status === 'ready' ? <Connected /> : <Welcome />;
}

/** Connected: the assemblies, or one of them */
function Connected() {
  // Only spaces that are assemblies: the account may hold many others.
  const assemblies = useSpaces({ having: [proposal, delegation] });
  const [open, setOpen] = useState<string | null>(remembered);
  // Just made or joined: its definitions may not have arrived, so wait for it rather than going home.
  const [pending, setPending] = useState<string | null>(null);
  const go = useCallback((id: string | null, fresh = false) => {
    remember(id);
    setOpen(id);
    setPending(fresh ? id : null);
  }, []);

  const space = open ? assemblies.spaces.find((s) => s.id === open) : undefined;
  if (space && pending === space.id && !space.joining) setPending(null);

  if (space) return <AssemblyView key={space.id} space={space} onBack={() => go(null)} />;
  if (open && (assemblies.loading || pending === open)) return <Opening onBack={() => go(null)} />;
  return <Home assemblies={assemblies} onOpen={go} />;
}

function Opening({ onBack }: { onBack: () => void }) {
  return (
    <div className="lq-shell">
      <main
        className="lq-main"
        style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, paddingTop: 120 }}
      >
        <Logo compact />
        <Loader label="Opening the assembly" showLabel />
        <p
          className="lq-faint"
          style={{ fontSize: 13, maxWidth: 360, textAlign: 'center', lineHeight: 1.55 }}
        >
          A new member gets the assembly from someone already in it, so this waits until one of them is
          online.
        </p>
        <button className="lq-btn" data-variant="ghost" onClick={onBack}>
          Back to your assemblies
        </button>
      </main>
    </div>
  );
}

function Home({
  assemblies,
  onOpen,
}: {
  assemblies: ReturnType<typeof useSpaces>;
  onOpen: (id: string, fresh?: boolean) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [link, setLink] = useState('');
  const { spaces, loading, error } = assemblies;

  const join = async (invite: string) => {
    const joined = await assemblies.join(inviteFromLink(invite));
    if (joined) onOpen(joined.id, true);
    return joined;
  };

  return (
    <div className="lq-shell">
      <header className="lq-header">
        <div className="lq-header-inner lq-bar">
          <Logo />
          <span style={{ flex: 1 }} />
          <AccountButton />
        </div>
      </header>
      <main className="lq-main" style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
        <InviteCard onJoin={join} />
        <div className="lq-rise">
          <h1 className="lq-display" style={{ fontSize: 34, lineHeight: 1.05 }}>
            Your assemblies
          </h1>
          <p className="lq-muted" style={{ fontSize: 14.5, marginTop: 4 }}>
            Each is a group that decides together: a club, a co-op, a neighbourhood, a team.
          </p>
        </div>

        <div className="lq-grid">
          {spaces.map((space) => (
            <Tile key={space.id} space={space} onOpen={() => onOpen(space.id, space.joining)} />
          ))}
          <button className="lq-card lq-tile lq-tile-new" onClick={() => setCreating(true)}>
            <span style={{ fontSize: 22, lineHeight: 1 }}>+</span>
            <span style={{ fontWeight: 500 }}>New assembly</span>
          </button>
        </div>
        {!loading && spaces.length === 0 && (
          <p className="lq-faint" style={{ fontSize: 13.5, marginTop: -12 }}>
            Start one for your group, or open an invite link someone sent you.
          </p>
        )}

        <form
          className="lq-card"
          style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}
          onSubmit={(event) => {
            event.preventDefault();
            if (link.trim()) void join(link).then((joined) => joined && setLink(''));
          }}
        >
          <p className="lq-section-title">Have an invite link?</p>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              className="lq-input"
              value={link}
              onChange={(event) => setLink(event.target.value)}
              placeholder="Paste it here"
              aria-label="Invite link"
              spellCheck={false}
            />
            <button className="lq-btn" data-variant="quiet" disabled={!link.trim()}>
              Join
            </button>
          </div>
        </form>
        <Problem>{error}</Problem>
      </main>
      {creating && (
        <NewAssembly
          onClose={() => setCreating(false)}
          create={(params) => assemblies.create(params)}
          onCreated={(id) => {
            setCreating(false);
            onOpen(id, true);
          }}
        />
      )}
    </div>
  );
}

/** An assembly on the home screen: how many are in it, and how many proposals are open */
function Tile({ space, onOpen }: { space: SpaceSummary; onOpen: () => void }) {
  const access = useAccess(space.id);
  const open = useQuery(space.id, { collection: proposal, where: { closed: { $ne: true } } }).result;
  const members = access?.members.length;
  return (
    <button className="lq-card lq-tile" data-interactive onClick={onOpen}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <Shape {...shapeFor(space.id)} size={44} />
        <span style={{ flex: 1 }} />
        {space.visibility === 'private' && (
          <span className="lq-chip" title="Only members can read it">
            Private
          </span>
        )}
      </div>
      <div style={{ marginTop: 'auto' }}>
        <p className="lq-display" style={{ fontSize: 19 }}>
          {space.name}
        </p>
        <p className="lq-muted lq-num" style={{ fontSize: 13, marginTop: 3 }}>
          {space.joining
            ? 'Joining…'
            : `${members ?? '–'} ${members === 1 ? 'member' : 'members'} · ${open?.records.length ?? '–'} open`}
          {!space.joining && <span className="lq-faint"> · since {ago(space.createdAt)}</span>}
        </p>
      </div>
    </button>
  );
}

/** Opened from an invite link: say what it is for, ask for a name, join */
function InviteCard({ onJoin }: { onJoin: (invite: string) => Promise<SpaceSummary | null> }) {
  const { invite, preview, problem, dismiss } = useInviteLink();
  const me = useMyName();
  const [busy, setBusy] = useState(false);
  if (!invite) return null;
  return (
    <div
      className="lq-card lq-rise"
      style={{
        padding: 20,
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
      }}
    >
      <div>
        <p className="lq-display" style={{ fontSize: 22 }}>
          {preview ? `You’re invited to ${preview.space.name}` : 'You’re invited'}
        </p>
        <p className="lq-muted" style={{ fontSize: 13.5, marginTop: 4 }}>
          {preview
            ? preview.carriesWrite
              ? `Join as ${preview.role ?? 'a member'}: vote, propose and delegate.`
              : 'This link lets you read along, not vote.'
            : problem}
        </p>
      </div>
      {preview && (
        <label className="lq-label" style={{ maxWidth: 320 }}>
          What should people call you?
          <input
            className="lq-input"
            value={me.name}
            onChange={(event) => me.setName(event.target.value)}
            placeholder="Your name"
            maxLength={64}
            autoComplete="name"
          />
        </label>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        {preview && (
          <button
            className="lq-btn"
            disabled={busy || !me.name.trim()}
            onClick={() => {
              setBusy(true);
              void me
                .save()
                .then(() => onJoin(invite))
                .then((joined) => joined && dismiss())
                .finally(() => setBusy(false));
            }}
          >
            {busy ? 'Joining…' : 'Join the assembly'}
          </button>
        )}
        <button className="lq-btn" data-variant="ghost" onClick={dismiss}>
          Not now
        </button>
      </div>
    </div>
  );
}

function AccountButton() {
  const { connection } = useConnection();
  const account = useAccount();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useDismiss(
    open,
    root,
    useCallback(() => setOpen(false), []),
  );
  return (
    <div ref={root} style={{ position: 'relative' }}>
      <button
        className="lq-btn"
        data-variant="quiet"
        style={{ paddingLeft: 6, gap: 8 }}
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      >
        <Avatar did={account.did} size={24} />
        <span className="lq-hide-phone">{account.name}</span>
      </button>
      {open && (
        <div
          className="lq-float lq-fade"
          style={{
            position: 'absolute',
            right: 0,
            top: 44,
            width: 260,
            padding: 14,
            zIndex: 30,
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}
        >
          <div>
            <p style={{ fontWeight: 600, color: palette.ink.strong }}>{account.name}</p>
            <p className="lq-faint" style={{ fontSize: 12, marginTop: 2, wordBreak: 'break-all' }}>
              {account.did.slice(0, 18)}…{account.did.slice(-6)}
            </p>
          </div>
          <p className="lq-muted" style={{ fontSize: 12.5, lineHeight: 1.5 }}>
            Your account lives in your Minca home. Disconnecting forgets it here; your assemblies stay in your
            account.
          </p>
          <button
            className="lq-btn"
            data-variant="danger"
            data-size="sm"
            onClick={() => void connection.disconnect()}
          >
            Disconnect
          </button>
        </div>
      )}
    </div>
  );
}
