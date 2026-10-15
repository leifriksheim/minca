import { useEffect, useState, type ReactNode } from 'react';
import type { CarrierSummary } from '@minca/core/node';
import {
  STAY_SIGNED_IN_CHOICES,
  passwordStrength,
  accountCredentialName,
  offerToSave,
  recoveryKit,
  type Connection,
  type StaySignedIn,
} from '@minca/core/session';
import { useAuth, useSession } from '@minca/core/react';
import { Avatar } from '@minca/app-shared/Avatar';
import { Shape, shapeFor } from '@minca/app-shared/shapes';
import { message, useAction, useCopy } from '@minca/app-shared/action';
import { PairPhone } from './PairPhone';
import { Hosting } from './Hosting';
import { Notifications } from './Notifications';
import { styles, palette } from '../styles';

/**
 * The account, as its home shows it: who you are, which apps may use it, how
 * this device gets in, where the data lives, and adding a phone. Apps link
 * here for "account settings" — they never hold the seed, so they have none of
 * their own.
 */
export function Settings() {
  const { auth, state } = useAuth();
  const session = useSession();
  const [stay, setStay] = useState<StaySignedIn>(() => auth.staySignedIn.choice());
  const [until, setUntil] = useState<Date | null>(() => auth.staySignedIn.until());
  const hasPasskey = (state.entry?.shortcuts.length ?? 0) > 0;
  const hasPassword = state.entry?.hasPassword ?? false;
  // Without either, every visit here asks for the recovery code.
  const onlyWayIn = Number(hasPasskey) + Number(hasPassword) === 1;
  const [changingPassword, setChangingPassword] = useState(false);
  const place = state.place;
  const [leaving, setLeaving] = useState<string | null>(null);
  const { run, busy, error: disconnectError } = useAction();
  const disconnecting = busy ? leaving : null;
  /** Runs `work` for the connection `id`, saying what went wrong as `Could not disconnect <what>: …` */
  const leave = (id: string, what: string, work: () => Promise<unknown>) => {
    setLeaving(id);
    void run(() =>
      work().catch((error: unknown) => {
        throw new Error(`Could not disconnect ${what}: ${message(error)}`);
      }),
    );
  };
  // What disconnecting could not do yet: heard of nowhere else, or a read-only note that runs out on its own.
  const [notYet, setNotYet] = useState<string | null>(null);
  // A program connected by code is its own key, and so is a carrier; an app takes the programs that connected through it along.
  // It waits a moment for one of the account's devices or apps to take the revoke in, since only that stops it.
  const disconnect = (app: Connection) => {
    const what = app.name ?? new URL(app.origin).host;
    setNotYet(null);
    leave(connectionId(app), what, async () => {
      const heard = await auth.disconnect(app.origin, {
        ...(app.via === 'code' || app.access === 'carry' ? { audience: app.audience } : {}),
        waitMs: HEARD_WITHIN_MS,
      });
      if (app.access === 'read')
        setNotYet(
          `${what} only reads, so there is no key to take back: it keeps reading until its access runs out.`,
        );
      else if (!heard)
        setNotYet(
          `${what} is disconnected here, but none of your other devices or apps is reachable to hear of it yet. It keeps working until one is: keep this open a moment, or it happens the next time you open your account home while one is online.`,
        );
    });
  };

  // Carriers are in the account registry, so every device lists them — not
  // only the home that connected one, which is all `connections()` knows.
  const [carriers, setCarriers] = useState<ReadonlyArray<CarrierSummary> | null>(null);
  // A host is a carrier too, but it has its own section.
  const [hostKeys, setHostKeys] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    void session.node.hosting.list().then(
      (hosts) => setHostKeys(new Set(hosts.map((host) => host.host))),
      () => {},
    );
  }, [session]);
  // Which carriers are online now: each is a peer in its own carry space. One
  // that never is may be keeping another account online instead.
  const [online, setOnline] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    let current: ReadonlyArray<CarrierSummary> = [];
    const look = async () => {
      const seen = new Set<string>();
      for (const carrier of current) {
        const status = await session.node.spaces.status(carrier.space).catch(() => null);
        if (status?.peers.includes(carrier.did)) seen.add(carrier.space);
      }
      setOnline(seen);
    };
    const load = () =>
      void session.node.carriers.list().then(
        (found) => {
          current = found;
          setCarriers(found);
          void look();
        },
        () => {},
      );
    load();
    return session.node.subscribe((event) => {
      if (event.type === 'records' || event.type === 'account') load();
      else if (event.type === 'status' && current.some((carrier) => carrier.space === event.space))
        void look();
    });
  }, [session]);
  const presence = (space: string | undefined) =>
    space && online.has(space) ? 'online now' : 'not online right now';
  const anyAway = (carriers ?? []).some((carrier) => !online.has(carrier.space));
  // A carrier disconnected on another device is gone here too.
  const connections = auth
    .connections()
    .filter(
      (app) =>
        app.access !== 'carry' ||
        carriers === null ||
        carriers.some((carrier) => carrier.space === app.carrySpace),
    );
  const known = new Set(connections.map((app) => app.carrySpace).filter(Boolean));
  const elsewhere = (carriers ?? []).filter(
    (carrier) => !known.has(carrier.space) && !hostKeys.has(carrier.did),
  );
  const removeCarrier = (space: string) =>
    leave(space, 'it', async () => {
      await session.node.carriers.remove(space);
      setCarriers(await session.node.carriers.list());
    });

  const choose = async (choice: StaySignedIn) => {
    setStay(choice);
    await auth.staySignedIn.setChoice(choice);
    setUntil(auth.staySignedIn.until());
  };

  return (
    <>
      <AccountHeader name={session.account.name} did={session.did} onRename={(name) => auth.rename(name)} />

      <Section
        title="Connected apps"
        description="Apps that you let use your account. Each got a note, signed by your account, saying what it may use and until when. None of them has your password."
      >
        {connections.length === 0 && elsewhere.length === 0 && <Row label="No apps yet.">{null}</Row>}
        {connections.map((app) => (
          <Row
            key={connectionId(app)}
            shape={connectionId(app)}
            label={
              app.access === 'carry'
                ? `${describeConnection(app)} · ${presence(app.carrySpace)}`
                : describeConnection(app)
            }
          >
            <button
              onClick={() => disconnect(app)}
              disabled={disconnecting !== null}
              data-variant="quiet"
              style={styles.smallButton}
            >
              {disconnecting === connectionId(app) ? 'Disconnecting…' : 'Disconnect'}
            </button>
          </Row>
        ))}
        {elsewhere.map((carrier) => (
          <Row
            key={carrier.space}
            shape={carrier.space}
            label={`${carrier.name} · keeps your spaces online · connected on another device · ${presence(carrier.space)}`}
          >
            <button
              onClick={() => removeCarrier(carrier.space)}
              disabled={disconnecting !== null}
              data-variant="quiet"
              style={styles.smallButton}
            >
              {disconnecting === carrier.space ? 'Disconnecting…' : 'Disconnect'}
            </button>
          </Row>
        ))}
        {disconnectError && <p style={styles.error}>{disconnectError}</p>}
        {notYet && <p style={styles.errorHint}>{notYet}</p>}
        {anyAway && (
          <p style={styles.errorHint}>
            An extension that is not online either has Chrome closed, or is keeping a different account online
            now — open it to see which.
          </p>
        )}
        {connections.length > 0 && (
          <p style={styles.errorHint}>
            Disconnecting stops the app for good the next time it comes online: it signs itself out, and
            nothing it changes after that counts. What it already wrote stays, and it keeps what it could
            already read.
          </p>
        )}
      </Section>

      <Hosting node={session.node} />

      <Notifications node={session.node} />

      <Section
        title="Signing in"
        description="How you open your account here every day. A passkey works in this browser; a password works wherever your account is kept, including your pod in other apps."
      >
        {hasPasskey ? (
          <Row label="A passkey signs you in on this device.">
            <button
              onClick={() => void auth.removeShortcut('passkey')}
              disabled={state.busy || onlyWayIn}
              title={
                onlyWayIn
                  ? 'Set a password first — otherwise you would need your recovery code to get back in.'
                  : undefined
              }
              data-variant="quiet"
              style={{ ...styles.smallButton, color: palette.accent.danger }}
            >
              Remove
            </button>
          </Row>
        ) : (
          <Row label="No passkey on this device.">
            <button
              onClick={() => void auth.addPasskey()}
              disabled={state.busy}
              data-variant="primary"
              style={styles.darkSmall}
            >
              {state.busy ? 'Waiting…' : 'Set up a passkey'}
            </button>
          </Row>
        )}
        {changingPassword ? (
          <PasswordForm
            account={session.account.name}
            busy={state.busy}
            onSave={async (password) => {
              const ok = await auth.setPassword(password);
              if (ok) {
                const filedAs = accountCredentialName(session.account.name);
                await offerToSave(filedAs, password, filedAs);
                setChangingPassword(false);
              }
              return ok;
            }}
            onCancel={() => setChangingPassword(false)}
          />
        ) : (
          <Row label={hasPassword ? 'A password is set.' : 'No password.'}>
            <span style={{ display: 'flex', gap: 6 }}>
              <button
                onClick={() => setChangingPassword(true)}
                disabled={state.busy}
                data-variant="quiet"
                style={styles.smallButton}
              >
                {hasPassword ? 'Change' : 'Set a password'}
              </button>
              {hasPassword && (
                <button
                  onClick={() => void auth.removeShortcut('passphrase')}
                  disabled={state.busy || onlyWayIn}
                  title={
                    onlyWayIn
                      ? 'Set up a passkey first — otherwise you would need your recovery code to get back in.'
                      : undefined
                  }
                  data-variant="quiet"
                  style={{ ...styles.smallButton, color: palette.accent.danger }}
                >
                  Remove
                </button>
              )}
            </span>
          </Row>
        )}
        {changingPassword && state.error && <p style={styles.error}>{state.error.message}</p>}
      </Section>

      <RecoveryCode reveal={() => auth.recoveryCode()} name={session.account.name} did={session.did} />

      <Section
        title="Stay signed in"
        description="Skip unlocking when you come back. After this long without using it, you'll be asked again."
      >
        <div role="radiogroup" aria-label="Stay signed in" style={segmented}>
          {STAY_SIGNED_IN_CHOICES.map((choice) => (
            <button
              key={choice.value}
              role="radio"
              aria-checked={stay === choice.value}
              onClick={() => void choose(choice.value)}
              style={stay === choice.value ? segmentOn : segment}
            >
              {choice.label}
            </button>
          ))}
        </div>
        <p style={styles.errorHint}>
          {stay === 'never'
            ? 'This device asks to unlock every time.'
            : until
              ? `Signed in on this device until ${until.toLocaleDateString(undefined, { day: 'numeric', month: 'long' })}, or longer if you keep using it.`
              : 'Applies from your next unlock.'}{' '}
          Anyone who can use this browser can open your account while you're signed in.
        </p>
      </Section>

      {state.folderAvailable && (
        <Section
          title="Where your data lives"
          description="A pod is a folder on your computer that holds your account and spaces. Copy it, back it up, or put it in iCloud or Dropbox."
        >
          <Row
            label={place?.kind === 'folder' ? `Pod: ${place.directory?.name ?? 'folder'}` : 'In this browser'}
          >
            <button
              onClick={() => void auth.choosePod()}
              disabled={state.busy}
              data-variant="quiet"
              style={styles.smallButton}
            >
              {place?.kind === 'folder' ? 'Change pod' : 'Move to a pod'}
            </button>
          </Row>
        </Section>
      )}

      <div style={{ marginBottom: 16 }}>
        <PairPhone />
      </div>

      <Section
        title="Sign out of this device"
        description="Signs this account home out on this device. Your account and your data stay where they are."
      >
        <SignOut />
      </Section>
    </>
  );
}

