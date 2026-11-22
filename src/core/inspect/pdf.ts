import { containsMarkerLoose } from '../marker.js';
import { createCanvas } from '@napi-rs/canvas';
import { ocrFindMarker } from './ocr.js';

export interface PdfResult { found: boolean; method: string; pages: number }

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
let pdfjsPromise: Promise<PdfJs> | null = null;
const loadPdfJs = () => (pdfjsPromise ??= import('pdfjs-dist/legacy/build/pdf.mjs'));

/**
 * 1. Text layer of every page (handles compressed streams, CID fonts, etc.).
 * 2. Document metadata (title, subject, keywords, XMP).
 * 3. Pages with (almost) no text layer — scanned documents — are rendered and OCR'd.
 */
export async function inspectPdf(buf: Uint8Array, marker: string, opts: { ocrPages: number }): Promise<PdfResult> {
  const pdfjs = await loadPdfJs();
  const task = pdfjs.getDocument({
    data: new Uint8Array(buf), // pdf.js detaches the buffer it is given
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  });
  const doc = await task.promise;
  try {
    const scanned: number[] = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      const text = content.items.map((it) => ('str' in it ? it.str + (it.hasEOL ? '\n' : '') : '')).join('');
      if (containsMarkerLoose(text, marker)) return { found: true, method: `PDF text layer (page ${p})`, pages: doc.numPages };
      if (text.replace(/\s/g, '').length < 20) scanned.push(p);
      page.cleanup();
    }
    const meta = await doc.getMetadata().catch(() => null);
    if (meta && containsMarkerLoose(JSON.stringify(meta.info ?? {}) + (meta.metadata ? JSON.stringify([...meta.metadata]) : ''), marker)) {
      return { found: true, method: 'PDF metadata', pages: doc.numPages };
    }
    for (const p of scanned.slice(0, opts.ocrPages)) {
      const page = await doc.getPage(p);
      const viewport = page.getViewport({ scale: 2 });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await page.render({ canvas: canvas as any, canvasContext: ctx as any, viewport }).promise;
      const ocr = await ocrFindMarker(canvas.toBuffer('image/png'), marker);
      if (ocr.found) return { found: true, method: `OCR of scanned PDF page ${p}`, pages: doc.numPages };
    }
    return { found: false, method: 'PDF text layer + metadata' + (scanned.length ? ' + OCR' : ''), pages: doc.numPages };
  } finally {
    await task.destroy();
  }
}
