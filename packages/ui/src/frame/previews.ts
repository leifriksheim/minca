/**
 * A link's preview under the text that sends it, as a chat shows one: the
 * site, the page's title and a line or two about it, and its picture, small
 * beside them or, when the page asks for it, across the card. The page around
 * the screen reads the page (`minca.preview`); a preview is drawn, never kept.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { useSeen } from './attachments';
import { html } from './html';
import type { LinkPreview } from './minca';

/** How many links in one text get a card: the first ones */
const MAX_CARDS = 3;
/** How many answers a screen keeps, so a card drawn again draws at once */
const KEPT = 200;
const known = new Map<string, LinkPreview | null>();

/** Opens the page through the page around the screen: a screen can't open one itself */
const opener = (url: string) => (event: Event) => {
  event.preventDefault();
  void minca.link(url);
};

/** One link's card, asked for once it comes into view; nothing when the page says nothing about itself */
function LinkCard({ url }: { url: string }) {
  const spot = useRef<HTMLSpanElement>(null);
  const seen = useSeen(spot);
  const [preview, setPreview] = useState(known.get(url));
  useEffect(() => {
    if (!seen || preview !== undefined) return;
    let live = true;
    minca.preview(url).then(
      (found) => {
        known.set(url, found);
        if (known.size > KEPT) known.delete(known.keys().next().value ?? '');
        if (live) setPreview(found);
      },
      () => live && setPreview(null),
    );
    return () => {
      live = false;
    };
  }, [seen, url, preview]);
  if (!preview) return preview === undefined ? html`<span ref=${spot} />` : null;
  const { title, description, site, image, large } = preview;
  return html`<a
    class="link-card"
    href=${url}
    title=${url}
    data-large=${(large && image) || undefined}
    onClick=${opener(url)}
  >
    <span class="link-card-text">
      <small class="truncate">${site}</small>
      <strong>${title}</strong>
      ${description && html`<span>${description}</span>`}
    </span>
    ${image && html`<img src=${image} alt="" />`}
  </a>`;
}

/**
 * Cards for the links a text sends, the first few, at the end of the text:
 * a span, so a one-line text stays one element, and empty until a card comes.
 */
export function LinkPreviews({ links }: { links: ReadonlyArray<string> }) {
  if (!links.length) return null;
  return html`<span class="link-cards">
    ${links.slice(0, MAX_CARDS).map((url) => html`<${LinkCard} key=${url} url=${url} />`)}
  </span>`;
}
