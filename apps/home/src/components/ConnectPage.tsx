import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { ConfirmItsYou } from './ConfirmItsYou';
import { SignIn } from './SignIn';
import type { NewSpace, P2PNode, SpaceSummary } from '@minca/core';
import {
  isProposeRequest,
  receiveConnectCode,
  receiveConnectRequest,
  type ConnectRequest,
  type IncomingRequest,
  type MincaAuth,
  type ProposeRequest,
} from '@minca/core/session';
import { useAccountPicture, useAuth, useSession, useMinca, useWatched } from '@minca/react';
import { Wordmark } from '@minca/app-shared/Wordmark';
import { Avatar } from '@minca/app-shared/Avatar';
import { rememberedPicture } from '@minca/app-shared/rememberedPictures';
import { Shape } from '@minca/app-shared/shapes';
import { shapeFor } from '@minca/ui/shapes';
import { useAction } from '@minca/app-shared/action';
import styles from './ConnectPage.module.css';
import { Loader } from '@minca/app-shared/Loader';
import { relayUrls } from '@minca/app-shared/relay';
import { connectCode as code } from '../minca';

/** Back to choosing an account, from the page that says what an app gets */
const ChooseAgain = createContext<() => void>(() => {});

/**
 * An app opened this in a popup to ask for access to the account: choose the
 * account, prove it is you, then say what the app gets — as signing in with
 * Google goes. The account signs a note for the app's own key; the seed never
 * leaves this page. The app's address is what is trusted, as the browser
 * reports it, not what it calls itself.
 *
 * Or a program on a computer (`minca connect`, an AI's `minca mcp`) opened it
 * at `/connect#mc_…`: the same steps, for records in the whole account.
 */
export function ConnectPage() {
  const [incoming, setIncoming] = useState<IncomingRequest | null | undefined>(undefined);
  const [answered, setAnswered] = useState<{ allowed: boolean } | null>(null);
  const { state } = useMinca();
  const { auth } = useAuth();
  // The account the person chose in this window, or `other` for one this browser doesn't list.
  const [chosen, setChosen] = useState<string | null>(null);
  // Proof is read off the flow, not its state: a confirm moves this page on by itself.
  const [, setProved] = useState(0);

  // An account made in this window is the one chosen: nobody picks what they just made.
  // Until what it began in the background has reached the app and the host, this window stays.
  const [made, setMade] = useState(false);
  useEffect(
    () =>
      auth.subscribe(({ setup, session }) => {
        if (setup !== 'new' || !session) return;
        setChosen(session.account.id);
        setMade(true);
      }),
    [auth],
  );

  useEffect(() => {
    void (
      code
        ? receiveConnectCode({ code, relays: relayUrls(), onAnswered: setAnswered })
        : receiveConnectRequest()
    ).then(setIncoming);
  }, []);

  if (answered)
    return (
      <Frame title={answered.allowed ? 'Connected' : 'Not connected'}>
        <p>
          {answered.allowed
            ? 'You can close this tab and go back to your AI. It can use Minca now.'
            : 'Nothing was shared. You can close this tab.'}
        </p>
      </Frame>
    );

  if (incoming === undefined)
    return (
      <Frame>
        <p>
          <Loader label={code ? 'Finding the program' : 'Waiting for the app'} showLabel />
        </p>
        {code ? null : <SlowApp />}
      </Frame>
    );

  if (incoming === null && code) {
    return (
      <Frame title="This link was used, or has run out">
        <p>
          The program that opened it isn’t waiting for it any more. Ask it to connect again for a new link. If
          it says it connected and you didn’t allow it here, it joined someone else’s account: disconnect it
          there with <code>minca disconnect</code>.
        </p>
      </Frame>
    );
  }

  if (incoming === null) {
    return (
      <Frame title="Your account home">
        <p>Apps open this page to ask for access to your Minca account. Nothing has asked right now.</p>
        <a href="/">Your account</a>
      </Frame>
    );
  }

  const { request } = incoming;
  const signIn = (
    <Frame>
      <Asking incoming={incoming} />
      <SignIn />
    </Frame>
  );

  // A suggestion from an app already connected gives nothing new: being signed in is enough.
  if (isProposeRequest(request))
    return state?.stage === 'ready' ? <ApproveProposal incoming={incoming} request={request} /> : signIn;

  const choose = async (accountId: string | null) => {
    setChosen(accountId ?? 'other');
    const open = auth.getState().session;
    if (open && open.account.id === accountId) return;
    if (open) await auth.signOut();
    if (accountId) {
      await auth.select(accountId);
      auth.showSignIn();
    } else auth.showWelcome();
  };

  if (!state || state.stage === 'starting') return signIn;
  // No account here yet: making or restoring one is proof enough.
  if (chosen === null && state.accounts.length > 0)
    return <ChooseAccount incoming={incoming} onChoose={(id) => void choose(id)} />;
  if (state.stage !== 'ready') return signIn;

  if (!auth.mayGrant())
    return (
      <Frame>
        <Asking incoming={incoming} step="Confirm it’s you" />
        <WhichAccount label="Continuing as" busy={false} onSwitch={() => setChosen(null)} />
        <ConfirmItsYou
          why={`continue to ${asker(incoming.origin)}`}
          onConfirmed={() => setProved((n) => n + 1)}
          onCancel={() => setChosen(null)}
        />
      </Frame>
    );

  return (
    <ChooseAgain.Provider value={() => setChosen(null)}>
      {request.access === 'carry' ? (
        <ApproveCarrier incoming={incoming} request={request} />
      ) : (
        <Approve incoming={incoming} request={request} made={made} />
      )}
    </ChooseAgain.Provider>
  );
}

