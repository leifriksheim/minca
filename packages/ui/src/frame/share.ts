/**
 * Sharing a record into what a screen sends, as the chat and comments do:
 * "/" typed into an empty box, or a button, asks the person to choose one
 * anywhere in the space (`minca.pick`). It waits as a chip and goes with what
 * is sent next as a "shares" link; the record sent then shows it as a card.
 */
import { useEffect, useState } from 'preact/hooks';
import { html } from './html';
import type { ScreenRecord } from './minca';
import { Record, recordTitle } from './record';

/** A record waiting to be shared, and how to choose one, take it off, and send it */
export interface Share {
  readonly sharing: ScreenRecord | null;
  readonly error: string | null;
  /** Asks the person to choose a record; focus goes back to the box it is for */
  readonly pick: () => Promise<void>;
  readonly clear: () => void;
  /** For a box's onChange: "/" typed into an empty one picks rather than types */
  readonly typed: (draft: string, next: string) => string;
  /** The links for what is sent next: a "shares" to the record, or none */
  readonly links: ReadonlyArray<{ rel: string; to: string }>;
}

export function useShare(): Share {
  const [sharing, setSharing] = useState<ScreenRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pick = async () => {
    // Where the person goes on typing: the box itself, or the one beside the button they pressed
    const active = document.activeElement;
    const back =
      active instanceof HTMLButtonElement
        ? active.form?.querySelector('input:not([type="file"]):not([hidden]), textarea')
        : active;
    setError(null);
    try {
      const picked = await minca.pick();
      if (picked) setSharing(picked);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    if (back instanceof HTMLElement) back.focus();
  };
  return {
    sharing,
    error,
    pick,
    clear: () => setSharing(null),
    typed: (draft, next) => {
      if (draft || next !== '/') return next;
      void pick();
      return draft;
    },
    links: sharing ? [{ rel: 'shares', to: sharing.key }] : [],
  };
}

/** The record waiting to be shared, as a chip that takes it off */
export function Sharing({ share }: { share: Share }) {
  if (!share.sharing) return null;
  return html`<button type="button" class="chip" title="Don't share it" onClick=${share.clear}>
    ↗ ${recordTitle(share.sharing)} ✕
  </button>`;
}

/** What `from` shares, read through its link, as a card that opens it in the app that shows it */
export function Shared({ from }: { from: ScreenRecord }) {
  const shares = from.links.some((link) => link.rel === 'shares');
  const [record, setRecord] = useState<ScreenRecord | null | undefined>(undefined);
  useEffect(() => {
    if (!shares) return;
    const load = () => {
      minca.get(from.key, { link: 'shares' }).then(setRecord, () => setRecord(null));
    };
    load();
    return minca.onChange(load);
  }, [from.key, shares]);
  if (!shares || record === undefined) return null;
  if (record === null) return html`<p class="faint">Shared something that isn't here.</p>`;
  return html`<div class="shared">
    <${Record} record=${record} onOpen=${() => minca.open({ record: from.key, link: 'shares' })} />
  </div>`;
}
