import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.WALLED_DLP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wdlp-home-'));
const { Dlp } = await import('../dist/agent/dlp.js');
const { DEFAULTS } = await import('../dist/agent/config.js');

function fakeDialog(answer) {
  const calls = [];
  return { calls, ask: async (req) => { calls.push(req); return answer; } };
}
const txt = (s) => new TextEncoder().encode(s);

test('clean prompt: no dialog, continue', async () => {
  const d = fakeDialog('cancel');
  const r = await new Dlp(DEFAULTS, d.ask).checkPrompt('1', 'chatgpt', 'https://chatgpt.com/', 'hello world');
  assert.equal(r.decision, 'continue');
  assert.equal(r.reason, 'clean');
  assert.equal(d.calls.length, 0);
});

test('sensitive prompt: dialog names the source and shows the prompt', async () => {
  for (const [answer, decision] of [['continue', 'continue'], ['cancel', 'cancel'], ['timeout', 'cancel'], ['unavailable', 'cancel']]) {
    const d = fakeDialog(answer);
    const r = await new Dlp(DEFAULTS, d.ask).checkPrompt('2', 'perplexity', 'https://www.perplexity.ai/', 'see WALLED_SENSITIVE doc');
    assert.equal(r.decision, decision, answer);
    assert.equal(d.calls.length, 1);
    assert.match(d.calls[0].message, /TEXT PROMPT/);
    assert.match(d.calls[0].message, /Perplexity/);
    assert.match(d.calls[0].message, /see WALLED_SENSITIVE doc/);
  }
});

test('files: only flagged files are listed; clean uploads never prompt', async () => {
  const d = fakeDialog('cancel');
  const dlp = new Dlp(DEFAULTS, d.ask);
  const clean = await dlp.checkFiles('3', 'chatgpt', '', 'file-picker', [{ index: 0, name: 'a.txt', mime: 'text/plain', size: 5, bytes: txt('hello') }]);
  assert.equal(clean.decision, 'continue');
  assert.equal(d.calls.length, 0);
  const r = await dlp.checkFiles('4', 'chatgpt', '', 'drag-and-drop', [
    { index: 0, name: 'ok.txt', mime: 'text/plain', size: 5, bytes: txt('hello') },
    { index: 1, name: 'secret.txt', mime: 'text/plain', size: 20, bytes: txt('x WALLED_SENSITIVE y') },
  ]);
  assert.equal(r.decision, 'cancel');
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].name, 'secret.txt');
  assert.match(d.calls[0].message, /FILE UPLOAD/);
  assert.match(d.calls[0].message, /secret\.txt/);
  assert.doesNotMatch(d.calls[0].message, /ok\.txt/);
});

test('files too large to inspect ask the user (fail-safe), policy can block outright', async () => {
  const d = fakeDialog('continue');
  const r = await new Dlp(DEFAULTS, d.ask).checkFiles('5', 'chatgpt', '', 'file-picker', [{ index: 0, name: 'huge.bin', mime: '', size: 2e9, skipped: true }]);
  assert.equal(r.decision, 'continue');
  assert.match(d.calls[0].message, /could not be fully inspected/);
  const d2 = fakeDialog('continue');
  const r2 = await new Dlp({ ...DEFAULTS, onInspectionError: 'block' }, d2.ask).checkFiles('6', 'chatgpt', '', 'file-picker', [{ index: 0, name: 'huge.bin', mime: '', size: 2e9, skipped: true }]);
  assert.equal(r2.decision, 'cancel');
  assert.equal(d2.calls.length, 0);
});

test('audit log has decisions but never prompt text', async () => {
  const d = fakeDialog('cancel');
  await new Dlp(DEFAULTS, d.ask).checkPrompt('7', 'chatgpt', 'https://chatgpt.com/c/1', 'top secret WALLED_SENSITIVE words');
  const log = fs.readFileSync(path.join(process.env.WALLED_DLP_HOME, 'audit.jsonl'), 'utf8');
  assert.match(log, /"decision":"cancel"/);
  assert.doesNotMatch(log, /top secret/);
});