/**
 * The first step: which account the app gets. Every account this browser
 * keeps, the one signed in here among them; each asks for its password,
 * passkey or recovery code next.
 */
function ChooseAccount({
  incoming,
  onChoose,
}: {
  incoming: IncomingRequest;
  onChoose: (accountId: string | null) => void;
}) {
  const { state } = useAuth();
  const current = state.session?.account.id ?? null;
  const named = (name: string) => state.accounts.filter((account) => account.name === name).length;
  return (
    <Frame title="Choose an account">
      <p>
        to continue to <strong>{asker(incoming.origin)}</strong>
      </p>
      <ul role="list">
        {state.accounts.map((account) => (
          <li key={account.id}>
            <button
              onClick={() => onChoose(account.id)}
              disabled={state.busy}
              data-intent="open"
              className="row"
            >
              <Avatar did={account.did} size={32} round src={rememberedPicture(account.did)} />
              <span className="stack truncate" data-gap="tight">
                <strong>{account.name}</strong>
                <small>
                  {account.id === current
                    ? 'Signed in'
                    : named(account.name) > 1
                      ? `…${account.did.slice(-6)}`
                      : 'Signed out'}
                </small>
              </span>
            </button>
          </li>
        ))}
        <li>
          <button onClick={() => onChoose(null)} disabled={state.busy} data-intent="open" className="row">
            <span aria-hidden="true">+</span>
            Use another account
          </button>
        </li>
      </ul>
      <small>Next you confirm it’s you, then decide what it gets.</small>
    </Frame>
  );
}

/** After a few seconds: a phone may pause the app's tab while this one is in front */
function SlowApp() {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 4000);
    return () => clearTimeout(timer);
  }, []);
  if (!slow) return null;
  return <p>Taking a while? Switch back to the app's tab for a moment, then come back here.</p>;
}

/** Who is asking, by the address the browser reports — an extension has no host name worth showing */
function asker(origin: string): string {
  const url = new URL(origin);
  return url.protocol === 'chrome-extension:' || url.protocol === 'moz-extension:'
    ? 'A browser extension'
    : url.host;
}

