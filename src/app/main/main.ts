/**
 * Walled DLP Guard – Electron main process.
 *
 * One standalone desktop app: it hosts ChatGPT and Perplexity in its own window,
 * receives every gated prompt / upload from the guard preload over IPC, inspects
 * it with the DLP core (text, PDF, OCR) and asks the user with a native OS dialog.
 */
import { app, dialog, ipcMain, Menu, session, BrowserWindow, shell, type IpcMainInvokeEvent, type MenuItemConstructorOptions } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_PATH, HOME_DIR, loadConfig, saveConfig, type Config } from '../../core/config.js';
import { AUDIT_PATH, formatAudit, log, readAudit } from '../../core/audit.js';
import { Dlp } from '../../core/dlp.js';
import { shutdownOcr } from '../../core/inspect/ocr.js';
import type { DecisionReply, GuardSettings } from '../../core/types.js';
import { VERSION } from '../../core/version.js';
import { IPC, type ToolbarCommand } from '../ipc-channels.js';
import { createConfirm, scriptedShow, type ShowMessageBox } from './dialog.js';
import { browserUserAgent, parseFilesRequest, parsePromptRequest, permissionAllowed, trustedSite } from './policy.js';
import { lighten } from './response-color.js';
import { AppWindow, type TabId } from './window.js';

const DIR = path.dirname(fileURLToPath(import.meta.url)); // dist/app/main
const APP_DIR = path.resolve(DIR, '..');                   // dist/app

app.setName('Walled DLP Guard');
// Separate browser profile (cookies, cache) for automated tests or a second test instance.
if (process.env.WALLED_DLP_USER_DATA) app.setPath('userData', process.env.WALLED_DLP_USER_DATA);
if (!app.requestSingleInstanceLock()) app.exit(0);

let cfg: Config = loadConfig();
let main: AppWindow | null = null;

const nativeShow: ShowMessageBox = (parent, options) => (parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options));
const confirm = createConfirm(process.env.WALLED_DLP_TEST_DIALOG ? scriptedShow(process.env.WALLED_DLP_TEST_DIALOG) : nativeShow, () => main?.win ?? null);

const failClosed = (reason: string): DecisionReply => ({ decision: 'cancel', reason, findings: [], scanMs: 0 });

/** Accepts a DLP request only from the top frame of a ChatGPT / Perplexity page inside this app. */
function siteOf(e: IpcMainInvokeEvent | Electron.IpcMainEvent) {
  const fromOurView = e.sender.session === siteSession() && (main?.isSiteView(e.sender) || BrowserWindow.fromWebContents(e.sender) !== null);
  return trustedSite(e.senderFrame?.url, e.senderFrame === e.sender.mainFrame, fromOurView);
}

// WALLED_DLP_PARTITION="" (automated tests only) uses the default session so the test driver can route requests.
const PARTITION = process.env.WALLED_DLP_PARTITION ?? 'persist:walled-dlp';
const siteSession = () => (PARTITION ? session.fromPartition(PARTITION) : session.defaultSession);

function registerIpc() {
  ipcMain.on(IPC.settings, (e) => {
    const s: GuardSettings = { marker: cfg.marker, maxInspectBytes: cfg.maxInspectMB * 1024 * 1024 };
    e.returnValue = s;
  });

  ipcMain.handle(IPC.checkPrompt, async (e, payload: unknown): Promise<DecisionReply> => {
    const site = siteOf(e);
    const req = parsePromptRequest(payload);
    if (!site || !req) return failClosed('app-error');
    try {
      return await new Dlp(cfg, confirm, (f) => e.sender.send(IPC.status, f)).checkPrompt(site, e.senderFrame!.url, req.text);
    } catch (err) {
      log('prompt check failed', String(err));
      return failClosed('app-error');
    }
  });

  ipcMain.handle(IPC.checkFiles, async (e, payload: unknown): Promise<DecisionReply> => {
    const site = siteOf(e);
    const req = parseFilesRequest(payload);
    if (!site || !req) return failClosed('app-error');
    try {
      return await new Dlp(cfg, confirm, (f) => e.sender.send(IPC.status, f)).checkFiles(site, e.senderFrame!.url, req.via, req.files);
    } catch (err) {
      log('upload check failed', String(err));
      return failClosed('app-error');
    }
  });

  ipcMain.on(IPC.toolbarCommand, (e, c: ToolbarCommand) => {
    if (!main || e.sender !== main.toolbar.webContents) return;
    const wc = main.current();
    switch (c?.cmd) {
      case 'switch': if (c.tab === 'chatgpt' || c.tab === 'perplexity') main.show(c.tab); break;
      case 'back': if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack(); break;
      case 'forward': if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward(); break;
      case 'reload': wc.reload(); break;
      case 'home': void wc.loadURL(main.active === 'chatgpt' ? 'https://chatgpt.com/' : 'https://www.perplexity.ai/'); break;
      case 'audit': showAudit(); break;
      case 'color':
        if (/^#[0-9a-f]{6}$/i.test(c.light)) {
          cfg = saveConfig({ responseColor: { light: c.light, dark: lighten(c.light) } });
          main.refreshColors();
        }
        break;
    }
  });
}

