import { useEffect, useState, type ReactNode } from 'react';
import type { CarrierSummary, P2PNode } from '@minca/core/node';
import {
  STAY_SIGNED_IN_CHOICES,
  passwordStrength,
  accountCredentialName,
  offerToSave,
  recoveryKit,
  connectionKey,
  type AuthState,
  type Connection,
  type StaySignedIn,
} from '@minca/core/session';
import { useAsync, useAuth, useSession } from '@minca/react';
import { usernameIdeas } from '@minca/core/inbox';
import { UsernamePicker } from '@minca/app-shared/UsernamePicker';
import { shortUsername, useFreeUsername } from '@minca/app-shared/usernames';
import { ask } from '@minca/app-shared/Ask';
import { Shape } from '@minca/app-shared/shapes';
import { shapeFor, type ShapeKind } from '@minca/ui/shapes';
import type { ShapeColour } from '@minca/ui/tokens';
import { message, useAction, useCopy } from '@minca/app-shared/action';
import { PairPhone } from './PairPhone';
import { ConfirmItsYou } from './ConfirmItsYou';
import { Hosting } from './Hosting';
import { Notifications } from './Notifications';
import { styles, palette, hstack, stack } from '../styles';
import type { TabId } from '../tabs';

/**
 * The account, as its home shows it: who you are, which apps may use it, how
 * this device gets in, where the data lives, and adding a phone. Apps link
 * here for "account settings" — they never hold the seed, so they have none of
 * their own.
 */
