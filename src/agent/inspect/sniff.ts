/** Content-based file type detection. The file name/extension is never trusted. */
export type FileKind = 'pdf' | 'image' | 'text' | 'binary';

const IMAGE_SIGNATURES: Array<[string, number[], number]> = [
  ['png', [0x89, 0x50, 0x4e, 0x47], 0],
  ['jpeg', [0xff, 0xd8, 0xff], 0],
  ['gif', [0x47, 0x49, 0x46, 0x38], 0],
  ['bmp', [0x42, 0x4d], 0],
  ['tiff', [0x49, 0x49, 0x2a, 0x00], 0],
  ['tiff', [0x4d, 0x4d, 0x00, 0x2a], 0],
];

function startsWith(buf: Uint8Array, sig: number[], offset = 0): boolean {
  if (buf.length < offset + sig.length) return false;
  return sig.every((b, i) => buf[offset + i] === b);
}

export function sniff(buf: Uint8Array): { kind: FileKind; subtype: string } {
  // PDF header may be preceded by junk; spec allows it within the first 1024 bytes.
  const head = Buffer.from(buf.subarray(0, 1024)).toString('latin1');
  if (head.includes('%PDF-')) return { kind: 'pdf', subtype: 'pdf' };
  for (const [name, sig, off] of IMAGE_SIGNATURES) if (startsWith(buf, sig, off)) return { kind: 'image', subtype: name };
  // RIFF....WEBP
  if (startsWith(buf, [0x52, 0x49, 0x46, 0x46]) && startsWith(buf, [0x57, 0x45, 0x42, 0x50], 8)) return { kind: 'image', subtype: 'webp' };
  // ISO-BMFF: ....ftypavif / heic
  if (buf.length > 12 && Buffer.from(buf.subarray(4, 8)).toString('latin1') === 'ftyp') {
    const brand = Buffer.from(buf.subarray(8, 12)).toString('latin1');
    if (/avif|avis|heic|heix|mif1|msf1/.test(brand)) return { kind: 'image', subtype: brand.trim() };
  }
  if (looksLikeText(buf)) return { kind: 'text', subtype: 'text' };
  return { kind: 'binary', subtype: 'binary' };
}

export function looksLikeText(buf: Uint8Array): boolean {
  if (buf.length === 0) return true;
  if (startsWith(buf, [0xef, 0xbb, 0xbf]) || startsWith(buf, [0xff, 0xfe]) || startsWith(buf, [0xfe, 0xff])) return true;
  const sample = buf.subarray(0, 8192);
  let control = 0;
  for (const b of sample) {
    if (b === 0) return false;
    if (b < 0x09 || (b > 0x0d && b < 0x20)) control++;
  }
  return control / sample.length < 0.02;
}
