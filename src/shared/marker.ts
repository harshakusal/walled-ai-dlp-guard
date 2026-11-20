/**
 * Marker detection shared by the browser extension (fast, synchronous check on
 * prompts) and the desktop agent (authoritative check on prompts and files).
 *
 * Three levels of strictness:
 *  - containsMarker:          prompts / text files. Unicode-normalised, case-insensitive,
 *                             invisible characters stripped (defeats trivial evasion).
 *  - containsMarkerLoose:     PDF text. Additionally ignores whitespace, because PDF
 *                             text extraction often splits words into separate runs.
 *  - findMarkerFuzzy:         OCR output. Compares only [A-Z0-9], maps common OCR
 *                             confusions and tolerates a small edit distance.
 */

export const DEFAULT_MARKER = 'WALLED_SENSITIVE';

// Zero-width / invisible formatting characters that render as nothing.
const INVISIBLE = /[\u00AD\u034F\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/g;

export function normalize(text: string): string {
  return text.normalize('NFKC').replace(INVISIBLE, '').toUpperCase();
}

export function containsMarker(text: string, marker: string = DEFAULT_MARKER): boolean {
  if (!text) return false;
  return normalize(text).includes(normalize(marker));
}

export function containsMarkerLoose(text: string, marker: string = DEFAULT_MARKER): boolean {
  if (!text) return false;
  const strip = (s: string) => normalize(s).replace(/\s+/g, '');
  return strip(text).includes(strip(marker));
}

/** Map characters OCR engines commonly confuse with letters of the marker. */
const OCR_CONFUSIONS: Record<string, string> = { '0': 'O', '1': 'I', '5': 'S', '8': 'B', '|': 'I', '$': 'S' };

export function ocrSkeleton(text: string): string {
  let out = '';
  for (const ch of normalize(text)) {
    const mapped = OCR_CONFUSIONS[ch] ?? ch;
    if (/[A-Z]/.test(mapped)) out += mapped;
  }
  return out;
}

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

export interface FuzzyMatch {
  found: boolean;
  distance: number;
  matched?: string;
}

/**
 * Sliding-window fuzzy search for the marker inside OCR text.
 * The skeleton of "WALLED_SENSITIVE" is "WALLEDSENSITIVE" (15 letters); allowing
 * up to 2 edits keeps false positives negligible while surviving typical OCR noise
 * (e.g. "WALLED SENSlTIVE", "WALLEO_SENSITIVE").
 */
export function findMarkerFuzzy(text: string, marker: string = DEFAULT_MARKER, maxDistance = 2): FuzzyMatch {
  const hay = ocrSkeleton(text);
  const needle = ocrSkeleton(marker);
  if (!needle) return { found: false, distance: Infinity };
  if (hay.includes(needle)) return { found: true, distance: 0, matched: needle };
  let best: FuzzyMatch = { found: false, distance: Infinity };
  for (let len = needle.length - maxDistance; len <= needle.length + maxDistance; len++) {
    if (len <= 0) continue;
    for (let i = 0; i + len <= hay.length; i++) {
      const window = hay.slice(i, i + len);
      const d = levenshtein(window, needle);
      if (d < best.distance) best = { found: d <= maxDistance, distance: d, matched: window };
      if (d === 0) return best;
    }
  }
  return best;
}

/** Short, single-line preview of a prompt for dialogs and logs. */
export function preview(text: string, max = 160): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}
