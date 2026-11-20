import type { DialogBackend, DialogOutcome, DialogRequest } from './types.js';
import { run, which } from './exec.js';

const pango = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** GTK dialog via zenity (GNOME/most distros). Exit 0 = OK button, 1 = Cancel/Esc/close, 5 = timeout. */
export const zenity: DialogBackend = {
  name: 'zenity (GTK)',
  available: () => which('zenity'),
  async show(req: DialogRequest): Promise<DialogOutcome> {
    const r = await run('zenity', [
      '--question',
      `--title=${req.title}`,
      `--text=${pango(req.message)}`,
      '--ok-label=Continue',
      '--cancel-label=Cancel',
      '--default-cancel',
      '--icon=dialog-warning',
      '--width=520',
      `--timeout=${req.timeoutSec}`,
    ], { timeoutMs: (req.timeoutSec + 5) * 1000 });
    if (r.code === 0) return 'continue';
    if (r.code === 5) return 'timeout';
    return 'cancel';
  },
};

/** Qt dialog via kdialog (KDE). */
export const kdialog: DialogBackend = {
  name: 'kdialog (Qt)',
  available: () => which('kdialog'),
  async show(req: DialogRequest): Promise<DialogOutcome> {
    const r = await run('kdialog', [
      '--title', req.title,
      '--warningcontinuecancel', req.message,
      '--continue-label', 'Continue',
    ], { timeoutMs: req.timeoutSec * 1000 });
    if (r.code === 0) return 'continue';
    if (r.code === null) return 'timeout';
    return 'cancel';
  },
};
