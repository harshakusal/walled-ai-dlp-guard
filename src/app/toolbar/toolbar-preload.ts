/** Toolbar preload: exposes exactly two functions to the toolbar page (not to any website). */
import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type ToolbarCommand, type ToolbarState } from '../ipc-channels.js';

contextBridge.exposeInMainWorld('walled', {
  command: (c: ToolbarCommand) => ipcRenderer.send(IPC.toolbarCommand, c),
  onState: (fn: (s: ToolbarState) => void) => ipcRenderer.on(IPC.toolbarState, (_e, s: ToolbarState) => fn(s)),
});
