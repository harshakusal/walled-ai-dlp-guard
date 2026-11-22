/**
 * AI-response colour. Injected by the main process with webContents.insertCSS as a
 * *user* stylesheet, so it wins over the sites' own `!important` author rules and
 * also covers answers that are still streaming or re-rendered.
 *
 * Only descendants of the answer container are coloured (not the container itself),
 * so code blocks (<pre>) keep the site's syntax colours, and the user's own messages
 * are never matched.
 */
export interface ResponseColors { light: string; dark: string }

const HEX = /^#[0-9a-f]{3,8}$/i;

export function responseColorCss(c: ResponseColors): string {
  const light = HEX.test(c.light) ? c.light : '#c2410c';
  const dark = HEX.test(c.dark) ? c.dark : '#fdba74';
  return `
:root { --walled-dlp-color: ${light}; }
:root.dark, :root[data-color-scheme="dark"], :root[data-theme="dark"], :root.dark-theme { --walled-dlp-color: ${dark}; }
@media (prefers-color-scheme: dark) { :root:not(.light):not([data-color-scheme="light"]) { --walled-dlp-color: ${dark}; } }

/* ChatGPT (signed-in and signed-out app) */
[data-message-author-role="assistant"] .markdown :not(pre, pre *),
[data-message-role="assistant"] [data-assistant-markdown] :not(pre, pre *),
/* Perplexity answers (the user's own query bubble reuses data-renderer="lm", so it is excluded) */
:is(.prose[data-renderer="lm"], [id^="markdown-content-"]):not([data-message-bubble] *) :not(pre, pre *) {
  color: var(--walled-dlp-color) !important;
}`;
}

/** A dark-theme variant that stays readable when the user picks a light-theme colour. */
export function lighten(hex: string, amount = 0.45): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return '#fdba74';
  const n = parseInt(m[1], 16);
  const ch = (shift: number) => {
    const v = (n >> shift) & 0xff;
    return Math.round(v + (255 - v) * amount).toString(16).padStart(2, '0');
  };
  return `#${ch(16)}${ch(8)}${ch(0)}`;
}
