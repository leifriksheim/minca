import { useEffect, useMemo, useState } from 'react';
import type { OwnAutomationView, P2PNode, SpaceSummary } from '@minca/core/node';
import { message, useAction } from '@minca/app-shared/action';
import { Shape } from '@minca/app-shared/shapes';
import { Toggle } from '@minca/app-shared/Toggle';
import { shapeFor } from '@minca/ui/shapes';
import { styles, palette, stack } from '../styles';

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
    <section id="notifications" className="surface" style={styles.settingsSection}>
      <div>
        <h2 style={styles.sectionHeading}>Notify me when…</h2>
        <p style={styles.sectionText}>
          What apps asked to tell you about, and you allowed. Switch one off to pause it.
        </p>
      </div>

      {subscriptions?.length === 0 && (
        <p style={styles.errorHint}>Nothing yet. An app asks first, when you turn its notifications on.</p>
      )}

      {groups.map(([app, subs]) => (
        <div key={app?.origin ?? ''} style={stack(8)}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Shape {...shapeFor(app?.origin ?? 'here')} size={24} />
            <strong style={{ fontSize: 14, color: palette.ink.strong }}>
              {app ? (app.name ?? new URL(app.origin).host) : 'Made here before'}
            </strong>
            {app?.name && <span style={styles.faint}>{new URL(app.origin).host}</span>}
          </div>
          <ul className="rows" style={styles.list}>
            {subs.map((sub) => (
              <li key={sub.id} style={row}>
                <span style={{ ...stack(1), flex: 1, minWidth: 0, opacity: sub.paused ? 0.55 : 1 }}>
                  <span style={{ fontSize: 14, fontWeight: 500, color: palette.ink.strong }}>{sub.name}</span>
                  <span style={styles.faint}>
                    {(sub.spaces ?? 'all') === 'all'
                      ? 'Every space'
                      : [...(sub.spaces ?? [])].map(spaceName).join(', ')}
                    {sub.paused ? ' · Paused' : ''}
                  </span>
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
                  data-variant="ghost"
                  style={remove}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}

      {error && <p style={{ ...styles.errorHint, color: palette.accent.danger }}>{error}</p>}
    </section>
  );
}

const row = { display: 'flex', alignItems: 'center', gap: 12, padding: '10px 10px 10px 14px' } as const;

/** Taking one away for good: a quiet × beside its switch */
const remove = {
  ...styles.smallButton,
  border: 'none',
  background: 'none',
  width: 30,
  height: 30,
  minHeight: 30,
  padding: 0,
  display: 'grid',
  placeItems: 'center',
  fontSize: 16,
  color: palette.ink.muted,
} as const;
