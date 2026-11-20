import type { DialogBackend, DialogOutcome, DialogRequest } from './types.js';
import { run } from './exec.js';

/**
 * Native NSAlert-style dialog through AppleScript. Text is passed as argv (never
 * interpolated into the script), so prompt content cannot inject AppleScript.
 */
const SCRIPT = [
  'on run argv',
  '  activate',
  '  set r to display dialog (item 1 of argv) with title (item 2 of argv) buttons {"Cancel", "Continue"} default button "Cancel" cancel button "Cancel" with icon caution giving up after ((item 3 of argv) as integer)',
  '  if gave up of r then return "timeout"',
  '  return button returned of r',
  'end run',
];

export const osascript: DialogBackend = {
  name: 'AppleScript display dialog (macOS)',
  available: async () => process.platform === 'darwin',
  async show(req: DialogRequest): Promise<DialogOutcome> {
    const args = SCRIPT.flatMap((l) => ['-e', l]).concat(['--', req.message, req.title, String(req.timeoutSec)]);
    const r = await run('osascript', args, { timeoutMs: (req.timeoutSec + 5) * 1000 });
    const out = r.stdout.trim();
    if (r.code === 0 && out === 'Continue') return 'continue';
    if (out === 'timeout') return 'timeout';
    return 'cancel'; // includes error -128 (user cancelled / Esc)
  },
};
