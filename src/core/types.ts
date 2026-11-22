/** Types shared by the guard (renderer preload), the main process and the DLP core. */

export type Site = 'chatgpt' | 'perplexity' | 'unknown';
export type Decision = 'continue' | 'cancel';
export type UploadVia = 'file-picker' | 'drag-and-drop' | 'paste';

export interface FileMeta {
  name: string;
  mime: string;
  size: number;
  /** true when the file is larger than the inspection limit and its bytes were not sent */
  skipped?: boolean;
}
export interface FilePayload extends FileMeta {
  bytes?: Uint8Array;
}

export interface Finding {
  source: 'prompt' | 'file';
  name: string;
  kind: string;     // text | pdf | image | binary | prompt
  method: string;   // e.g. "PDF text layer (page 2)", "OCR (edit distance 1)"
}

export interface DecisionReply {
  decision: Decision;
  /** clean | user-continue | user-cancel | timeout | no-dialog | uninspectable | app-error */
  reason: string;
  findings: Finding[];
  scanMs: number;
}

/** What the native confirmation dialog shows. */
export interface DialogRequest {
  title: string;
  /** Main line: where the marker was found (TEXT PROMPT / FILE UPLOAD) and on which site. */
  message: string;
  /** Prompt preview or the list of files, and what Continue / Cancel do. */
  detail: string;
  timeoutSec: number;
}
export type DialogOutcome = 'continue' | 'cancel' | 'timeout' | 'unavailable';

/** Settings the guard needs inside the page. */
export interface GuardSettings {
  marker: string;
  maxInspectBytes: number;
}
