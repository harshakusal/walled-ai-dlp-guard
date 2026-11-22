/**
 * The app window: a toolbar (tabs, navigation, colour, audit log) on top and one
 * WebContentsView per protected web app below it. Both sites stay loaded, so
 * switching tabs never loses a conversation.
 */
import { BaseWindow, BrowserWindow, WebContentsView, shell, type Session, type WebContents } from 'electron';
import path from 'node:path';
import { SITE_NAMES, SITE_URLS } from '../../core/sites.js';
import { IPC, type ToolbarState } from '../ipc-channels.js';
import { popupPolicy } from './policy.js';
import { responseColorCss, type ResponseColors } from './response-color.js';

export type TabId = 'chatgpt' | 'perplexity';
const TOOLBAR_HEIGHT = 48;

export interface AppWindowOptions {
  session: Session;
  dir: string;              // dist/app
  colors: () => ResponseColors;
  marker: string;
  version: string;
  startUrls?: Partial<Record<TabId, string>>;
}

export class AppWindow {
  readonly win: BaseWindow;
  readonly toolbar: WebContentsView;
  readonly views: Record<TabId, WebContentsView>;
  active: TabId = 'chatgpt';
  private cssKeys = new Map<number, string>();

  constructor(private opts: AppWindowOptions) {
    this.win = new BaseWindow({ width: 1440, height: 920, minWidth: 900, minHeight: 600, title: 'Walled DLP Guard', backgroundColor: '#ffffff', icon: path.join(opts.dir, 'icon.png') });

    this.toolbar = new WebContentsView({
      webPreferences: { preload: path.join(opts.dir, 'toolbar-preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    this.toolbar.webContents.loadFile(path.join(opts.dir, 'toolbar', 'toolbar.html'));
    this.toolbar.webContents.on('did-finish-load', () => this.pushState());
    this.toolbar.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.toolbar.webContents.on('will-navigate', (e) => e.preventDefault());

    const makeSiteView = (tab: TabId) => {
      const view = new WebContentsView({ webPreferences: this.siteWebPreferences() });
      this.protect(view.webContents);
      for (const ev of ['page-title-updated', 'did-start-loading', 'did-stop-loading', 'did-navigate', 'did-navigate-in-page'] as const) {
        view.webContents.on(ev as 'did-stop-loading', () => this.pushState());
      }
      view.webContents.loadURL(opts.startUrls?.[tab] ?? SITE_URLS[tab]);
      return view;
    };
    this.views = { chatgpt: makeSiteView('chatgpt'), perplexity: makeSiteView('perplexity') };

    this.win.contentView.addChildView(this.views.chatgpt);
    this.win.contentView.addChildView(this.views.perplexity);
    this.win.contentView.addChildView(this.toolbar);
    this.win.on('resize', () => this.layout());
    this.layout();
    this.show('chatgpt');
  }

  /** Every page that can show ChatGPT / Perplexity runs the guard preload in an isolated, sandboxed world. */
  siteWebPreferences() {
    return {
      session: this.opts.session,
      preload: path.join(this.opts.dir, 'guard.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: true,
    };
  }

  /** Response colour, pop-up policy and navigation rules for a site view or sign-in pop-up. */
  protect(wc: WebContents) {
    wc.on('dom-ready', () => void this.applyCss(wc));
    wc.setWindowOpenHandler(({ url }) => {
      const policy = popupPolicy(url);
      if (policy === 'external') { void shell.openExternal(url); return { action: 'deny' }; }
      if (policy === 'deny') return { action: 'deny' };
      return { action: 'allow', overrideBrowserWindowOptions: { width: 520, height: 720, autoHideMenuBar: true, webPreferences: this.siteWebPreferences() } };
    });
    wc.on('did-create-window', (child: BrowserWindow) => this.protect(child.webContents));
  }

  private async applyCss(wc: WebContents) {
    if (wc.isDestroyed()) return;
    const old = this.cssKeys.get(wc.id);
    if (old) await wc.removeInsertedCSS(old).catch(() => {});
    const key = await wc.insertCSS(responseColorCss(this.opts.colors()), { cssOrigin: 'user' }).catch(() => '');
    if (key) this.cssKeys.set(wc.id, key);
  }

  /** Re-applies the response colour in every open site page (after a change in the toolbar). */
  refreshColors() {
    for (const v of Object.values(this.views)) void this.applyCss(v.webContents);
    this.pushState();
  }

  show(tab: TabId) {
    this.active = tab;
    for (const [id, v] of Object.entries(this.views)) v.setVisible(id === tab);
    this.views[tab].webContents.focus();
    this.win.setTitle(`Walled DLP Guard – ${SITE_NAMES[tab]}`);
    this.pushState();
  }

  current(): WebContents {
    return this.views[this.active].webContents;
  }

  isSiteView(wc: WebContents): boolean {
    return Object.values(this.views).some((v) => v.webContents === wc);
  }

  private layout() {
    const { width, height } = this.win.getContentBounds();
    this.toolbar.setBounds({ x: 0, y: 0, width, height: TOOLBAR_HEIGHT });
    for (const v of Object.values(this.views)) v.setBounds({ x: 0, y: TOOLBAR_HEIGHT, width, height: Math.max(0, height - TOOLBAR_HEIGHT) });
  }

  pushState() {
    if (!this.views || this.toolbar.webContents.isDestroyed()) return;
    const state: ToolbarState = {
      active: this.active,
      tabs: (Object.keys(this.views) as TabId[]).map((id) => {
        const wc = this.views[id].webContents;
        return { id, title: SITE_NAMES[id], loading: wc.isLoading(), canGoBack: wc.navigationHistory.canGoBack(), canGoForward: wc.navigationHistory.canGoForward() };
      }),
      marker: this.opts.marker,
      color: this.opts.colors(),
      version: this.opts.version,
    };
    this.toolbar.webContents.send(IPC.toolbarState, state);
  }
}
