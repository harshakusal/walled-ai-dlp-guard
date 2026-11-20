# Walled DLP Guard

A desktop data-loss-prevention (DLP) app for **ChatGPT** (chatgpt.com) and **Perplexity** (perplexity.ai) on the web.

It checks every **text prompt** and every **file upload** (text, PDF, image) for the marker
`WALLED_SENSITIVE`. When the marker is found, the submission is **held** and a **native desktop
dialog** opens. The dialog says whether the hit was in a **prompt** or a **file** and shows the
prompt or the file name(s):

* **Continue**: the original prompt or file is submitted unchanged.
* **Cancel**: nothing is sent. The user can edit and send again, or pick files again.

The AI's responses on both sites are shown in a **different text colour** (orange by default; you can change it).

**Demo video (about 4 min, captioned):** [`docs/demo/walled-dlp-guard-demo.mp4`](docs/demo/walled-dlp-guard-demo.mp4)
([direct download](https://github.com/harshakusal/walled-ai-dlp-guard/raw/main/docs/demo/walled-dlp-guard-demo.mp4))

**Architecture overview:** [ARCHITECTURE.md](ARCHITECTURE.md)

```
 Chrome / Edge / Brave                                   Desktop
┌────────────────────────────────────────┐   native    ┌──────────────────────────────────────┐
│ content script (chatgpt / perplexity)  │  messaging  │ walled-dlp agent (Node.js)           │
│  • captures send / upload events first │◄──────────► │  • text / PDF / image (OCR) inspection│
│  • holds them, replays on Continue     │   (stdio)   │  • native Continue/Cancel dialog     │
│  • recolours AI responses (CSS)        │             │  • policy, fail-closed, audit log    │
└────────────────────────────────────────┘             └──────────────────────────────────────┘
```

## How each requirement is met

| Requirement | Implementation |
|---|---|
| Works with ChatGPT web and Perplexity web | MV3 extension content script on `chatgpt.com`, `chat.openai.com` and `perplexity.ai`. Each site has its own adapter in [`src/extension/sites.ts`](src/extension/sites.ts). |
| Inspect text prompts | Enter key, send-button click and form submit are caught in the capture phase, before the site's own handlers. The composer text is checked for the marker (Unicode-normalised, case-insensitive). |
| Inspect file uploads: text, PDF, image | File picker, drag-and-drop and paste are all caught. Bytes are streamed in chunks to the agent, which detects the real file type from its content (the extension is ignored). Text files are decoded (UTF-8/16). PDFs use the text layer, then metadata, then OCR of scanned pages. Images use OCR (Tesseract, offline English model). A raw-byte scan also covers metadata. |
| Native desktop dialog with Continue / Cancel | The **agent** opens an OS dialog: zenity/kdialog on Linux, `osascript` on macOS, WinForms via PowerShell on Windows. It is not an in-page popup. |
| Dialog says prompt vs. file and shows its name | "…detected in a **TEXT PROMPT** you are submitting to Perplexity. Prompt: "…"", or "…detected in a **FILE UPLOAD** to ChatGPT (via drag and drop). • report.pdf (PDF, 3.1 KB) – found via PDF text layer (page 2)". |
| Continue proceeds unmodified | The held event is replayed with the same `File` objects or the same prompt. If the prompt is edited while the dialog is open, it is checked again. |
| Cancel blocks and the user can retry | The held event is dropped and the `<input type=file>` is cleared, so the same file can be chosen again. The prompt text stays in the box for editing. |
| Different colour for AI responses on both sites | Declarative CSS on the assistant-message containers, with a separate light and dark theme colour. The user's own messages and code blocks are not recoloured. The colour can be set in the toolbar popup or in the agent config. |
| Source, README, architecture, demo | This repo, [ARCHITECTURE.md](ARCHITECTURE.md), and the video above (recorded on the live sites). |

## Requirements

* Node.js **20+** (tested on Node 22, Linux)
* Chrome, Chromium, Edge or Brave (Manifest V3, version 116 or newer)
* A dialog backend:
  * **Linux:** `zenity` (GNOME/GTK) or `kdialog` (KDE)
  * **macOS:** built in (`osascript`)
  * **Windows:** built in (PowerShell + WinForms)

## Install

```bash
git clone https://github.com/harshakusal/walled-ai-dlp-guard.git
cd walled-ai-dlp-guard
npm install
npm run build          # compiles the agent (dist/agent) and bundles the extension (dist/extension)
npm run install-host   # registers the native-messaging host for Chrome/Chromium/Edge/Brave
```

Then load the extension:

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select `dist/extension`.
   * The manifest has a fixed key, so the ID is always `deoglpgghholljpmkibnmkcpflgihine`. That ID is the one the host allows.
3. Reload any open ChatGPT or Perplexity tabs.

The toolbar popup should show **Agent: connected**.

Optional checks: `npx walled-dlp status` (backend, config, paths) and `npx walled-dlp dialog-test` (opens the native dialog).

Extra install options:

* **Another browser or profile:** `walled-dlp install --browser edge`, or `--user-data-dir <profile dir>`. Run `walled-dlp uninstall` to remove the registration.
* **Global command:** `npm link` puts `walled-dlp` on your PATH. Otherwise use `npx walled-dlp …` from the repo.

> The browser starts the agent on demand: it launches `~/.walled-dlp/walled-dlp-host.sh` (or `.bat` on Windows), which runs `dist/agent/cli.js host`. No background service is needed.

## Use

| Action | Result |
|---|---|
| Send a normal prompt | Sent straight away (checked in-page; nothing leaves the browser) |
| Send a prompt containing `WALLED_SENSITIVE` | Held → native dialog → Continue sends it unchanged / Cancel keeps it in the box |
| Upload a clean file | Inspected by the agent, then attached as usual |
| Upload a file containing the marker (text, PDF incl. scanned, PNG/JPEG/WebP/…) | Held → dialog naming the file(s) → Continue attaches / Cancel drops it |

The `fixtures/` folder has ready-made test files: clean and sensitive `.txt`, a UTF-16 `.txt`, compressed PDFs, a scanned (image-only) PDF, PNG screenshots, a dark-mode screenshot, a JPEG photo, and a PDF renamed to `.txt`.

Try the inspector without a browser:

```bash
npx walled-dlp scan fixtures/*
```

### CLI

```
walled-dlp install [--browser chrome|chromium|edge|brave|...] [--user-data-dir DIR] [--extension-id ID]
walled-dlp uninstall | status | dialog-test
walled-dlp scan FILE...           # same inspection as uploads; exit code 1 if anything is sensitive
walled-dlp audit [-n N] [--json]  # recent decisions
```

### Configuration: `~/.walled-dlp/config.json` (optional)

```json
{
  "marker": "WALLED_SENSITIVE",
  "dialogTimeoutSec": 120,
  "ocrPdfPages": 5,
  "onInspectionError": "ask",
  "responseColor": { "light": "#c2410c", "dark": "#fdba74" }
}
```

* `dialogTimeoutSec`: an unanswered dialog counts as **Cancel** when this runs out.
* `onInspectionError`: what to do with a file that can't be parsed (`ask` | `allow` | `block`).
* Colours set in the extension popup override `responseColor`.
* `WALLED_DLP_HOME` changes the folder used for config and audit.

### Audit log

`~/.walled-dlp/audit.jsonl` keeps one line per decision: time, site, decision, reason, file names, sizes, types, SHA-256 hashes and detection method.
It **never stores prompt text or file content**.

## Tests

```bash
npm test          # build + 31 unit/integration tests (node:test)
npm run test:e2e  # 7 browser end-to-end tests (Playwright + real extension + real agent; needs a display / Xvfb)
```

**Unit and integration tests** cover:

* marker matching, including normalisation, near-misses and OCR fuzziness
* inspection of every fixture type: compressed PDF text, scanned PDF OCR, dark-mode OCR, JPEG, UTF-16, a renamed file, a corrupt PDF, and a marker in PNG metadata
* the policy engine and audit privacy
* the real native-messaging host process over stdio: framing, chunked uploads, Continue/Cancel/timeout, protocol errors, and exit when the pipe closes

**End-to-end tests** load the built extension in Chromium. Mock ChatGPT and Perplexity pages are served on the real origins. The tests drive prompts (Enter and button), file-picker, drag-and-drop and paste uploads, Continue and Cancel, response colouring, and the fail-closed path when no agent is running. Dialog answers are scripted with `WALLED_DLP_TEST_DIALOG`.

The demo video shows the same flows on the **live** sites, with the real zenity dialog on Linux.

## Known limitations

* **Tested on Linux (zenity) only.** The macOS and Windows dialog backends are written but have not been run on those systems.
* **Site markup changes.** Selectors for the composer, send button and assistant messages may break when ChatGPT or Perplexity change their UI.
  * The generic fallbacks (any `contenteditable`/`textarea` composer, any submit-type button in its form) reduce the risk.
  * Upload interception does not depend on site markup.
* **Browser-level control only.** The extension can be turned off by the user, and the sites can be used from apps or browsers without it. Enterprise rollout would force-install it with browser policy (`ExtensionInstallForcelist`) and block other paths at the network or proxy layer.
* **OCR accuracy.** OCR is English only and best effort: very small, rotated, handwritten or low-contrast text can be missed.
  * Matching tolerates up to 2 recognition errors.
  * Scanned PDFs: only the first `ocrPdfPages` pages are OCR'd.
* **Other file types.** DOCX, XLSX and ZIP are not unpacked, but the raw-byte scan still finds an uncompressed marker.
* **Large files.** Files over 100 MB are not inspected; the user is asked instead.
* **Waiting time.** Large uploads and OCR add a short delay (each demo file takes under 1 s; `walled-dlp scan` prints the time per file).
