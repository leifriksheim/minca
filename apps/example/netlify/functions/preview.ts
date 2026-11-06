/**
 * Link previews, as a Netlify Function beside the app (app.minca.social):
 * `GET /.netlify/functions/preview?url=https://…` answers a page's title,
 * description, site and picture, read from its Open Graph and Twitter card
 * tags, the way a chat shows a link someone sent. A browser can't read
 * another site's page, and a screen has no network at all, so this reads it
 * for them (`apps/shared/src/previews.ts` asks it). Nothing here is Minca: no
 * record holds a preview, and an app that can't reach this shows links as
 * links.
 *
 * It fetches what anyone asks, so it reaches only public addresses on the
 * usual ports, checked as each connection is made, redirects included, and it
 * reads little: the start of a page, and one picture of at most 1 MB. The
 * answer is cached a day, so a link many people see is read once.
 */
import { lookup } from 'node:dns';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import type { Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

/** How much of a page is read: its head is near the start */
const MAX_PAGE = 512 * 1024;
/** The largest picture passed on, before the app makes it smaller for a screen */
const MAX_IMAGE = 1024 * 1024;
const PICTURES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']);
const MAX_REDIRECTS = 4;
/** For everything one preview reads, under the function's own 10 seconds */
const TIMEOUT_MS = 8000;
const MAX_TITLE = 200;
const MAX_DESCRIPTION = 300;
const HOUR = 60 * 60;
const DAY = 24 * HOUR;
const AGENT = 'Mozilla/5.0 (compatible; MincaBot/1.0; +https://minca.social)';

/** What a page says about itself, as a chat shows it */
export interface Preview {
  /** Where the page is, after any redirects */
  readonly url: string;
  readonly title: string;
  readonly description: string;
  /** Its site's name, or its host */
  readonly site: string;
  /** Its picture's address, read here; the answer carries the picture itself */
  readonly image?: string;
  /** Whether the page asks for its picture to be shown large (`twitter:card` summary_large_image or player) */
  readonly large: boolean;
}

/** Whether an IP address is on the public internet: not this machine, a private network, or a range set aside */
export function isPublicAddress(address: string): boolean {
  const v4 = isIP(address) === 4 ? address : /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (v4) {
    const [a = 0, b = 0, c = 0] = v4.split('.').map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (isIP(address) !== 6) return false;
  // Only global unicast (2000::/3), and of it not 6to4, Teredo or the documentation range, which lead elsewhere or nowhere
  const [first = 0, second = 0] = address.split(':').map((part) => (part ? parseInt(part, 16) : 0));
  return (
    (first & 0xe000) === 0x2000 &&
    first !== 0x2002 &&
    !(first === 0x2001 && (second === 0 || second === 0xdb8))
  );
}

/** An address this may fetch: http or https, on its usual port, with no password in it */
export function isWebAddress(address: URL): boolean {
  return (
    (address.protocol === 'https:' || address.protocol === 'http:') &&
    !address.username &&
    !address.password &&
    (address.port === '' || address.port === '80' || address.port === '443')
  );
}

/** A name's addresses, refused if any of them isn't public, so a connection can't be steered inside */
const publicOnly: LookupFunction = (hostname, options, callback) =>
  lookup(hostname, { ...options, all: true }, (error, addresses) => {
    const first = addresses?.[0];
    if (error || !first) return callback(error ?? new Error(`${hostname} has no address`), '');
    if (addresses.some((a) => !isPublicAddress(a.address)))
      return callback(new Error(`${hostname} is not on the public internet`), '');
    if (options.all) callback(null, addresses);
    else callback(null, first.address, first.family);
  });

/** One response, before its redirects are followed */
function open(address: URL, accept: string, signal: AbortSignal): Promise<IncomingMessage> {
  // A name is checked as it is looked up; an address written as one is never looked up, so it is checked here.
  const literal = address.hostname.replace(/^\[|\]$/g, '');
  if (isIP(literal) && !isPublicAddress(literal))
    return Promise.reject(new Error(`${literal} is not on the public internet`));
  const request = address.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    request(
      address,
      {
        lookup: publicOnly,
        signal,
        headers: {
          accept,
          'accept-encoding': 'gzip, deflate, br',
          'accept-language': 'en',
          'user-agent': AGENT,
        },
      },
      resolve,
    )
      .on('error', reject)
      .end();
  });
}

/** Its body as sent, unpacked */
function body(response: IncomingMessage): Readable {
  switch (response.headers['content-encoding']) {
    case 'gzip':
      return response.pipe(createGunzip());
    case 'deflate':
      return response.pipe(createInflate());
    case 'br':
      return response.pipe(createBrotliDecompress());
    default:
      return response;
  }
}

/** At most `max` bytes of it: past that, the start (`cut`) or nothing */
async function read(response: IncomingMessage, max: number, cut: boolean): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of body(response)) {
      if (!Buffer.isBuffer(chunk)) continue;
      chunks.push(chunk);
      size += chunk.length;
      if (size >= max) {
        if (!cut) throw new Error(`Larger than ${max} bytes`);
        break;
      }
    }
  } finally {
    response.destroy();
  }
  return new Uint8Array(Buffer.concat(chunks).subarray(0, max));
}

