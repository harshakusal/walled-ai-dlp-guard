/**
 * Content script (isolated world, document_start) on chatgpt.com and perplexity.ai.
 *
 * Interception model: capture-phase listeners on `window`, registered before any
 * page script runs, so they fire before the web app's own handlers (React, ProseMirror,
 * Lexical...). A gated event is stopped (`preventDefault` + `stopImmediatePropagation`)
 * - the web app never sees it - and the decision is delegated to the desktop agent,
 * which inspects content and shows the native dialog. On Continue the *original*
 * action is replayed (same File objects / same prompt), on Cancel nothing is sent.
 *
 *   prompts: Enter in a composer, click on the send button, <form> submit
 *   files:   <input type=file> input/change, drag-and-drop, paste
 */
import { containsMarker, DEFAULT_MARKER } from '../shared/marker.js';
import type { DecisionReply, FileMeta, FromAgent, HelloReply, Site, ToAgent, UploadVia } from '../shared/protocol.js';
import { ADAPTERS, detectSite, findSendButton, isSendButton, type SiteAdapter } from './sites.js';
import { toast } from './toast.js';

const SITE: Site = detectSite(location.hostname);
const ADAPTER: SiteAdapter | null = SITE === 'unknown' ? null : ADAPTERS[SITE];
const CHUNK = 4 * 1024 * 1024;
const MAX_INSPECT = 100 * 1024 * 1024;

let marker = DEFAULT_MARKER;
let busy = false;
/** True only while we synchronously re-dispatch an approved action. */
let replaying = false;

// ---------------------------------------------------------------- agent bridge
let port: chrome.runtime.Port | null = null;
const waiters = new Map<string, (r: DecisionReply) => void>();
const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

function getPort(): chrome.runtime.Port {
  if (port) return port;
  const p = chrome.runtime.connect({ name: 'walled-dlp' }); // throws if the extension was reloaded
  p.onMessage.addListener((msg: FromAgent | { t: 'agent'; hello: HelloReply }) => {
    if (msg.t === 'agent') return applyAgent(msg.hello);
    if (msg.t === 'decision') { waiters.get(msg.id)?.(msg); waiters.delete(msg.id); }
    if (msg.t === 'status' && waiters.has(msg.id)) {
      const what = msg.findings.map((f) => (f.source === 'file' ? `"${f.name}"` : 'your prompt')).join(', ');
      toast(`Sensitive marker found in ${what || 'this upload'} – confirm in the Walled DLP dialog.`, 'warn', 0);
    }
  });
  p.onDisconnect.addListener(() => {
    port = null;
    for (const [id, resolve] of waiters) resolve({ t: 'decision', id, decision: 'cancel', reason: 'extension-disconnected', findings: [], scanMs: 0 });
    waiters.clear();
  });
  port = p;
  return p;
}

function waitFor(id: string): Promise<DecisionReply> {
  return new Promise((resolve) => waiters.set(id, resolve));
}

function send(msg: ToAgent) {
  getPort().postMessage(msg);
}

// ---------------------------------------------------------------- response colour
type Colors = { light: string; dark: string };
interface Stored { colorOverride?: Colors; agent?: HelloReply | null }
const stored = (keys: Array<keyof Stored>) => chrome.storage.local.get(keys) as Promise<Stored>;

function applyColors(colors?: Colors | null) {
  if (!colors) return;
  const root = document.documentElement;
  root.style.setProperty('--walled-dlp-light', colors.light);
  root.style.setProperty('--walled-dlp-dark', colors.dark);
}
function applyAgent(h: HelloReply) {
  marker = h.marker || DEFAULT_MARKER;
  void stored(['colorOverride']).then(({ colorOverride }) => applyColors(colorOverride ?? h.responseColor));
}
void stored(['colorOverride', 'agent']).then(({ colorOverride, agent }) => {
  if (agent?.marker) marker = agent.marker;
  applyColors(colorOverride ?? agent?.responseColor);
});
chrome.storage.onChanged.addListener((changes) => {
  if (changes.colorOverride) void stored(['agent']).then(({ agent }) => applyColors((changes.colorOverride.newValue as Colors | undefined) ?? agent?.responseColor));
});

// ---------------------------------------------------------------- helpers
function block(e: Event) {
  e.preventDefault();
  e.stopImmediatePropagation();
}

function replay(fn: () => void) {
  replaying = true;
  try { fn(); } finally { replaying = false; }
}

type Editable = HTMLTextAreaElement | HTMLInputElement | HTMLElement;

