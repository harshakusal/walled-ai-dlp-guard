import { containsMarker } from '../marker.js';

/** Decode a text file honouring BOMs (UTF-8, UTF-16 LE/BE); default UTF-8. */
export function decodeText(buf: Uint8Array): string {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (b[0] === 0xff && b[1] === 0xfe) return b.subarray(2).toString('utf16le');
  if (b[0] === 0xfe && b[1] === 0xff) {
    const swapped = Buffer.from(b.subarray(2));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(b);
}

export function inspectText(buf: Uint8Array, marker: string): { found: boolean; method: string } {
  return { found: containsMarker(decodeText(buf), marker), method: 'text content' };
}

/**
 * Last-resort scan of raw bytes (ASCII/Latin-1 and UTF-16LE views). Catches the marker
 * in metadata (PNG tEXt, EXIF, XMP), uncompressed PDF streams and unknown formats.
 */
export function rawByteScan(buf: Uint8Array, marker: string): boolean {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  const m = marker.toUpperCase();
  if (b.toString('latin1').toUpperCase().includes(m)) return true;
  if (b.length >= 2) {
    const even = b.subarray(0, b.length - (b.length % 2));
    if (even.toString('utf16le').toUpperCase().includes(m)) return true;
    if (b.length > 2) {
      const odd = b.subarray(1, 1 + ((b.length - 1) - ((b.length - 1) % 2)));
      if (odd.toString('utf16le').toUpperCase().includes(m)) return true;
    }
  }
  return false;
}
