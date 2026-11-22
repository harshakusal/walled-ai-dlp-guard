// End-to-end: real Chromium + the built extension + the real native host (dialogs
// answered by the scripted test backend). Needs a display (Xvfb on CI/headless boxes).
//   npm run build && xvfb-run -a node --test tests/e2e/extension.e2e.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { CHATGPT, PERPLEXITY } from './mock-sites.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const ext = path.join(root, 'dist/extension');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wdlp-e2e-'));
const profile = path.join(tmp, 'profile');
const home = path.join(tmp, 'home');
const answerFile = path.join(tmp, 'answer');
const dialogLog = path.join(tmp, 'dialogs.jsonl');
const fixtures = path.join(tmp, 'fixtures');
const env = { ...process.env, WALLED_DLP_HOME: home, WALLED_DLP_TEST_DIALOG: `file:${answerFile}`, WALLED_DLP_TEST_DIALOG_LOG: dialogLog };

execFileSync(process.execPath, [path.join(root, 'scripts/make-fixtures.mjs'), fixtures], { stdio: 'ignore' });
execFileSync(process.execPath, [path.join(root, 'dist/agent/cli.js'), 'install', '--user-data-dir', profile], { env, stdio: 'ignore' });

const answer = (a) => fs.writeFileSync(answerFile, a);
const dialogs = () => (fs.existsSync(dialogLog) ? fs.readFileSync(dialogLog, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []);

let ctx;
test.before(async () => {
  ctx = await chromium.launchPersistentContext(profile, {
    headless: false,
    env,
    ignoreDefaultArgs: ['--disable-extensions', '--disable-component-extensions-with-background-pages'],
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });
  await ctx.route('https://chatgpt.com/**', (r) => r.fulfill({ contentType: 'text/html', body: CHATGPT }));
  await ctx.route('https://www.perplexity.ai/**', (r) => r.fulfill({ contentType: 'text/html', body: PERPLEXITY }));
});
test.after(async () => { await ctx?.close(); });

async function open(url) {
  const page = await ctx.newPage();
  await page.goto(url);
  await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--walled-dlp-light') !== '', null, { timeout: 15000 });
  return page;
}
const sent = (p) => p.evaluate(() => window.__sent);
const uploads = (p) => p.evaluate(() => window.__uploads);
const settle = (p, ms = 1500) => p.waitForTimeout(ms);

for (const [site, url, composer, sendBtn] of [
  ['ChatGPT', 'https://chatgpt.com/', '#prompt-textarea', '#composer-submit-button'],
  ['Perplexity', 'https://www.perplexity.ai/', '#ask-input', 'button[aria-label="Submit"]'],
]) {
  test(`${site}: prompts`, async () => {
    const p = await open(url);
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
    assert.match(dialogs().at(-1).message, new RegExp(`TEXT PROMPT.*${site}`, 's'));

    // sensitive + Continue (send button): the original prompt is submitted unchanged
    answer('continue');
    await p.click(sendBtn);
    await settle(p);
    assert.deepEqual(await sent(p), ['hello there', 'memo WALLED_SENSITIVE one']);

    // sensitive + Continue (Enter)
    await p.click(composer); await p.keyboard.type('two WALLED_SENSITIVE'); await p.keyboard.press('Enter');
    await settle(p);
    assert.deepEqual((await sent(p)).at(-1), 'two WALLED_SENSITIVE');
    await p.close();
  });

  test(`${site}: file picker, drag-and-drop and paste for text, PDF and image`, async () => {
    const p = await open(url);
    const input = p.locator('#upload');

    // clean file: passes without a dialog
    const before = dialogs().length;
    await input.setInputFiles(path.join(fixtures, 'notes-clean.txt'));
    await settle(p);
    assert.deepEqual(await uploads(p), ['picker:notes-clean.txt']);
    assert.equal(dialogs().length, before);

    for (const file of ['notes-sensitive.txt', 'report-sensitive.pdf', 'screenshot-sensitive.png']) {
      answer('cancel');
      await input.setInputFiles(path.join(fixtures, file));
      await settle(p, 3000);
      assert.ok(!(await uploads(p)).includes(`picker:${file}`), `${file} must be blocked`);
      assert.match(dialogs().at(-1).message, new RegExp(`FILE UPLOAD[\\s\\S]*${file.replace('.', '\\.')}`));
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
    for (const [type, via] of [['drop', 'drop'], ['paste', 'paste']]) {
      answer('cancel');
      await fire(type);
      await settle(p, 2500);
      assert.ok(!(await uploads(p)).includes(`${via}:dropped.pdf`));
      answer('continue');
      await fire(type);
      await settle(p, 2500);
      assert.ok((await uploads(p)).includes(`${via}:dropped.pdf`), `${via} after Continue`);
    }
    await p.close();
  });

  test(`${site}: AI responses are recoloured, user messages and code are not`, async () => {
    const p = await open(url);
    const color = (sel) => p.locator(sel).evaluate((e) => getComputedStyle(e).color);
    assert.equal(await color('#answer'), 'rgb(194, 65, 12)');
    if (site === 'Perplexity') assert.notEqual(await color('#query'), 'rgb(194, 65, 12)');
    if (site === 'ChatGPT') assert.notEqual(await color('#code'), 'rgb(194, 65, 12)');
    await p.close();
  });
}

test('agent not running: sensitive prompt is blocked (fail-closed), clean prompt still works', async () => {
  // Separate browser profile whose host manifest points at a launcher that does not exist.
  const profile2 = path.join(tmp, 'profile-no-agent');
  execFileSync(process.execPath, [path.join(root, 'dist/agent/cli.js'), 'install', '--user-data-dir', profile2], { env, stdio: 'ignore' });
  const manifest = path.join(profile2, 'NativeMessagingHosts', 'ai.walled.dlp_guard.json');
  fs.writeFileSync(manifest, JSON.stringify({ ...JSON.parse(fs.readFileSync(manifest, 'utf8')), path: path.join(tmp, 'missing.sh') }));
  const ctx2 = await chromium.launchPersistentContext(profile2, {
    headless: false, env,
    ignoreDefaultArgs: ['--disable-extensions', '--disable-component-extensions-with-background-pages'],
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });
  try {
    await ctx2.route('https://chatgpt.com/**', (r) => r.fulfill({ contentType: 'text/html', body: CHATGPT }));
    const p = await ctx2.newPage();
    await p.goto('https://chatgpt.com/');
    await p.waitForTimeout(1500);
    await p.click('#prompt-textarea'); await p.keyboard.type('ok prompt'); await p.keyboard.press('Enter');
    await p.click('#prompt-textarea'); await p.keyboard.type('x WALLED_SENSITIVE'); await p.keyboard.press('Enter');
    await p.locator('#upload').setInputFiles(path.join(fixtures, 'notes-clean.txt'));
    await p.waitForTimeout(1500);
    assert.deepEqual(await sent(p), ['ok prompt']);
    assert.deepEqual(await uploads(p), [], 'files cannot be inspected without the agent, so uploads are held');
  } finally {
    await ctx2.close();
  }
});
