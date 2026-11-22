# Architecture

Walled DLP Guard is **one standalone desktop application** built on Electron. It has no browser extension, no native-messaging host and no helper process. The web apps run inside the application's own window.

| Part | Runs in | Responsibility |
|---|---|---|
| **Main process** (`src/app/main`) | Node.js process of the app | Creates the window and views, applies security policy and the response colour, receives DLP requests over IPC, shows the **native dialog**, and writes the audit log. |
| **DLP core** (`src/core`) | Main process, as plain TypeScript with no Electron imports | Marker matching, file-type sniffing, text / PDF / OCR inspection, the policy engine (`Dlp`), config and audit. The tests and the CLI use the same code. |
| **Guard** (`src/app/guard`) | Preload script of every ChatGPT / Perplexity page, in an isolated world in a sandboxed renderer | Catches prompt submits and file uploads before the page sees them, holds them, asks the main process, then replays or drops them. |
| **Toolbar** (`src/app/toolbar`) | Its own small sandboxed view | Tabs, navigation, protection status, colour picker, audit-log button. Talks to the main process through two functions exposed by `contextBridge`. |

### Why an Electron app with embedded web views?

* **Standalone, and the browser part is inside the app.** The brief excludes extensions, plug-ins and add-ons. In this design the browser engine is part of the app: the app decides what code runs in the ChatGPT and Perplexity pages (the preload), and when.
* **Interception happens before transmission, and without breaking the site.** The guard sees the real user action at the moment it happens: the prompt text, or the `File` objects being picked, dropped or pasted. It can hold the action and later replay exactly that action through the site's own upload code.
  * The alternative, a TLS-intercepting proxy, would need a trusted root CA on the machine. It would also have to parse each site's private API traffic (streaming, chunked or resumable uploads) and could not "pause" a request while the user decides without breaking the app.
* **The dialog is native.** `dialog.showMessageBox` is drawn by the OS toolkit, so the page cannot create, hide or click it.

## Process and window layout

```
BaseWindow "Walled DLP Guard"
├── WebContentsView  toolbar.html        (sandbox, contextIsolation, CSP, preload: toolbar-preload.cjs)
├── WebContentsView  https://chatgpt.com (sandbox, contextIsolation, session persist:walled-dlp, preload: guard.cjs)
└── WebContentsView  https://www.perplexity.ai               (same as above)
    └── sign-in pop-ups (Google/Apple/Microsoft/OpenAI) → BrowserWindow with the same preload and session
```

Both site views stay loaded, so switching tabs never loses a conversation.

## End-to-end flow

```
 site page (React app)            guard preload (isolated world)                 main process
 ─────────────────────            ──────────────────────────────                 ────────────
 user presses Enter / clicks send
 ── capture listener on window ─► composer text contains marker?
                                  no  → do nothing (event continues, zero delay)
                                  yes → preventDefault + stopImmediatePropagation
                                        invoke('dlp:check-prompt', {text})  ───►  validate sender + input
                                                                                  Dlp.checkPrompt → marker found
                                                                     ◄─────────   send('dlp:status')  (toast: "confirm in dialog")
                                                                                  dialog.showMessageBox(Cancel | Continue)
                                                                     ◄─────────   {decision, reason, findings}
                                  continue → replay once (button.click() /
                                             synthetic Enter / requestSubmit)
                                  cancel   → keep text, toast "Blocked"

 user picks / drops / pastes files
 ── capture listener on window ─► hold the event, read File bytes (≤ maxInspectMB)
                                  invoke('dlp:check-files', {via, files[]}) ───►  sniff type → text / PDF / OCR
                                                                                  clean → continue (no dialog)
                                                                                  marker → native dialog naming the file(s)
                                                                     ◄─────────   decision
                                  continue → re-dispatch the same change / drop /
                                             paste event with the same File objects
                                  cancel   → input.value = '' (same file can be re-picked)
```

## Interception and enforcement (guard)

Electron runs the preload **before any page script**, in an **isolated JavaScript world** (contextIsolation). The guard registers **capture-phase listeners on `window`**. Capture on `window` is the first stop of DOM event dispatch, so these listeners always run before the site's own React, ProseMirror (ChatGPT) or Lexical (Perplexity) handlers.

