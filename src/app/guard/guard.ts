/**
 * Guard: the preload script of every ChatGPT / Perplexity view in the app.
 *
 * Electron runs it in an isolated JavaScript world (contextIsolation) before any
 * page script, so its capture-phase listeners on `window` fire before the web
 * app's own handlers (React, ProseMirror, Lexical...). A gated event is stopped
 * (`preventDefault` + `stopImmediatePropagation`) – the web app never sees it –
 * and the decision is delegated over IPC to the main process, which inspects the
 * content and shows the native dialog. On Continue the *original* action is
 * replayed (same File objects / same prompt), on Cancel nothing is sent.
 *
 *   prompts: Enter in a composer, click on the send button, <form> submit
 *   files:   <input type=file> input/change, drag-and-drop, paste
 *
 * The page cannot reach this code or the IPC channel: nothing is exposed with
 * contextBridge, and the main process only accepts DLP requests from its own
 * site views.
 */
import { ipcRenderer } from 'electron';
import { containsMarker, DEFAULT_MARKER } from '../../core/marker.js';
import type { DecisionReply, FilePayload, Finding, GuardSettings, Site, UploadVia } from '../../core/types.js';
import { IPC } from '../ipc-channels.js';
import { ADAPTERS, detectSite, findSendButton, isSendButton, type SiteAdapter } from './sites.js';
import { toast } from './toast.js';

const SITE: Site = detectSite(location.hostname);
const ADAPTER: SiteAdapter | null = SITE === 'unknown' ? null : ADAPTERS[SITE];

let settings: GuardSettings = { marker: DEFAULT_MARKER, maxInspectBytes: 100 * 1024 * 1024 };
try { settings = ipcRenderer.sendSync(IPC.settings) as GuardSettings; } catch { /* defaults */ }
const marker = settings.marker;

let busy = false;
/** True only while we synchronously re-dispatch an approved action. */
let replaying = false;

// ---------------------------------------------------------------- main-process bridge
const failClosed = (reason: string): DecisionReply => ({ decision: 'cancel', reason, findings: [], scanMs: 0 });

async function ask(channel: string, payload: unknown): Promise<DecisionReply> {
  try {
    return (await ipcRenderer.invoke(channel, payload)) as DecisionReply;
  } catch {
    return failClosed('app-error');
  }
}

ipcRenderer.on(IPC.status, (_e, findings: Finding[]) => {
  const what = findings.map((f) => (f.source === 'file' ? `"${f.name}"` : 'your prompt')).join(', ');
  toast(`Sensitive marker found in ${what || 'this upload'} – confirm in the Walled DLP dialog.`, 'warn', 0);
});

// ---------------------------------------------------------------- helpers
/** Listeners are only installed on ChatGPT / Perplexity, never on sign-in or other pages. */
function on<K extends keyof WindowEventMap>(type: K, fn: (e: WindowEventMap[K]) => void, capture: true): void {
  if (ADAPTER) window.addEventListener(type, fn, capture);
}

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
  'no-dialog': 'Blocked – the confirmation dialog could not be shown (fail-closed).',
  'app-error': 'Blocked – Walled DLP hit an internal error (fail-closed).',
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
  let r: DecisionReply;
  try {
    toast('Sensitive marker detected in your prompt – confirm in the Walled DLP dialog.', 'warn', 0);
    r = await ask(IPC.checkPrompt, { site: SITE, url: location.href, text });
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

on('keydown', (e) => {
  if (replaying || e.key !== 'Enter' || e.shiftKey || e.isComposing || e.keyCode === 229) return;
  const composer = editableFrom(e.target);
  if (!composer) return;
  void gatePrompt(e, composer, () => submitComposer(composer));
}, true);

// Pointer/mouse down on the send button with a sensitive prompt is swallowed so
// no handler can submit early; the click handler below asks for the decision.
for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup'] as const) {
  on(type, (e) => {
    if (replaying) return;
    const btn = (e.target as Element | null)?.closest?.('button, [role="button"]');
    if (!btn || !isSendButton(btn, ADAPTER)) return;
    const composer = findComposerNear(btn);
    if (composer && containsMarker(readText(composer), marker)) block(e);
  }, true);
}

on('click', (e) => {
  if (replaying) return;
  const btn = (e.target as Element | null)?.closest?.<HTMLElement>('button, [role="button"]');
  if (!btn || !isSendButton(btn, ADAPTER)) return;
  const composer = findComposerNear(btn);
  if (!composer) return;
  void gatePrompt(e, composer, () => btn.isConnected ? btn.click() : submitComposer(composer));
}, true);

on('submit', (e) => {
  if (replaying) return;
  const form = e.target as HTMLFormElement;
  const composer = form.querySelector?.<HTMLElement>('textarea, [contenteditable="true"]');
  if (!composer) return;
  const ed = editableFrom(composer);
  if (ed) void gatePrompt(e, ed, () => form.requestSubmit());
}, true);

// ---------------------------------------------------------------- files
/** Sends the files to the main process and resolves true if the upload may proceed. */
async function gateFiles(files: File[], via: UploadVia): Promise<boolean> {
  if (busy) { toast('Waiting for your decision in the Walled DLP dialog…', 'warn'); return false; }
  busy = true;
  const names = files.map((f) => f.name || 'pasted-file').join(', ');
  try {
    toast(`Walled DLP: inspecting ${files.length > 1 ? `${files.length} files` : `"${names}"`}…`, 'info', 0);
    const payload: FilePayload[] = [];
    for (const f of files) {
      const skipped = f.size > settings.maxInspectBytes;
      payload.push({ name: f.name || 'pasted-file', mime: f.type, size: f.size, skipped, bytes: skipped ? undefined : new Uint8Array(await f.arrayBuffer()) });
    }
    const r = await ask(IPC.checkFiles, { site: SITE, url: location.href, via, files: payload });
    if (r.decision === 'continue') {
      toast(r.reason === 'clean' ? 'Walled DLP: no sensitive content found.' : 'Allowed – upload continues.', 'ok');
      return true;
    }
    toast(`Upload of ${names}: ${reasonText(r.reason)}`, 'block');
    return false;
  } catch {
    toast(reasonText('app-error'), 'block');
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
on('input', onFileInput, true);
on('change', onFileInput, true);

on('drop', (e) => {
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

on('paste', (e) => {
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

