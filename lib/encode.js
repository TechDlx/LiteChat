/**
 * Image re-encoding, isolated behind one function.
 *
 * sharp is loaded dynamically so that a missing or broken binary disables
 * uploads instead of taking the whole chat server down. That matters here:
 * sharp is the only native dependency and the only thing in the project that
 * can fail for platform reasons.
 */

let sharp = null;
let loadError = null;

try {
  sharp = (await import('sharp')).default;
} catch (err) {
  loadError = err;
  console.error('[encode] sharp unavailable, image uploads disabled:', err.message.split('\n')[0]);
}

export const available = Boolean(sharp);
export const unavailableReason = loadError ? loadError.message.split('\n')[0] : '';

/**
 * Decode, correct orientation, shrink and re-encode to WebP.
 *
 * Re-encoding is the security boundary, not a nicety: it discards EXIF (phone
 * photos carry GPS), and destroys anything hidden in the original container.
 * The original bytes are never written to disk.
 *
 * @returns {Promise<{ data: Buffer, width: number, height: number }>}
 */
export async function encodeImage(buf, { maxEdge, quality, maxPixels }) {
  if (!sharp) throw new Error('sharp unavailable');

  // limitInputPixels rejects decompression bombs before the full decode,
  // rather than after the memory has already been allocated.
  const out = await sharp(buf, { limitInputPixels: maxPixels, animated: false })
    .rotate()                       // applies EXIF orientation, then drops metadata
    .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
    .webp({ quality })
    .toBuffer({ resolveWithObject: true });

  return { data: out.data, width: out.info.width, height: out.info.height };
}
