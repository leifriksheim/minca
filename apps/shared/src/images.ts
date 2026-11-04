/** An image made at most `side` pixels on its longer side, as WebP: what a picture is added as */
export async function shrinkImage(file: Blob, side = 512): Promise<{ bytes: Uint8Array; mime: string }> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
  const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.85 });
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: blob.type || 'image/webp' };
}
