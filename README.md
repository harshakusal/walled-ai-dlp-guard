# Walled DLP Guard

A **standalone desktop app** for data-loss prevention (DLP) on **ChatGPT** (chatgpt.com) and **Perplexity** (perplexity.ai).

It is built with Electron and **does not need any browser extension, plug-in or add-on**. The app opens both web apps in its own window, with one tab each. It checks every **text prompt** and every **file upload** (text, PDF, image) for the marker `WALLED_SENSITIVE` before anything is sent.

When the marker is found, the action is **held** and a **native OS dialog** opens. The dialog says whether the hit is in a **text prompt** or a **file upload**, and shows the prompt or the file name(s). You then choose:

* **Continue**: the original prompt or file is sent unchanged.
* **Cancel**: nothing is sent. You can edit and send again, or choose the files again.

Prompts and files without the marker go through with no extra step. The **AI responses** on both sites are shown in a **different text colour** (orange by default; you can change it in the toolbar).

* **Demo video** (about 5 min, captioned, recorded with the packaged AppImage on the live sites):
  * Watch in your browser: <https://harshakusal.github.io/walled-ai-dlp-guard/>
  * Or download the file: [`docs/demo/walled-dlp-guard-demo.mp4`](docs/demo/walled-dlp-guard-demo.mp4)
