// Runs the real native messaging host as a child process, exactly as Chrome does.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { encode, FrameDecoder } from '../dist/agent/native-messaging.js';

const fixtures = fs.mkdtempSync(path.join(os.tmpdir(), 'wdlp-host-fx-'));
execFileSync(process.execPath, ['scripts/make-fixtures.mjs', fixtures], { stdio: 'ignore' });

function startHost(answer) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wdlp-host-'));
  const dialogLog = path.join(home, 'dialogs.jsonl');
  const child = spawn(process.execPath, ['dist/agent/cli.js', 'chrome-extension://deoglpgghholljpmkibnmkcpflgihine/'], {
    env: { ...process.env, WALLED_DLP_HOME: home, WALLED_DLP_TEST_DIALOG: answer, WALLED_DLP_TEST_DIALOG_LOG: dialogLog },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const messages = [];
  const listeners = [];
  // Every byte on stdout must be a valid frame: any stray log line would break Chrome.
  const decoder = new FrameDecoder((m) => { messages.push(m); listeners.forEach((l) => l(m)); });
  child.stdout.on('data', (c) => decoder.push(c));
  const send = (m) => child.stdin.write(encode(m));
  const reply = (id, t = 'decision') => new Promise((resolve) => {
    const hit = messages.find((m) => m.id === id && m.t === t);
    if (hit) return resolve(hit);
    listeners.push((m) => { if (m.id === id && m.t === t) resolve(m); });
  });
  const dialogs = () => (fs.existsSync(dialogLog) ? fs.readFileSync(dialogLog, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []);
  return { child, send, reply, messages, dialogs };
}

function sendFile(h, id, name, via = 'file-picker') {
  const bytes = fs.readFileSync(path.join(fixtures, name));
  h.send({ t: 'files-begin', id, site: 'chatgpt', url: 'https://chatgpt.com/', via, files: [{ index: 0, name, mime: '', size: bytes.length }] });
  for (let off = 0; off < bytes.length; off += 1000) h.send({ t: 'file-chunk', id, index: 0, data: bytes.subarray(off, off + 1000).toString('base64') });
  h.send({ t: 'files-end', id });
}

test('hello handshake reports marker, colours and dialog backend', async () => {
  const h = startHost('cancel');
  h.send({ t: 'hello', id: 'h', extensionVersion: 'test' });
  const r = await h.reply('h', 'hello');
  assert.equal(r.marker, 'WALLED_SENSITIVE');
  assert.match(r.dialogBackend, /scripted/);
  assert.ok(r.responseColor.light);
  h.child.stdin.end();
});

test('prompt + chunked uploads of every type, with concurrent requests', async () => {
  const h = startHost('cancel');
  h.send({ t: 'prompt', id: 'p1', site: 'chatgpt', url: 'https://chatgpt.com/', text: 'just a question' });
  h.send({ t: 'prompt', id: 'p2', site: 'perplexity', url: 'https://www.perplexity.ai/', text: 'WALLED_SENSITIVE inside' });
  sendFile(h, 'f1', 'report-sensitive.pdf');
  sendFile(h, 'f2', 'screenshot-sensitive.png', 'drag-and-drop');
  sendFile(h, 'f3', 'notes-clean.txt', 'paste');
  sendFile(h, 'f4', 'notes-sensitive.txt');
  const [p1, p2, f1, f2, f3, f4] = await Promise.all(['p1', 'p2', 'f1', 'f2', 'f3', 'f4'].map((id) => h.reply(id)));
  assert.deepEqual([p1.decision, p2.decision, f1.decision, f2.decision, f3.decision, f4.decision], ['continue', 'cancel', 'cancel', 'cancel', 'continue', 'cancel']);
  assert.equal(p2.reason, 'user-cancel');
  assert.equal(f3.reason, 'clean');
  // a status message precedes every dialog
  for (const id of ['p2', 'f1', 'f2', 'f4']) assert.ok(h.messages.some((m) => m.t === 'status' && m.id === id), id);
  const shown = h.dialogs();
  assert.equal(shown.length, 4);
  assert.ok(shown.some((d) => /report-sensitive\.pdf/.test(d.message) && /PDF/.test(d.message)));
  assert.ok(shown.some((d) => /screenshot-sensitive\.png/.test(d.message) && /drag and drop/.test(d.message)));
  h.child.stdin.end();
});

test('continue is passed through', async () => {
  const h = startHost('continue');
  sendFile(h, 'c1', 'photo-sensitive.jpg');
  const r = await h.reply('c1');
  assert.equal(r.decision, 'continue');
  assert.equal(r.reason, 'user-continue');
  h.child.stdin.end();
});

test('timeout fails closed', async () => {
  const h = startHost('timeout');
  h.send({ t: 'prompt', id: 't', site: 'chatgpt', url: '', text: 'WALLED_SENSITIVE' });
  const r = await h.reply('t');
  assert.equal(r.decision, 'cancel');
  assert.equal(r.reason, 'timeout');
  h.child.stdin.end();
});

test('protocol errors fail closed and the host keeps running', async () => {
  const h = startHost('continue');
  h.send({ t: 'files-end', id: 'nope' });
  const r = await h.reply('nope');
  assert.equal(r.decision, 'cancel');
  assert.equal(r.reason, 'agent-error');
  h.send({ t: 'prompt', id: 'after', site: 'chatgpt', url: '', text: 'fine' });
  assert.equal((await h.reply('after')).decision, 'continue');
  h.child.stdin.end();
});

test('host exits when the browser closes the pipe', async () => {
  const h = startHost('cancel');
  const exited = new Promise((r) => h.child.on('exit', r));
  h.child.stdin.end();
  assert.equal(await exited, 0);
});
