/**
 * Service worker: bridges content scripts (one port per tab) and the desktop agent
 * (one native messaging port). The open native port keeps this worker alive.
 */
import { HOST_NAME, type FromAgent, type HelloReply, type ToAgent } from '../shared/protocol.js';

type Pending = { port: chrome.runtime.Port };
const pending = new Map<string, Pending>();
const tabs = new Set<chrome.runtime.Port>();
let native: chrome.runtime.Port | null = null;
let hello: HelloReply | null = null;
let lastError = '';

function failClosed(id: string, reason: string) {
  const p = pending.get(id);
  pending.delete(id);
  p?.port.postMessage({ t: 'decision', id, decision: 'cancel', reason, findings: [], scanMs: 0 } satisfies FromAgent);
}

function connectNative(): chrome.runtime.Port | null {
  if (native) return native;
  try {
    native = chrome.runtime.connectNative(HOST_NAME);
  } catch (e) {
    lastError = String(e);
    return null;
  }
  native.onMessage.addListener((msg: FromAgent) => {
    if (msg.t === 'hello') {
      hello = msg;
      void chrome.storage.local.set({ agent: msg });
      for (const t of tabs) { try { t.postMessage({ t: 'agent', hello: msg }); } catch { /* closed */ } }
      return;
    }
    const p = pending.get(msg.id);
    if (!p) return;
    if (msg.t !== 'status') pending.delete(msg.id);
    try { p.port.postMessage(msg); } catch { /* tab closed */ }
  });
  native.onDisconnect.addListener(() => {
    lastError = chrome.runtime.lastError?.message ?? 'disconnected';
    native = null;
    hello = null;
    void chrome.storage.local.set({ agent: null, agentError: lastError });
    // Fail closed: every request still waiting for the agent is cancelled.
    for (const id of [...pending.keys()]) failClosed(id, 'agent-unavailable');
  });
  native.postMessage({ t: 'hello', id: 'hello', extensionVersion: chrome.runtime.getManifest().version } satisfies ToAgent);
  return native;
}

function toAgent(msg: ToAgent, port: chrome.runtime.Port | null) {
  const n = connectNative();
  // Requests that expect a decision reply; file chunks belong to the pending 'files-begin'.
  if (port && (msg.t === 'prompt' || msg.t === 'files-begin' || msg.t === 'dialog-test')) pending.set(msg.id, { port });
  if (!n) { failClosed(msg.id, 'agent-unavailable'); return; }
  try {
    n.postMessage(msg);
  } catch (e) {
    lastError = String(e);
    failClosed(msg.id, 'agent-unavailable');
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'walled-dlp') return;
  tabs.add(port);
  connectNative();
  if (hello) port.postMessage({ t: 'agent', hello });
  port.onMessage.addListener((msg: ToAgent) => toAgent(msg, port));
  port.onDisconnect.addListener(() => {
    tabs.delete(port);
    for (const [id, p] of pending) if (p.port === port) pending.delete(id);
  });
});

// Popup requests
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.t === 'status') {
    connectNative();
    setTimeout(() => sendResponse({ hello, lastError }), hello ? 0 : 400);
    return true;
  }
  if (msg?.t === 'dialog-test') {
    const id = `test-${Date.now()}`;
    const fake = { postMessage: (m: FromAgent) => sendResponse(m) } as unknown as chrome.runtime.Port;
    toAgent({ t: 'dialog-test', id }, fake);
    return true;
  }
  return false;
});

chrome.runtime.onStartup.addListener(() => { connectNative(); });
chrome.runtime.onInstalled.addListener(() => { connectNative(); });