| Channel | Events caught | Hold | Replay on Continue |
|---|---|---|---|
| Prompt via keyboard | `keydown` Enter in the composer (not Shift+Enter or IME composition) | stop event | click on the send button, or a synthetic Enter |
| Prompt via button | `pointerdown/mousedown/pointerup/mouseup/click` on the send button | stop event | `button.click()` |
| Prompt via form | `submit` | stop event | `form.requestSubmit()` |
| File picker | `input` / `change` on `<input type=file>` | stop event | re-dispatch `input` + `change` on the same input |
| Drag and drop | `drop` | stop event (also stops the window from opening the file); send `dragleave` so the site's drop overlay closes | new `DragEvent('drop')` whose `DataTransfer` holds the same `File`s |
| Paste | `paste` with files | stop event | new `ClipboardEvent('paste')` with the same `File`s |

Details:

* **Replay guard.** A `replaying` flag is set only during the synchronous re-dispatch, so the replayed event is not caught again. Only one decision can be pending at a time.
* **What you approve is what is sent.** Before a prompt is replayed, the composer is read again. If the text changed while the dialog was open, the user must send again, which triggers a fresh check.
* **Cancel.** Nothing reaches the site. The file input is reset, and the prompt stays in the composer. A toast in a closed shadow root (the page can't read or style it) gives the reason.
* **Site adapters** (`guard/sites.ts`) hold the selectors.
  * ChatGPT: composer `#prompt-textarea`; send button `#composer-submit-button` / `[data-testid=send-button]`.
  * Perplexity: composer `#ask-input`; send button `[data-testid=submit-button]`.
  * Generic fallbacks: any `contenteditable` or `textarea` composer, and a send/submit-labelled button.
  * The guard does nothing on any other origin, such as sign-in pages.

### IPC hardening (main process)

* `ipcMain.handle('dlp:check-*')` only answers requests that meet all of these:
  * the sender uses the app's site session, so the toolbar and audit window are excluded;
  * the request comes from the **top frame**;
  * the URL is **https** `chatgpt.com` / `chat.openai.com` / `perplexity.ai`.

  Anything else gets a **cancel** (`policy.ts → trustedSite`).
* Renderer input is validated before use: shape, types, sizes and the allowed `via` values.
* Nothing is exposed to page scripts. The guard uses `ipcRenderer` from its isolated world, and only the toolbar gets a two-function `contextBridge` API.

## Inspection pipeline (DLP core)

`core/inspect/index.ts` works on the **bytes**, not the file name or MIME type.

1. **Sniff** (`sniff.ts`): magic numbers for PDF, PNG, JPEG, GIF, BMP, TIFF and WebP. Otherwise the file is treated as text if it decodes cleanly (BOM, UTF-8, UTF-16), and as binary if not.
2. **Text**: decode and match.
3. **PDF** (`pdf.ts`, pdfjs-dist):
   * a. the text layer, page by page (handles compressed streams and CID fonts);
   * b. the metadata;
   * c. pages without real text (**scanned PDFs**) are rendered at 2× with `@napi-rs/canvas` and OCR'd, up to `ocrPdfPages` pages.
4. **Image** (`ocr.ts`, tesseract.js with the bundled offline `eng` model):
   * Decode any format, flatten transparency onto white, and upscale small images.
   * OCR the image. If nothing matches, also OCR an **inverted** copy, which handles light-on-dark and dark-mode screenshots.
   * One worker is created and reused.
5. **Raw-byte fallback**: a latin1 and UTF-16 scan catches the marker in metadata, uncompressed parts of other formats, and unparseable files.

Matching (`core/marker.ts`) has three levels:

* **Prompts and text:** NFKC normalisation, zero-width characters removed, case-insensitive.
* **PDF text:** also whitespace-insensitive.
* **OCR text:** fuzzy. Text is reduced to an A–Z skeleton, common OCR confusions are mapped (`0→O`, `1/I/|→L`, `5→S`…), and a match within **Levenshtein distance ≤ 2** counts. The tests check that near-misses are *not* flagged.

## Native dialog

`app/main/dialog.ts` wraps Electron's `dialog.showMessageBox`, which on each OS uses:

* **Linux:** a GTK message dialog
* **macOS:** NSAlert
* **Windows:** a Win32 message/task dialog

Settings and behaviour:

* **Content:** `type: 'warning'`, buttons **Cancel | Continue**, `defaultId` and `cancelId` = Cancel, `noLink`.
* **Window:** the dialog is modal to the app window.
* **What it says:** `message` names the channel (TEXT PROMPT / FILE UPLOAD), the site and, for files, how they were added. `detail` shows the prompt (shortened to 220 characters) or the flagged files, with type, size and how the marker was found.
* **Queue:** dialogs are shown one at a time.
* **Timeout:** after `dialogTimeoutSec` the dialog is closed through an `AbortSignal` and the result is **timeout**, which is treated as Cancel.
* **Errors:** any exception gives **unavailable**, also treated as Cancel.
* **Test hook:** `WALLED_DLP_TEST_DIALOG=continue|cancel|timeout|error|file:<path>` replaces the dialog in automated tests and logs what would have been shown. It is never set in normal use.

## Response colour

`app/main/response-color.ts` builds the CSS, and the main process injects it with `webContents.insertCSS(css, { cssOrigin: 'user' })` on every `dom-ready`.

* **Why user-origin.** A user-origin `!important` rule beats the site's own `!important` author rules. Because it is a stylesheet, it also applies to answers that are still streaming in.
* **What it targets.**
  * ChatGPT: `[data-message-author-role="assistant"] .markdown`.
  * Perplexity: answer `.prose`, excluding the user bubble `[data-message-bubble]`.
* **What it leaves alone.** Only descendants are coloured, and `pre` is excluded, so code blocks keep their syntax colours.
* **Themes.** There are separate light and dark colours, chosen from the site's theme class or `prefers-color-scheme`.
* **Changing the colour.** The toolbar colour picker saves the light colour and a lighter dark-theme variant, then re-injects the CSS in both views. Colours are validated as hex before they are put into CSS.

## Failure modes: fail closed

| Situation | Result |
|---|---|
| Dialog not answered within `dialogTimeoutSec` (120 s) | **Blocked** (`timeout`) |
| Dialog cannot be shown or throws | **Blocked** (`no-dialog`) |
| IPC error, untrusted sender or malformed request | **Blocked** (`app-error`) |
| A file can't be parsed and no marker was found | `onInspectionError`: **ask** (default) / allow / block |
| File larger than `maxInspectMB` | Not inspected; the user is **asked** |

## Security and privacy

* **Isolation.** Site views use `sandbox: true`, `contextIsolation: true` and `nodeIntegration: false`. `<webview>` tags are blocked.
* **Permissions.** Only clipboard, fullscreen and notifications are allowed. Camera, microphone, location, USB and similar are denied.
* **Pop-ups.** Only known sign-in providers open in the app; other links open in the system browser, and odd schemes are refused.
* **Local only.** All inspection is offline in the main process. The OCR model ships with the app, and content never leaves the machine except through the user's own approved submission.
* **Audit log.** `~/.walled-dlp/audit.jsonl` (mode 0600) records the time, site origin, channel, decision, reason, file names, sizes, types, SHA-256 hashes and detection method. It **never** records prompt text or file content; a test checks this.
* **Single instance.** Only one copy of the app runs per user profile.

## Trade-offs

* **Embedded web views vs. the user's own browser.** An in-app browser gives reliable, hold-able interception without an extension. The cost is that the protection only applies when the sites are used through this app, so enterprise deployment would pair it with network policy.
* **Fast in-page prompt check.** Clean prompts never leave the page and add no delay. Prompts with the marker are re-checked in the main process before the dialog. Files always go to the main process, because PDF parsing and OCR belong there.
* **Event replay vs. re-implementing uploads.** Replaying the original DOM event keeps each site's own upload code path, so the upload is unmodified. The catch is that it depends on the sites accepting synthetic `change`, `drop` and `paste` events; both do today.
* **Electron.** One TypeScript codebase for three OSes, with the OS's native dialog and good PDF and OCR libraries. The cost is the app size (about 180 MB AppImage, mostly Chromium).