/**
 * Signing out, and what becomes of the apps connected from here: an app's
 * note doesn't need the home signed in, so they would keep working. Asked
 * each time, ticked to disconnect them; carriers stay, as they hold nothing
 * that writes.
 */
function SignOut() {
  const { auth } = useAuth();
  const [asking, setAsking] = useState(false);
  const [disconnect, setDisconnect] = useState(true);
  const { run, busy, error } = useAction();
  const apps = auth.connections().filter((app) => app.access !== 'carry');
  // A read-only note has no key to revoke: it runs until its time does.
  const readOnly = apps.filter((app) => app.access !== 'write');
  const signOut = (options: { disconnect?: boolean } = {}) => void run(() => auth.signOut(options));

  if (!asking || apps.length === 0)
    return (
      <div>
        <button
          onClick={() => (apps.length === 0 ? signOut() : setAsking(true))}
          disabled={busy}
          data-variant="quiet"
          style={styles.smallButton}
        >
          {busy ? 'Signing out…' : 'Sign out'}
        </button>
        {error && <p style={styles.error}>{error}</p>}
      </div>
    );
  return (
    <div>
      <label data-choice style={{ ...styles.choice, alignItems: 'flex-start' }}>
        <input
          type="checkbox"
          checked={disconnect}
          onChange={() => setDisconnect((was) => !was)}
          style={{ ...styles.checkbox, marginTop: 2 }}
        />
        <span style={{ flex: 1 }}>
          Also disconnect {apps.length === 1 ? 'the app' : `the ${apps.length} apps`} connected here
          <span style={{ ...styles.errorHint, display: 'block', marginTop: 4 }}>
            {apps.map((app) => app.name ?? new URL(app.origin).host).join(', ')}.{' '}
            {disconnect
              ? `They stop working, with the automations they suggested, and ask you to connect again${
                  readOnly.length > 0
                    ? `; ${readOnly.length === 1 ? 'one only reads, and keeps reading' : `${readOnly.length} only read, and keep reading`} until ${readOnly.length === 1 ? 'its' : 'their'} access runs out`
                    : ''
                }. If none of your devices or apps is reachable now, they hear of it when you next sign in here.`
              : 'They keep working until their access runs out, signed out here or not.'}
          </span>
        </span>
      </label>
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button
          onClick={() => signOut({ disconnect })}
          disabled={busy}
          data-variant="primary"
          style={styles.darkSmall}
        >
          {busy ? 'Signing out…' : 'Sign out'}
        </button>
        <button
          onClick={() => setAsking(false)}
          disabled={busy}
          data-variant="quiet"
          style={styles.smallButton}
        >
          Cancel
        </button>
      </div>
      {error && <p style={styles.error}>{error}</p>}
    </div>
  );
}