/** A small line above sign-in, so it is clear why this window opened */
function Asking({ incoming, step = 'Sign in' }: { incoming: IncomingRequest; step?: string }) {
  return (
    <aside>
      <strong>
        {!isProposeRequest(incoming.request) && incoming.request.via === 'code'
          ? `A program calling itself “${incoming.request.name ?? 'a program'}”`
          : asker(incoming.origin)}
      </strong>{' '}
      {isProposeRequest(incoming.request)
        ? 'suggests what to notify you about.'
        : 'wants to use your Minca account.'}{' '}
      {step} to decide
      {isProposeRequest(incoming.request) ? '.' : ' what it gets.'}
    </aside>
  );
}

function Approve({
  incoming,
  request,
  made,
}: {
  incoming: IncomingRequest;
  request: ConnectRequest;
  /** The account was made in this window, which holds what it wrote for the app and the host */
  made: boolean;
}) {
  const { origin } = incoming;
  const { auth } = useAuth();
  const session = useSession();
  const host = new URL(origin).host;
  // A program that reached the app with a code is its own key, apart from the app's own connection.
  const byCode = request.via === 'code';
  const recordsOnly = request.recordsOnly === true;
  const previous = auth
    .connections()
    .find((known) =>
      byCode
        ? known.audience === request.audience
        : known.origin === origin && !known.via && known.access !== 'carry',
    );

  const spaces = useSpaces(true);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(
    () => new Set(previous?.spaces.map((space) => space.id) ?? []),
  );
  const { run, busy, error } = useAction();

  const whole = request.scope === 'account';
  const choosing = !whole && request.chooseSpaces !== false;
  const writes = request.access === 'write';
  // Spaces the app can use as asked: to change one, the account must be able to.
  const offered = spaces.filter((space) => !writes || space.writable);
  const privateChosen = offered.some((space) => chosen.has(space.id) && space.visibility === 'private');
  const creating = request.create ?? [];
  // A whole-account app gets the contacts anyway; the box below is for one that asks for them alone.
  const contacts = request.contacts === true && !recordsOnly && !whole;
  const nothing = !whole && !contacts && chosen.size === 0 && creating.length === 0;

  // A program keeps its note only once the person gives it the check code: this page then waits for that.
  const [sent, setSent] = useState(false);
  const [handing, setHanding] = useState(false);
  const grant = () =>
    run(async () => {
      const answer = await auth.grant({ origin, request, spaceIds: [...chosen] });
      // Only an app that reads the contacts reads the inbox: the whole account, or the contacts alone.
      const contacts = answer.scope === 'account' || answer.contactsSpace !== undefined;
      const handed = made
        ? handOver(auth, session.node, contacts ? request.audience : null)
        : Promise.resolve();
      incoming.approve(answer, handed);
      if (incoming.check) return setSent(true);
      setHanding(true);
      await handed;
    });

  if (sent && incoming.check)
    return (
      <Frame title="Now give it the code">
        <p>
          Type this into the terminal where you started it, or tell your AI, so it knows this is your account.
        </p>
        <CheckCode check={incoming.check} />
        <p>
          <Loader label="Waiting for the program" showLabel />
        </p>
      </Frame>
    );

  return (
    <Frame title={byCode ? `Connect “${request.name ?? 'a program'}”` : `Connect to ${host}`}>
      <p>
        {byCode
          ? 'A program on your computer or a server, such as your AI, opened this page. '
          : request.name && <>It calls itself “{request.name}”, and </>}
        {byCode || !request.name ? 'It wants' : 'wants'} to {writes ? 'read and change' : 'read'}{' '}
        {whole ? 'everything in' : 'spaces in'} your account.
        {byCode && ' Allow it only if you started it just now.'}
      </p>

      <WhichAccount label={byCode ? 'The account it will work in' : 'The account it will use'} busy={busy} />

      {incoming.check && (
        <Note title="Its code">
          It can use your account as soon as you allow it, so allow it only if something you started just now
          is asking for this code. Then give it the code, in its terminal or by telling your AI, so it knows
          this is your account.
          <CheckCode check={incoming.check} />
        </Note>
      )}

      {recordsOnly && writes && (
        <>
          <Note title="What it can do">
            Read {whole ? 'every space, including ones you make later' : 'the spaces you pick'}, write records
            in them as you, and propose new collections and apps there. Everything it writes shows as yours,
            and apps can tell it came from a key that may only write records.
          </Note>
          <Note title="What always needs you">
            Adding an app or a collection, changing roles, inviting or removing people, joining or leaving
            spaces. Every device ignores a key like this that tries. It can't sign in as you.
          </Note>
        </>
      )}

      {whole && !recordsOnly && (
        <Note title="Your whole account">
          Every space, private ones too, your direct messages, contacts and contact requests. It can make and
          join spaces for you, but can’t sign in as you or change your password or passkeys.
        </Note>
      )}

      {contacts && (
        <Note title="Your contacts">
          Who is on your contact list, and contact requests sent to you in the spaces it gets. It can change
          the list. Asking someone, or saying yes to a request, also needs your whole account.
        </Note>
      )}

      {choosing && (
        <fieldset>
          <legend>{byCode ? 'Which spaces it may work in' : 'Which spaces'}</legend>
          {offered.length === 0 && <small>You have no spaces it could use.</small>}
          <ul role="list">
            {offered.map((space) => (
              <Tick
                key={space.id}
                on={chosen.has(space.id)}
                onToggle={() => setChosen((was) => toggled(was, space.id))}
                note={`${space.visibility} · ${space.role ?? 'following'}`}
              >
                <Shape {...shapeFor(space.id)} size={18} />
                {space.name}
              </Tick>
            ))}
          </ul>
        </fieldset>
      )}

      {creating.length > 0 && (
        <fieldset>
          <legend>New spaces for it</legend>
          <ul role="list">
            {creating.map((space, index) => (
              <li key={index} className="stack" data-gap="tight">
                <span className="row" data-spread>
                  {space.name}
                  <small>
                    {space.visibility} · {constitution(space, session.did)}
                  </small>
                </span>
                {space.top !== 'none' && cofoundersOf(space, session.did).length > 0 && (
                  <small>
                    Also founders, who hold everything there and can't be removed:{' '}
                    {cofoundersOf(space, session.did).join(', ')}
                  </small>
                )}
              </li>
            ))}
          </ul>
          <small>Made in your account, so your other devices and apps see them too.</small>
        </fieldset>
      )}

      <small>
        Stays in sync for {lasts(request.days ?? 7)}, then asks again. What it changes, and what it sets up to
        run, counts until you disconnect it in your account.
        {(whole || privateChosen) && ' Reading the private spaces it gets can’t be taken back yet.'}
      </small>

      <Answer
        error={error}
        busy={busy}
        blocked={nothing}
        allowLabel={handing ? 'Finishing setting up…' : busy ? 'Giving access…' : 'Allow'}
        proveTo={`continue to ${host}`}
        onAllow={grant}
        onDeny={() => incoming.deny()}
      />

      <small>
        {byCode ? 'The program' : 'The app'} gets a note signed by your account, for its own key. It never
        sees your password.
        {byCode && ' You can disconnect it any time, in your account.'}
      </small>
    </Frame>
  );
}

