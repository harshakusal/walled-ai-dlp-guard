// Minimal stand-ins for the ChatGPT and Perplexity UIs, served on the real origins
// (intercepted in the app's main process with protocol.handle) so the app treats them exactly like the real sites.
// They reproduce what matters for interception: a rich-text composer whose Enter
// key / send button submit through the page's own handlers, a file input, a drop
// zone and paste handling - all wired the way React apps do it (bubble-phase listeners).
const common = `
<script>
  window.__sent = []; window.__uploads = [];
  function composerText() { const c = document.querySelector('[data-mock-composer]'); return c.value ?? c.innerText; }
  function clearComposer() { const c = document.querySelector('[data-mock-composer]'); if ('value' in c && c.tagName === 'TEXTAREA') c.value = ''; else c.innerText = ''; }
  function submit() { const t = composerText().trim(); if (t) { window.__sent.push(t); clearComposer(); } }
  function took(files, via) { for (const f of files) window.__uploads.push(via + ':' + f.name); }
  document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && e.target.closest('[data-mock-composer]')) { e.preventDefault(); submit(); } });
  document.addEventListener('click', (e) => { if (e.target.closest('[data-mock-send]')) submit(); });
  document.addEventListener('change', (e) => { if (e.target.type === 'file') took(e.target.files, 'picker'); });
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => { e.preventDefault(); took(e.dataTransfer.files, 'drop'); });
  document.addEventListener('paste', (e) => { if (e.clipboardData.files.length) { e.preventDefault(); took(e.clipboardData.files, 'paste'); } });
</script>`;

export const CHATGPT = `<!doctype html><html><head><title>ChatGPT (mock)</title></head><body>
<main>
  <article data-message-author-role="user"><div class="whitespace-pre-wrap">user question</div></article>
  <article data-message-author-role="assistant"><div class="markdown prose"><p id="answer">Assistant answer text</p><pre><code id="code">code()</code></pre></div></article>
  <form id="composer" onsubmit="return false">
    <div id="prompt-textarea" contenteditable="true" data-mock-composer style="min-height:40px;border:1px solid #999"></div>
    <input type="file" id="upload" multiple style="display:block">
    <button id="composer-submit-button" data-testid="send-button" aria-label="Send prompt" type="button" data-mock-send>Send</button>
  </form>
  <div id="dropzone" style="height:80px;border:2px dashed #999">drop here</div>
</main>${common}</body></html>`;

export const PERPLEXITY = `<!doctype html><html><head><title>Perplexity (mock)</title></head><body>
<main>
  <div data-message-bubble="right"><div data-renderer="lm" id="query">user query bubble</div></div>
  <div id="markdown-content-0"><div class="prose dark:prose-invert" data-renderer="lm"><p id="answer">Perplexity answer text</p></div></div>
  <div data-composer="true">
    <div id="ask-input" contenteditable="true" data-mock-composer style="min-height:40px;border:1px solid #999"></div>
    <input type="file" id="upload" multiple style="display:block">
    <button aria-label="Submit" type="button" data-mock-send>Go</button>
  </div>
  <div id="dropzone" style="height:80px;border:2px dashed #999">drop here</div>
</main>${common}</body></html>`;
