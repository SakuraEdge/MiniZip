"use strict";

const { contextBridge, ipcRenderer, webUtils } = require("electron");
const invoke = (method, payload) => ipcRenderer.invoke("minizip:" + method, payload);

contextBridge.exposeInMainWorld("miniZip", {
  version: "Dev v1.0.0",
  openArchive: () => invoke("openArchive"),
  openFolder: () => invoke("openFolder"),
  openDropped: (file) => invoke("openDropped", { path: webUtils.getPathForFile(file) }),
  chooseDestination: (archiveId) => invoke("chooseDestination", { archiveId }),
  unlock: (archiveId, password) => invoke("unlock", { archiveId, password }),
  extract: (payload) => invoke("extract", payload),
  remove: (payload) => invoke("remove", payload),
  test: (archiveId) => invoke("test", { archiveId }),
  preview: (archiveId, entryId) => invoke("preview", { archiveId, entryId }),
  cancelTask: (taskId) => invoke("cancelTask", { taskId }),
  revealTask: (taskId) => invoke("revealTask", { taskId }),
  closeArchive: (archiveId) => invoke("closeArchive", { archiveId }),
  ready: () => invoke("ready"),
  createArchive: () => invoke("createArchive"),
  quickReady: () => invoke("quickReady"),
  quickDestination: () => invoke("quickDestination"),
  quickResize: (height) => invoke("quickResize", height),
  quickStart: (settings) => invoke("quickStart", settings),
  quickCancel: () => invoke("quickCancel"),
  quickClose: () => invoke("quickClose"),
  quickReveal: () => invoke("quickReveal"),
  updateState: () => invoke("updateState"),
  checkUpdates: () => invoke("checkUpdates"),
  updatePreferences: (settings) => invoke("updatePreferences", settings),
  downloadUpdate: () => invoke("downloadUpdate"),
  cancelUpdate: () => invoke("cancelUpdate"),
  installUpdate: () => invoke("installUpdate"),
  defaultApps: () => invoke("defaultApps"),
  repository: () => invoke("repository"),
  onUpdate: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("minizip:update", listener);
    return () => ipcRenderer.removeListener("minizip:update", listener);
  },
  onTask: (callback) => {
    const listener = (_event, task) => callback(task);
    ipcRenderer.on("minizip:task", listener);
    return () => ipcRenderer.removeListener("minizip:task", listener);
  },
  onArchive: (callback) => {
    const listener = (_event, archive) => callback(archive);
    ipcRenderer.on("minizip:archive", listener);
    return () => ipcRenderer.removeListener("minizip:archive", listener);
  }
});
