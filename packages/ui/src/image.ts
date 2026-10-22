/** The longest side a picture is added at, as chat apps send one: sharp on any screen, a fraction of a photo's size */
const MAX_SIDE = 2048;
/** A picture at most this large and within MAX_SIDE is added as it is */
const SMALL = 500 * 1000;
/** Kinds a canvas draws one frame of exactly; a GIF may move and an SVG has no size, so they go as they are */
const DRAWN = ['image/jpeg', 'image/png', 'image/webp'];

/**
 * A picture made fit to add: at most MAX_SIDE pixels on its longer side, as
 * WebP. Anything else, a picture already small, or one that wouldn't come out
 * smaller, is the file as it was.
 */
export async function fitImage(file: File): Promise<File> {
  if (!DRAWN.includes(file.type) || typeof createImageBitmap !== 'function') return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size <= SMALL) {
      bitmap.close();
      return file;
    }
    const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    // A browser that can't write WebP writes PNG instead, which is kept only if it is smaller.
    const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.85 });
    if (blob.size >= file.size) return file;
    const type = blob.type || 'image/webp';
    const name = file.name.replace(/\.[^.]*$/, '') + (type === 'image/webp' ? '.webp' : '.png');
    return new File([blob], name, { type });
  } catch {
    return file;
  }
}
