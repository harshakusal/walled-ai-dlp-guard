/** Toolbar page script (runs in the toolbar view only). */
import type { ToolbarCommand, ToolbarState } from '../ipc-channels.js';

declare global {
  interface Window { walled: { command(c: ToolbarCommand): void; onState(fn: (s: ToolbarState) => void): void } }
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

for (const b of document.querySelectorAll<HTMLButtonElement>('.tab')) {
  b.addEventListener('click', () => window.walled.command({ cmd: 'switch', tab: b.dataset.tab as 'chatgpt' | 'perplexity' }));
}
for (const id of ['back', 'forward', 'reload', 'home', 'audit'] as const) {
  $(id).addEventListener('click', () => window.walled.command({ cmd: id }));
}
const color = $<HTMLInputElement>('color');
color.addEventListener('change', () => window.walled.command({ cmd: 'color', light: color.value }));

window.walled.onState((s) => {
  for (const b of document.querySelectorAll<HTMLButtonElement>('.tab')) {
    const t = s.tabs.find((x) => x.id === b.dataset.tab);
    b.setAttribute('aria-selected', String(b.dataset.tab === s.active));
    b.classList.toggle('loading', !!t?.loading);
  }
  const cur = s.tabs.find((x) => x.id === s.active);
  $<HTMLButtonElement>('back').disabled = !cur?.canGoBack;
  $<HTMLButtonElement>('forward').disabled = !cur?.canGoForward;
  $('marker').textContent = s.marker;
  if (document.activeElement !== color) color.value = s.color.light;
  document.title = `Walled DLP Guard ${s.version}`;
});
