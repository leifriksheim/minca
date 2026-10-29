/**
 * Small menus that open from a button, as chat apps have them: "+" to attach
 * or share, an emoji picker, and the reactions on a record made with it.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { useRecords, usePeople } from './hooks';
import { html } from './html';

const REACTION = 'std.reaction';

/** Emoji to pick from: the ones people reach for, a row each of faces, hands, hearts and things */
const EMOJIS = [
  '😀',
  '😂',
  '🥹',
  '😊',
  '😍',
  '🥳',
  '😎',
  '🤔',
  '😮',
  '😢',
  '😡',
  '😴',
  '🙃',
  '😅',
  '🤯',
  '🫠',
  '👍',
  '👎',
  '👏',
  '🙌',
  '🙏',
  '💪',
  '👋',
  '🤝',
  '❤️',
  '🧡',
  '💛',
  '💚',
  '💙',
  '💜',
  '🖤',
  '💔',
  '🔥',
  '✨',
  '🎉',
  '✅',
  '❌',
  '⭐',
  '💯',
  '👀',
  '☕',
  '🍕',
  '🍻',
  '🎂',
  '🌱',
  '☀️',
  '🌧️',
  '🚀',
];

/** Open until a pick, Escape, or a press anywhere outside `box` */
function useOpen() {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (event: Event) => {
      const outside = event.target instanceof Node && !box.current?.contains(event.target);
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : outside) setOpen(false);
    };
    addEventListener('pointerdown', away);
    addEventListener('keydown', away);
    return () => {
      removeEventListener('pointerdown', away);
      removeEventListener('keydown', away);
    };
  }, [open]);
  return { open, setOpen, box };
}

/**
 * "+": a menu to attach files, when `onFiles` is given (the app keeps
 * std.file), and to share something from the space.
 */
export function AddMenu({
  onShare,
  onFiles,
}: {
  onShare: () => void;
  onFiles?: ((files: File[]) => void) | null;
}) {
  const { open, setOpen, box } = useOpen();
  const picker = useRef<HTMLInputElement>(null);
  const choose = (then: () => void) => {
    setOpen(false);
    then();
  };
  return html`<div class="menu-anchor" ref=${box}>
    <button
      type="button"
      data-variant="ghost"
      data-icon
      class="menu-button"
      aria-label="Attach or share"
      aria-expanded=${open}
      onClick=${() => setOpen(!open)}
    >
      +
    </button>
    ${
      open &&
      html`<ul class="suggestions above menu" role="menu">
        ${onFiles && html`<li role="menuitem" onClick=${() => choose(() => picker.current?.click())}>Upload a file</li>`}
        <li role="menuitem" onClick=${() => choose(onShare)}>Share from this space</li>
      </ul>`
    }
    ${
      onFiles &&
      html`<input
        ref=${picker}
        type="file"
        multiple
        hidden
        onChange=${(event: Event) => {
          if (!(event.currentTarget instanceof HTMLInputElement)) return;
          onFiles([...(event.currentTarget.files ?? [])]);
          event.currentTarget.value = '';
        }}
      />`
    }
  </div>`;
}

/** How wide and tall the grid of emoji is, to tell which way it fits */
const GRID = { width: 280, height: 220 };

/**
 * A button that opens a grid of emoji; `onPick` gets the one chosen. The grid
 * opens above the button, or below it near the top, and leftwards near the
 * right edge, so it is never cut off.
 */
export function EmojiPicker({
  onPick,
  label = 'Add an emoji',
  icon = '🙂',
}: {
  onPick: (emoji: string) => void;
  label?: string;
  icon?: string;
}) {
  const { open, setOpen, box } = useOpen();
  const [side, setSide] = useState('');
  const toggle = () => {
    const at = box.current?.getBoundingClientRect();
    if (at)
      setSide(
        `${at.top < GRID.height + 16 ? ' below' : ''}${at.left + GRID.width > innerWidth - 8 ? ' right' : ''}`,
      );
    setOpen(!open);
  };
  return html`<div class="menu-anchor" ref=${box}>
    <button
      type="button"
      data-variant="ghost"
      data-icon
      class="menu-button"
      aria-label=${label}
      title=${label}
      aria-expanded=${open}
      onClick=${toggle}
    >
      ${icon}
    </button>
    ${
      open &&
      html`<div class=${`emoji-grid${side}`} role="listbox" aria-label="Emoji">
        ${EMOJIS.map(
          (emoji) =>
            html`<button
              type="button"
              key=${emoji}
              role="option"
              onClick=${() => {
                setOpen(false);
                onPick(emoji);
              }}
            >
              ${emoji}
            </button>`,
        )}
      </div>`
    }
  </div>`;
}

interface ReactionBody {
  readonly emoji?: string;
}

/**
 * The emoji reactions on a record, std.reaction about it: one pill per emoji
 * with how many, yours pressed, a click adding or taking back yours. Needs
 * "std.reaction" in the app's collections.
 */
export function Reactions({
  about,
  adding = true,
}: {
  about: { key: string; createdBy?: string };
  /** Show a button to add one; off where the record shows its own */
  adding?: boolean;
}) {
  const reactions = useRecords<ReactionBody>(REACTION, { 'link:about': about.key });
  const people = usePeople();
  const me = minca.me.did;
  if (!reactions) return null;
  const groups = new Map<string, typeof reactions>();
  for (const r of reactions)
    if (typeof r.body?.emoji === 'string') groups.set(r.body.emoji, [...(groups.get(r.body.emoji) ?? []), r]);
  if (groups.size === 0 && !adding) return null;
  const nameOf = (did: string) =>
    did === me ? 'You' : (people.find((p) => p.did === did)?.name ?? 'Someone');
  return html`<div class="reactions">
    ${[...groups].map(([emoji, these]) => {
      const mine = these.find((r) => r.createdBy === me);
      return html`<button
        type="button"
        key=${emoji}
        class="reaction"
        aria-pressed=${!!mine}
        title=${these.map((r) => nameOf(r.createdBy ?? '')).join(', ')}
        onClick=${() => (mine ? minca.remove(mine.key) : react(about, emoji))}
      >
        ${emoji} <span>${these.length}</span>
      </button>`;
    })}
    ${
      adding &&
      groups.size > 0 &&
      html`<${EmojiPicker}
        label="Add a reaction"
        onPick=${(emoji: string) => void react(about, emoji).catch(() => null)}
      />`
    }
  </div>`;
}

/**
 * Reacts to a record with an emoji, as the person looking. The same one again
 * is refused by std.reaction's rules (one of each per person), which is why
 * callers may let that refusal go.
 */
export function react(about: { key: string; createdBy?: string }, emoji: string) {
  const me = minca.me.did;
  return minca.put(
    REACTION,
    { emoji, ...(about.createdBy && about.createdBy !== me ? { respondingTo: about.createdBy } : {}) },
    { links: [{ rel: 'about', to: about.key }] },
  );
}
