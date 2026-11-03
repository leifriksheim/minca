import { useEffect, useMemo, useState } from 'react';
import type { OwnAutomationView, P2PNode, SpaceSummary } from '@minca/core/node';
import { message, useAction } from '@minca/app-shared/action';
import { Shape } from '@minca/app-shared/shapes';
import { Toggle } from '@minca/app-shared/Toggle';
import { shapeFor } from '@minca/ui/shapes';

/**
 * "Notify me when…": what apps asked to let you know about, and you allowed.
 *
 * Only an app adds one, when you ask it to, and you say yes here in the home;
 * the home itself adds none. Each shows under the app that asked, which shows
 * the notifications itself. Here you pause or remove them.
 */
export function Notifications({ node }: { node: P2PNode }) {
  const [subscriptions, setSubscriptions] = useState<ReadonlyArray<OwnAutomationView> | null>(null);
  const [spaces, setSpaces] = useState<ReadonlyArray<SpaceSummary>>([]);
  const [doing, setDoing] = useState<string | null>(null);
  const { run, busy: acting, error, setError } = useAction();
  const busy = acting ? doing : null;

  useEffect(() => {
    void node.automations.list().then(setSubscriptions, (reason: unknown) => setError(message(reason)));
    void node.spaces.list().then(setSpaces, () => {});
    // Linked to from an app: straight here.
    if (location.hash === '#notifications') document.getElementById('notifications')?.scrollIntoView();
  }, [node, setError]);

  const spaceName = (id: string) => spaces.find((space) => space.id === id)?.name ?? 'a space';

  const act = (what: string, work: () => Promise<void>) => {
    setDoing(what);
    return run(async () => {
      await work();
      setSubscriptions(await node.automations.list());
    });
  };

  // By the app that asked; ones made here before, last.
  const groups = useMemo(() => {
    const byApp = new Map<string, [OwnAutomationView['app'], OwnAutomationView[]]>();
    for (const sub of subscriptions ?? []) {
      const at = sub.app?.origin ?? '';
      if (!byApp.has(at)) byApp.set(at, [sub.app, []]);
      byApp.get(at)![1].push(sub);
    }
    return [...byApp.entries()]
      .sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)))
      .map(([, group]) => group);
  }, [subscriptions]);

  return (
    <article id="notifications">
      <div className="stack" data-gap="tight">
        <h2>Notify me when…</h2>
        <small>What apps asked to tell you about, and you allowed. Switch one off to pause it.</small>
      </div>

      {subscriptions?.length === 0 && (
        <small>Nothing yet. An app asks first, when you turn its notifications on.</small>
      )}

      {groups.map(([app, subs]) => (
        <div key={app?.origin ?? ''} className="stack">
          <div className="row">
            <Shape {...shapeFor(app?.origin ?? 'here')} size={24} />
            <strong>{app ? (app.name ?? new URL(app.origin).host) : 'Made here before'}</strong>
            {app?.name && <small>{new URL(app.origin).host}</small>}
          </div>
          <ul role="list">
            {subs.map((sub) => (
              <li key={sub.id} className="row">
                <span className="stack truncate" data-gap="tight">
                  <strong>{sub.name}</strong>
                  <small>
                    {(sub.spaces ?? 'all') === 'all'
                      ? 'Every space'
                      : [...(sub.spaces ?? [])].map(spaceName).join(', ')}
                    {sub.paused ? ' · Paused' : ''}
                  </small>
                </span>
                <Toggle
                  on={!sub.paused}
                  label={`${sub.name}: ${sub.paused ? 'off' : 'on'}`}
                  disabled={busy !== null}
                  onChange={(on) =>
                    void act(
                      `pause:${sub.id}`,
                      async () => void (await node.automations.update(sub.id, { paused: !on })),
                    )
                  }
                />
                <button
                  onClick={() => void act(`remove:${sub.id}`, () => node.automations.remove(sub.id))}
                  disabled={busy !== null}
                  aria-label={`Remove ${sub.name}`}
                  title="Remove"
                  data-intent="quiet"
                  data-icon
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}

      {error && <p role="alert">{error}</p>}
    </article>
  );
}
