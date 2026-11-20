import type { DialogBackend, DialogOutcome, DialogRequest } from './types.js';
import { zenity, kdialog } from './linux.js';
import { osascript } from './macos.js';
import { winforms } from './windows.js';

export type { DialogOutcome, DialogRequest } from './types.js';

const CANDIDATES: Record<string, DialogBackend[]> = {
  win32: [winforms],
  darwin: [osascript],
  linux: [zenity, kdialog],
};

let chosen: Promise<DialogBackend | null> | null = null;

/**
 * Test hook: WALLED_DLP_TEST_DIALOG=continue|cancel|timeout (or file:/path containing one
 * of those) answers every dialog
 * automatically (used by the automated test-suite only; never set it in real use).
 */
const scripted = (answer: string): DialogBackend => ({
  name: `scripted test backend (${answer})`,
  available: async () => true,
  show: async (req) => {
    const fs = await import('node:fs');
    if (answer.startsWith('file:')) answer = fs.readFileSync(answer.slice(5), 'utf8').trim();
    const log = process.env.WALLED_DLP_TEST_DIALOG_LOG;
    if (log) fs.appendFileSync(log, JSON.stringify(req) + '\n');
    return answer as DialogOutcome;
  },
});

export function backend(): Promise<DialogBackend | null> {
  const test = process.env.WALLED_DLP_TEST_DIALOG;
  if (test) return Promise.resolve(scripted(test));
  chosen ??= (async () => {
    for (const b of CANDIDATES[process.platform] ?? [zenity, kdialog]) if (await b.available()) return b;
    return null;
  })();
  return chosen;
}

// Dialogs are shown one at a time: two stacked modal questions about different
// actions are confusing, and the user must know exactly which action they approve.
let tail: Promise<unknown> = Promise.resolve();

/** Shows the native confirmation dialog. Any failure resolves to 'cancel' (fail closed). */
export function confirm(req: DialogRequest): Promise<DialogOutcome | 'unavailable'> {
  const job = async (): Promise<DialogOutcome | 'unavailable'> => {
    const b = await backend();
    if (!b) return 'unavailable';
    try {
      return await b.show(req);
    } catch {
      return 'cancel';
    }
  };
  const next = tail.then(job, job);
  tail = next.catch(() => undefined);
  return next;
}
