import { sniff } from './sniff.js';
import { inspectText, rawByteScan } from './text.js';
import { inspectPdf } from './pdf.js';
import { ocrFindMarker } from './ocr.js';

export interface InspectOptions { marker: string; ocrPdfPages: number }

export interface InspectResult {
  found: boolean;
  kind: string;      // pdf | image | text | binary
  subtype: string;
  method: string;    // how it was found (or what was checked)
  error?: string;    // inspection failed (corrupt / unsupported); raw scan still ran
  ms: number;
}

/** Inspect one file's bytes for the marker. Type is detected from content, not the name. */
export async function inspectFile(buf: Uint8Array, opts: InspectOptions): Promise<InspectResult> {
  const started = Date.now();
  const { kind, subtype } = sniff(buf);
  const done = (r: Omit<InspectResult, 'kind' | 'subtype' | 'ms'>): InspectResult => ({ kind, subtype, ms: Date.now() - started, ...r });
  try {
    if (kind === 'text') {
      const r = inspectText(buf, opts.marker);
      return done(r);
    }
    // Cheap check first: marker in metadata / uncompressed content.
    if (rawByteScan(buf, opts.marker)) return done({ found: true, method: 'raw bytes / metadata' });
    if (kind === 'pdf') {
      const r = await inspectPdf(buf, opts.marker, { ocrPages: opts.ocrPdfPages });
      return done({ found: r.found, method: r.method });
    }
    if (kind === 'image') {
      const r = await ocrFindMarker(buf, opts.marker);
      return done({ found: r.found, method: r.found ? `OCR (edit distance ${r.distance})` : 'OCR' });
    }
    return done({ found: false, method: 'raw bytes' });
  } catch (err) {
    const found = rawByteScan(buf, opts.marker);
    return done({ found, method: 'raw bytes (fallback)', error: (err as Error).message ?? String(err) });
  }
}