/** How long the window stays open for the extension to take its passes, at most */
const HAND_OVER_MS = 30_000;

/**
 * Until what this window began for a new account is done and has reached
 * where it goes: the username's claim and the host's handover, then the
 * inbox (when the app reads the contacts) to the app or the host, and the
 * passes to the host, which only this node holds yet.
 */
async function handOver(auth: MincaAuth, node: P2PNode, app: string | null): Promise<unknown> {
  // However long it takes: closed halfway, a name could lead to an inbox no record says it does.
  // The claim's work and requests, and the handover's, end by themselves.
  await auth.settled();
  // A new account has one carrier, if any: the host it was kept online with.
  const carriers = await node.carriers.list();
  const contacts = app && auth.getState().username ? await node.contacts.space() : null;
  const held = (space: string, peers: ReadonlyArray<string>) =>
    firstTrue(peers.map((peer) => node.spaces.reached(space, peer, HAND_OVER_MS)));
  return Promise.all([
    // The app has the inbox, or a host does, which the app syncs it from.
    contacts && app && held(contacts, [app, ...carriers.map((carrier) => carrier.did)]),
    ...carriers.map((carrier) => node.carriers.reached(carrier.space, HAND_OVER_MS)),
  ]);
}

/** True as soon as one of these is; false once all are false */
function firstTrue(waits: ReadonlyArray<Promise<boolean>>): Promise<boolean> {
  return new Promise((resolve) => {
    let left = waits.length;
    if (left === 0) resolve(false);
    for (const wait of waits)
      void wait.then(
        (done) => (done ? resolve(true) : --left === 0 && resolve(false)),
        () => --left === 0 && resolve(false),
      );
  });
}

