import { createRequire } from 'node:module';
import { createWorker, PSM, type Worker } from 'tesseract.js';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { findMarkerFuzzy, type FuzzyMatch } from '../marker.js';

const require = createRequire(import.meta.url);

let workerPromise: Promise<Worker> | null = null;
let queue: Promise<unknown> = Promise.resolve();

/** One long-lived OCR worker; the English model ships with npm (offline, no CDN download). */
function getWorker(): Promise<Worker> {
  if (!workerPromise) {
    const eng = require('@tesseract.js-data/eng') as { langPath: string; gzip: boolean };
    workerPromise = createWorker('eng', 1, {
      langPath: eng.langPath,
      gzip: eng.gzip,
      cacheMethod: 'none',
      logger: () => {},
      errorHandler: () => {},
    }).then(async (w) => {
      await w.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT });
      return w;
    });
    workerPromise.catch(() => { workerPromise = null; });
  }
  return workerPromise;
}

/**
 * Decode any image format the platform can read, flatten transparency onto white,
 * and upscale small images (OCR accuracy drops sharply below ~20px glyph height).
 */
export async function normaliseImage(buf: Uint8Array): Promise<Buffer[]> {
  const img = await loadImage(Buffer.from(buf));
  const longest = Math.max(img.width, img.height);
  const scale = longest < 1200 ? Math.min(3, 1600 / Math.max(longest, 1)) : longest > 4000 ? 4000 / longest : 1;
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  const normal = canvas.toBuffer('image/png');
  // Inverted copy for light-on-dark text (dark mode screenshots, banners).
  const data = ctx.getImageData(0, 0, w, h);
  for (let i = 0; i < data.data.length; i += 4) {
    data.data[i] = 255 - data.data[i];
    data.data[i + 1] = 255 - data.data[i + 1];
    data.data[i + 2] = 255 - data.data[i + 2];
  }
  ctx.putImageData(data, 0, 0);
  return [normal, canvas.toBuffer('image/png')];
}

export async function ocrText(png: Buffer): Promise<string> {
  const run = async () => {
    const worker = await getWorker();
    const { data } = await worker.recognize(png);
    return data.text ?? '';
  };
  const next = queue.then(run, run);
  queue = next.catch(() => undefined);
  return next;
}

export async function ocrFindMarker(buf: Uint8Array, marker: string): Promise<FuzzyMatch & { text: string }> {
  let best: FuzzyMatch & { text: string } = { found: false, distance: Infinity, text: '' };
  for (const variant of await normaliseImage(buf)) {
    const text = await ocrText(variant);
    const m = findMarkerFuzzy(text, marker);
    if (m.distance < best.distance) best = { ...m, text };
    if (m.found) break;
  }
  return best;
}

export async function shutdownOcr(): Promise<void> {
  if (workerPromise) {
    const w = await workerPromise.catch(() => null);
    workerPromise = null;
    await w?.terminate();
  }
}
