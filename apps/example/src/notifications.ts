/** Notifications: each app's `notify` offered through the account home, then matched and shown by this app while it is open. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAccount, useConnection, useNode } from '@minca/core/react';
import {
  MAX_PROPOSALS,
  ownQuery,
  watchNotifications,
  type AutomationProposal,
  type OwnAutomationView,
} from '@minca/core';
import { accountHomeLink } from '@minca/core/session';
import { notifyOn, type AppAutomation } from '@minca/core/schemas';
import { APPS } from './components/apps';
import { isForMe, madeNotify, needsOf } from './components/apps/entries';
import { launcherApp, sortLauncher, type LauncherApp } from './components/apps/launcher';
import { message } from '@minca/app-shared/action';
import { addAlert } from './alerts';

/** Offered whatever apps a space has */
const CONTACTS: AutomationProposal = notifyOn('Someone asks to be your contact', 'std.contact-request');

const supported = () => typeof globalThis.Notification === 'function';

/** What an automation looks for, as the same thing asked for again would be */
const lookingFor = (own: Pick<AppAutomation, 'when'>) =>
  `${own.when.query.collection} ${JSON.stringify(own.when.query.where ?? null)}`;

/** The same, for one the account keeps */
const keptFor = (own: OwnAutomationView) => lookingFor({ when: { query: ownQuery(own) } });

/** This app's automations, as the account keeps them */
export function useOwnAutomations(): ReadonlyArray<OwnAutomationView> {
  const node = useNode();
  const [mine, setMine] = useState<ReadonlyArray<OwnAutomationView>>([]);
  useEffect(() => {
    let live = true;
    const load = () =>
      void node.automations
        .list()
        .then((all) => live && setMine(all.filter((own) => own.app?.origin === globalThis.location.origin)))
        .catch(() => {});
    load();
    const stop = node.subscribe((event) => {
      if (event.type === 'records' || event.type === 'account') load();
    });
    return () => {
      live = false;
      stop();
    };
  }, [node]);
  return mine;
}

/** One proposal, as the same thing asked for again would be */
const proposalKey = (proposal: AutomationProposal) =>
  `${lookingFor(proposal)} ${proposal.spaces?.join(',') ?? 'all'}`;

/** Asks the browser, then the home, from the click; what the home kept counts as on at once, before the account space syncs */
export function useAsk() {
  const { connection, state } = useConnection();
  const [permission, setPermission] = useState(() => (supported() ? Notification.permission : 'denied'));
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [kept, setKept] = useState<ReadonlySet<string>>(() => new Set());

  // Allowed or blocked in the browser's own site settings: follow it there too.
  useEffect(() => {
    let status: PermissionStatus | null = null;
    const follow = () => supported() && setPermission(Notification.permission);
    void globalThis.navigator?.permissions
      ?.query({ name: 'notifications' })
      .then((found) => {
        status = found;
        found.addEventListener('change', follow);
      })
      .catch(() => {});
    return () => status?.removeEventListener('change', follow);
  }, []);

  /** Resolves to whether the person kept any of them */
  const ask = useCallback(
    (proposals: ReadonlyArray<AutomationProposal>): Promise<boolean> => {
      setError(null);
      // Everything asked for is on already: nothing to open the home for.
      if (proposals.length === 0) return Promise.resolve(true);
      if (!supported()) {
        setError('This browser can’t show notifications.');
        return Promise.resolve(false);
      }
      if (Notification.permission === 'denied') {
        setError('Notifications are blocked for this site in your browser’s settings.');
        return Promise.resolve(false);
      }
      const asking =
        Notification.permission === 'granted'
          ? Promise.resolve('granted' as const)
          : Notification.requestPermission();
      const proposing = connection.propose(proposals);
      void asking.then(setPermission);
      setAsking(true);
      return proposing
        .then((answer) => {
          const names = new Set(answer.automations.map((own) => own.name));
          const yes = proposals.filter((proposal) => names.has(proposal.name.trim()));
          setKept((was) => new Set([...was, ...yes.map(proposalKey)]));
          return yes.length > 0;
        })
        .catch((failed: unknown) => {
          setError(message(failed));
          return false;
        })
        .finally(() => setAsking(false));
    },
    [connection],
  );

  const allow = useCallback(() => {
    if (supported()) void Notification.requestPermission().then(setPermission);
  }, []);

  const manage = useCallback(() => {
    const did = state.grant?.did;
    const url = did
      ? accountHomeLink(state.home, did, 'notifications')
      : `${new URL('.', state.home).href}#notifications`;
    globalThis.open(url, 'minca-account', 'popup,width=720,height=820');
  }, [state.home, state.grant?.did]);

  return { permission, error, asking, kept, ask, allow, manage };
}

