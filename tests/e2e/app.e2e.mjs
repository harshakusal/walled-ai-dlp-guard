// End-to-end: the real Electron app (main process + guard preload + DLP core), with
// mock ChatGPT / Perplexity pages served on the real origins and the native dialog
// answered by the scripted test hook. Needs a display (use xvfb-run on headless Linux).
//   npm run build && xvfb-run -a node --test tests/e2e/app.e2e.mjs
//   (packaged build: WALLED_DLP_E2E_EXECUTABLE=release/linux-unpacked/walled-dlp-guard)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { _electron as electron } from 'playwright';
import { CHATGPT, PERPLEXITY } from './mock-sites.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wdlp-e2e-'));
const home = path.join(tmp, 'home');
const answerFile = path.join(tmp, 'answer');
const dialogLog = path.join(tmp, 'dialogs.jsonl');
const fixtures = path.join(tmp, 'fixtures');
execFileSync(process.execPath, [path.join(root, 'scripts/make-fixtures.mjs'), fixtures], { stdio: 'ignore' });
fs.mkdirSync(home, { recursive: true });
fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ dialogTimeoutSec: 3 }));

const answer = (a) => fs.writeFileSync(answerFile, a);
const dialogs = () => (fs.existsSync(dialogLog) ? fs.readFileSync(dialogLog, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []);
const text = (d) => `${d.message}\n${d.detail}`;

let app;
const pages = {};
test.before(async () => {
  answer('cancel');
  // WALLED_DLP_E2E_EXECUTABLE=release/linux-unpacked/walled-dlp-guard runs the same suite against the packaged app.
  const packaged = process.env.WALLED_DLP_E2E_EXECUTABLE;
  app = await electron.launch({
    ...(packaged ? { executablePath: path.resolve(root, packaged) } : {}),
    args: [...(packaged ? [] : [root]), ...(process.env.CI || process.getuid?.() === 0 ? ['--no-sandbox'] : [])],
    env: {
      ...process.env,
      WALLED_DLP_HOME: home,
      WALLED_DLP_TEST_DIALOG: `file:${answerFile}`,
      WALLED_DLP_TEST_DIALOG_LOG: dialogLog,
      WALLED_DLP_PARTITION: '',
      WALLED_DLP_USER_DATA: path.join(tmp, 'user-data'),
      WALLED_DLP_START_URLS: JSON.stringify({ chatgpt: 'about:blank#chatgpt', perplexity: 'about:blank#perplexity' }),
    },
  });
  const ctx = app.context();
  await ctx.route('https://chatgpt.com/**', (r) => r.fulfill({ contentType: 'text/html', body: CHATGPT }));
  await ctx.route('https://www.perplexity.ai/**', (r) => r.fulfill({ contentType: 'text/html', body: PERPLEXITY }));
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && !(pages.chatgpt && pages.perplexity && pages.toolbar)) {
    for (const w of app.windows()) {
      const u = w.url();
      if (u.endsWith('#chatgpt')) pages.chatgpt = w;
      if (u.endsWith('#perplexity')) pages.perplexity = w;
      if (u.includes('toolbar.html')) pages.toolbar = w;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.ok(pages.chatgpt && pages.perplexity && pages.toolbar, 'app window with toolbar and both site views');
});
test.after(async () => { await app?.close(); });

async function open(site, url) {
  const p = pages[site];
  await p.goto(url);
  await p.waitForSelector('[data-mock-composer]');
  return p;
}
const sent = (p) => p.evaluate(() => window.__sent);
const uploads = (p) => p.evaluate(() => window.__uploads);
const settle = (p, ms = 1200) => p.waitForTimeout(ms);

test('the app is a single desktop window: toolbar + ChatGPT + Perplexity views, no browser extension', async () => {
  const toolbarText = await pages.toolbar.locator('body').innerText();
  assert.match(toolbarText, /ChatGPT/);
  assert.match(toolbarText, /Perplexity/);
  assert.match(toolbarText, /WALLED_SENSITIVE/);
  const exts = await app.evaluate(({ session }) => session.defaultSession.extensions?.getAllExtensions?.() ?? session.defaultSession.getAllExtensions());
  assert.equal(exts.length, 0);
});

for (const [site, url, composer, sendBtn, name] of [
  ['chatgpt', 'https://chatgpt.com/', '#prompt-textarea', '#composer-submit-button', 'ChatGPT'],
  ['perplexity', 'https://www.perplexity.ai/', '#ask-input', 'button[aria-label="Submit"]', 'Perplexity'],
]) {
  test(`${name}: prompts`, async () => {
    const p = await open(site, url);
    const before = dialogs().length;

    // clean prompt: no dialog, submitted immediately
    await p.click(composer); await p.keyboard.type('hello there'); await p.keyboard.press('Enter');
    assert.deepEqual(await sent(p), ['hello there']);
    assert.equal(dialogs().length, before);

    // sensitive + Cancel (Enter): blocked, text kept for editing
    answer('cancel');
    await p.click(composer); await p.keyboard.type('memo WALLED_SENSITIVE one'); await p.keyboard.press('Enter');
    await settle(p);
    assert.deepEqual(await sent(p), ['hello there']);
    assert.equal(await p.locator(composer).innerText(), 'memo WALLED_SENSITIVE one');
    assert.equal(dialogs().length, before + 1);
    const d = dialogs().at(-1);
    assert.match(d.message, new RegExp(`TEXT PROMPT.*${name}`));
    assert.match(d.detail, /memo WALLED_SENSITIVE one/);
    assert.deepEqual(d.buttons, ['Cancel', 'Continue']);

    // sensitive + Continue (send button): the original prompt is submitted unchanged
    answer('continue');
    await p.click(sendBtn);
    await settle(p);
    assert.deepEqual(await sent(p), ['hello there', 'memo WALLED_SENSITIVE one']);

    // sensitive + Continue (Enter)
    await p.click(composer); await p.keyboard.type('two WALLED_SENSITIVE'); await p.keyboard.press('Enter');
    await settle(p);
    assert.deepEqual((await sent(p)).at(-1), 'two WALLED_SENSITIVE');
  });

  test(`${name}: file picker, drag-and-drop and paste for text, PDF and image`, async () => {
    const p = await open(site, url);
    const input = p.locator('#upload');

    // clean file: passes without a dialog
    const before = dialogs().length;
    await input.setInputFiles(path.join(fixtures, 'notes-clean.txt'));
    await settle(p);
    assert.deepEqual(await uploads(p), ['picker:notes-clean.txt']);
    assert.equal(dialogs().length, before);

    for (const file of ['notes-sensitive.txt', 'report-sensitive.pdf', 'scan-sensitive.pdf', 'screenshot-sensitive.png']) {
      answer('cancel');
      await input.setInputFiles(path.join(fixtures, file));
      await settle(p, 3000);
      assert.ok(!(await uploads(p)).includes(`picker:${file}`), `${file} must be blocked`);
      const d = dialogs().at(-1);
      assert.match(d.message, new RegExp(`FILE UPLOAD to ${name}`));
      assert.match(d.detail, new RegExp(file.replace('.', '\\.')));
      assert.equal(await input.evaluate((i) => i.files.length), 0, 'input reset so the same file can be picked again');

      answer('continue');
      await input.setInputFiles(path.join(fixtures, file));
      await settle(p, 3000);
      assert.ok((await uploads(p)).includes(`picker:${file}`), `${file} must be uploaded after Continue`);
    }

    // drag-and-drop and paste use the same inspection
    const bytes = fs.readFileSync(path.join(fixtures, 'report-sensitive.pdf')).toString('base64');
    const fire = (type) => p.evaluate(([type, b64]) => {
      const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bin], 'dropped.pdf', { type: 'application/pdf' }));
      const target = type === 'drop' ? document.querySelector('#dropzone') : document.querySelector('[data-mock-composer]');
      const ev = type === 'drop'
        ? new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt })
        : new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
      target.dispatchEvent(ev);
    }, [type, bytes]);
    for (const [type, via, label] of [['drop', 'drop', 'drag and drop'], ['paste', 'paste', 'paste']]) {
      answer('cancel');
      await fire(type);
      await settle(p, 2500);
      assert.ok(!(await uploads(p)).includes(`${via}:dropped.pdf`));
      assert.match(dialogs().at(-1).message, new RegExp(`via ${label}`));
      answer('continue');
      await fire(type);
      await settle(p, 2500);
      assert.ok((await uploads(p)).includes(`${via}:dropped.pdf`), `${via} after Continue`);
    }
  });

  test(`${name}: AI responses are recoloured, user messages and code are not`, async () => {
    const p = await open(site, url);
    await p.waitForFunction(() => getComputedStyle(document.querySelector('#answer')).color === 'rgb(194, 65, 12)', null, { timeout: 5000 });
    const color = (sel) => p.locator(sel).evaluate((e) => getComputedStyle(e).color);
    if (site === 'perplexity') assert.notEqual(await color('#query'), 'rgb(194, 65, 12)');
    if (site === 'chatgpt') assert.notEqual(await color('#code'), 'rgb(194, 65, 12)');
  });
}

