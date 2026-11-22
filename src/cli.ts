#!/usr/bin/env node
/**
 * Developer CLI for the DLP core (no GUI needed): inspect files exactly as the app
 * inspects uploads, read the audit log, and show the effective configuration.
 */
import fs from 'node:fs';
import path from 'node:path';
import { inspectFile } from './core/inspect/index.js';
import { shutdownOcr } from './core/inspect/ocr.js';
import { loadConfig, CONFIG_PATH, HOME_DIR } from './core/config.js';
import { AUDIT_PATH, formatAudit, readAudit } from './core/audit.js';
import { VERSION } from './core/version.js';

const HELP = `walled-dlp ${VERSION} – Walled DLP Guard command-line tools

Usage:
  walled-dlp scan FILE...           Inspect files for the marker exactly as uploads are inspected
                                    (exit code 1 if any file is sensitive).
  walled-dlp audit [-n N] [--json]  Show the last N audit entries (default 20).
  walled-dlp status                 Show paths and the effective configuration.

The desktop app itself is started with "npm start" (or the packaged AppImage).
`;

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'scan': {
      if (!rest.length) { console.error('scan: give at least one file'); return 2; }
      const cfg = loadConfig();
      let hits = 0;
      for (const f of rest) {
        const r = await inspectFile(fs.readFileSync(f), { marker: cfg.marker, ocrPdfPages: cfg.ocrPdfPages });
        if (r.found) hits++;
        console.log(`${r.found ? 'SENSITIVE' : 'clean    '}  ${path.basename(f).padEnd(32)} ${r.kind.padEnd(6)} ${String(r.ms).padStart(5)} ms  ${r.method}${r.error ? `  (error: ${r.error})` : ''}`);
      }
      await shutdownOcr();
      return hits ? 1 : 0;
    }
    case 'audit': {
      const i = rest.indexOf('-n');
      const n = i >= 0 ? Number(rest[i + 1]) || 20 : 20;
      const entries = readAudit(n);
      for (const e of entries) console.log(rest.includes('--json') ? JSON.stringify(e) : formatAudit(e));
      if (!entries.length) console.log(`(no entries yet in ${AUDIT_PATH})`);
      return 0;
    }
    case 'status':
      console.log(JSON.stringify({ version: VERSION, home: HOME_DIR, config: CONFIG_PATH, audit: AUDIT_PATH, effectiveConfig: loadConfig() }, null, 2));
      return 0;
    case 'version': case '--version': case '-v':
      console.log(VERSION);
      return 0;
    default:
      console.log(HELP);
      return cmd && cmd !== 'help' && cmd !== '--help' ? 2 : 0;
  }
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => { console.error(err); process.exitCode = 1; });
