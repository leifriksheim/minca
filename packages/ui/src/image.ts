/** The longest side a picture is added at, as chat apps send one: sharp on any screen, a fraction of a photo's size */
const MAX_SIDE = 2048;
/** A picture at most this large and within MAX_SIDE is added as it is */
const SMALL = 500 * 1000;
/** Kinds a canvas draws one frame of exactly; a GIF may move and an SVG has no size, so they go as they are */
const DRAWN = ['image/jpeg', 'image/png', 'image/webp'];
/** The longest side of a thumbnail: sharp in a list or a chat on a dense screen */
const THUMB_SIDE = 480;
/** A picture this small is its own thumbnail */
const THUMB_ENOUGH = 64 * 1000;
/** The largest thumbnail an app fetches: the thumbnail is its writer's word, and one larger than ours is no thumbnail */
const THUMB_MAX = 256 * 1024;
/** A video whose first frame hasn't drawn by now gets no thumbnail */
const FRAME_MS = 5_000;

/** `source` drawn at most `side` pixels on its longer side, as WebP (PNG where a browser can't write WebP) */
async function drawn(source: CanvasImageSource, width: number, height: number, side: number): Promise<Blob> {
  const scale = Math.min(1, side / Math.max(width, height));
  const canvas = new OffscreenCanvas(
    Math.max(1, Math.round(width * scale)),
    Math.max(1, Math.round(height * scale)),
  );
  canvas.getContext('2d')?.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.convertToBlob({ type: 'image/webp', quality: side === THUMB_SIDE ? 0.7 : 0.85 });
}

/** A blob as a File named after `like`, with the extension its type says */
function named(blob: Blob, like: string, suffix = ''): File {
  const type = blob.type || 'image/webp';
  const name = like.replace(/\.[^.]*$/, '') + suffix + (type === 'image/webp' ? '.webp' : '.png');
  return new File([blob], name, { type });
}

/**
 * A picture made fit to add: at most MAX_SIDE pixels on its longer side, as
 * WebP. Anything else, a picture already small, or one that wouldn't come out
 * smaller, is the file as it was.
 */
export async function fitImage(file: File): Promise<File> {
  if (!DRAWN.includes(file.type) || typeof createImageBitmap !== 'function') return file;
  try {
    const bitmap = await createImageBitmap(file);
    if (Math.max(bitmap.width, bitmap.height) <= MAX_SIDE && file.size <= SMALL) {
      bitmap.close();
      return file;
    }
    const blob = await drawn(bitmap, bitmap.width, bitmap.height, MAX_SIDE);
    bitmap.close();
    // A browser that can't write WebP writes PNG instead, which is kept only if it is smaller.
    return blob.size < file.size ? named(blob, file.name) : file;
  } catch {
    return file;
  }
}

/**
 * A small still of a picture or a video, to show in its place until it is
 * opened: `std.file`'s `thumbnail`. It is small enough that every device
 * fetches it ahead, while the file itself may wait until someone opens it.
 * Null for a picture already that small, for other files, where the browser
 * can't draw one, and where it can't make one small enough.
 */
export async function thumbnailOf(file: File): Promise<File | null> {
  try {
    if (DRAWN.includes(file.type)) {
      if (file.size <= THUMB_ENOUGH || typeof createImageBitmap !== 'function') return null;
      const bitmap = await createImageBitmap(file);
      const blob = await drawn(bitmap, bitmap.width, bitmap.height, THUMB_SIDE);
      bitmap.close();
      return blob.size < file.size && blob.size <= THUMB_MAX ? named(blob, file.name, '-thumb') : null;
    }
    if (file.type.startsWith('video/') && typeof document !== 'undefined') {
      const url = URL.createObjectURL(file);
      try {
        const video = await frameOf(url);
        const blob = await drawn(video, video.videoWidth, video.videoHeight, THUMB_SIDE);
        return blob.size <= THUMB_MAX ? named(blob, file.name, '-thumb') : null;
      } finally {
        URL.revokeObjectURL(url);
      }
    }
  } catch {
    // Something a browser can't decode: the file goes without a thumbnail.
  }
  return null;
}

/** A video element at an early frame of `url`, ready to draw; rejects if none comes */
function frameOf(url: string): Promise<HTMLVideoElement> {
  const video = document.createElement('video');
  return new Promise<HTMLVideoElement>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('No frame')), FRAME_MS);
    const done = (error: Error | null) => {
      clearTimeout(timer);
      if (error || !video.videoWidth) reject(error ?? new Error('No frame'));
      else resolve(video);
    };
    video.addEventListener('error', () => done(new Error('Unplayable')), { once: true });
    video.addEventListener('seeked', () => done(null), { once: true });
    // A frame a little in, past a fade from black, but never past the end.
    video.addEventListener(
      'loadeddata',
      () => (video.currentTime = Number.isFinite(video.duration) ? Math.min(1, video.duration / 2) : 0),
      { once: true },
    );
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.src = url;
  });
}

/**
 * Whether to show a `std.file`'s thumbnail in its place: only for a picture
 * or a video, so another kind of file never looks like one, and only a
 * thumbnail small enough to fetch ahead.
 */
export function showsThumbnail(mime: unknown, thumbnail: unknown): boolean {
  if (typeof mime !== 'string' || !/^(image|video)\//.test(mime)) return false;
  const size: unknown =
    typeof thumbnail === 'object' && thumbnail !== null ? Reflect.get(thumbnail, 'size') : null;
  return typeof size === 'number' && size <= THUMB_MAX;
}
