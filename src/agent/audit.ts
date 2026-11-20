import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HOME_DIR } from './config.js';

export const AUDIT_PATH = path.join(HOME_DIR, 'audit.jsonl');

export const sha256 = (data: string | Uint8Array) => crypto.createHash('sha256').update(data).digest('hex');

/**
 * Append-only JSONL audit trail. Never stores prompt text or file content —
 * only names, sizes, hashes, how the marker was found and the decision.
 */
export function audit(entry: Record<string, unknown>): void {
  try {
    fs.mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 });
    fs.appendFileSync(AUDIT_PATH, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', { mode: 0o600 });
  } catch {
    /* auditing must never break enforcement */
  }
}

export function log(...args: unknown[]): void {
  // stdout is the native messaging channel: diagnostics go to stderr only.
  process.stderr.write(`[walled-dlp ${new Date().toISOString()}] ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`);
}