export function Settings({ tab, openTab }: { tab: TabId; openTab: (tab: TabId) => void }) {
  const { auth, state } = useAuth();
  const session = useSession();
  const [stay, setStay] = useState<StaySignedIn>(() => auth.staySignedIn.choice());
  const [until, setUntil] = useState<Date | null>(() => auth.staySignedIn.until());
  const hasPasskey = (state.entry?.shortcuts.length ?? 0) > 0;
  const hasPassword = state.entry?.hasPassword ?? false;
  // Without either, every visit here asks for the recovery code.
  const onlyWayIn = Number(hasPasskey) + Number(hasPassword) === 1;
  const [changingPassword, setChangingPassword] = useState(false);
  // A change to how the account signs in waits here until the person proves it is them.
  const [waiting, setWaiting] = useState<{ why: string; then: () => void } | null>(null);
  const guarded = (why: string, then: () => void) =>
    auth.isConfirmed() ? then() : setWaiting({ why, then });
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
  // A program connected by code is kept by its key, and so is a carrier.
  // It waits a moment for one of the account's devices or apps to take the revoke in, since only that stops it.
  const disconnect = (app: Connection) => {
    const what = app.name ?? new URL(app.origin).host;
    setNotYet(null);
    leave(connectionKey(app), what, async () => {
      const heard = await auth.disconnect(app.origin, {
        ...(connectionKey(app) === app.audience ? { audience: app.audience } : {}),
        waitMs: HEARD_WITHIN_MS,
      });
      // A reader may still have replaced a key that wrote: that one is revoked, and may go unheard.
      if (app.access === 'read' && !app.retired?.length)
        setNotYet(
          `${what} only reads, so there is no key to take back: it keeps reading until its access runs out.`,
        );
      else if (!heard)
        setNotYet(
          `${what} is disconnected here, but none of your other devices or apps is reachable to hear of it yet. It keeps working until one is: keep this open a moment, or it happens the next time you open your account home while one is online.`,
        );
    });
  };

  // Every app at once, for when one has gone wrong and you can't tell which: carriers stay.
  const disconnectAll = () => {
    setNotYet(null);
    leave('all', 'every app', async () => {
      const origins = new Set(connections.filter((app) => app.access !== 'carry').map((app) => app.origin));
      for (const origin of origins) await auth.disconnect(origin, { waitMs: HEARD_WITHIN_MS });
    });
  };

  const { carriers, hostKeys, online, reload: reloadCarriers } = useCarriers();
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
      await reloadCarriers();
    });

  const disconnectButton = (id: string, onClick: () => void) => (
    <button
      onClick={onClick}
      disabled={disconnecting !== null}
      data-variant="quiet"
      style={styles.smallButton}
    >
      {disconnecting === id ? 'Disconnecting…' : 'Disconnect'}
    </button>
  );
  /** Removes a way in, unless it is the only one: then the other must be set up first */
  const removeButton = (shortcut: 'passkey' | 'passphrase', other: string) => (
    <button
      onClick={() =>
        guarded(
          `remove the ${shortcut === 'passkey' ? 'passkey' : 'password'}`,
          () => void auth.removeShortcut(shortcut),
        )
      }
      disabled={state.busy || onlyWayIn}
      title={
        onlyWayIn ? `${other} first — otherwise you would need your recovery code to get back in.` : undefined
      }
      data-variant="quiet"
      style={{ ...styles.smallButton, color: palette.accent.danger }}
    >
      Remove
    </button>
  );

  const choose = async (choice: StaySignedIn) => {
    setStay(choice);
    await auth.staySignedIn.setChoice(choice);
    setUntil(auth.staySignedIn.until());
  };

  return (
    <>
      {tab === 'home' && (
        <>
          <PageHead title={`Hi, ${session.account.name}`} line="Here’s how your account is doing." />
          <Overview
            hasPasskey={hasPasskey}
            hasPassword={hasPassword}
            apps={connections.filter((app) => app.access !== 'carry').length}
            keepers={carriers?.length ?? 0}
            openTab={openTab}
          />
          <div style={{ marginTop: 16 }}>
            <Username />
          </div>
        </>
      )}
      {tab === 'security' && (
        <>
          <PageHead title="Security" line="How you get into your account, and how you get it back." />
          <Section
            title="Signing in"
            description="How you open your account here every day. A passkey works in this browser; a password works wherever your account is kept, including your pod in other apps."
          >
            {hasPasskey ? (
              <Row label="A passkey signs you in on this device.">
                {removeButton('passkey', 'Set a password')}
              </Row>
            ) : (
              <Row label="No passkey on this device.">
                <button
                  onClick={() => guarded('add a passkey', () => void auth.addPasskey())}
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
                  const save = async () => {
                    const ok = await auth.setPassword(password);
                    if (ok) {
                      const filedAs = accountCredentialName(session.account.name);
                      await offerToSave(filedAs, password, filedAs);
                      setChangingPassword(false);
                    }
                    return ok;
                  };
                  // Open longer than the proof lasts: ask again, then save.
                  if (auth.isConfirmed()) return save();
                  setWaiting({ why: 'change the password', then: () => void save() });
                  return false;
                }}
                onCancel={() => setChangingPassword(false)}
              />
            ) : (
              <Row label={hasPassword ? 'A password is set.' : 'No password.'}>
                <span style={hstack(6)}>
                  <button
                    onClick={() => guarded('change the password', () => setChangingPassword(true))}
                    disabled={state.busy}
                    data-variant="quiet"
                    style={styles.smallButton}
                  >
                    {hasPassword ? 'Change' : 'Set a password'}
                  </button>
                  {hasPassword && removeButton('passphrase', 'Set up a passkey')}
                </span>
              </Row>
            )}
            {changingPassword && state.error && <p style={styles.error}>{state.error.message}</p>}
            {waiting && (
              <ConfirmItsYou
                why={waiting.why}
                onConfirmed={() => {
                  setWaiting(null);
                  waiting.then();
                }}
                onCancel={() => setWaiting(null)}
              />
            )}
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

          <Section
            title="Sign out of this device"
            description="Signs this account home out on this device. Your account and your data stay where they are."
          >
            <SignOut />
          </Section>
        </>
      )}
      {tab === 'apps' && (
        <>
          <PageHead title="Apps" line="What you let use your account, and what they may tell you." />
          <Section
            title="Connected apps"
            description="Each one got a note, signed by your account, saying what it may use and until when. None of them has your password."
          >
            {connections.length === 0 && elsewhere.length === 0 && (
              <p style={styles.errorHint}>No apps yet.</p>
            )}
            {(connections.length > 0 || elsewhere.length > 0) && (
              <ul className="rows" style={styles.list}>
                {connections.map((app) => (
                  <AppRow
                    key={connectionKey(app)}
                    mark={connectionKey(app)}
                    title={appTitle(app)}
                    detail={[
                      ...appDetail(app),
                      ...(app.access === 'carry' ? [presence(app.carrySpace)] : []),
                    ]}
                    open={openable(app)}
                  >
                    {disconnectButton(connectionKey(app), () => disconnect(app))}
                  </AppRow>
                ))}
                {elsewhere.map((carrier) => (
                  <AppRow
                    key={carrier.space}
                    mark={carrier.space}
                    title={carrier.name}
                    detail={[
                      'Keeps your spaces online',
                      'Connected on another device',
                      presence(carrier.space),
                    ]}
                  >
                    {disconnectButton(carrier.space, () => removeCarrier(carrier.space))}
                  </AppRow>
                ))}
              </ul>
            )}
            {disconnectError && <p style={styles.error}>{disconnectError}</p>}
            {notYet && <p style={styles.errorHint}>{notYet}</p>}
            {anyAway && (
              <p style={styles.errorHint}>
                An extension that is not online either has Chrome closed, or is keeping a different account
                online now — open it to see which.
              </p>
            )}
            {connections.length > 0 && (
              <p style={styles.errorHint}>
                Disconnecting signs the app out the next time it comes online. It keeps what it could already
                read.
              </p>
            )}
            {connections.filter((app) => app.access !== 'carry').length > 1 && (
              <button
                onClick={disconnectAll}
                disabled={disconnecting !== null}
                data-variant="quiet"
                style={{ ...styles.smallButton, alignSelf: 'flex-start' }}
              >
                {disconnecting === 'all' ? 'Disconnecting…' : 'Something wrong? Disconnect every app'}
              </button>
            )}
          </Section>

          <Notifications node={session.node} />
        </>
      )}
      {tab === 'devices' && (
        <>
          <PageHead title="Devices" line="Your account on your phone, or another computer." />
          <PairPhone />
        </>
      )}
      {tab === 'data' && (
        <>
          <PageHead title="Data" line="Where your spaces are kept, and how they stay safe." />
          <Copies
            place={place}
            folderAvailable={state.folderAvailable}
            busy={state.busy}
            onChooseFolder={() => void auth.choosePod()}
            carriers={(carriers ?? []).filter((carrier) => !hostKeys.has(carrier.did))}
            hosts={(carriers ?? []).filter((carrier) => hostKeys.has(carrier.did))}
            presence={presence}
          />

          <Hosting node={session.node} />
        </>
      )}
    </>
  );
}

