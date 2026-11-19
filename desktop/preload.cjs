"use strict";

const { contextBridge, ipcRenderer, webUtils } = require("electron");
const invoke = (method, payload) => ipcRenderer.invoke("minizip:" + method, payload);

contextBridge.exposeInMainWorld("miniZip", {
  openArchive: () => invoke("openArchive"),
  openFolder: () => invoke("openFolder"),
  openDropped: (file) => invoke("openDropped", { path: webUtils.getPathForFile(file) }),
  chooseDestination: (archiveId) => invoke("chooseDestination", { archiveId }),
  unlock: (archiveId, password) => invoke("unlock", { archiveId, password }),
  extract: (payload) => invoke("extract", payload),
  remove: (payload) => invoke("remove", payload),
  rename: (archiveId, entryId, name) => invoke("rename", { archiveId, entryId, name }),
  test: (archiveId) => invoke("test", { archiveId }),
  preview: (archiveId, entryId) => invoke("preview", { archiveId, entryId }),
  openEntry: (archiveId, entryId) => invoke("openEntry", { archiveId, entryId }),
  programAction: (archiveId, token, revision, action) => invoke("programAction", { archiveId, token, revision, action }),
  onProgram: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("minizip:program", listener);
    return () => ipcRenderer.removeListener("minizip:program", listener);
  },
  editState: (archiveId) => invoke("editState", { archiveId }),
  finishEdits: (archiveId, entryId) => invoke("finishEdits", { archiveId, entryId }),
  discardEdits: archiveId => invoke("discardEdits", { archiveId }),
  saveEdits: (archiveId) => invoke("saveEdits", { archiveId }),
  exportEdits: (archiveId) => invoke("exportEdits", { archiveId }),
  revealEdits: (archiveId) => invoke("revealEdits", { archiveId }),
  workFiles: () => invoke("workFiles"),
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
  },
  onEdits: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("minizip:edits", listener);
    return () => ipcRenderer.removeListener("minizip:edits", listener);
  }
});
