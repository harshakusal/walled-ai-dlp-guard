// The native dialog adapter (Electron's dialog.showMessageBox is replaced by a fake).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createConfirm, messageBoxOptions } from '../dist/app/main/dialog.js';

const req = { title: 'Walled DLP – sensitive content detected', message: 'Sensitive marker WALLED_SENSITIVE was detected in a TEXT PROMPT', detail: 'Prompt: "x"', timeoutSec: 1 };

test('native message box: Cancel / Continue, Cancel is default and the Esc/close action', () => {
  const o = messageBoxOptions(req);
  assert.deepEqual(o.buttons, ['Cancel', 'Continue']);
  assert.equal(o.defaultId, 0);
  assert.equal(o.cancelId, 0);
  assert.equal(o.type, 'warning');
  assert.equal(o.message, req.message);
  assert.equal(o.detail, req.detail);
});

test('button index maps to the decision', async () => {
  for (const [response, outcome] of [[1, 'continue'], [0, 'cancel']]) {
    const confirm = createConfirm(async () => ({ response, checkboxChecked: false }), () => null);
    assert.equal(await confirm(req), outcome);
  }
});

test('unanswered dialog is closed after the timeout and counts as timeout', async () => {
  let aborted = false;
  const confirm = createConfirm((_p, o) => new Promise((resolve) => o.signal.addEventListener('abort', () => { aborted = true; resolve({ response: 0, checkboxChecked: false }); })), () => null);
  const started = Date.now();
  assert.equal(await confirm({ ...req, timeoutSec: 1 }), 'timeout');
  assert.ok(aborted);
  assert.ok(Date.now() - started >= 900);
});

test('a failing dialog is unavailable (the core then blocks)', async () => {
  const confirm = createConfirm(async () => { throw new Error('no display'); }, () => null);
  assert.equal(await confirm(req), 'unavailable');
});

test('dialogs are shown one at a time', async () => {
  let open = 0, maxOpen = 0;
  const confirm = createConfirm(async () => {
    open++; maxOpen = Math.max(maxOpen, open);
    await new Promise((r) => setTimeout(r, 30));
    open--;
    return { response: 1, checkboxChecked: false };
  }, () => null);
  const results = await Promise.all([confirm(req), confirm(req), confirm(req)]);
  assert.deepEqual(results, ['continue', 'continue', 'continue']);
  assert.equal(maxOpen, 1);
});