/**
 * The home tab: how the account is doing at a glance, one colour tile per
 * tab, its shape off the corner. A tile that wants something says so in its
 * chip.
 */
function Overview({
  hasPasskey,
  hasPassword,
  apps,
  keepers,
  openTab,
}: {
  hasPasskey: boolean;
  hasPassword: boolean;
  apps: number;
  keepers: number;
  openTab: (tab: TabId) => void;
}) {
  const ways = [hasPasskey && 'a passkey', hasPassword && 'a password'].filter(Boolean).join(' and ');
  const tiles: ReadonlyArray<{
    kind: ShapeKind;
    colour: ShapeColour;
    title: string;
    line: string;
    chip: string;
    warn?: boolean;
    action: string;
    tab: TabId;
  }> = [
    {
      kind: 'daisy',
      colour: 'coral',
      title: 'Apps',
      line:
        apps === 0
          ? 'Apps you connect show up here.'
          : `${apps} ${apps === 1 ? 'app uses' : 'apps use'} your account.`,
      chip: apps === 0 ? 'None yet' : `${apps} connected`,
      action: 'See apps',
      tab: 'apps',
    },
    {
      kind: 'flower',
      colour: 'peach',
      title: 'Devices',
      line: 'Scan a code, and your phone is the same account.',
      chip: 'Takes a minute',
      action: 'Add your phone',
      tab: 'devices',
    },
    {
      kind: 'burst',
      colour: 'sage',
      title: 'Data',
      line:
        keepers === 0
          ? 'Nothing keeps your spaces while your pages are closed.'
          : `Kept online by ${keepers} ${keepers === 1 ? 'helper' : 'helpers'}.`,
      chip: keepers === 0 ? 'Only here' : 'Backed up',
      warn: keepers === 0,
      action: 'See your data',
      tab: 'data',
    },
    {
      kind: 'scallop',
      colour: 'cobalt',
      title: 'Security',
      line: ways ? `You sign in with ${ways}.` : 'Only your recovery code opens your account here.',
      chip: ways ? 'All set' : 'Set one up',
      warn: !ways,
      action: 'See security',
      tab: 'security',
    },
  ];
  return (
    <div className="home-tiles">
      {tiles.map((tile) => (
        <section key={tile.title} className="home-tile" data-c={tile.colour}>
          <Shape kind={tile.kind} colour={tile.colour} className="home-tile-art" />
          <span className={tile.warn ? 'home-chip home-chip-warn' : 'home-chip'}>{tile.chip}</span>
          <h2>{tile.title}</h2>
          <p>{tile.line}</p>
          <button onClick={() => openTab(tile.tab)} data-variant="quiet" style={styles.smallButton}>
            {tile.action}
          </button>
        </section>
      ))}
    </div>
  );
}

