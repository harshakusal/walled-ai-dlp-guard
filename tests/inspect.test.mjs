import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { inspectFile } from '../dist/agent/inspect/index.js';
import { shutdownOcr } from '../dist/agent/inspect/ocr.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wdlp-fixtures-'));
execFileSync(process.execPath, ['scripts/make-fixtures.mjs', dir], { stdio: 'ignore' });
const opts = { marker: 'WALLED_SENSITIVE', ocrPdfPages: 5 };
const scan = (name) => inspectFile(fs.readFileSync(path.join(dir, name)), opts);

test.after(() => shutdownOcr());

const cases = [
  ['notes-clean.txt', false, 'text'],
  ['notes-sensitive.txt', true, 'text'],
  ['notes-sensitive-utf16.txt', true, 'text'],
  ['report-clean.pdf', false, 'pdf'],
  ['report-sensitive.pdf', true, 'pdf'],          // compressed streams, marker on page 2
  ['scan-sensitive.pdf', true, 'pdf'],            // image-only page -> OCR
  ['renamed-pdf-sensitive.txt', true, 'pdf'],     // type from content, not extension
  ['screenshot-clean.png', false, 'image'],
  ['screenshot-sensitive.png', true, 'image'],
  ['photo-sensitive.jpg', true, 'image'],
  ['darkmode-sensitive.png', true, 'image'],      // light-on-dark text
];

for (const [name, expected, kind] of cases) {
  test(`${name} -> ${expected ? 'SENSITIVE' : 'clean'} (${kind})`, async () => {
    const r = await scan(name);
    assert.equal(r.kind, kind);
    assert.equal(r.found, expected, `method=${r.method} error=${r.error ?? ''}`);
    assert.equal(r.error, undefined);
  });
}

test('the text PDF really is compressed (marker not visible in raw bytes)', () => {
  assert.ok(!fs.readFileSync(path.join(dir, 'report-sensitive.pdf')).toString('latin1').includes('WALLED_SENSITIVE'));
});

test('corrupt PDF falls back to raw scan and reports the error', async () => {
  const r = await inspectFile(Buffer.from('%PDF-1.7\n garbage WALLED_SENSITIVE \n%%EOF'), opts);
  assert.equal(r.found, true);
  const r2 = await inspectFile(Buffer.from('%PDF-1.7\n garbage only'), opts);
  assert.equal(r2.found, false);
  assert.ok(r2.error);
});

test('marker hidden in PNG metadata is caught without OCR', async () => {
  const png = fs.readFileSync(path.join(dir, 'screenshot-clean.png'));
  const withMeta = Buffer.concat([png, Buffer.from('tEXtComment\0WALLED_SENSITIVE')]);
  const r = await inspectFile(withMeta, opts);
  assert.equal(r.found, true);
  assert.match(r.method, /raw bytes/);
});
