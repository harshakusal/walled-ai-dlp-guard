# Architecture

Walled DLP Guard has two parts that talk over Chrome **native messaging**:

| Component | Runs in | Responsibility |
|---|---|---|
| **Browser sensor** (`src/extension`) | Chrome/Edge/Brave, MV3 extension | Catch prompt submits and file uploads on ChatGPT and Perplexity before the page sees them. Hold them, ask the agent, then replay or drop them. Recolour AI responses. |
| **Desktop agent** (`src/agent`, `walled-dlp`) | Native process started by the browser (Node.js) | Inspect content (text, PDF, image OCR), apply the policy, show the **native OS dialog**, write the audit log. |
| Shared (`src/shared`) | both | Marker matching (`marker.ts`) and the message protocol (`protocol.ts`). |

Why this split:

* **Interception needs the browser.** Only code inside the page can stop a submit or an upload before the web app's JavaScript reads it. A network proxy only sees TLS traffic, and changing it after the fact is fragile.
* **The dialog needs to be native.** The assignment asks for a desktop dialog, and an in-page popup could be scripted or hidden by the page. The agent is a real OS process, so it uses the OS's own dialog toolkit.
* **Heavy inspection needs the agent.** PDF parsing and OCR are too heavy and too security-sensitive for the page. In the agent they run outside the browser sandbox, offline, and the content never goes to the network.

## End-to-end flow

```
 page (chatgpt.com / perplexity.ai)        extension                         desktop agent (walled-dlp host)
 ───────────────────────────────────  ─────────────────────────────  ───────────────────────────────────────────
 user presses Enter / clicks send
 ── capture-phase listener (ours) ──► marker in composer?
                                       no  → let event through (zero overhead)
                                       yes → preventDefault +
                                             stopImmediatePropagation
                                             {t:'prompt', text}  ───────►  containsMarker → native dialog
                                                                   ◄──────  {t:'status', awaiting-user}  (toast: "confirm in the
                                                                                                          Walled DLP dialog")
                                                                   ◄──────  {t:'decision', continue|cancel}
                                       continue → replay (click / Enter /
                                                  requestSubmit) once
                                       cancel   → keep text, show toast

 user picks / drops / pastes files
 ── capture-phase listener (ours) ──► hold event, read File bytes
                                       files-begin, file-chunk×N (4 MB,
                                       base64), files-end   ─────────────►  reassemble → sniff type → inspect
                                                                            clean   → continue (no dialog)
                                                                            marker  → native dialog naming the file(s)
                                                                   ◄──────  decision
                                       continue → re-dispatch the same
                                                  change/drop/paste event
                                       cancel   → input.value = '' (can
                                                  re-select the same file)
```

`background.ts` (service worker) is a relay. It keeps one `connectNative('ai.walled.dlp_guard')` port and tracks pending request IDs. If the agent disconnects, every pending request gets a **cancel** (fail closed).

## Interception and enforcement (browser side)

The content script runs at **`document_start`** in the extension's isolated world. It registers **capture-phase listeners on `window`**. Capture on `window` is the first point in event dispatch, so our handlers run before the listeners of React, ProseMirror (ChatGPT) or Lexical (Perplexity), however the app registered them.

| Channel | Events caught | Hold | Replay on Continue |
|---|---|---|---|
| Prompt via keyboard | `keydown` Enter (not Shift+Enter or IME composition) in the composer | stop event | synthetic Enter on the composer, or click on the send button |
| Prompt via button | `pointerdown/mousedown/pointerup/mouseup/click` on the send button | stop event | `button.click()` |
| Prompt via form | `submit` | stop event | `form.requestSubmit()` |
| File picker | `input` / `change` on `<input type=file>` | stop event | re-dispatch `input` + `change` on the same input |
| Drag and drop | `drop` (and `dragover` while busy) | stop event; send `dragleave` so the page's overlay closes | new `DragEvent('drop')` with a `DataTransfer` holding the same `File`s |
| Paste | `paste` with files | stop event | new `ClipboardEvent('paste')` with the same `File`s |