/** How much this site keeps in the browser, and whether the browser may clear it to make room */
function useBrowserStorage(): { used: number | null; persisted: boolean | null } {
  const found = useAsync(async () => {
    const storage = globalThis.navigator?.storage;
    const [estimate, persisted] = await Promise.all([
      storage?.estimate?.().catch(() => null),
      storage?.persisted?.().catch(() => null),
    ]);
    return { used: estimate?.usage ?? null, persisted: persisted ?? null };
  }, []);
  return found.status === 'done' ? found.value : { used: null, persisted: null };
}

const megabytes = (bytes: number) => `${Math.max(1, Math.round(bytes / 1_000_000))} MB`;

/**
 * Where copies of the account's spaces are, as far as this home can tell:
 * here, and every carrier and host. Every device and app keeps its own copy
 * too, but nothing lists them, so the section says so rather than counting.
 */
function Copies({
  place,
  folderAvailable,
  busy,
  onChooseFolder,
  carriers,
  hosts,
  presence,
}: {
  place: AuthState['place'];
  folderAvailable: boolean;
  busy: boolean;
  onChooseFolder: () => void;
  carriers: ReadonlyArray<CarrierSummary>;
  hosts: ReadonlyArray<CarrierSummary>;
  presence: (space: string) => string;
}) {
  const browser = useBrowserStorage();
  const inFolder = place?.kind === 'folder';
  const here = inFolder
    ? `Folder “${place.directory?.name ?? 'pod'}”`
    : [
        'This browser',
        browser.used !== null ? megabytes(browser.used) : null,
        browser.persisted === false ? 'may be cleared to make room' : null,
      ]
        .filter(Boolean)
        .join(' · ');
  const alone = carriers.length === 0 && hosts.length === 0;
  return (
    <Section
      title="Your copies"
      description="Every device and app you use keeps its own copy of your spaces, and they sync with each other. More than one copy is what keeps them safe."
    >
      <Row label={here}>
        {folderAvailable && (
          <button onClick={onChooseFolder} disabled={busy} data-variant="quiet" style={styles.smallButton}>
            {inFolder ? 'Change folder' : 'Keep in a folder'}
          </button>
        )}
      </Row>
      {carriers.map((carrier) => (
        <Row key={carrier.space} label={`${carrier.name} · ${presence(carrier.space)}`}>
          <span />
        </Row>
      ))}
      {hosts.map((host) => (
        <Row key={host.space} label={`${host.name} · host`}>
          <span />
        </Row>
      ))}
      <p style={styles.errorHint}>
        {inFolder
          ? 'This page writes to the folder only while it is open. Give the Minca extension the same folder and it keeps it up to date while Chrome is open; then the folder is a whole copy of your account, which you can open with your password on any computer.'
          : 'A folder keeps your account and its data on your computer, where clearing the browser can’t reach it. Put it in iCloud or Dropbox to back it up.'}
      </p>
      {alone && (
        <p style={styles.errorHint}>
          Nothing keeps a copy while your pages are closed. Your recovery code brings back your account, but
          your private spaces come back only from another copy: add your phone below, or the Minca extension.
        </p>
      )}
    </Section>
  );
}

/**
 * Signing out, and what becomes of the apps connected from here: an app's
 * note doesn't need the home signed in, so they keep working. Asked each
 * time, unticked: disconnecting revokes, which is for when something is wrong.
 * Carriers stay, as they hold nothing that writes.
 */
function SignOut() {
  const { auth } = useAuth();
  const [asking, setAsking] = useState(false);
  const [disconnect, setDisconnect] = useState(false);
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
              : 'They keep working until you disconnect them, signed out here or not.'}
          </span>
        </span>
      </label>
      <div style={{ ...hstack(8), marginTop: 12 }}>
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