let auditWin: BrowserWindow | null = null;
function showAudit() {
  const esc = (s: string) => s.replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[ch]!);
  const lines = readAudit(200).map(formatAudit).reverse();
  const html = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Walled DLP – audit log</title><style>body{font:13px/1.5 ui-monospace,monospace;margin:16px;background:#0f172a;color:#e2e8f0}h1{font:600 15px system-ui;margin:0 0 4px}p{font:12px system-ui;color:#94a3b8;margin:0 0 12px}pre{white-space:pre-wrap;margin:0}</style>
<h1>Audit log (newest first)</h1><p>${esc(AUDIT_PATH)} – decisions, file names and hashes only; prompt text and file content are never stored.</p><pre>${esc(lines.join('\n') || '(no entries yet)')}</pre>`;
  if (!auditWin || auditWin.isDestroyed()) {
    auditWin = new BrowserWindow({ width: 1100, height: 560, title: 'Walled DLP – audit log', autoHideMenuBar: true, webPreferences: { sandbox: true, contextIsolation: true, javascript: false } });
  }
  void auditWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  auditWin.show();
}

function buildMenu() {
  const go = (tab: TabId) => () => main?.show(tab);
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    { label: 'File', submenu: [{ label: 'Audit log', accelerator: 'CmdOrCtrl+L', click: showAudit }, { label: 'Open settings folder', click: () => void shell.openPath(HOME_DIR) }, { type: 'separator' }, { role: 'quit' }] },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'ChatGPT', accelerator: 'CmdOrCtrl+1', click: go('chatgpt') },
        { label: 'Perplexity', accelerator: 'CmdOrCtrl+2', click: go('perplexity') },
        { type: 'separator' },
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => main?.current().reload() },
        { label: 'Back', accelerator: 'Alt+Left', click: () => main?.current().navigationHistory.goBack() },
        { label: 'Forward', accelerator: 'Alt+Right', click: () => main?.current().navigationHistory.goForward() },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' },
        { label: 'Developer tools (page)', accelerator: 'CmdOrCtrl+Shift+I', click: () => main?.current().toggleDevTools() },
      ],
    },
    { role: 'help', submenu: [{ label: `Walled DLP Guard ${VERSION}`, enabled: false }, { label: `Marker: ${cfg.marker}`, enabled: false }, { label: `Config: ${CONFIG_PATH}`, enabled: false }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function hardenSession() {
  const s = siteSession();
  s.setUserAgent(browserUserAgent(s.getUserAgent()));
  const debug = !!process.env.WALLED_DLP_DEBUG;
  s.setPermissionRequestHandler((_wc, permission, cb) => { if (debug) log('permission request', permission, permissionAllowed(permission)); cb(permissionAllowed(permission)); });
  s.setPermissionCheckHandler((_wc, permission) => { if (debug) log('permission check', permission, permissionAllowed(permission)); return permissionAllowed(permission); });
  // Downloads (e.g. exported chats) go to the normal Downloads folder with a save dialog.
  s.on('will-download', (_e, item) => item.setSaveDialogOptions({ title: 'Save download' }));
}

app.on('second-instance', () => { if (main) { if (main.win.isMinimized()) main.win.restore(); main.win.focus(); } });
app.on('web-contents-created', (_e, wc) => {
  // No page may turn itself into something we did not create (e.g. <webview> tags).
  wc.on('will-attach-webview', (ev) => ev.preventDefault());
});

app.whenReady().then(() => {
  hardenSession();
  registerIpc();
  buildMenu();
  const startUrls = process.env.WALLED_DLP_START_URLS ? (JSON.parse(process.env.WALLED_DLP_START_URLS) as Partial<Record<TabId, string>>) : undefined;
  main = new AppWindow({ session: siteSession(), dir: APP_DIR, colors: () => cfg.responseColor, marker: cfg.marker, version: VERSION, startUrls });
  if (process.env.WALLED_DLP_START_TAB === 'perplexity') main.show('perplexity');
  main.win.on('closed', () => { main = null; app.quit(); });
  log(`Walled DLP Guard ${VERSION} started; config ${CONFIG_PATH}; audit ${AUDIT_PATH}`);
}).catch((err) => { log('startup failed', String(err)); app.exit(1); });

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => { void shutdownOcr(); });