/** What an address answers, following its redirects, each checked as the first was */
async function get(
  address: URL,
  accept: string,
  max: number,
  cut: boolean,
  signal: AbortSignal,
): Promise<{ url: URL; /** Its content-type, as sent */ type: string; body: Uint8Array }> {
  let at = address;
  for (let hops = 0; hops <= MAX_REDIRECTS; hops++) {
    if (!isWebAddress(at)) throw new Error('Not a web address');
    const response = await open(at, accept, signal);
    const status = response.statusCode ?? 0;
    const next = response.headers.location;
    if (status >= 300 && status < 400 && next) {
      response.destroy();
      at = new URL(next, at);
      continue;
    }
    if (status !== 200) {
      response.destroy();
      throw new Error(`${at.href} answered ${status}`);
    }
    const type = response.headers['content-type'] ?? '';
    return { url: at, type, body: await read(response, max, cut) };
  }
  throw new Error('Too many redirects');
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
};

/** Text as a page writes it in an attribute or a title: its entities read, its spaces as one */
function plain(text: string): string {
  return text
    .replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
      if (name[0] !== '#') return ENTITIES[name.toLowerCase()] ?? whole;
      const code =
        name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;

/** A tag's attributes, by lower-case name */
function attributesOf(tag: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const [, name = '', a, b, c] of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g))
    found.set(name.toLowerCase(), a ?? b ?? c ?? '');
  return found;
}

/**
 * What a page says about itself, from its `<meta>` tags (Open Graph first,
 * then Twitter's, then the plain ones) and its `<title>`; null when it says
 * neither a title nor a description.
 */
export function readPreview(html: string, url: URL): Preview | null {
  const meta = new Map<string, string>();
  for (const [tag] of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attributes = attributesOf(tag);
    const key = (attributes.get('property') ?? attributes.get('name') ?? '').toLowerCase();
    const content = attributes.get('content');
    // The first of each counts, as it does for the sites that read these
    if (key && content !== undefined && !meta.has(key)) meta.set(key, plain(content));
  }
  const pick = (...keys: string[]) => keys.map((key) => meta.get(key)).find((value) => value) ?? '';
  const titled = /<title\b[^>]*>([^<]*)<\/title>/i.exec(html)?.[1];
  const title = pick('og:title', 'twitter:title') || plain(titled ?? '');
  const description = pick('og:description', 'twitter:description', 'description');
  if (!title && !description) return null;
  const host = url.hostname.replace(/^www\./, '');
  const picture = pick(
    'og:image:secure_url',
    'og:image',
    'og:image:url',
    'twitter:image',
    'twitter:image:src',
  );
  const image = picture && URL.canParse(picture, url) ? new URL(picture, url) : null;
  const card = pick('twitter:card');
  return {
    url: url.href,
    title: clip(title || host, MAX_TITLE),
    description: clip(description, MAX_DESCRIPTION),
    site: clip(pick('og:site_name') || host, 80),
    ...(image && isWebAddress(image) ? { image: image.href } : {}),
    large: card === 'summary_large_image' || card === 'player',
  };
}

/** A page's bytes as text, in the charset it says it is in */
function textOf(bytes: Uint8Array, type: string): string {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 2048));
  const charset =
    /charset=([\w-]+)/i.exec(type)?.[1] ?? /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1] ?? 'utf-8';
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

/** A page's picture, as a data: URL; undefined when it isn't one this passes on */
async function pictureOf(address: string, signal: AbortSignal): Promise<string | undefined> {
  const found = await get(new URL(address), 'image/*', MAX_IMAGE, false, signal);
  const mime = found.type.split(';')[0]?.trim().toLowerCase() ?? '';
  if (!PICTURES.has(mime)) return undefined;
  return `data:${mime};base64,${Buffer.from(found.body).toString('base64')}`;
}

/** JSON, for any page to read, cached for `seconds` in browsers and at Netlify's edge, keyed on the url asked */
function answer(status: number, value: unknown, seconds: number): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'cache-control': `public, max-age=${seconds}`,
      'netlify-cdn-cache-control': `public, durable, max-age=${seconds}, stale-while-revalidate=${7 * DAY}`,
      'netlify-vary': 'query=url',
    },
  });
}

/** `?url=`: its preview, or null when the page has none or can't be read */
export default async function preview(request: Request): Promise<Response> {
  const asked = new URL(request.url).searchParams.get('url') ?? '';
  const address = asked.length <= 2048 && URL.canParse(asked) ? new URL(asked) : null;
  if (!address || !isWebAddress(address))
    return answer(400, { error: 'url must be an http or https address' }, DAY);
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  try {
    const page = await get(address, 'text/html,application/xhtml+xml', MAX_PAGE, true, signal);
    const found = /html/i.test(page.type) ? readPreview(textOf(page.body, page.type), page.url) : null;
    if (!found) return answer(200, null, DAY);
    const image = found.image ? await pictureOf(found.image, signal).catch(() => undefined) : undefined;
    return answer(200, { ...found, image }, DAY);
  } catch {
    // Down, slow or refused: asked again in a while, not at once by everyone who sees the link
    return answer(200, null, HOUR);
  }
}