/** A tab's title and what it is for */
function PageHead({ title, line }: { title: string; line: string }) {
  return (
    <header className="home-page-head">
      <h1>{title}</h1>
      <p>{line}</p>
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
      <div style={hstack(8)}>
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
  const [asking, setAsking] = useState(false);
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
          <div style={hstack(8)}>
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
      ) : asking ? (
        <ConfirmItsYou
          why="see your recovery code"
          onConfirmed={() => {
            setAsking(false);
            setCode(reveal());
          }}
          onCancel={() => setAsking(false)}
        />
      ) : (
        <div>
          {/* Read straight away within a few minutes of the last confirm; otherwise it asks. */}
          <button
            onClick={() => {
              const now = reveal();
              if (now) setCode(now);
              else setAsking(true);
            }}
            data-variant="quiet"
            style={styles.smallButton}
          >
            Show recovery code
          </button>
        </div>
      )}
    </Section>
  );
}

/** How long disconnecting waits for one of the account's devices or apps to take the revoke in */
const HEARD_WITHIN_MS = 5000;

/** What an app goes by: what it called itself, else where it lives */
function appTitle(app: Connection): string {
  if (app.access === 'carry') return app.name ?? 'Browser extension';
  if (app.via === 'code') return app.name ?? 'A program';
  return app.name ?? new URL(app.origin).host;
}

/** Where it lives, what it may use, and until when: "todo.example · Reads and changes Groceries · Until 3 October" */
function appDetail(app: Connection): ReadonlyArray<string> {
  const url = new URL(app.origin);
  const extension = url.protocol === 'chrome-extension:' || url.protocol === 'moz-extension:';
  const host = extension ? 'Browser extension' : url.host;
  if (app.access === 'carry') return ['Keeps your spaces online', "Can't read them"];
  const what =
    app.scope === 'account'
      ? 'your whole account'
      : app.spaces.length
        ? app.spaces.map((space) => space.name).join(', ')
        : 'no spaces';
  const expired = app.expiresAt * 1000 < Date.now();
  const until = new Date(app.expiresAt * 1000).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'long',
  });
  return [
    app.via === 'code' ? `By code, via ${host}${app.recordsOnly ? ', records only' : ''}` : host,
    `${app.access === 'write' ? 'Reads and changes' : 'Reads'} ${what}`,
    expired
      ? app.access === 'write'
        ? 'Stopped syncing; can still change things until disconnected'
        : 'Ran out'
      : `Until ${until}`,
  ];
}

/** Where to go back to an app, when it is a website: not an extension, a program or a carrier */
function openable(app: Connection): string | undefined {
  if (app.access === 'carry' || app.via === 'code') return undefined;
  return /^https?:$/.test(new URL(app.origin).protocol) ? app.origin : undefined;
}

const openLink = {
  ...styles.darkSmall,
  display: 'inline-flex',
  alignItems: 'center',
  textDecoration: 'none',
} as const;

/** One app in the list: its shape, its name, a quiet line about it, the way back to it, and what to do */
function AppRow({
  mark,
  title,
  detail,
  open,
  children,
}: {
  /** What picks its shape: where it lives, or its key */
  mark: string;
  title: string;
  detail: ReadonlyArray<string>;
  open?: string | undefined;
  children: ReactNode;
}) {
  return (
    <li style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', flexWrap: 'wrap' }}>
      <Shape {...shapeFor(mark)} size={32} />
      <span style={{ ...stack(2), flex: '1 1 200px', minWidth: 0 }}>
        <strong style={{ fontSize: 15, fontWeight: 600, color: palette.ink.strong }}>{title}</strong>
        <span style={{ fontSize: 13, lineHeight: 1.45, color: palette.ink.muted }}>{detail.join(' · ')}</span>
      </span>
      <span style={hstack(8)}>
        {open && (
          <a href={open} target="_blank" rel="noopener" data-variant="primary" style={openLink}>
            Open
          </a>
        )}
        {children}
      </span>
    </li>
  );
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
    <section className="surface" style={styles.settingsSection}>
      <div>
        <h2 style={styles.sectionHeading}>{title}</h2>
        <p style={styles.sectionText}>{description}</p>
      </div>
      {children}
    </section>
  );
}

/**
 * Your username, which every Minca app finds you by: pick one, or copy,
 * change or give up the one you have. Kept here, with the account, rather
 * than in each app.
 */
