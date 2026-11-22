/** IPC channel names shared by the main process and the two preload scripts. */
export const IPC = {
  // guard (site views) -> main
  settings: 'dlp:settings',          // sendSync -> GuardSettings
  checkPrompt: 'dlp:check-prompt',   // invoke -> DecisionReply
  checkFiles: 'dlp:check-files',     // invoke -> DecisionReply
  // main -> guard
  status: 'dlp:status',              // Finding[]: the native dialog is about to open
  // toolbar <-> main
  toolbarState: 'ui:state',          // main -> toolbar: ToolbarState
  toolbarCommand: 'ui:command',      // toolbar -> main: ToolbarCommand
} as const;

export interface ToolbarState {
  active: 'chatgpt' | 'perplexity';
  tabs: Array<{ id: 'chatgpt' | 'perplexity'; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean }>;
  marker: string;
  color: { light: string; dark: string };
  version: string;
}

export type ToolbarCommand =
  | { cmd: 'switch'; tab: 'chatgpt' | 'perplexity' }
  | { cmd: 'back' | 'forward' | 'reload' | 'home' | 'audit' }
  | { cmd: 'color'; light: string };
