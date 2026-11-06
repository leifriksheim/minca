/**
 * Link previews: a page's title, description and picture, as a chat shows a
 * link someone sent. A browser can't read another site's page, so the app's
 * own function reads it (`apps/example/netlify/functions/preview.ts`) and
 * this asks that. Nothing here is Minca: a preview is drawn, never kept in a
 * record, and without the service a link shows as a link.
 *
 * Set `VITE_MINCA_PREVIEWS` to another deployment of the function to use
 * that instead.
 */

/** What a page says about itself */
export interface LinkPreview {
  /** Where the page is, after any redirects */
  readonly url: string;
  readonly title: string;
  readonly description: string;
  /** Its site's name, or its host */
  readonly site: string;
  readonly image: { readonly bytes: Uint8Array; readonly mime: string } | null;
  /** Whether the page asks for its picture to be shown large */
  readonly large: boolean;
}

/** How many answers this page keeps, the oldest going first */
const KEPT = 200;
const asked = new Map<string, Promise<LinkPreview | null>>();

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;
const text = (value: unknown, max: number) => (typeof value === 'string' ? value.slice(0, max) : '');

/** A data: URL's bytes and type, or null when it isn't a picture's */
function pictureIn(value: unknown): LinkPreview['image'] {
  const match =
    typeof value === 'string' ? /^data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(value) : null;
  if (!match?.[1] || !match[2]) return null;
  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { bytes, mime: match[1] };
}

/** What the service answered, as a preview, or null when it isn't one */
export function previewOf(value: unknown): LinkPreview | null {
  if (!isObject(value) || typeof value.url !== 'string' || !URL.canParse(value.url)) return null;
  const title = text(value.title, 200);
  if (!title) return null;
  return {
    url: value.url,
    title,
    description: text(value.description, 300),
    site: text(value.site, 80),
    image: pictureIn(value.image),
    large: value.large === true,
  };
}

async function ask(url: string): Promise<LinkPreview | null> {
  const service =
    import.meta.env.VITE_MINCA_PREVIEWS ?? 'https://app.minca.social/.netlify/functions/preview';
  const response = await fetch(`${service}?${new URLSearchParams({ url })}`);
  if (!response.ok) return null;
  return previewOf(await response.json());
}

/**
 * A link's preview, or null when it has none. Asked once per link while the
 * page is open; when the service can't be reached, asked again next time.
 */
export function linkPreview(url: string): Promise<LinkPreview | null> {
  const known = asked.get(url);
  if (known) return known;
  const answer = ask(url).catch(() => {
    asked.delete(url);
    return null;
  });
  asked.set(url, answer);
  if (asked.size > KEPT) asked.delete(asked.keys().next().value ?? '');
  return answer;
}
