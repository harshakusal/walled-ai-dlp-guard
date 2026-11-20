/**
 * Per-site knowledge, kept deliberately small: interception itself is generic
 * (capture-phase DOM events), sites only tell us which button is "send" and
 * where the composer is. Each list has generic fallbacks so a markup change on
 * either site degrades gracefully instead of silently disabling the guard.
 */
import type { Site } from '../shared/protocol.js';

export interface SiteAdapter {
  site: Site;
  composerSelectors: string[];
  sendButtonSelectors: string[];
}

const GENERIC_COMPOSERS = ['textarea', '[contenteditable="true"]', '[contenteditable="plaintext-only"]'];

export const ADAPTERS: Record<Exclude<Site, 'unknown'>, SiteAdapter> = {
  chatgpt: {
    site: 'chatgpt',
    composerSelectors: ['#prompt-textarea', 'textarea[name="prompt-textarea"]', '#mobile-composer-prompt', 'form [contenteditable="true"]', ...GENERIC_COMPOSERS],
    sendButtonSelectors: ['#composer-submit-button', 'button[data-testid="send-button"]', 'button[aria-label="Send prompt"]', 'button[aria-label="Send message"]'],
  },
  perplexity: {
    site: 'perplexity',
    composerSelectors: ['#ask-input', '[data-composer] [contenteditable="true"]', '[data-composer] textarea', ...GENERIC_COMPOSERS],
    sendButtonSelectors: ['button[data-testid="submit-button"]', 'button[aria-label="Submit"]', 'button[aria-label="Send"]'],
  },
};

export function detectSite(hostname: string): Site {
  if (/(^|\.)chatgpt\.com$|(^|\.)chat\.openai\.com$/.test(hostname)) return 'chatgpt';
  if (/(^|\.)perplexity\.ai$/.test(hostname)) return 'perplexity';
  return 'unknown';
}

const SEND_LABEL = /\b(send|submit)\b/i;
const NOT_SEND = /(feedback|dismiss|close|cancel|stop|share|report|edit)/i;

/** Is this the control that submits the prompt? */
export function isSendButton(btn: Element, adapter: SiteAdapter | null): boolean {
  if (adapter?.sendButtonSelectors.some((s) => btn.matches(s))) return true;
  const label = [btn.getAttribute('aria-label'), btn.getAttribute('data-testid'), btn.id, btn.getAttribute('title')].filter(Boolean).join(' ');
  if (label && NOT_SEND.test(label)) return false;
  if (SEND_LABEL.test(label)) return true;
  // Unlabelled submit button of a form that contains a prompt editor.
  return !label && btn instanceof HTMLButtonElement && btn.type === 'submit' && !!btn.form?.querySelector(GENERIC_COMPOSERS.join(','));
}

export function findSendButton(composer: HTMLElement, adapter: SiteAdapter | null): HTMLElement | null {
  let el: HTMLElement | null = composer;
  for (let depth = 0; el && depth < 12; depth++, el = el.parentElement) {
    for (const b of el.querySelectorAll<HTMLElement>('button, [role="button"]')) {
      if (isSendButton(b, adapter) && !(b as HTMLButtonElement).disabled) return b;
    }
  }
  for (const s of adapter?.sendButtonSelectors ?? []) {
    const b = document.querySelector<HTMLElement>(s);
    if (b) return b;
  }
  return null;
}
