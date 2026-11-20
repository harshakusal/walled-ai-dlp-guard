/** Small, non-blocking status line (shadow DOM, so page CSS cannot affect it). Decisions are never taken here. */
let host: HTMLElement | null = null;
let box: HTMLDivElement | null = null;
let timer: number | undefined;

const COLORS = { info: '#1f2937', ok: '#047857', warn: '#b45309', block: '#b91c1c' } as const;

export function toast(text: string, kind: keyof typeof COLORS = 'info', ms = 4500): void {
  if (!host || !host.isConnected) {
    host = document.createElement('walled-dlp-toast');
    const shadow = host.attachShadow({ mode: 'closed' });
    box = document.createElement('div');
    box.setAttribute('role', 'status');
    box.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;max-width:420px;padding:10px 14px;border-radius:10px;color:#fff;font:500 13px/1.4 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.25);pointer-events:none;transition:opacity .2s';
    shadow.append(box);
    (document.body ?? document.documentElement).append(host);
  }
  box!.textContent = `🛡 ${text}`;
  box!.style.background = COLORS[kind];
  box!.style.opacity = '1';
  clearTimeout(timer);
  if (ms > 0) timer = window.setTimeout(() => { if (box) box.style.opacity = '0'; }, ms);
}