function Username() {
  const { node, account } = useSession();
  const [loaded, setLoaded] = useState(0);
  const found = useAsync(() => node.inbox.get(), [node, loaded]);
  const username = found.status === 'done' ? (found.value?.username ?? null) : null;
  const [changing, setChanging] = useState(false);
  const suggestion = useFreeUsername(username ? [] : usernameIdeas(account.name));
  const { copied, copy } = useCopy();
  const { run, error } = useAction();
  const done = () => {
    setChanging(false);
    setLoaded((n) => n + 1);
  };

  return (
    <Section
      title="Your username"
      description="How people find you and add you, in every Minca app. Anyone with it can ask to be your contact, and you choose who gets in."
    >
      {found.status === 'loading' ? null : username && !changing ? (
        <div style={stack(10)}>
          <strong style={usernameStyle}>{shortUsername(username)}</strong>
          <span style={{ ...hstack(6), flexWrap: 'wrap' }}>
            <button
              onClick={() => copy(shortUsername(username))}
              data-variant="quiet"
              style={styles.smallButton}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button onClick={() => setChanging(true)} data-variant="quiet" style={styles.smallButton}>
              Change
            </button>
            <button
              onClick={() =>
                void run(async () => {
                  const sure = await ask(
                    `${shortUsername(username)} stops leading to you, and anyone may take it. Your contacts stay.`,
                    { title: 'Give up your username?', yes: 'Give it up', danger: true },
                  );
                  if (!sure) return;
                  await node.inbox.release();
                  done();
                })
              }
              data-variant="danger"
              style={{ ...styles.smallButton, color: palette.accent.danger }}
            >
              Give it up
            </button>
          </span>
        </div>
      ) : (
        <UsernamePicker current={username} suggestion={suggestion} onClaimed={done}>
          {username && (
            <button
              type="button"
              onClick={() => setChanging(false)}
              data-variant="ghost"
              style={styles.linkButton}
            >
              Cancel
            </button>
          )}
        </UsernamePicker>
      )}
      {error && <p style={styles.error}>{error}</p>}
    </Section>
  );
}

const usernameStyle = {
  fontFamily: palette.display,
  fontSize: 24,
  fontWeight: 700,
  letterSpacing: '-0.04em',
  color: palette.ink.strong,
  overflowWrap: 'anywhere',
} as const;

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
    <div style={stack(6)}>
      <div aria-hidden style={hstack(4)}>
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

/**
 * The account's carriers, one per key, and which are online now. Carriers are
 * in the account registry, so every device lists them, not only the home that
 * connected one. A host is a carrier too, but it has its own section: `hostKeys`.
 */
function useCarriers() {
  const { node } = useSession();
  const [found, setFound] = useState<ReadonlyArray<CarrierSummary> | null>(null);
  const [online, setOnline] = useState<ReadonlySet<string>>(new Set());
  const hosts = useAsync(() => node.hosting.list(), [node]);
  const hostKeys = new Set(hosts.status === 'done' ? hosts.value.map((host) => host.host) : []);

  const reload = async () => setFound(await node.carriers.list());

  useEffect(() => {
    const load = () => void node.carriers.list().then(setFound, () => {});
    load();
    return node.subscribe((event) => {
      if (event.type === 'records' || event.type === 'account') load();
    });
  }, [node]);

  // Each carrier is a peer in its own carry space when it is online.
  useEffect(() => {
    if (!found) return;
    const look = () => void onlineSpaces(node, found).then(setOnline);
    look();
    return node.subscribe((event) => {
      if (event.type === 'status' && found.some((carrier) => carrier.space === event.space)) look();
    });
  }, [node, found]);

  return { carriers: found && onePerKey(found), hostKeys, online, reload };
}

/** The carry spaces whose carrier is online, by key: one set up on two devices is online in one of its two */
async function onlineSpaces(
  node: P2PNode,
  carriers: ReadonlyArray<CarrierSummary>,
): Promise<ReadonlySet<string>> {
  const seen = new Set<string>();
  for (const carrier of carriers) {
    const status = await node.spaces.status(carrier.space).catch(() => null);
    if (status?.peers.includes(carrier.did))
      for (const same of carriers) if (same.did === carrier.did) seen.add(same.space);
  }
  return seen;
}

/** Each carrier once, by key: one set up on two devices at once has two carry spaces (spec 06 §4.2) */
function onePerKey(carriers: ReadonlyArray<CarrierSummary>): ReadonlyArray<CarrierSummary> {
  return carriers.filter(
    (carrier, index) => carriers.findIndex((other) => other.did === carrier.did) === index,
  );
}