Details:

* **Replay guard.** A `replaying` flag is set only during the synchronous re-dispatch, so the replayed event is not caught again. Only one decision can be pending at a time (`busy`); other gated actions are blocked while it is open.
* **What you approve is what gets sent.** Before a prompt is replayed, the composer is read again. If the user typed a different sensitive prompt while the dialog was open, it goes through the check again.
* **Cancel.** Nothing reaches the page. The file input is reset, so choosing the same file again fires `change`. The prompt stays in the composer so the user can edit and retry. A small toast (closed shadow root, so the page can't read or style it) gives the reason.
* **Site adapters** (`sites.ts`) hold the per-site selectors for the composer, send button and assistant messages.
  * ChatGPT: `#prompt-textarea`, `#composer-submit-button` / `[data-testid=send-button]`.
  * Perplexity: `#ask-input`, `[data-testid=submit-button]`.
  * Generic fallbacks: any `contenteditable` or `textarea` composer, and a submit button inside its form.

### Response colour

`response-color.css` is declared in the manifest, so it applies from the first paint with no flicker and no MutationObserver.

* **Targets.** It colours text inside ChatGPT's `[data-message-author-role="assistant"]` and Perplexity's answer `.prose` blocks.
* **Exclusions.** User message bubbles (`[data-message-bubble]`) and code blocks (`pre`) keep their own colours.
* **Colours.** Two CSS variables (`--walled-dlp-light`, `--walled-dlp-dark`) are picked by the site's theme class or `prefers-color-scheme`. The content script sets them from the agent config or the popup override.

## Inspection pipeline (agent)

`inspect/index.ts` works on the **bytes**, not on the file name or MIME type. A PDF renamed to `.txt` is still parsed as a PDF.

1. **Sniff** (`sniff.ts`): magic numbers for PDF, PNG, JPEG, GIF, BMP, TIFF and WebP; otherwise text if the bytes decode cleanly (BOM, UTF-8, UTF-16); otherwise binary.
2. **Text**: decode (UTF-8, UTF-16 LE/BE) and match.
3. **PDF** (`pdf.ts`, pdfjs-dist):
   * a. the text layer, page by page (this handles compressed content streams and fonts);
   * b. the metadata (title, subject, keywords…);
   * c. if no page has real text (a **scanned PDF**), render up to `ocrPdfPages` pages at 2× with `@napi-rs/canvas` and OCR them.
4. **Image** (`ocr.ts`, tesseract.js with the bundled offline `eng` model):
   * Decode any image format, flatten transparency onto white, and upscale small images.
   * OCR the image. If nothing matches, also OCR an inverted copy, which handles dark-mode screenshots.
   * The worker is created once and reused.
5. **Raw-byte fallback**: a latin1 and UTF-16 scan of the raw bytes. This catches the marker in PNG/JPEG metadata, uncompressed parts of other formats, and unparseable files.

Matching (`shared/marker.ts`) has three levels:

* **Prompts and text:** NFKC normalisation (so full-width or compatibility characters match), zero-width characters removed, case-insensitive.
* **PDF text:** also whitespace-insensitive, because PDF text runs often split words.
* **OCR text:** fuzzy. Text is reduced to an A–Z skeleton, common OCR confusions are mapped (`0→O`, `1/I/|→L`, `5→S`…), and a match within **Levenshtein distance ≤ 2** of the marker counts. The tests also check that unrelated words are *not* flagged.

## Native dialog

`dialog/index.ts` picks a backend at runtime:

| OS | Backend | Notes |
|---|---|---|
| Linux | `zenity --question` (GTK); fallback `kdialog` | Tested (shown in the demo). |
| macOS | `osascript` → `display dialog … buttons {"Cancel","Continue"}` with a caution icon | The text is passed as an argv argument, never put into the script source, so there is no injection. |
| Windows | `powershell -NoProfile` WinForms form, `TopMost` | The text is passed in environment variables. |

All backends:

* Dialogs are **queued** (one at a time).
* The default button is **Cancel**.
* Closing the window counts as Cancel.
* A timeout (`dialogTimeoutSec`) gives `timeout`, which is treated as Cancel.
* If no backend exists, the result is `no-dialog-backend`, also treated as Cancel.

A test hook (`WALLED_DLP_TEST_DIALOG=continue|cancel|timeout|file:<path>`) replaces the UI in automated tests and logs what would have been shown.

## Native messaging protocol

The framing is standard Chrome native messaging: a 32-bit little-endian length, then UTF-8 JSON.

* **stdout** carries only frames. All diagnostics go to stderr.
* **Messages:** `hello`, `prompt`, `files-begin` / `file-chunk` / `files-end`, `dialog-test`.
* **Replies:** `hello`, `status`, `decision`, `error`.
* **Chunking.** Files travel as 4 MB base64 chunks. Chrome caps a message at 64 MB going to the host and 1 MB coming from it.
* **Agent limits.** The agent caps one upload at 512 MB in total. A malformed message gets `error`; the extension treats it as cancel, and the host keeps running.
* **Lifetime.** The host exits when the browser closes stdin.

Registration (`installer.ts`):

* **Manifest.** Writes `ai.walled.dlp_guard.json` into each browser's `NativeMessagingHosts` folder (Linux and macOS) or into `HKCU\Software\…\NativeMessagingHosts` (Windows).
* **Who can connect.** `allowed_origins` contains only this extension's fixed ID. The ID comes from the manifest `key`, so no other extension can talk to the agent.
* **Launcher.** A launcher script pins the absolute Node binary and `cli.js` paths.

## Failure modes: fail closed

| Situation | Result |
|---|---|
| Agent not installed or crashed, `connectNative` fails | The gated action is **blocked**, and the toast explains how to install. Clean prompts are unaffected because they are checked in-page. |
| Dialog not answered within `dialogTimeoutSec` (120 s) | **Blocked** (`timeout`) |
| No dialog backend | **Blocked** (`no-dialog-backend`) |
| Internal or protocol error | **Blocked** (`agent-error`) |
| A file can't be parsed (corrupt or unsupported) and no marker was found | `onInspectionError`: **ask** (default) / allow / block |
| File larger than 100 MB | Not inspected; the user is **asked** |

## Privacy and security

* **Local only.** All inspection is offline. The OCR model ships with the package, and no content leaves the machine except through the user's own approved submission.
* **Audit log.** `~/.walled-dlp/audit.jsonl` records the time, site origin, channel, decision, reason, file names, sizes, types, SHA-256 hashes and detection method. It **never** records prompt text or file content; a test checks this.
* **Minimal permissions.** The extension asks for `nativeMessaging` and `storage` only, with host permissions limited to the two sites.
* **Isolation from the page.**
  * The content script runs in an isolated world, so page scripts can't call it.
  * The toast is in a closed shadow root.
  * The decision is made by an OS process the page can't reach.

## Trade-offs

* **Extension + agent vs. a pure desktop proxy (MITM).** A proxy would need a trusted root CA, and it would only see encrypted, app-specific API payloads. Holding and replaying a request after the user confirms would also be fragile. In-page interception sees exactly what the user is sending (prompt text and `File` objects) at the moment they send it. The cost is the dependency on the browser.
* **Fast in-page prompt check.** Clean prompts never leave the page and add no delay. Only prompts that contain the marker go to the agent, which re-checks them and shows the dialog. Files always go to the agent, because OCR and PDF parsing belong there.
* **Event replay vs. re-implementing upload.** Replaying the original DOM event keeps the site's own upload code path, so the upload is "unmodified". The catch is that it depends on the site accepting synthetic `change` and `drop` events; it worked on both sites in testing.
* **Node.js agent.** Node gives one codebase for three OSes and good PDF and OCR libraries. A signed native binary (for example made with `pkg`, or a Go/Rust rewrite) would be the production next step.