/** Everything this app can notify about, in every space, worked out before the click that opens the home's popup */
function useEverything(): ReadonlyArray<AutomationProposal> {
  const node = useNode();
  const [offers, setOffers] = useState<ReadonlyArray<AutomationProposal>>(() => gather([]));
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      const made: LauncherApp[] = [];
      for (const space of await node.spaces.list()) {
        const [records, collections, access] = await Promise.all([
          node.records.list<LauncherApp>(space.id, { collection: launcherApp.name }),
          node.collections.list(space.id),
          node.spaces.access(space.id),
        ]).catch(() => [[], [], null] as const);
        for (const record of sortLauncher(records, collections, access, needsOf).placed)
          if (record.body && record.body.builtIn === undefined) made.push(record.body);
      }
      if (live) setOffers(gather(made));
    };
    void load();
    // Apps come and go with records; one look a little after a burst of them is enough.
    const stop = node.subscribe((event) => {
      if (event.type !== 'records') return;
      clearTimeout(timer);
      timer = setTimeout(() => void load(), 1500);
    });
    return () => {
      live = false;
      clearTimeout(timer);
      stop();
    };
  }, [node]);
  return offers;
}

/** Contact requests, the built-in apps and these made ones, once each, as many as one request may carry */
function gather(made: ReadonlyArray<LauncherApp>): ReadonlyArray<AutomationProposal> {
  const all = [CONTACTS, ...APPS.flatMap((app) => app.notify), ...made.flatMap(madeNotify)];
  const once = new Map(all.map((offer) => [lookingFor(offer), offer]));
  return [...once.values()].slice(0, MAX_PROPOSALS);
}

/** This app's notifications as the account keeps them, and turning them all on */
export function useAppNotifications() {
  const mine = useOwnAutomations();
  const everything = useEverything();
  const { permission, error, asking, kept, ask, allow, manage } = useAsk();
  // What is on everywhere already is not asked for again.
  const turnOn = useCallback(
    () =>
      void ask(
        everything.filter(
          (offer) =>
            !kept.has(proposalKey(offer)) &&
            !mine.some((own) => (own.spaces ?? 'all') === 'all' && keptFor(own) === lookingFor(offer)),
        ),
      ),
    [ask, everything, kept, mine],
  );
  return {
    on: mine.filter((own) => !own.paused).length,
    permission,
    error,
    asking,
    turnOn,
    allow,
    manage,
  };
}

/** One app's notifications in one space (all, or only what names you): whether each is on, and turning one on */
export function useNotifyFor(spaceId: string, offers: ReadonlyArray<AppAutomation>) {
  const mine = useOwnAutomations();
  const { permission, error, asking, kept, ask, allow, manage } = useAsk();
  const covers = (offer: AppAutomation) =>
    kept.has(proposalKey({ ...offer, spaces: [spaceId] })) ||
    mine.some((own) => {
      const spaces = own.spaces ?? 'all';
      return (
        !own.paused && (spaces === 'all' || spaces.includes(spaceId)) && keptFor(own) === lookingFor(offer)
      );
    });
  const everything = offers.filter((offer) => !isForMe(offer));
  const forMe = offers.filter(isForMe);
  const turnOn = (which: ReadonlyArray<AppAutomation>) =>
    void ask(which.filter((offer) => !covers(offer)).map((offer) => ({ ...offer, spaces: [spaceId] })));
  return {
    everything,
    forMe,
    on: {
      everything: everything.length > 0 && everything.every(covers),
      forMe: forMe.length > 0 && forMe.every(covers),
    },
    permission,
    error,
    asking,
    turnOn,
    allow,
    manage,
  };
}

/** How long to wait for every automation a record matches, before showing one notification for it */
const GATHER_MS = 150;

/**
 * What this app's automations match: each goes in the bell, and is shown as a notification
 * while nobody looks. A record several match is one, under the most particular.
 */
export function useShowNotifications(openSpace: (id: string) => void) {
  const node = useNode();
  const { did } = useAccount();
  const open = useRef(openSpace);
  open.current = openSpace;
  useEffect(() => {
    const waiting = new Map<
      string,
      { label: string; particular: boolean; timer: ReturnType<typeof setTimeout> }
    >();
    const show = (key: string, label: string, spaceId: string) => {
      waiting.delete(key);
      addAlert(did, { record: key, space: spaceId, label, at: new Date().toISOString() });
      if (!supported() || Notification.permission !== 'granted' || globalThis.document.hasFocus()) return;
      void node.spaces.get(spaceId).then((space) => {
        const shown = new Notification(label, { body: space ? `In ${space.name}` : '', tag: key });
        shown.onclick = () => {
          globalThis.focus();
          open.current(spaceId);
          shown.close();
        };
      });
    };
    const stop = watchNotifications(node, {
      onNotify: ({ automation, record }) => {
        const particular = automation.when?.query.where !== undefined;
        const label = automation.then.kind === 'notify' ? automation.then.text : automation.name;
        const before = waiting.get(record.key);
        if (before && (before.particular || !particular)) return;
        if (before) clearTimeout(before.timer);
        const timer = setTimeout(() => show(record.key, label, record.space), GATHER_MS);
        waiting.set(record.key, { label, particular, timer });
      },
    });
    return () => {
      stop();
      for (const { timer } of waiting.values()) clearTimeout(timer);
    };
  }, [node, did]);
}
