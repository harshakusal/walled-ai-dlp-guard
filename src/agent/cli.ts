#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { runHost } from './host.js';
import { install, uninstall, EXTENSION_ID } from './installer.js';
import { inspectFile } from './inspect/index.js';
import { shutdownOcr } from './inspect/ocr.js';
import { backend, confirm } from './dialog/index.js';
import { loadConfig, CONFIG_PATH, HOME_DIR } from './config.js';
import { AUDIT_PATH } from './audit.js';
import { VERSION } from './version.js';

const HELP = `walled-dlp ${VERSION} – Walled DLP Guard desktop agent

Usage:
  walled-dlp install [--browser chrome|chromium|edge|brave|...] [--user-data-dir DIR] [--extension-id ID]
                              Register the native messaging host (run once).
  walled-dlp uninstall        Remove the registration.
  walled-dlp status           Show configuration, dialog backend and registration.
  walled-dlp scan FILE...     Inspect files for the marker exactly as uploads are inspected.
  walled-dlp dialog-test      Show the native confirmation dialog.
  walled-dlp audit [-n N] [--json]  Show the last N audit entries (default 20).
  walled-dlp host             Run as native messaging host (started by the browser).
`;

function flag(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) if (args[i] === name && args[i + 1]) out.push(args[++i]);
  return out;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  // Chrome passes the caller origin (and on Windows --parent-window) as arguments.
  if (cmd === 'host' || (cmd ?? '').startsWith('chrome-extension://')) {
    runHost();
    return -1; // keep running
  }
  switch (cmd) {
    case 'install': {
      const written = install({ browsers: flag(rest, '--browser'), userDataDir: flag(rest, '--user-data-dir')[0], extensionIds: flag(rest, '--extension-id') });
      console.log('Native messaging host registered:');
      written.forEach((w) => console.log('  ' + w));
      console.log(`\nAllowed extension ID: ${flag(rest, '--extension-id').join(', ') || EXTENSION_ID}`);
      console.log('Now load the extension (dist/extension) in chrome://extensions and reload any open ChatGPT/Perplexity tabs.');
      return 0;
    }
    case 'uninstall': {
      const removed = uninstall({ userDataDir: flag(rest, '--user-data-dir')[0] });
      console.log(removed.length ? 'Removed:\n  ' + removed.join('\n  ') : 'Nothing to remove.');
      return 0;
    }
    case 'status': {
      const b = await backend();
      console.log(JSON.stringify({ version: VERSION, platform: process.platform, node: process.version, home: HOME_DIR, config: CONFIG_PATH, audit: AUDIT_PATH, dialogBackend: b?.name ?? 'NONE (install zenity or kdialog on Linux)', extensionId: EXTENSION_ID, effectiveConfig: loadConfig() }, null, 2));
      return 0;
    }
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
    case 'dialog-test': {
      const b = await backend();
      console.log(`backend: ${b?.name ?? 'none'}`);
      console.log('outcome:', await confirm({ title: 'Walled DLP – test dialog', message: 'Sensitive marker WALLED_SENSITIVE was detected in a TEXT PROMPT.\n\nPrompt: "example"\n\nContinue or Cancel?', timeoutSec: 60 }));
      return 0;
    }
    case 'audit': {
      const n = Number(flag(rest, '-n')[0] ?? 20);
      const lines = fs.existsSync(AUDIT_PATH) ? fs.readFileSync(AUDIT_PATH, 'utf8').trim().split('\n').filter(Boolean) : [];
      if (rest.includes('--json')) { lines.slice(-n).forEach((l) => console.log(l)); return 0; }
      for (const l of lines.slice(-n)) {
        const e = JSON.parse(l) as { ts: string; event: string; site: string; via?: string; decision: string; reason: string; chars?: number; files?: Array<{ name: string; kind?: string; found?: boolean; method?: string }> };
        const what = e.event === 'prompt'
          ? `prompt (${e.chars} chars)`
          : `upload via ${e.via}: ${(e.files ?? []).map((f) => `${f.name}${f.found ? ` [SENSITIVE: ${f.method}]` : ''}`).join(', ')}`;
        const time = new Date(e.ts).toLocaleTimeString();
        console.log(`${time}  ${e.site.padEnd(10)} ${e.decision.toUpperCase().padEnd(8)} ${e.reason.padEnd(13)} ${what}`);
      }
      return 0;
    }
    case 'version': case '--version': case '-v':
      console.log(VERSION);
      return 0;
    default:
      console.log(HELP);
      return cmd && cmd !== 'help' && cmd !== '--help' ? 2 : 0;
  }
}

main(process.argv.slice(2)).then((code) => { if (code >= 0) process.exitCode = code; }, (err) => { console.error(err); process.exitCode = 1; });
