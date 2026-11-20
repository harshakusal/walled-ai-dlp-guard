/**
 * Policy engine: decides whether an action needs confirmation and, if so, asks
 * the user through the native dialog. Pure of any I/O transport, so the same code
 * serves the native messaging host, the CLI and the tests.
 */
import { containsMarker, preview } from '../shared/marker.js';
import type { DecisionReply, FileMeta, Finding, Site, UploadVia } from '../shared/protocol.js';
import type { Config } from './config.js';
import { inspectFile } from './inspect/index.js';
import { confirm, type DialogOutcome, type DialogRequest } from './dialog/index.js';
import { audit, sha256 } from './audit.js';

export type Confirm = (req: DialogRequest) => Promise<DialogOutcome | 'unavailable'>;
export type Notify = (id: string, findings: Finding[]) => void;

const SITE_NAMES: Record<Site, string> = { chatgpt: 'ChatGPT', perplexity: 'Perplexity', unknown: 'the web app' };
const VIA_NAMES: Record<UploadVia, string> = { 'file-picker': 'file picker', 'drag-and-drop': 'drag and drop', paste: 'paste' };

const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

export class Dlp {
  constructor(private cfg: Config, private ask: Confirm = confirm, private notify: Notify = () => {}) {}

  get config() { return this.cfg; }

  private async decide(findings: Finding[], request: DialogRequest, base: Omit<DecisionReply, 't' | 'decision' | 'reason' | 'findings'>): Promise<DecisionReply> {
    this.notify(base.id, findings);
    const outcome = await this.ask(request);
    const decision = outcome === 'continue' ? 'continue' : 'cancel';
    const reason = outcome === 'continue' ? 'user-continue' : outcome === 'cancel' ? 'user-cancel' : outcome === 'timeout' ? 'timeout' : 'no-dialog-backend';
    return { t: 'decision', ...base, decision, reason, findings };
  }

  async checkPrompt(id: string, site: Site, url: string, text: string): Promise<DecisionReply> {
    const started = Date.now();
    if (!containsMarker(text, this.cfg.marker)) {
      audit({ event: 'prompt', site, decision: 'continue', reason: 'clean', chars: text.length });
      return { t: 'decision', id, decision: 'continue', reason: 'clean', findings: [], scanMs: Date.now() - started };
    }
    const findings: Finding[] = [{ source: 'prompt', name: preview(text, 80), kind: 'prompt', method: 'text match' }];
    const reply = await this.decide(findings, {
      title: 'Walled DLP – sensitive content detected',
      message:
        `Sensitive marker ${this.cfg.marker} was detected in a TEXT PROMPT you are submitting to ${SITE_NAMES[site]}.\n\n` +
        `Prompt: "${preview(text, 220)}"\n\n` +
        `Continue: submit the prompt unchanged.\nCancel: do not submit (you can edit and retry).`,
      timeoutSec: this.cfg.dialogTimeoutSec,
    }, { id, scanMs: Date.now() - started });
    audit({ event: 'prompt', site, url: originOf(url), decision: reply.decision, reason: reply.reason, chars: text.length, sha256: sha256(text) });
    return reply;
  }

  async checkFiles(id: string, site: Site, url: string, via: UploadVia, files: Array<FileMeta & { bytes?: Uint8Array }>): Promise<DecisionReply> {
    const started = Date.now();
    const findings: Finding[] = [];
    const problems: string[] = [];
    const lines: string[] = [];
    const results = [];
    for (const f of files) {
      if (f.skipped || !f.bytes) {
        problems.push(`${f.name} (${fmtSize(f.size)}): too large to inspect`);
        results.push({ name: f.name, size: f.size, skipped: true });
        continue;
      }
      const r = await inspectFile(f.bytes, { marker: this.cfg.marker, ocrPdfPages: this.cfg.ocrPdfPages });
      results.push({ name: f.name, size: f.size, kind: r.kind, found: r.found, method: r.method, ms: r.ms, error: r.error, sha256: sha256(f.bytes) });
      if (r.found) {
        findings.push({ source: 'file', name: f.name, kind: r.kind, method: r.method });
        lines.push(`• ${f.name} (${r.kind.toUpperCase()}, ${fmtSize(f.size)}) – found via ${r.method}`);
      } else if (r.error && this.cfg.onInspectionError !== 'allow') {
        problems.push(`${f.name} (${fmtSize(f.size)}): could not be inspected (${r.error.slice(0, 80)})`);
      }
    }
    const scanMs = Date.now() - started;
    let reply: DecisionReply;
    if (!findings.length && !problems.length) {
      reply = { t: 'decision', id, decision: 'continue', reason: 'clean', findings, scanMs };
    } else if (!findings.length && this.cfg.onInspectionError === 'block') {
      reply = { t: 'decision', id, decision: 'cancel', reason: 'uninspectable', findings, scanMs };
    } else {
      const header = findings.length
        ? `Sensitive marker ${this.cfg.marker} was detected in a FILE UPLOAD to ${SITE_NAMES[site]} (via ${VIA_NAMES[via]}).`
        : `A FILE UPLOAD to ${SITE_NAMES[site]} could not be fully inspected.`;
      const body = [
        ...(lines.length ? ['File(s) containing the marker:', ...lines] : []),
        ...(problems.length ? ['Not inspected:', ...problems.map((p) => `• ${p}`)] : []),
      ].join('\n');
      const count = files.length > 1 ? ` all ${files.length} files of this upload` : ' the file';
      reply = await this.decide(findings, {
        title: 'Walled DLP – sensitive content detected',
        message: `${header}\n\n${body}\n\nContinue: upload${count} unchanged.\nCancel: block this upload (you can choose files again).`,
        timeoutSec: this.cfg.dialogTimeoutSec,
      }, { id, scanMs });
    }
    audit({ event: 'upload', site, url: originOf(url), via, decision: reply.decision, reason: reply.reason, files: results });
    return reply;
  }
}

function originOf(url: string): string {
  try { return new URL(url).origin; } catch { return ''; }
}