* **Linux download (AppImage):** [Releases](https://github.com/harshakusal/walled-ai-dlp-guard/releases/latest)
* **Architecture overview:** [ARCHITECTURE.md](ARCHITECTURE.md)

```
┌───────────────────────────── Walled DLP Guard (one desktop app) ───────────────────────────────┐
│  toolbar: [ChatGPT] [Perplexity]  ← → ↻  ● Protected · WALLED_SENSITIVE   colour   Audit log   │
│ ┌───────────────────────────────────────────────┐        ┌───────────────────────────────────┐ │
│ │ chatgpt.com / perplexity.ai (sandboxed view)  │  IPC   │ main process (Node.js)            │ │
│ │  guard preload (isolated world):              │ ─────► │  • DLP core: text / PDF / OCR     │ │
│ │  • catches Enter / send / upload / drop /     │        │  • native dialog                  │ │
│ │    paste before the page sees them            │ ◄───── │    (dialog.showMessageBox)        │ │
│ │  • replays them on Continue                   │        │  • response-colour CSS, audit log │ │
│ └───────────────────────────────────────────────┘        └───────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────────────────────────────┘
```

## How each requirement is met

| Requirement | Implementation |
|---|---|
| **Standalone desktop app**, no extension / plug-in / add-on | An Electron app with its own window, menu and toolbar. It is packaged as an AppImage, and `electron-builder` targets are set up for macOS (dmg) and Windows (nsis). ChatGPT and Perplexity run in sandboxed `WebContentsView`s inside the app. No browser and no browser extension is used or installed; an end-to-end test checks this. |
| Works with ChatGPT web and Perplexity web | Tabs load `https://chatgpt.com/` and `https://www.perplexity.ai/` (the real web apps), with a Chrome-compatible user agent. Sign-in pop-ups (Google, Apple, Microsoft, OpenAI) open inside the app; other links open in the system browser. |
| Inspect text prompts **before they are submitted** | The guard preload runs before any page script, in an isolated world. Its capture-phase listeners catch the Enter key, the send-button click and form submit **before the web app's own handlers**. A prompt with the marker is held while the main process decides. |
| Inspect file uploads **before they are transmitted** (text, PDF, image) | File picker, drag-and-drop and paste are all caught. The main process gets the file bytes over IPC and checks the real file type from its content, not its extension. Text is decoded as UTF-8/16. PDFs are checked via the text layer, then metadata, then OCR of scanned pages. Images are checked with OCR (Tesseract, offline English model). A raw-byte scan also covers metadata. |
| **Native** desktop dialog with Continue / Cancel | Electron `dialog.showMessageBox` uses the OS's own toolkit: a GTK dialog on Linux, NSAlert on macOS, a Win32 task dialog on Windows. It is **not HTML**, and the page cannot see or script it. Cancel is the default button and the Esc/close action. |
| Dialog says prompt vs. file and names it | **Prompt** example: "…was detected in a **TEXT PROMPT** you are submitting to Perplexity." Detail: `Prompt: "…"`. **File** example: "…was detected in a **FILE UPLOAD** to ChatGPT (via drag and drop)." Detail: `• report.pdf (PDF, 3.1 KB) – found via PDF text layer (page 2)`. |
| No marker: no extra interaction | Clean prompts never leave the page, so there is no delay. Clean files are inspected and attached with no dialog. |
| Continue: proceed unmodified | The held event is replayed with the **same** `File` objects or the same prompt, through the site's own code path. If the prompt was edited while the dialog was open, it is checked again. |
| Cancel: block, and you can retry | The event never reaches the site. The file input is cleared so the same file can be picked again, and the prompt stays in the box for editing. |
| Recolour all AI responses on both sites | The main process injects a **user-origin stylesheet** (`webContents.insertCSS`) on every page load. It covers streaming answers too. The user's own messages and code blocks keep their colours. A colour picker in the toolbar changes the colour live, and the choice is saved. |
| Source, README, architecture, demo | This repo, [ARCHITECTURE.md](ARCHITECTURE.md), and the demo video above. |

## Run it

### Option A – packaged Linux build (AppImage)

1. Download `Walled-DLP-Guard-2.0.0-x86_64.AppImage` from the [latest release](https://github.com/harshakusal/walled-ai-dlp-guard/releases/latest).
2. Make it executable and start it:

```bash
chmod +x Walled-DLP-Guard-2.0.0-x86_64.AppImage
./Walled-DLP-Guard-2.0.0-x86_64.AppImage
# On systems without FUSE 2:  ./Walled-DLP-Guard-2.0.0-x86_64.AppImage --appimage-extract-and-run
```

### Option B – from source (Linux, macOS, Windows)

Requires Node.js **20+** (tested with Node 24).

```bash
git clone https://github.com/harshakusal/walled-ai-dlp-guard.git
cd walled-ai-dlp-guard
npm install
npm start              # builds (tsc + esbuild) and launches the app
```

Build installers with `npm run dist:linux`, `npm run dist:mac` or `npm run dist:win`. The output goes to `release/`.

> **Tested on:** Linux (Debian 13, X11) only, both from source and as the AppImage. The code has no Linux-specific parts, but the macOS and Windows builds and native dialogs **have not been run on those systems**.

## Use

1. Start the app. The **ChatGPT** tab opens first; switch with the toolbar tabs or **Ctrl+1 / Ctrl+2**.
2. Sign in to either site as you would in a browser, or use it signed out. Sessions are kept in the app's own profile.
3. Work as usual:

| You do | Result |
|---|---|
| Send a normal prompt | Sent immediately |
| Send a prompt containing `WALLED_SENSITIVE` (Enter or send button) | Held → native dialog → **Continue** sends it unchanged / **Cancel** keeps it in the box |
| Upload a clean file (picker, drag-and-drop, paste) | Inspected, then attached as usual |
| Upload a text / PDF (also scanned) / image file containing the marker | Held → dialog naming the file(s) → **Continue** attaches it / **Cancel** drops it |

Other controls:

* **Toolbar:** back / forward / reload / new chat, and a status pill showing the marker.
* **AI response colour:** a picker in the toolbar.
* **Audit log:** shows the recent decisions (**Ctrl+L**).

The `fixtures/` folder has ready-made test files:

* clean and sensitive `.txt` files, plus a UTF-16 `.txt`
* compressed PDFs, and a scanned (image-only) PDF
* PNG screenshots, a dark-mode screenshot and a JPEG photo
* a PDF renamed to `.txt`

### Configuration: `~/.walled-dlp/config.json` (optional)

```json
{
  "marker": "WALLED_SENSITIVE",
  "dialogTimeoutSec": 120,
  "ocrPdfPages": 5,
  "onInspectionError": "ask",
  "maxInspectMB": 100,
  "responseColor": { "light": "#c2410c", "dark": "#fdba74" }
}
```

* `dialogTimeoutSec`: an unanswered dialog is closed after this many seconds and counts as **Cancel**.
* `onInspectionError`: what to do with a file that can't be parsed (`ask` | `allow` | `block`).
* `maxInspectMB`: files larger than this are not inspected; the user is asked instead.
* `WALLED_DLP_HOME` changes the folder used for config and audit.

### Audit log

`~/.walled-dlp/audit.jsonl` keeps one line per decision: time, site, channel, decision, reason, file names, sizes, types, SHA-256 hashes and detection method.
It **never stores prompt text or file content**.

You can view it in the app (**Audit log**), or with `npm run audit`.

### Developer CLI

These commands use the same DLP core as the app; no GUI is needed.

```bash
npm run build
node dist/cli.js scan fixtures/*        # inspect files exactly as uploads are inspected
node dist/cli.js audit -n 20            # recent decisions (--json for raw lines)
node dist/cli.js status                 # paths + effective configuration
```

## Tests

```bash
npm test          # build + 37 unit/integration tests (node:test)
npm run test:e2e  # 10 end-to-end tests that drive the real Electron app (needs a display; use xvfb-run on headless Linux)
WALLED_DLP_E2E_EXECUTABLE=release/linux-unpacked/walled-dlp-guard npm run test:e2e   # same suite against the packaged build
```

**Unit and integration tests** cover:

* marker matching, including normalisation, near-misses and OCR fuzziness
* inspection of every fixture type: compressed PDF, scanned PDF, dark-mode OCR, JPEG, UTF-16, a renamed file, a corrupt PDF, and a marker in PNG metadata
* the policy engine and audit privacy
* the native-dialog adapter: button mapping, timeout, failure and one-dialog-at-a-time
* main-process security policy: which senders are trusted, input validation, pop-ups, permissions, user agent and CSS sanitising

**End-to-end tests** launch the app with Playwright. Mock ChatGPT and Perplexity pages are served on the real origins, and the dialog is answered by a test hook. They cover:

* prompts sent by Enter and by the send button
* file picker, drag-and-drop and paste for text, PDF, scanned PDF and image
* Continue and Cancel
* response colouring
* fail-closed on timeout or dialog error
* the toolbar colour picker
* the audit log
* that no browser extension is loaded

The demo video shows the same flows on the **live** sites, using the packaged AppImage and the real GTK dialog.

## Known limitations

* **Tested on Linux only.** The macOS and Windows builds are configured but untested.
* **Only covers the app.** It protects ChatGPT and Perplexity *inside the app*. If the same sites are opened in a normal browser, they are not covered. A company rollout would make this app the approved way to reach them, and block the sites elsewhere (proxy, DNS or browser policy).
* **Site markup changes.** The selectors for the composer, send button and assistant messages can break when ChatGPT or Perplexity change their UI.
  * Generic fallbacks reduce the risk.
  * Upload interception does not depend on site markup.
* **OCR accuracy.** OCR is English only and best effort: very small, rotated, handwritten or low-contrast text can be missed.
  * Matching allows up to 2 recognition errors.
  * Scanned PDFs: only the first `ocrPdfPages` pages are checked.
* **Other file types.** DOCX, XLSX and ZIP are not unpacked; only a raw-byte scan is done. Files over `maxInspectMB` are not inspected, and the user is asked instead.
* **Linux file picker.** Electron 41+ opens the system file picker through the XDG desktop portal, which normal GNOME, KDE and XFCE desktops provide. On a bare X server without a D-Bus session and `xdg-desktop-portal-gtk`, the picker can return no file. Drag-and-drop and paste still work there.
* **ChatGPT sign-in.** The demo uses signed-out ChatGPT, which only accepts images. Text and PDF uploads on ChatGPT are therefore shown with Cancel in the demo, and fully covered by the end-to-end tests.

An earlier browser-extension prototype is kept on the `legacy-browser-extension` branch for reference only; it is **not** part of this submission.