/**
 * A carrier — the browser extension — asking to keep the spaces online. It
 * gets a pass for each space, never a key: it can hold and pass on what it
 * cannot read.
 */
function ApproveCarrier({ incoming, request }: { incoming: IncomingRequest; request: ConnectRequest }) {
  const { origin } = incoming;
  const { auth, state } = useAuth();
  const session = useSession();
  const { run, busy, error } = useAction();
  const pod = state.place?.kind === 'folder' ? (state.place.directory?.name ?? 'your pod') : null;
  // One extension carries one account: allowing it here moves it off another one.
  const elsewhere = auth.connectedElsewhere(origin);

  const [handing, setHanding] = useState(false);

  const grant = () =>
    run(async () => {
      const grant = await auth.grantCarry({ origin, request });
      // Until the extension has its passes, this window's node may be the only one holding them.
      const reached = session.node.carriers.reached(grant.carry.space, HAND_OVER_MS);
      incoming.approve(grant, reached);
      setHanding(true);
      await reached;
    });

  return (
    <Frame title="Keep your spaces online">
      <p>
        {/* Where it asks from, always: a name is only what the asker calls itself (spec 06 §2.3). */}
        {request.name ? (
          <>
            “{request.name}” (<strong>{asker(origin)}</strong>)
          </>
        ) : (
          asker(origin)
        )}{' '}
        wants to keep your spaces online, even with no app open.
      </p>

      <WhichAccount label="The account it will keep online" busy={busy} />

      {elsewhere.length > 0 && (
        <aside data-tone="danger" className="stack">
          <strong>It keeps {elsewhere.map((account) => `“${account.name}”`).join(' and ')} online now</strong>
          <p>
            It keeps one account online at a time. Allowing it here switches it to {session.account.name}, and{' '}
            {elsewhere.length === 1 ? 'that account stops' : 'those accounts stop'} being kept online. Wanted
            the other one? Choose “Use another account” above.
          </p>
        </aside>
      )}

      <Note title="What it can do">
        Hold your spaces as they travel, with private ones still locked, and pass them on to your other
        devices and the people you share with.
        {pod ? ` Keep your pod, “${pod}”, up to date — it asks you to pick the folder next.` : ''}
      </Note>
      <Note title="What it can't do">
        Read your private spaces, change anything in them, or sign in as you. It never gets your password or a
        space's key.
      </Note>

      <small>
        Like a relay, it can see who wrote something and when, but not what it says. You can disconnect it any
        time in your account.
      </small>

      <Answer
        error={error}
        busy={busy}
        allowLabel={handing ? 'Handing your spaces over…' : busy ? 'Connecting…' : 'Allow'}
        proveTo="keep your spaces online with it"
        onAllow={grant}
        onDeny={() => incoming.deny()}
      />
    </Frame>
  );
}

/**
 * An app already connected, suggesting subscriptions because the person
 * asked it to. Nothing else changes: it gets no access it didn't have, and
 * learns only which of its suggestions the person kept.
 */
