import { spawn } from 'node:child_process';

export interface ExecResult { code: number | null; stdout: string; stderr: string }

/** Spawn without a shell (no injection), never inherit stdout (it carries native messaging). */
export function run(cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { env: opts.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: String(e) });
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = opts.timeoutMs ? setTimeout(() => child.kill(), opts.timeoutMs) : null;
    child.on('error', (e) => { if (timer) clearTimeout(timer); resolve({ code: -1, stdout, stderr: stderr + String(e) }); });
    child.on('close', (code) => { if (timer) clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

export async function which(cmd: string): Promise<boolean> {
  const probe = process.platform === 'win32' ? await run('where', [cmd]) : await run('sh', ['-c', 'command -v "$0"', cmd]);
  return probe.code === 0;
}