function editableFrom(target: EventTarget | null): Editable | null {
  const el = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  if (!el) return null;
  const field = el.closest('textarea, input[type="text"], input[type="search"], input:not([type])');
  if (field) return field as Editable;
  let ce = el.closest<HTMLElement>('[contenteditable]:not([contenteditable="false"])');
  if (!ce) return null;
  while (ce.parentElement?.isContentEditable) ce = ce.parentElement; // editor root
  return ce;
}

function readText(el: Editable): string {
  return el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement ? el.value : el.innerText;
}

function findComposerNear(from: Element): Editable | null {
  const sel = (ADAPTER?.composerSelectors ?? ['textarea', '[contenteditable="true"]']).join(',');
  let el: Element | null = from;
  for (let depth = 0; el && depth < 12; depth++, el = el.parentElement) {
    const found = el.querySelector<HTMLElement>(sel);
    if (found) return editableFrom(found);
  }
  const active = editableFrom(document.activeElement);
  if (active) return active;
  for (const s of ADAPTER?.composerSelectors ?? []) {
    const c = document.querySelector<HTMLElement>(s);
    if (c) return editableFrom(c);
  }
  return null;
}

const REASONS: Record<string, string> = {
  'user-cancel': 'Blocked – you chose Cancel. Nothing was sent; you can edit and try again.',
  timeout: 'Blocked – no decision was made in time (fail-closed).',
  'agent-unavailable': 'Blocked – the Walled DLP desktop agent is not running (fail-closed). Run "npm run install-host" and reload.',
  'extension-disconnected': 'Blocked – the Walled DLP extension was reloaded. Refresh this page.',
  'no-dialog-backend': 'Blocked – no native dialog backend available on this system (fail-closed).',
  'agent-error': 'Blocked – the Walled DLP agent hit an internal error (fail-closed).',
  uninspectable: 'Blocked – the file could not be inspected (policy: block).',
};
const reasonText = (r: string) => REASONS[r] ?? `Blocked (${r}).`;

// ---------------------------------------------------------------- prompts
async function gatePrompt(e: Event, composer: Editable, doReplay: () => void): Promise<void> {
  const text = readText(composer);
  if (!containsMarker(text, marker)) return; // clean prompt: untouched, zero overhead
  block(e);
  if (busy) { toast('Waiting for your decision in the Walled DLP dialog…', 'warn'); return; }
  busy = true;
  const id = uid();
  let r: DecisionReply;
  try {
    toast('Sensitive marker detected in your prompt – confirm in the Walled DLP dialog.', 'warn', 0);
    const done = waitFor(id);
    send({ t: 'prompt', id, site: SITE, url: location.href, text });
    r = await done;
  } catch {
    r = { t: 'decision', id, decision: 'cancel', reason: 'extension-disconnected', findings: [], scanMs: 0 };
  } finally {
    busy = false;
  }
  if (r.decision !== 'continue') {
    toast(reasonText(r.reason), 'block');
    composer.focus();
    return;
  }
  if (readText(composer) !== text) {
    // What you approve is what is sent: an edited prompt needs a fresh check.
    toast('The prompt changed while the dialog was open – press send again.', 'warn');
    return;
  }
  toast('Allowed – prompt submitted.', 'ok');
  replay(doReplay);
}

function submitComposer(composer: Editable) {
  const btn = findSendButton(composer, ADAPTER);
  if (btn) { btn.click(); return; }
  composer.focus();
  composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true }));
}

window.addEventListener('keydown', (e) => {
  if (replaying || e.key !== 'Enter' || e.shiftKey || e.isComposing || e.keyCode === 229) return;
  const composer = editableFrom(e.target);
  if (!composer) return;
  void gatePrompt(e, composer, () => submitComposer(composer));
}, true);

// Pointer/mouse down on the send button with a sensitive prompt is swallowed so
// no handler can submit early; the click handler below asks for the decision.
for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup'] as const) {
  window.addEventListener(type, (e) => {
    if (replaying) return;
    const btn = (e.target as Element | null)?.closest?.('button, [role="button"]');
    if (!btn || !isSendButton(btn, ADAPTER)) return;
    const composer = findComposerNear(btn);
    if (composer && containsMarker(readText(composer), marker)) block(e);
  }, true);
}

window.addEventListener('click', (e) => {
  if (replaying) return;
  const btn = (e.target as Element | null)?.closest?.<HTMLElement>('button, [role="button"]');
  if (!btn || !isSendButton(btn, ADAPTER)) return;
  const composer = findComposerNear(btn);
  if (!composer) return;
  void gatePrompt(e, composer, () => btn.isConnected ? btn.click() : submitComposer(composer));
}, true);

window.addEventListener('submit', (e) => {
  if (replaying) return;
  const form = e.target as HTMLFormElement;
  const composer = form.querySelector?.<HTMLElement>('textarea, [contenteditable="true"]');
  if (!composer) return;
  const ed = editableFrom(composer);
  if (ed) void gatePrompt(e, ed, () => form.requestSubmit());
}, true);