test('fail-closed: an unanswered dialog (timeout) or a dialog error blocks the prompt', async () => {
  const p = await open('chatgpt', 'https://chatgpt.com/');
  for (const a of ['timeout', 'error']) {
    answer(a);
    await p.click('#prompt-textarea'); await p.keyboard.type(`fail ${a} WALLED_SENSITIVE`); await p.keyboard.press('Enter');
    await settle(p, a === 'timeout' ? 4500 : 1200);
    assert.deepEqual(await sent(p), [], `${a} must block`);
    await p.locator('#prompt-textarea').evaluate((e) => { e.innerText = ''; });
  }
});

test('toolbar colour picker changes the response colour live', async () => {
  const p = await open('perplexity', 'https://www.perplexity.ai/');
  await pages.toolbar.locator('#color').evaluate((el) => { el.value = '#1d4ed8'; el.dispatchEvent(new Event('change')); });
  await p.waitForFunction(() => getComputedStyle(document.querySelector('#answer')).color === 'rgb(29, 78, 216)', null, { timeout: 5000 });
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')).responseColor.light, '#1d4ed8');
});

test('audit log: decisions are recorded without prompt text or file content', async () => {
  const log = fs.readFileSync(path.join(home, 'audit.jsonl'), 'utf8');
  assert.match(log, /"decision":"cancel"/);
  assert.match(log, /"decision":"continue"/);
  assert.match(log, /report-sensitive\.pdf/);
  assert.doesNotMatch(log, /memo WALLED_SENSITIVE one/);
});
