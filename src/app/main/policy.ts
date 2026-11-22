/**
 * Small, pure policy helpers (unit-tested without Electron).
 */
import { siteOfUrl } from '../../core/sites.js';
import type { FilePayload, Site, UploadVia } from '../../core/types.js';

/** Hosts a site view may open in an in-app pop-up (sign-in flows). Everything else opens in the system browser. */
const AUTH_HOSTS = [
  'accounts.google.com', 'appleid.apple.com', 'login.microsoftonline.com', 'login.live.com',
  'auth.openai.com', 'auth0.openai.com', 'chatgpt.com', 'chat.openai.com', 'www.perplexity.ai', 'perplexity.ai',
];

export function popupPolicy(url: string): 'in-app' | 'external' | 'deny' {
  let u: URL;
  try { u = new URL(url); } catch { return 'deny'; }
  if (u.protocol === 'about:') return 'in-app';
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'deny';
  return AUTH_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith('.' + h)) ? 'in-app' : 'external';
}

/** Permissions the AI sites may get; everything else (camera, location, MIDI, USB...) is denied. */
const ALLOWED_PERMISSIONS = new Set(['clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'notifications']);
export const permissionAllowed = (permission: string) => ALLOWED_PERMISSIONS.has(permission);

/** A DLP request is only accepted from a top-level ChatGPT / Perplexity page in one of our own views. */
export function trustedSite(frameUrl: string | undefined, isTopFrame: boolean, fromOurView: boolean): Site | null {
  if (!fromOurView || !isTopFrame || !frameUrl) return null;
  const site = siteOfUrl(frameUrl);
  return site === 'unknown' ? null : site;
}

const VIAS: UploadVia[] = ['file-picker', 'drag-and-drop', 'paste'];

/** Validates the shape of an upload request coming from a renderer (never trust renderer input). */
export function parseFilesRequest(p: unknown): { via: UploadVia; files: FilePayload[] } | null {
  if (!p || typeof p !== 'object') return null;
  const { via, files } = p as { via?: unknown; files?: unknown };
  if (!VIAS.includes(via as UploadVia) || !Array.isArray(files) || files.length === 0 || files.length > 100) return null;
  const out: FilePayload[] = [];
  for (const f of files as Array<Record<string, unknown>>) {
    if (!f || typeof f.name !== 'string' || typeof f.size !== 'number') return null;
    const bytes = f.bytes instanceof Uint8Array ? f.bytes : undefined;
    out.push({ name: f.name.slice(0, 255), mime: typeof f.mime === 'string' ? f.mime : '', size: f.size, skipped: !bytes || f.skipped === true, bytes });
  }
  return { via: via as UploadVia, files: out };
}

export function parsePromptRequest(p: unknown): { text: string } | null {
  if (!p || typeof p !== 'object') return null;
  const { text } = p as { text?: unknown };
  return typeof text === 'string' && text.length <= 2_000_000 ? { text } : null;
}

/** Chrome's user agent without the "Electron/x" and app tokens, so the sites serve their normal web app. */
export function browserUserAgent(electronUa: string): string {
  return electronUa.replace(/\s(Electron|walled-ai-dlp-guard|Walled DLP Guard)\/\S+/gi, '');
}