// ---------------------------------------------------------------- files
function readAsBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).replace(/^data:[^,]*,/, ''));
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

/** Sends the files to the agent and resolves true if the upload may proceed. */
async function gateFiles(files: File[], via: UploadVia): Promise<boolean> {
  if (busy) { toast('Waiting for your decision in the Walled DLP dialog…', 'warn'); return false; }
  busy = true;
  const id = uid();
  const names = files.map((f) => f.name).join(', ');
  try {
    toast(`Walled DLP: inspecting ${files.length > 1 ? `${files.length} files` : `"${names}"`}…`, 'info', 0);
    const metas: FileMeta[] = files.map((f, index) => ({ index, name: f.name || 'pasted-file', mime: f.type, size: f.size, skipped: f.size > MAX_INSPECT }));
    const done = waitFor(id);
    send({ t: 'files-begin', id, site: SITE, url: location.href, via, files: metas });
    for (const m of metas) {
      if (m.skipped) continue;
      const f = files[m.index];
      for (let off = 0; off < f.size || (off === 0 && f.size === 0); off += CHUNK) {
        send({ t: 'file-chunk', id, index: m.index, data: await readAsBase64(f.slice(off, off + CHUNK)) });
        if (f.size === 0) break;
      }
    }
    send({ t: 'files-end', id });
    const r = await done;
    if (r.decision === 'continue') {
      toast(r.reason === 'clean' ? 'Walled DLP: no sensitive content found.' : 'Allowed – upload continues.', 'ok');
      return true;
    }
    toast(`Upload of ${names}: ${reasonText(r.reason)}`, 'block');
    return false;
  } catch {
    toast(reasonText('extension-disconnected'), 'block');
    return false;
  } finally {
    busy = false;
  }
}

function cloneTransfer(files: File[], strings: Array<[string, string]> = []): DataTransfer {
  const dt = new DataTransfer();
  for (const [type, value] of strings) dt.setData(type, value);
  for (const f of files) dt.items.add(f);
  return dt;
}

// <input type="file">: 'input' fires first, then 'change' – both are held back.
const inspecting = new WeakSet<HTMLInputElement>();
function onFileInput(e: Event) {
  if (replaying) return;
  const input = e.target;
  if (!(input instanceof HTMLInputElement) || input.type !== 'file' || !input.files?.length) return;
  block(e);
  if (inspecting.has(input)) return;
  inspecting.add(input);
  const files = [...input.files];
  void gateFiles(files, 'file-picker').then((ok) => {
    inspecting.delete(input);
    if (ok) {
      replay(() => {
        input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
    } else {
      input.value = ''; // so picking the same file again fires 'change' again
    }
  });
}
window.addEventListener('input', onFileInput, true);
window.addEventListener('change', onFileInput, true);

window.addEventListener('drop', (e) => {
  if (replaying || !e.dataTransfer?.files.length) return;
  const files = [...e.dataTransfer.files];
  const strings = [...e.dataTransfer.types].filter((t) => t !== 'Files').map((t) => [t, e.dataTransfer!.getData(t)] as [string, string]);
  const target = e.target as Element;
  const init = { bubbles: true, cancelable: true, composed: true, clientX: e.clientX, clientY: e.clientY, screenX: e.screenX, screenY: e.screenY };
  block(e); // also stops the browser from opening the file
  void gateFiles(files, 'drag-and-drop').then((ok) => {
    const t = target.isConnected ? target : document.elementFromPoint(e.clientX, e.clientY) ?? document.body;
    replay(() => {
      if (ok) t.dispatchEvent(new DragEvent('drop', { ...init, dataTransfer: cloneTransfer(files, strings) }));
      else t.dispatchEvent(new DragEvent('dragleave', { ...init, dataTransfer: new DataTransfer() })); // reset drop overlay
    });
  });
}, true);

window.addEventListener('paste', (e) => {
  if (replaying || !e.clipboardData?.files.length) return;
  const files = [...e.clipboardData.files];
  const strings = [...e.clipboardData.types].filter((t) => t !== 'Files').map((t) => [t, e.clipboardData!.getData(t)] as [string, string]);
  const target = e.target as Element;
  block(e);
  void gateFiles(files, 'paste').then((ok) => {
    if (!ok) return;
    const t = target.isConnected ? target : document.activeElement ?? document.body;
    replay(() => t.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, composed: true, clipboardData: cloneTransfer(files, strings) })));
  });
}, true);

// Connect early so the agent's colours and marker are applied before the first response.
try { getPort(); } catch { /* extension context gone */ }
