import { avatarFit, avatarRadius, avatarShape } from '../avatar';
import { remembered, useAnswer, usePeople } from './hooks';
import { html } from './html';

/** Pictures by account, asked for once for the life of the screen */
const pictures = remembered<string | null>();

/** Someone's face: the picture they chose, or the shape their account gives, the same as everywhere in the app */
export function Avatar({ did, size = 28, round = false }: { did: string; size?: number; round?: boolean }) {
  const src = useAnswer(() => pictures(did, () => minca.picture(did).catch(() => null)), [did]);
  const { d, fill, ground } = avatarShape(did);
  const style = `width:${size}px;height:${size}px;border-radius:${avatarRadius(size, round)};background:${ground};flex-shrink:0;display:block;object-fit:cover`;
  if (src) return html`<img src=${src} width=${size} height=${size} alt="" style=${style} />`;
  return html`<svg width=${size} height=${size} viewBox="0 0 100 100" aria-hidden="true" style=${style}>
    <path d=${d} fill=${fill} transform=${avatarFit(round)} />
  </svg>`;
}

/** Someone's name here: "You" for the person looking */
export function useName(did: string | null | undefined): string {
  const people = usePeople();
  if (did && did === minca.me.did) return 'You';
  return people.find((one) => one.did === did)?.name ?? 'Someone';
}

/** Someone by face and name, or by name alone where their face is shown beside it; clicking opens their card in the app */
export function Person({
  did,
  size = 20,
  name,
  face = true,
}: {
  did: string;
  size?: number;
  name?: string;
  face?: boolean;
}) {
  const known = useName(did);
  return html`<button
    type="button"
    class="person"
    onClick=${(event: Event) => {
      // People sit in rows that open things of their own; this click is for the person.
      event.stopPropagation();
      void minca.open({ person: did });
    }}
  >
    ${face && html`<${Avatar} did=${did} size=${size} round />`}
    <span>${name ?? known}</span>
  </button>`;
}

/**
 * Something someone said, as chat apps and comments show it: their face in a column of its own, their name and the
 * time above the words. A later line in a run of theirs leaves the face out (face={false}) and shows the time there
 * while pointed at. Attributes like id go on the line itself.
 */
export function Said({
  did,
  time,
  face = true,
  children,
  ...line
}: {
  did: string;
  time: string;
  face?: boolean;
  children?: unknown;
  [attribute: string]: unknown;
}) {
  return html`<div class="said" ...${line}>
    ${face ? html`<${Avatar} did=${did} size=${36} round />` : html`<small>${time}</small>`}
    <div class="stack" data-gap="tight">
      ${
        face &&
        html`<div class="row" data-gap="tight">
          <strong><${Person} did=${did} face=${false} /></strong><small>${time}</small>
        </div>`
      }
      ${children}
    </div>
  </div>`;
}