function ApproveProposal({ incoming, request }: { incoming: IncomingRequest; request: ProposeRequest }) {
  const { origin } = incoming;
  const { auth } = useAuth();
  const session = useSession();
  const connection = auth
    .connections()
    .find((known) => known.origin === origin && !known.via && known.access !== 'carry');
  const spaces = useSpaces(false);
  const [kept, setKept] = useState<ReadonlySet<number>>(
    () => new Set(request.automations.map((_, index) => index)),
  );
  const { run, busy, error } = useAction();

  const who = connection?.name ?? request.name ?? asker(origin);
  const reachesAll = connection?.scope === 'account';
  const where = (ids: ReadonlyArray<string> | undefined) => {
    if (!ids) return reachesAll ? 'every space' : 'the spaces it has';
    const names = ids.map((id) => spaces.find((space) => space.id === id)?.name ?? 'a space');
    return names.join(', ');
  };

  // The app hears at once; this window stays until the new wakes are written for the browser extension, or a while.
  const allow = () =>
    run(async () =>
      incoming.approve(
        await auth.propose({ origin, request, kept: [...kept] }),
        session.node.carriers.settled(HAND_OVER_MS),
      ),
    );

  if (!connection) {
    return (
      <Frame title="Not connected here">
        <p>
          {asker(origin)} suggested what to notify you about, but it isn't connected to your account,{' '}
          {session.account.name}, in this home. Connect it first — or, if it keeps another account, switch to
          that one.
        </p>
        <button onClick={() => incoming.deny('It is not connected to this account here. Connect it first.')}>
          Close
        </button>
      </Frame>
    );
  }

  return (
    <Frame title="Notify you when…">
      <p>
        “{who}” suggests these for your account, <strong>{session.account.name}</strong>. Keep the ones you
        want.
      </p>

      <section className="stack">
        <ul role="list">
          {request.automations.map((proposal, index) => (
            <Tick
              key={index}
              on={kept.has(index)}
              onToggle={() => setKept((was) => toggled(was, index))}
              note={where(proposal.spaces)}
            >
              {proposal.name}
            </Tick>
          ))}
        </ul>
        <small>
          {who} lets you know itself, while it is open. You can pause or remove these any time in your
          account.
        </small>
      </section>

      <Answer
        error={error}
        busy={busy}
        blocked={kept.size === 0}
        allowLabel={busy ? 'Adding…' : kept.size === 1 ? 'Notify me' : `Notify me about ${kept.size}`}
        onAllow={allow}
        denyLabel="Not now"
        onDeny={() => incoming.deny('You chose not to.')}
      />
    </Frame>
  );
}

/** A line to tick, with a note on the right */
function Tick({
  on,
  onToggle,
  note,
  children,
}: {
  on: boolean;
  onToggle: () => void;
  note: string;
  children: ReactNode;
}) {
  return (
    <li>
      <label>
        <input type="checkbox" checked={on} onChange={onToggle} />
        <span className="row truncate">{children}</span>
        <small>{note}</small>
      </label>
    </li>
  );
}

/** The set with `item` taken out if it was in, put in if it wasn't */
function toggled<T>(set: ReadonlySet<T>, item: T): Set<T> {
  const next = new Set(set);
  if (next.has(item)) next.delete(item);
  else next.add(item);
  return next;
}

/**
 * The account's spaces, asked again as spaces arrive: one made in an app a
 * moment ago may still be on its way here. With `hold`, a space whose role
 * isn't known yet is opened, which syncs its access history and so its role.
 */
function useSpaces(hold: boolean): ReadonlyArray<SpaceSummary> {
  const [opened] = useState(() => new Set<string>());
  const spaces = useWatched(
    async (node) => {
      const found = await node.spaces.list();
      for (const space of found) {
        if (!hold || space.role !== null || opened.has(space.id)) continue;
        opened.add(space.id);
        void node.spaces.hold(space.id).catch(() => {});
      }
      return found;
    },
    [hold],
    { when: (event) => event.type === 'spaces' || event.type === 'account' || event.type === 'records' },
  );
  return spaces ?? [];
}

