/**
 * Messages exchanged between the content script, the extension service worker
 * and the desktop agent (Chrome native messaging: 32-bit length-prefixed JSON).
 */

export const HOST_NAME = 'ai.walled.dlp_guard';
export const PROTOCOL_VERSION = 1;

export type Site = 'chatgpt' | 'perplexity' | 'unknown';
export type Decision = 'continue' | 'cancel';
export type UploadVia = 'file-picker' | 'drag-and-drop' | 'paste';

export interface FileMeta {
  index: number;
  name: string;
  mime: string;
  size: number;
  /** true when the file is larger than the inspection limit and its bytes were not sent */
  skipped?: boolean;
}

// ---- extension -> agent ----
export interface HelloRequest { t: 'hello'; id: string; extensionVersion: string }
export interface PromptRequest { t: 'prompt'; id: string; site: Site; url: string; text: string }
export interface FilesBegin { t: 'files-begin'; id: string; site: Site; url: string; via: UploadVia; files: FileMeta[] }
export interface FileChunk { t: 'file-chunk'; id: string; index: number; data: string /* base64 */ }
export interface FilesEnd { t: 'files-end'; id: string }
export interface DialogTest { t: 'dialog-test'; id: string }
export type ToAgent = HelloRequest | PromptRequest | FilesBegin | FileChunk | FilesEnd | DialogTest;

// ---- agent -> extension ----
export interface Finding {
  source: 'prompt' | 'file';
  name: string;
  kind: string;     // text | pdf | image | binary | prompt
  method: string;   // e.g. "pdf text layer (page 2)", "OCR (distance 1)"
}
export interface HelloReply {
  t: 'hello';
  id: string;
  agentVersion: string;
  protocol: number;
  platform: string;
  marker: string;
  responseColor: { light: string; dark: string };
  dialogBackend: string;
}
export interface DecisionReply {
  t: 'decision';
  id: string;
  decision: Decision;
  /** why: clean | user | timeout | agent-error | ... */
  reason: string;
  findings: Finding[];
  scanMs: number;
}
export interface ErrorReply { t: 'error'; id: string; message: string }
/** Sent before the native dialog opens, so the page can tell the user where to look. */
export interface StatusReply { t: 'status'; id: string; state: 'awaiting-user'; findings: Finding[] }
export type FromAgent = HelloReply | DecisionReply | ErrorReply | StatusReply;
