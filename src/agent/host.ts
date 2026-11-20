/**
 * Native messaging host: the desktop side of Walled DLP Guard. Chrome starts it
 * when the extension connects and keeps it alive while the port is open.
 * Requests are handled concurrently; native dialogs are serialised by dialog/index.ts.
 */
import { attach } from './native-messaging.js';
import { Dlp } from './dlp.js';
import { loadConfig } from './config.js';
import { backend, confirm } from './dialog/index.js';
import { shutdownOcr } from './inspect/ocr.js';
import { log } from './audit.js';
import { PROTOCOL_VERSION, type FileMeta, type FilesBegin, type FromAgent, type ToAgent } from '../shared/protocol.js';
import { VERSION } from './version.js';

interface Upload { begin: FilesBegin; parts: Map<number, Buffer[]>; bytes: number }
const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;

export function runHost(): void {
  // Anything printed to stdout would corrupt the protocol: route console to stderr.
  console.log = console.info = console.warn = console.debug = (...a: unknown[]) => log(...a);

  const cfg = loadConfig();
  const uploads = new Map<string, Upload>();
  const dlp = new Dlp(cfg, confirm, (id, findings) => send({ t: 'status', id, state: 'awaiting-user', findings } satisfies FromAgent));

  const send = attach(process.stdin, process.stdout, (raw) => {
    handle(raw as ToAgent).catch((err) => {
      log('handler error', String(err));
      const id = (raw as { id?: string }).id ?? '';
      // Fail closed: an internal error never lets a gated action through.
      send({ t: 'decision', id, decision: 'cancel', reason: 'agent-error', findings: [], scanMs: 0 } satisfies FromAgent);
    });
  }, () => {
    void shutdownOcr().finally(() => process.exit(0));
  });

  async function handle(msg: ToAgent): Promise<void> {
    switch (msg.t) {
      case 'hello': {
        const b = await backend();
        send({
          t: 'hello', id: msg.id, agentVersion: VERSION, protocol: PROTOCOL_VERSION, platform: process.platform,
          marker: cfg.marker, responseColor: cfg.responseColor, dialogBackend: b?.name ?? 'none',
        } satisfies FromAgent);
        return;
      }
      case 'prompt':
        send(await dlp.checkPrompt(msg.id, msg.site, msg.url, msg.text));
        return;
      case 'files-begin':
        uploads.set(msg.id, { begin: msg, parts: new Map(), bytes: 0 });
        return;
      case 'file-chunk': {
        const u = uploads.get(msg.id);
        if (!u) return;
        const chunk = Buffer.from(msg.data, 'base64');
        u.bytes += chunk.length;
        if (u.bytes > MAX_UPLOAD_BYTES) throw new Error('upload exceeds agent limit');
        const list = u.parts.get(msg.index) ?? [];
        list.push(chunk);
        u.parts.set(msg.index, list);
        return;
      }
      case 'files-end': {
        const u = uploads.get(msg.id);
        uploads.delete(msg.id);
        if (!u) throw new Error('unknown upload');
        const files: Array<FileMeta & { bytes?: Uint8Array }> = u.begin.files.map((f) => ({
          ...f,
          bytes: f.skipped ? undefined : Buffer.concat(u.parts.get(f.index) ?? []),
        }));
        send(await dlp.checkFiles(msg.id, u.begin.site, u.begin.url, u.begin.via, files));
        return;
      }
      case 'dialog-test': {
        const outcome = await confirm({
          title: 'Walled DLP – test dialog',
          message: 'This is a test of the native confirmation dialog.\n\nContinue or Cancel?',
          timeoutSec: cfg.dialogTimeoutSec,
        });
        send({ t: 'decision', id: msg.id, decision: outcome === 'continue' ? 'continue' : 'cancel', reason: `test-${outcome}`, findings: [], scanMs: 0 });
        return;
      }
      default:
        log('unknown message', msg);
    }
  }
  log(`host started (pid ${process.pid}, origin ${process.argv.find((a) => a.startsWith('chrome-extension://')) ?? 'n/a'})`);
}
