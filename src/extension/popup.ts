const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

async function refresh() {
  const res = await chrome.runtime.sendMessage({ t: 'status' });
  const agent = $('agent');
  if (res?.hello) {
    agent.textContent = `connected (v${res.hello.agentVersion})`;
    agent.className = 'ok';
    $('backend').textContent = res.hello.dialogBackend;
    $('marker').textContent = res.hello.marker;
  } else {
    agent.textContent = 'NOT running';
    agent.className = 'bad';
    $('msg').textContent = `${res?.lastError ?? ''} – run "npm run install-host" and reload the extension. Sensitive actions are blocked until the agent is available.`;
  }
  const { colorOverride } = await chrome.storage.local.get('colorOverride');
  const colors = colorOverride ?? res?.hello?.responseColor ?? { light: '#c2410c', dark: '#fdba74' };
  $<HTMLInputElement>('light').value = colors.light;
  $<HTMLInputElement>('dark').value = colors.dark;
}

async function saveColors() {
  await chrome.storage.local.set({ colorOverride: { light: $<HTMLInputElement>('light').value, dark: $<HTMLInputElement>('dark').value } });
}

$('light').addEventListener('input', saveColors);
$('dark').addEventListener('input', saveColors);
$('reset').addEventListener('click', async () => { await chrome.storage.local.remove('colorOverride'); await refresh(); });
$('test').addEventListener('click', async () => {
  $('msg').textContent = 'Dialog shown on the desktop…';
  const r = await chrome.runtime.sendMessage({ t: 'dialog-test' });
  $('msg').textContent = `Dialog result: ${r?.decision ?? 'n/a'} (${r?.reason ?? ''})`;
});
void refresh();
