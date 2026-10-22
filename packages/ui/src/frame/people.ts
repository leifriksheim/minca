import { useEffect, useState } from 'preact/hooks';
import { avatarFit, avatarRadius, avatarShape } from '../avatar';
import { usePeople } from './hooks';
import { html } from './html';

/** Pictures by account, asked for once for the life of the screen */
const pictures = new Map<string, Promise<string | null>>();
const pictureOf = (did: string) => {
  let known = pictures.get(did);
  if (!known) {
    known = minca.picture(did).catch(() => null);
    pictures.set(did, known);
  }
  return known;
};

/** Someone's face: the picture they chose, or the shape their account gives, the same as everywhere in the app */
export function Avatar({ did, size = 28, round = false }: { did: string; size?: number; round?: boolean }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setSrc(null);
    void pictureOf(did).then((url) => live && setSrc(url));
    return () => {
      live = false;
    };
  }, [did]);
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
