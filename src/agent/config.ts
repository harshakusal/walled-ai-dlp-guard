import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_MARKER } from '../shared/marker.js';

export interface Config {
  /** Sensitive marker to look for. */
  marker: string;
  /** Seconds before an unanswered dialog auto-cancels (fail closed). */
  dialogTimeoutSec: number;
  /** Scanned (image-only) PDF pages to OCR per file. */
  ocrPdfPages: number;
  /** What to do when a file cannot be parsed (corrupt / unsupported) and no marker was found. */
  onInspectionError: 'ask' | 'allow' | 'block';
  /** AI response text colour on ChatGPT / Perplexity. */
  responseColor: { light: string; dark: string };
}

export const DEFAULTS: Config = {
  marker: DEFAULT_MARKER,
  dialogTimeoutSec: 120,
  ocrPdfPages: 5,
  onInspectionError: 'ask',
  responseColor: { light: '#c2410c', dark: '#fdba74' },
};

export const HOME_DIR = process.env.WALLED_DLP_HOME ?? path.join(os.homedir(), '.walled-dlp');
export const CONFIG_PATH = path.join(HOME_DIR, 'config.json');

export function loadConfig(): Config {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as Partial<Config>;
    return { ...DEFAULTS, ...raw, responseColor: { ...DEFAULTS.responseColor, ...(raw.responseColor ?? {}) } };
  } catch {
    return { ...DEFAULTS };
  }
}
