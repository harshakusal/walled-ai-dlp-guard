import type { Site } from './types.js';

/** The two web apps the guard protects. */
export const SITE_URLS: Record<Exclude<Site, 'unknown'>, string> = {
  chatgpt: 'https://chatgpt.com/',
  perplexity: 'https://www.perplexity.ai/',
};

export const SITE_NAMES: Record<Site, string> = { chatgpt: 'ChatGPT', perplexity: 'Perplexity', unknown: 'the web app' };

export function detectSite(hostname: string): Site {
  if (/(^|\.)chatgpt\.com$|(^|\.)chat\.openai\.com$/.test(hostname)) return 'chatgpt';
  if (/(^|\.)perplexity\.ai$/.test(hostname)) return 'perplexity';
  return 'unknown';
}

export function siteOfUrl(url: string): Site {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' ? detectSite(u.hostname) : 'unknown';
  } catch {
    return 'unknown';
  }
}
