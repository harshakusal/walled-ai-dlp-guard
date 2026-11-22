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
  // Diagnostics go to stderr; the audit file only ever holds decisions.
  process.stderr.write(`[walled-dlp ${new Date().toISOString()}] ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`);
}

export interface AuditEntry {
  ts: string; event: string; site: string; via?: string; decision: string; reason: string; chars?: number;
  files?: Array<{ name: string; kind?: string; found?: boolean; method?: string; skipped?: boolean }>;
}

/** Last `n` audit entries, oldest first. */
export function readAudit(n = 50): AuditEntry[] {
  try {
    return fs.readFileSync(AUDIT_PATH, 'utf8').trim().split('\n').filter(Boolean).slice(-n).map((l) => JSON.parse(l) as AuditEntry);
  } catch {
    return [];
  }
}

/** One human-readable line per decision (used by the CLI and the app's audit window). */
export function formatAudit(e: AuditEntry): string {
  const what = e.event === 'prompt'
    ? `prompt (${e.chars} chars)`
    : `upload via ${e.via}: ${(e.files ?? []).map((f) => `${f.name}${f.found ? ` [SENSITIVE: ${f.method}]` : f.skipped ? ' [not inspected: too large]' : ''}`).join(', ')}`;
  const time = new Date(e.ts).toLocaleString();
  return `${time}  ${e.site.padEnd(10)} ${e.decision.toUpperCase().padEnd(8)} ${e.reason.padEnd(13)} ${what}`;
}