/**
 * Who is signed in here, and a way to answer as someone else: the request
 * waits while the person signs in to another account, and is answered from it.
 */
function WhichAccount({ label, busy, onSwitch }: { label: string; busy: boolean; onSwitch?: () => void }) {
  const chooseAgain = useContext(ChooseAgain);
  const session = useSession();
  const picture = useAccountPicture();
  return (
    <div className="row">
      <Avatar did={session.did} size={32} src={picture} />
      <div className="stack truncate" data-gap="tight">
        <strong>{session.account.name}</strong>
        <small>{label}</small>
      </div>
      <button onClick={onSwitch ?? chooseAgain} disabled={busy} data-intent="ghost">
        Use another account
      </button>
    </div>
  );
}

/** A boxed explanation: what something may do, or may not */
function Note({ title, children }: { title: string; children: ReactNode }) {
  return (
    <aside className="stack" data-gap="tight">
      <strong>{title}</strong>
      <small>{children}</small>
    </aside>
  );
}

/**
 * What went wrong, if anything, then the two answers to a request. With
 * `proveTo`, allowing is a grant: proof given on the way here lasts a few
 * minutes, and after that it asks again first.
 */
function Answer({
  error,
  busy,
  blocked = false,
  allowLabel,
  proveTo,
  onAllow,
  denyLabel = "Don't allow",
  onDeny,
}: {
  error: string | null;
  busy: boolean;
  /** Nothing to allow yet */
  blocked?: boolean;
  allowLabel: string;
  /** What proving it is you is for, when allowing grants access */
  proveTo?: string;
  onAllow: () => Promise<unknown>;
  denyLabel?: string;
  onDeny: () => void;
}) {
  const { auth } = useAuth();
  const [proving, setProving] = useState(false);
  if (proving && proveTo)
    return (
      <ConfirmItsYou
        why={proveTo}
        onConfirmed={() => {
          setProving(false);
          void onAllow();
        }}
        onCancel={() => setProving(false)}
      />
    );
  const allow = () => (proveTo && !auth.mayGrant() ? setProving(true) : void onAllow());
  return (
    <>
      {error && <aside data-tone="danger">{error}</aside>}
      <div className="stack">
        <button onClick={allow} disabled={busy || blocked} data-intent="primary">
          {allowLabel}
        </button>
        <button onClick={onDeny} disabled={busy}>
          {denyLabel}
        </button>
      </div>
    </>
  );
}

/** The other founders an app names, each once, never the person themselves */
function cofoundersOf(space: NewSpace, me: string): string[] {
  return [...new Set(space.cofounders ?? [])].filter((did) => did !== me);
}

/**
 * A new space's constitution in a few words: who founds it, and its roles.
 * "You found it · Admin, Member"; "No founder · Steward, Member".
 */
function constitution(space: NewSpace, me: string): string {
  const roles = (space.roles ?? []).map((role) => role.title ?? role.name);
  const others = cofoundersOf(space, me).length;
  const top =
    space.top === 'none'
      ? 'No founder'
      : others
        ? `You and ${others === 1 ? 'one other' : `${others} others`} found it`
        : roles.length
          ? 'You found it'
          : 'Just you';
  return roles.length ? `${top} · ${roles.join(', ')}` : top;
}

/** The six digits a program connected by code needs, in two groups: "482 913" */
function CheckCode({ check }: { check: string }) {
  return (
    <span className={styles.check}>
      {check.slice(0, 3)} {check.slice(3)}
    </span>
  );
}

/** "7 days", "1 year" */
function lasts(days: number): string {
  if (days >= 365) return days === 365 ? '1 year' : `${Math.round(days / 365)} years`;
  return days === 1 ? '1 day' : `${days} days`;
}

/** The page around it, under Minca's mark; the sign-in element's own is hidden in the home's styles */
function Frame({ title, children }: { title?: ReactNode; children: ReactNode }) {
  return (
    <main className={styles.frame}>
      <Wordmark />
      {title && <h1>{title}</h1>}
      {children}
    </main>
  );
}
