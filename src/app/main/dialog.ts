/**
 * The native confirmation dialog.
 *
 * Electron's dialog.showMessageBox is drawn by the operating system's own toolkit
 * (GTK on Linux, NSAlert on macOS, a Win32 task dialog on Windows) – it is not HTML
 * and the web page cannot see, script or fake it.
 */
import type { BaseWindow, MessageBoxOptions, MessageBoxReturnValue } from 'electron';
import fs from 'node:fs';
import type { DialogOutcome, DialogRequest } from '../../core/types.js';

export type ShowMessageBox = (parent: BaseWindow | null, options: MessageBoxOptions) => Promise<MessageBoxReturnValue>;

export const BUTTONS = ['Cancel', 'Continue'] as const;
const CANCEL = 0;
const CONTINUE = 1;

/** Builds the options for one confirmation. Cancel is the default and the Esc/close action. */
export function messageBoxOptions(req: DialogRequest, signal?: AbortSignal): MessageBoxOptions {
  return {
    type: 'warning',
    title: req.title,
    message: req.message,
    detail: req.detail,
    buttons: [...BUTTONS],
    defaultId: CANCEL,
    cancelId: CANCEL,
    noLink: true,
    normalizeAccessKeys: false,
    signal,
  };
}

/**
 * Returns a `confirm` function for the DLP core. Dialogs are shown one at a time
 * (two stacked questions about different actions would be confusing) and every
 * failure – timeout, error, closed window – is a Cancel (fail closed).
 */
export function createConfirm(show: ShowMessageBox, parent: () => BaseWindow | null): (req: DialogRequest) => Promise<DialogOutcome> {
  let tail: Promise<unknown> = Promise.resolve();
  const one = async (req: DialogRequest): Promise<DialogOutcome> => {
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, Math.max(1, req.timeoutSec) * 1000);
    try {
      const win = parent();
      const { response } = await show(win && !win.isDestroyed() ? win : null, messageBoxOptions(req, ctrl.signal));
      if (timedOut) return 'timeout';
      return response === CONTINUE ? 'continue' : 'cancel';
    } catch {
      return timedOut ? 'timeout' : 'unavailable';
    } finally {
      clearTimeout(timer);
    }
  };
  return (req) => {
    const next = tail.then(() => one(req), () => one(req));
    tail = next.catch(() => undefined);
    return next;
  };
}

/**
 * Automated-test hook only: WALLED_DLP_TEST_DIALOG=continue|cancel|timeout|file:<path>
 * answers every dialog without showing it and appends the request to
 * WALLED_DLP_TEST_DIALOG_LOG. Never set in normal use.
 */
export function scriptedShow(spec: string): ShowMessageBox {
  return async (_parent, options) => {
    const answer = spec.startsWith('file:') ? fs.readFileSync(spec.slice(5), 'utf8').trim() : spec;
    const log = process.env.WALLED_DLP_TEST_DIALOG_LOG;
    if (log) fs.appendFileSync(log, JSON.stringify({ title: options.title, message: options.message, detail: options.detail, buttons: options.buttons }) + '\n');
    if (answer === 'timeout') {
      // behave like an unanswered dialog: wait until the caller aborts it
      await new Promise<void>((resolve) => options.signal?.addEventListener('abort', () => resolve(), { once: true }));
      return { response: CANCEL, checkboxChecked: false };
    }
    if (answer === 'error') throw new Error('dialog failed');
    return { response: answer === 'continue' ? CONTINUE : CANCEL, checkboxChecked: false };
  };
}
