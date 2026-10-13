// Secure bridge between the renderer and the main process.
// Only the whitelisted API below is exposed to the web page.

import { contextBridge, ipcRenderer, webUtils } from "electron";

const api = {
  // dialogs
  chooseCreatePath: () => ipcRenderer.invoke("dialog:createVaultPath"),
  chooseOpenPath: () => ipcRenderer.invoke("dialog:openVaultPath"),
  chooseDir: () => ipcRenderer.invoke("dialog:pickDir"),
  chooseFiles: () => ipcRenderer.invoke("dialog:pickFiles"),

  // vault ops
  createVault: (args: any) => ipcRenderer.invoke("vault:create", args),
  openVault: (args: any) => ipcRenderer.invoke("vault:open", args),
  closeVault: (args: any) => ipcRenderer.invoke("vault:close", args),
  discardVault: (args: any) => ipcRenderer.invoke("vault:discard", args),
  changePassword: (args: any) =>
    ipcRenderer.invoke("vault:changePassword", args),
  recoverVault: (args: any) => ipcRenderer.invoke("vault:recover", args),
  regenRecovery: (args: any) => ipcRenderer.invoke("vault:regenRecovery", args),
  removeRecovery: (args: any) =>
    ipcRenderer.invoke("vault:removeRecovery", args),
  info: (args: any) => ipcRenderer.invoke("vault:info", args),
  preflight: (args: any) => ipcRenderer.invoke("vault:preflight", args),
  sessions: () => ipcRenderer.invoke("vault:sessions"),
  addFiles: (args: any) => ipcRenderer.invoke("vault:addFiles", args),
  deleteVault: (args: any) => ipcRenderer.invoke("vault:delete", args),
  setMeta: (args: any) => ipcRenderer.invoke("vault:setMeta", args),
  confirmDialog: (args: any) => ipcRenderer.invoke("dialog:confirm", args),

  // file browser (within open vault's working dir)
  listFiles: (args: any) => ipcRenderer.invoke("files:list", args),
  deleteFile: (args: any) => ipcRenderer.invoke("files:delete", args),
  renameFile: (args: any) => ipcRenderer.invoke("files:rename", args),

  // settings / recent vaults — read-only. The main process owns the list; see
  // the note beside settings:getRecent in main.ts.
  getRecent: () => ipcRenderer.invoke("settings:getRecent"),
  getAutoLock: () => ipcRenderer.invoke("settings:getAutoLock"),
  setAutoLock: (minutes: number) =>
    ipcRenderer.invoke("settings:setAutoLock", minutes),
  getTheme: () => ipcRenderer.invoke("settings:getTheme"),
  setTheme: (theme: string) => ipcRenderer.invoke("settings:setTheme", theme),
  isOnboardingDone: () => ipcRenderer.invoke("settings:isOnboardingDone"),
  markOnboardingDone: () => ipcRenderer.invoke("settings:markOnboardingDone"),

  // file association: listen for a vault path sent by the main process
  onOpenVaultFile: (cb: (filePath: string) => void) => {
    ipcRenderer.on("app:openVaultFile", (_event, filePath: string) =>
      cb(filePath),
    );
  },

  // UI commands dispatched from the application menu (see the switch in
  // renderer.js): new-vault, open-vault, settings, theme, recents-changed.
  onMenuCommand: (cb: (cmd: string, arg?: string) => void) => {
    ipcRenderer.on(
      "app:menuCommand",
      (_event, payload: { cmd: string; arg?: string }) => {
        if (!payload || typeof payload.cmd !== "string") return;
        cb(payload.cmd, payload.arg);
      },
    );
  },

  // Report user activity so the main process can measure *inactivity* for
  // auto-lock. Throttled in the renderer (a note every 20 s of interaction), so
  // this is a cheap fire-and-forget message, not a per-keystroke one.
  noteActivity: () => ipcRenderer.send("app:activity"),

  // Report the open-vault count so the menu can enable/disable "Lock All Vaults".
  setOpenVaultCount: (count: number) => {
    ipcRenderer.send("menu:setOpenVaultCount", count);
  },

  // auto-lock / manual-lock notification from main process. `reason` is
  // "auto" (idle timer) or "manual" (File > Lock All Vaults).
  onAutoLocked: (cb: (info: { count: number; reason: string }) => void) => {
    ipcRenderer.on(
      "app:autoLocked",
      (_event, info: { count: number; reason: string }) =>
        cb(info ?? { count: 0, reason: "auto" }),
    );
  },

  // resolve the absolute path of a dropped File (Electron webUtils)
  pathForFile: (file: File) => webUtils.getPathForFile(file),

  // system
  openPath: (p: string) => ipcRenderer.invoke("sys:openPath", p),
  copy: (text: string) => ipcRenderer.invoke("sys:copy", text),
  // copySecret: copies to clipboard and auto-clears after 30 s. Prefer this
  // over `copy` for anything sensitive — `copy` has no timer, so a secret
  // copied through it stays on the clipboard indefinitely.
  copySecret: (text: string) => ipcRenderer.invoke("sys:copySecret", text),
};

contextBridge.exposeInMainWorld("shadowbit", api);