/** Who this is, with the name editable in place */
function AccountHeader({
  name,
  did,
  onRename,
}: {
  name: string;
  did: string;
  onRename: (name: string) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  return (
    <header style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 28 }}>
      <Avatar did={did} size={48} />
      <div style={{ flex: 1, minWidth: 0 }}>
        {editing ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void onRename(draft).then((ok) => ok && setEditing(false));
            }}
            style={{ display: 'flex', gap: 6 }}
          >
            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              autoFocus
              aria-label="Account name"
              style={{ ...styles.input, height: 34 }}
            />
            <button
              type="submit"
              disabled={!draft.trim()}
              data-variant="primary"
              style={{ ...styles.darkSmall, height: 34 }}
            >
              Save
            </button>
          </form>
        ) : (
          <h1 style={{ ...styles.appTitle, display: 'flex', alignItems: 'baseline', gap: 10 }}>
            {name}
            <button
              onClick={() => {
                setDraft(name);
                setEditing(true);
              }}
              data-variant="ghost"
              style={{ ...styles.linkButton, fontSize: 13 }}
            >
              Rename
            </button>
          </h1>
        )}
        <CopyDid did={did} />
      </div>
    </header>
  );
}

/** A new password, twice; a manager fills both and offers to save it under the account's name */
function PasswordForm({
  account,
  busy,
  onSave,
  onCancel,
}: {
  account: string;
  busy: boolean;
  onSave: (password: string) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [mismatch, setMismatch] = useState(false);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        setMismatch(password !== again);
        if (password === again) void onSave(password);
      }}
      style={styles.form}
    >
      <input
        type="text"
        name="username"
        autoComplete="username"
        value={accountCredentialName(account)}
        readOnly
        aria-label="Account"
        style={styles.input}
      />
      <input
        type="password"
        name="password"
        autoComplete="new-password"
        placeholder="New password"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        autoFocus
        aria-label="New password"
        aria-describedby="password-strength"
        style={styles.input}
      />
      <Strength password={password} />
      <input
        type="password"
        name="confirm-password"
        autoComplete="new-password"
        placeholder="The same again"
        value={again}
        onChange={(event) => setAgain(event.target.value)}
        aria-label="Confirm password"
        style={styles.input}
      />
      {mismatch && <p style={styles.error}>Those two do not match.</p>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="submit" disabled={busy || !password} data-variant="primary" style={styles.darkSmall}>
          {busy ? 'Saving…' : 'Save password'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          data-variant="quiet"
          style={styles.smallButton}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

/**
 * The recovery code, hidden until asked for. It is the account itself, so it
 * is shown only on purpose, and never offered to a password manager as a login.
 */
function RecoveryCode({ reveal, name, did }: { reveal: () => string | null; name: string; did: string }) {
  const [code, setCode] = useState<string | null>(null);
  const { copied, copy } = useCopy();
  const download = () => {
    if (!code) return;
    const kit = recoveryKit({ code, name, did });
    const url = URL.createObjectURL(new Blob([kit.text], { type: 'text/plain' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = kit.filename;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <Section
      title="Recovery code"
      description="Your account, written out. It restores the account on any device, even one that has never seen it. Keep it somewhere safe — nobody can reissue it."
    >
      {code ? (
        <>
          <code
            style={{
              display: 'block',
              padding: 12,
              borderRadius: palette.radius.md,
              background: palette.surface.sunken,
              border: `1px solid ${palette.surface.line}`,
              color: palette.ink.strong,
              fontSize: 15,
              letterSpacing: '0.04em',
              textAlign: 'center',
              wordBreak: 'break-all',
              userSelect: 'all',
            }}
          >
            {code}
          </code>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => copy(code)} data-variant="quiet" style={styles.smallButton}>
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button onClick={download} data-variant="quiet" style={styles.smallButton}>
              Download
            </button>
            <button onClick={() => setCode(null)} data-variant="quiet" style={styles.smallButton}>
              Hide
            </button>
          </div>
          <p style={styles.errorHint}>Anyone who sees this can open your account.</p>
        </>
      ) : (
        <div>
          <button onClick={() => setCode(reveal())} data-variant="quiet" style={styles.smallButton}>
            Show recovery code
          </button>
        </div>
      )}
    </Section>
  );
}

/** Programs connect by code through an app's origin, several to one, so each is named by its key */
/** How long disconnecting waits for one of the account's devices or apps to take the revoke in */
const HEARD_WITHIN_MS = 5000;

const connectionId = (app: Connection) =>
  app.via === 'code' || app.access === 'carry' ? app.audience : app.origin;

/** The account's DID, short, with a way to copy it whole — what a host's `--allow` takes */
function CopyDid({ did }: { did: string }) {
  const { copied, copy } = useCopy();
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <code title={did} style={{ fontSize: 12, color: palette.ink.faint }}>
        {did.slice(0, 16)}…{did.slice(-6)}
      </code>
      <button
        onClick={() => copy(did)}
        data-variant="quiet"
        style={{ ...styles.smallButton, height: 24, fontSize: 12 }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </span>
  );
}

/** "Todo (todo.example) · read and change Groceries · until 3 October" */
function describeConnection(app: Connection): string {
  const url = new URL(app.origin);
  const extension = url.protocol === 'chrome-extension:' || url.protocol === 'moz-extension:';
  if (app.access === 'carry')
    return `${app.name ?? 'Browser extension'} · keeps your spaces online · can't read them`;
  const host = extension ? 'browser extension' : url.host;
  const who =
    app.via === 'code'
      ? `${app.name ?? 'A program'} (by code, via ${host}${app.recordsOnly ? ', records only' : ''})`
      : app.name
        ? `${app.name} (${host})`
        : host;
  const what =
    app.scope === 'account'
      ? 'your whole account'
      : app.spaces.length
        ? app.spaces.map((space) => space.name).join(', ')
        : 'no spaces';
  const until = new Date(app.expiresAt * 1000).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'long',
  });
  const expired = app.expiresAt * 1000 < Date.now();
  return `${who} · ${app.access === 'write' ? 'read and change' : 'read'} ${what} · ${expired ? 'ran out' : `until ${until}`}`;
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section style={styles.settingsSection}>
      <div>
        <h2 style={styles.sectionHeading}>{title}</h2>
        <p style={styles.sectionText}>{description}</p>
      </div>
      {children}
    </section>
  );
}

/** A line in a section; `shape` marks what it is about, an app by its address */
function Row({ label, shape, children }: { label: string; shape?: string; children: ReactNode }) {
  return (
    <div style={styles.settingsRow}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
        {shape !== undefined && <Shape {...shapeFor(shape)} size={18} />}
        <span>{label}</span>
      </span>
      {children}
    </div>
  );
}

// The shared segmented control, as wide as its choices rather than the section.
const segmented = {
  ...styles.segmented,
  display: 'inline-flex',
  alignSelf: 'flex-start',
  flexWrap: 'wrap',
} as const;
const segment = { ...styles.segment, flex: 'none' } as const;
const segmentOn = { ...styles.segmentActive, flex: 'none' } as const;

/** How strong a new password is, as it is typed: a warning, never a refusal */
function Strength({ password }: { password: string }) {
  const check = passwordStrength(password);
  const filled = password ? { weak: 1, fair: 2, strong: 3 }[check.strength] : 0;
  const colour = { weak: palette.accent.danger, fair: palette.accent.warn, strong: palette.accent.good }[
    check.strength
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div aria-hidden style={{ display: 'flex', gap: 4 }}>
        {[1, 2, 3].map((step) => (
          <span
            key={step}
            style={{
              flex: 1,
              height: 4,
              borderRadius: 2,
              background: step <= filled ? colour : palette.surface.line,
              transition: 'background-color .15s ease',
            }}
          />
        ))}
      </div>
      <p
        id="password-strength"
        aria-live="polite"
        style={{
          ...styles.errorHint,
          marginTop: 0,
          color: password && check.strength === 'weak' ? palette.accent.danger : styles.errorHint.color,
        }}
      >
        {check.hint || 'Any password works. Let your password manager make a strong one.'}
      </p>
    </div>
  );
}
