"use strict";

const { app, BrowserWindow, ipcMain, dialog, shell, Menu, session: electronSession } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { randomUUID } = require("node:crypto");
const { spawn } = require("node:child_process");
const { ArchiveEngine, ArchiveError, normalizeEntryPath, rejectLinks, assertInside, makeTree } = require("./archive-engine.cjs");
const { scanInputs, compress } = require("./compress-engine.cjs");
const { UpdateService } = require("./updates.cjs");
const { parseLaunch } = require("./launch.cjs");
const releaseConfig = require("../release-config.json");
const Core = require("../core.js");

const entryUrl = pathToFileURL(path.resolve(__dirname, "../index.html")).href;
const quickUrl = pathToFileURL(path.resolve(__dirname, "../quick.html")).href;
const quickWindows = new Map();
const sessions = new Map();
const tasks = new Map();
const activeArchives = new Set();
const activeDestinations = new Set();
const allowedDestinations = new Set();
const testMode = process.env.MINIZIP_TEST_MODE === "1";
let mainWindow;
let engine;
let closing = false;
let rendererReady = false;
const initialLaunch = parseLaunch(process.argv.slice(app.isPackaged ? 1 : 2));
let pendingFiles = initialLaunch.mode === "open" ? initialLaunch.paths : [];
let updates;
let draining = false;
let queuedCompression = [];
let compressionTimer = null;

if (testMode && process.env.MINIZIP_TEST_PROFILE) app.setPath("userData", process.env.MINIZIP_TEST_PROFILE);

function errorPayload(error) {
  return { code: error.code || "IO_ERROR", message: error instanceof ArchiveError ? error.message : error.code === "EACCES" || error.code === "EPERM" ? "没有访问权限，或文件正被其他程序占用。" : error.code === "ENOSPC" ? "磁盘空间不足。" : error.code === "ENOENT" ? "文件或目录不存在，请重新选择。" : "文件操作失败，请检查权限、磁盘空间与文件状态。" };
}
function validateSender(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame || event.senderFrame.url.split("#")[0] !== entryUrl) throw new ArchiveError("DENIED", "无法验证请求来源。");
}
function handle(name, callback) {
  ipcMain.handle("minizip:" + name, async (event, payload) => {
    try { validateSender(event); return { ok: true, value: await callback(payload || {}) }; }
    catch (error) { return { ok: false, error: errorPayload(error) }; }
  });
}
function getSession(id) {
  const current = sessions.get(id);
  if (!current) throw new ArchiveError("SESSION_EXPIRED", "文件会话已关闭，请重新打开。");
  return current;
}
function assertIdle(id) {
  if (activeArchives.has(id)) throw new ArchiveError("BUSY", "当前文件仍有任务进行中，请完成或取消后再操作。");
}
function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed() && rendererReady) mainWindow.webContents.send("minizip:" + channel, payload);
  if (channel === "task") {
    for (const current of quickWindows.values()) if (current.taskId === payload.id && !current.window.isDestroyed()) current.window.webContents.send("minizip:task", payload);
  }
}
function publicTask(task) {
  const { controller, promise, ...value } = task;
  return value;
}
function updateTask(task, changes) { Object.assign(task, changes); send("task", publicTask(task)); }

function startTask(current, kind, destination, operation) {
  assertIdle(current.archive.id);
  if ([...tasks.values()].filter((task) => task.status === "running").length >= 3) throw new ArchiveError("BUSY", "已有 3 个任务进行中，请等待任务完成。");
  if (destination) {
    const normalized = path.resolve(destination).toLowerCase();
    for (const existing of activeDestinations) {
      const a = path.relative(existing, normalized), b = path.relative(normalized, existing);
      const child = (relative) => !relative || relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
      if (child(a) || child(b)) throw new ArchiveError("BUSY", "该目录或其子目录已有任务，暂不能并发写入。");
    }
    activeDestinations.add(normalized);
  }
  activeArchives.add(current.archive.id);
  const controller = new AbortController();
  const task = { id: randomUUID(), archiveId: current.archive.id, name: current.archive.name, kind, destination: destination || current.archive.path, native: true, status: "running", phase: "starting", progress: null, count: current.archive.entries.length, canCancel: true, createdAt: Date.now(), controller };
  tasks.set(task.id, task);
  let lastUpdate = 0;
  const options = {
    signal: controller.signal,
    onProgress: (value) => { if (Date.now() - lastUpdate > 120 || value === 100) { lastUpdate = Date.now(); updateTask(task, { progress: value }); } },
    onPhase: (phase) => updateTask(task, { phase, canCancel: phase !== "committing" })
  };
  task.promise = new Promise((resolve) => setImmediate(resolve)).then(async () => {
    try {
      const result = await operation(options);
      if (result?.session) { sessions.set(current.archive.id, result.session); send("archive", result.session.archive); }
      updateTask(task, { status: "completed", progress: 100, phase: "completed", canCancel: false, result: result?.session ? { backupPath: result.backupPath, deleted: result.deleted } : result, finishedAt: Date.now() });
    } catch (error) {
      updateTask(task, { status: error.code === "CANCELLED" ? "cancelled" : "failed", phase: "finished", canCancel: false, error: errorPayload(error), finishedAt: Date.now() });
    } finally {
      activeArchives.delete(current.archive.id);
      if (destination) activeDestinations.delete(path.resolve(destination).toLowerCase());
    }
  });
  return publicTask(task);
}

async function acceptArchive(filePath) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) throw new ArchiveError("INVALID_FILE", "请选择有效的本地文件。");
  const current = await engine.open(filePath);
  sessions.set(current.archive.id, current);
  allowedDestinations.add(path.dirname(current.archive.path));
  return current.archive;
}
async function openFolder(folderPath) {
  folderPath = path.resolve(folderPath);
  await rejectLinks(folderPath);
  const flat = [];
  const visit = async (directory, prefix = "", depth = 0) => {
    if (depth > 32) throw new ArchiveError("LIMIT", "目录层级超过当前版本的 32 层上限。");
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (flat.length >= 50000) throw new ArchiveError("LIMIT", "目录超过 50,000 项，请打开更小的子目录。");
      if (entry.isSymbolicLink()) continue;
      const full = path.join(directory, entry.name);
      const relative = normalizeEntryPath(prefix + entry.name);
      const stat = await fs.lstat(full);
      if (!stat.isFile() && !stat.isDirectory()) continue;
      flat.push({ path: relative, folder: stat.isDirectory(), size: stat.size, packed: null, date: new Date(stat.mtimeMs).toLocaleString("sv-SE").slice(0, 16) });
      if (stat.isDirectory()) await visit(full, relative + "/", depth + 1);
    }
  };
  await visit(folderPath);
  const size = flat.filter((entry) => !entry.folder).reduce((sum, entry) => sum + entry.size, 0);
  const archive = { id: randomUUID(), name: path.basename(folderPath), path: folderPath, source: path.dirname(folderPath), entries: makeTree(flat), size, originalSize: size, format: "文件夹", method: "—", date: new Date().toLocaleString("sv-SE").slice(0, 16), native: true, folder: true, demo: false, canDelete: true, defaultDestination: folderPath };
  sessions.set(archive.id, { archive, flat, password: "" });
  return archive;
}

function registerHandlers() {
  handle("ready", async () => {
    rendererReady = true;
    setImmediate(drainFiles);
    return { version: releaseConfig.displayVersion, engine: "7-Zip 26.06 · LZ4 1.10", tasks: [...tasks.values()].map(publicTask), updates: updates.snapshot() };
  });
  handle("openArchive", async () => {
    const result = await dialog.showOpenDialog(mainWindow, { title: "打开压缩包", properties: ["openFile"], filters: [{ name: "压缩文件", extensions: ["zip", "rar", "7z", "lz4", "tar", "gz", "tgz", "bz2", "xz", "zst", "cab", "iso", "arj", "lzh", "lzma", "001", "zipx"] }, { name: "所有文件", extensions: ["*"] }] });
    return result.canceled ? null : acceptArchive(result.filePaths[0]);
  });
  handle("openDropped", async ({ path: filePath }) => {
    if (!filePath || typeof filePath !== "string") throw new ArchiveError("INVALID_FILE", "无法读取拖入文件的路径。");
    const stat = await fs.lstat(filePath);
    return stat.isDirectory() ? openFolder(filePath) : acceptArchive(filePath);
  });
  handle("openFolder", async () => {
    const result = await dialog.showOpenDialog(mainWindow, { title: "打开文件夹", properties: ["openDirectory"] });
    return result.canceled ? null : openFolder(result.filePaths[0]);
  });
  handle("chooseDestination", async ({ archiveId }) => {
    const current = getSession(archiveId);
    const result = await dialog.showOpenDialog(mainWindow, { title: "选择解压目录", defaultPath: current.archive.defaultDestination, properties: ["openDirectory", "createDirectory"] });
    if (result.canceled) return null;
    const selected = path.resolve(result.filePaths[0]);
    await rejectLinks(selected);
    allowedDestinations.add(selected);
    return selected;
  });
  handle("unlock", async ({ archiveId, password }) => {
    assertIdle(archiveId);
    const current = getSession(archiveId);
    const unlocked = await engine.open(current.archive.path, password);
    if (unlocked.archive.locked) throw new ArchiveError("WRONG_PASSWORD", "密码不正确，请重试。");
    unlocked.archive.id = archiveId;
    await engine.close(current);
    sessions.set(archiveId, unlocked);
    return unlocked.archive;
  });
  handle("extract", async ({ archiveId, destination, here, subfolder, policy, selection }) => {
    const current = getSession(archiveId);
    if (current.archive.folder) throw new ArchiveError("INVALID_FILE", "当前是文件夹，无需解压。");
    const base = here ? path.dirname(current.archive.path) : destination;
    if (typeof base !== "string" || !allowedDestinations.has(path.resolve(base))) throw new ArchiveError("DENIED", "请通过文件夹选择器指定解压目录。");
    let target = path.resolve(base);
    if (subfolder && !here) target = path.join(target, normalizeEntryPath(current.archive.name.replace(/\.(?:tar\.(?:gz|bz2|xz|zst|lz4)|tgz|tbz2|txz|tzst|[^.]+)$/i, "") || "output"));
    if (policy === "overwrite") {
      const choice = await dialog.showMessageBox(mainWindow, { type: "warning", title: "确认覆盖同名文件", message: "解压时覆盖目标目录中的同名文件？", detail: target, buttons: ["取消", "覆盖并解压"], defaultId: 0, cancelId: 0, noLink: true });
      if (choice.response !== 1) return null;
    }
    return startTask(current, "extract", target, (options) => engine.extract(current, target, { ...options, policy: policy || "rename", selection }));
  });
  handle("test", ({ archiveId }) => {
    const current = getSession(archiveId);
    if (current.archive.folder) throw new ArchiveError("INVALID_FILE", "文件夹不需要压缩包测试。");
    return startTask(current, "test", null, (options) => engine.test(current, options));
  });
  handle("remove", async ({ archiveId, selection }) => {
    const current = getSession(archiveId);
    assertIdle(archiveId);
    if (!Array.isArray(selection) || !selection.length) throw new ArchiveError("INVALID_SELECTION", "请先选择要删除的文件。");
    if (!current.archive.canDelete) throw new ArchiveError("READ_ONLY", "此格式或加密方式暂不支持直接删除内部文件。");
    const selected = engine.selected(current, selection);
    const choice = await dialog.showMessageBox(mainWindow, { type: "warning", title: current.archive.folder ? "移到回收站" : "删除压缩包内文件", message: `确认${current.archive.folder ? "移到回收站" : "删除"}所选 ${selection.length} 个项目？`, detail: `${current.archive.path}\n\n${selection.slice(0, 8).join("\n")}\n\n${current.archive.folder ? "文件将移至系统回收站。" : "原压缩包会在同目录保留 .minizip-backup 备份。"}`, buttons: ["取消", current.archive.folder ? "移到回收站" : "删除并保留备份"], defaultId: 0, cancelId: 0, noLink: true });
    if (choice.response !== 1) return null;
    if (!current.archive.folder) return startTask(current, "delete", null, (options) => engine.deleteEntries(current, selection, options));
    const top = selection.filter((id) => !selection.some((other) => other !== id && id.startsWith(other + "/")));
    return startTask(current, "delete", null, async (options) => {
      options.onPhase("committing");
      let deleted = 0;
      try {
        for (const id of top) {
          const name = normalizeEntryPath(id);
          if (!selected.some((entry) => entry.path === name || entry.path.startsWith(name + "/"))) throw new ArchiveError("INVALID_SELECTION", "所选文件不在当前目录。");
          const target = path.join(current.archive.path, ...name.split("/"));
          assertInside(current.archive.path, target); await rejectLinks(target);
          await shell.trashItem(target); deleted++;
        }
      } finally {
        const refreshed = await openFolder(current.archive.path);
        const refreshedSession = sessions.get(refreshed.id); sessions.delete(refreshed.id);
        refreshedSession.archive.id = archiveId; sessions.set(archiveId, refreshedSession); send("archive", refreshedSession.archive);
      }
      return { deleted, recycleBin: true };
    });
  });
  handle("preview", async ({ archiveId, entryId }) => {
    const current = getSession(archiveId);
    assertIdle(archiveId);
    if (!current.archive.folder) return engine.preview(current, entryId);
    const item = current.flat.find((entry) => entry.path === entryId && !entry.folder);
    if (!item) throw new ArchiveError("INVALID_SELECTION", "文件不在当前目录。");
    const filePath = path.join(current.archive.path, ...normalizeEntryPath(entryId).split("/"));
    assertInside(current.archive.path, filePath); await rejectLinks(filePath);
    const stat = await fs.stat(filePath);
    const ext = Core.extension(filePath);
    const mime = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", avif: "image/avif" }[ext];
    if (mime && stat.size <= 12 * 1024 ** 2) return { kind: "image", dataUrl: `data:${mime};base64,${(await fs.readFile(filePath)).toString("base64")}` };
    if (Core.kindFor(filePath) === "text" && stat.size <= 1024 ** 2) return { kind: "text", content: await fs.readFile(filePath, "utf8") };
    throw new ArchiveError("NO_PREVIEW", "不支持此类型，或文件超过预览大小上限。");
  });
  handle("cancelTask", ({ taskId }) => {
    const task = tasks.get(taskId);
    if (!task || task.status !== "running" || !task.canCancel) throw new ArchiveError("NOT_CANCELLABLE", "该任务当前不能取消。");
    task.controller.abort(); return true;
  });
  handle("revealTask", async ({ taskId }) => {
    const task = tasks.get(taskId);
    if (!task || task.status !== "completed") throw new ArchiveError("INVALID_TASK", "任务尚未完成。");
    const location = task.result?.backupPath || task.destination;
    if (task.result?.backupPath || task.kind !== "extract") shell.showItemInFolder(location);
    else { const error = await shell.openPath(location); if (error) throw new ArchiveError("OPEN_FAILED", "无法打开目标文件夹。"); }
    return true;
  });
  handle("closeArchive", async ({ archiveId }) => {
    assertIdle(archiveId);
    const current = getSession(archiveId); if (!current.archive.folder) await engine.close(current); sessions.delete(archiveId); return true;
  });
  handle("createArchive", async () => {
    const result = await dialog.showOpenDialog(mainWindow, { title: "选择要压缩的文件", properties: ["openFile", "multiSelections"] });
    if (!result.canceled) await createQuickWindow(result.filePaths);
    return true;
  });
  handle("updateState", () => updates.snapshot());
  handle("checkUpdates", () => updates.check());
  handle("updatePreferences", (settings) => updates.preferences(settings));
  handle("downloadUpdate", () => { updates.download().catch(() => {}); return updates.snapshot(); });
  handle("cancelUpdate", () => { updates.cancel(); return true; });
  handle("installUpdate", async () => {
    if ([...tasks.values()].some((task) => task.status === "running")) throw new ArchiveError("BUSY", "请先完成或取消文件任务再安装更新。");
    const target = await updates.installer();
    const result = await dialog.showMessageBox(mainWindow, { type: "question", title: "安装更新", message: "关闭 MiniZip 并启动已校验的安装程序？", detail: "请在安装向导中确认升级。", buttons: ["取消", "安装更新"], defaultId: 0, cancelId: 0, noLink: true });
    if (result.response !== 1) return false;
    const child = spawn(target, [], { detached: true, stdio: "ignore", windowsHide: false, shell: false });
    await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    child.unref();
    for (const current of quickWindows.values()) current.window.close();
    mainWindow.close(); return true;
  });
  handle("defaultApps", () => shell.openExternal("ms-settings:defaultapps"));
  handle("repository", async () => { if (!releaseConfig.repository) throw new ArchiveError("UPDATE_CONFIG", "GitHub 仓库尚未配置。"); await shell.openExternal("https://github.com/" + releaseConfig.repository); return true; });
  registerQuickHandlers();
}

async function drainFiles() {
  if (draining || !rendererReady || !mainWindow || mainWindow.isDestroyed()) return;
  draining = true;
  try {
    while (pendingFiles.length && rendererReady && mainWindow && !mainWindow.isDestroyed()) {
      const file = pendingFiles.shift();
      try { send("archive", await acceptArchive(file)); }
      catch (error) { dialog.showErrorBox("无法打开压缩包", errorPayload(error).message); }
    }
  } finally { draining = false; }
}
function quickHandle(name, callback) {
  ipcMain.handle("minizip:" + name, async (event, payload) => {
    try {
      const current = quickWindows.get(event.sender.id);
      if (!current || event.senderFrame !== event.sender.mainFrame || event.senderFrame.url !== quickUrl) throw new ArchiveError("DENIED", "无法验证快速压缩请求。");
      return { ok: true, value: await callback(current, payload) };
    } catch (error) { return { ok: false, error: errorPayload(error) }; }
  });
}
function registerQuickHandlers() {
  quickHandle("quickReady", async (current) => {
    current.manifest = await current.manifestPromise;
    const { entries, ...summary } = current.manifest;
    current.allowed.add(summary.destination);
    return summary;
  });
  quickHandle("quickDestination", async (current) => {
    const selected = await dialog.showOpenDialog(current.window, { title: "选择保存位置", defaultPath: current.manifest?.destination, properties: ["openDirectory", "createDirectory"] });
    if (selected.canceled) return null;
    await rejectLinks(selected.filePaths[0]); current.allowed.add(path.resolve(selected.filePaths[0])); return selected.filePaths[0];
  });
  quickHandle("quickResize", (current, height) => { if (Number.isFinite(height)) current.window.setContentSize(490, Math.max(420, Math.min(720, height))); return true; });
  quickHandle("quickStart", async (current, settings) => {
    if (!current.manifest || current.starting || current.taskId && tasks.get(current.taskId)?.status === "running") throw new ArchiveError("BUSY", "文件尚未准备好，或压缩已开始。");
    current.starting = true;
    try {
      if (!settings || !["zip", "7z"].includes(settings.format) || typeof settings.name !== "string" || settings.name.length > 180 || !current.allowed.has(path.resolve(settings.destination || ""))) throw new ArchiveError("INPUT", "压缩设置无效，请重新选择保存位置。");
      const name = normalizeEntryPath(settings.name.trim());
      if (name.includes("/")) throw new ArchiveError("INPUT", "压缩包名称不能包含目录。");
      const target = path.join(settings.destination, name + "." + settings.format);
      let overwrite = false;
      try { await fs.lstat(target); overwrite = true; } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (overwrite) {
        const answer = await dialog.showMessageBox(current.window, { type: "warning", title: "覆盖同名压缩包", message: "目标压缩包已存在，是否保留备份后覆盖？", detail: target, buttons: ["取消", "备份并覆盖"], defaultId: 0, cancelId: 0, noLink: true });
        if (answer.response !== 1) return null;
      }
      const manifest = await scanInputs(current.manifest.sources);
      const archive = { id: "quick-" + current.window.webContents.id, name: path.basename(target), path: target, entries: manifest.entries };
      const task = startTask({ archive }, "compress", path.dirname(target), (options) => compress(engine, manifest, target, { ...settings, overwrite }, options));
      current.taskId = task.id; return task;
    } finally { current.starting = false; }
  });
  quickHandle("quickCancel", (current) => { const task = tasks.get(current.taskId); if (task?.status === "running" && task.canCancel) task.controller.abort(); return true; });
  quickHandle("quickClose", (current) => { current.window.close(); return true; });
  quickHandle("quickReveal", (current) => { const task = tasks.get(current.taskId); if (task?.status === "completed") shell.showItemInFolder(task.result.path); return true; });
}
async function createQuickWindow(paths) {
  const window = new BrowserWindow({ width: 506, height: 486, useContentSize: true, resizable: false, maximizable: false, title: "MiniZip · 快速压缩", icon: path.resolve(__dirname, "../assets/minizip.ico"), backgroundColor: "#ffffff", show: !testMode, autoHideMenuBar: true, webPreferences: { preload: path.join(__dirname, "preload.cjs"), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, backgroundThrottling: false, devTools: !app.isPackaged } });
  const current = { window, manifest: null, manifestPromise: scanInputs(paths), allowed: new Set(), taskId: null, closing: false };
  current.manifestPromise.catch(() => {});
  quickWindows.set(window.webContents.id, current);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => { if (url !== quickUrl) event.preventDefault(); });
  window.on("close", (event) => {
    const task = tasks.get(current.taskId);
    if (task?.status === "running" && !current.closing) {
      event.preventDefault();
      if (!task.canCancel) { dialog.showMessageBoxSync(window, { type: "info", message: "正在安全保存，请稍候。" }); return; }
      if (dialog.showMessageBoxSync(window, { type: "question", message: "取消压缩并关闭窗口？", buttons: ["继续压缩", "取消压缩"], defaultId: 0, cancelId: 0 }) !== 1) return;
      current.closing = true; task.controller.abort(); task.promise.finally(() => window.destroy());
    }
  });
  const contentsId = window.webContents.id;
  window.on("closed", () => { quickWindows.delete(contentsId); });
  await window.loadFile(path.resolve(__dirname, "../quick.html"));
  return window;
}
function queueQuickWindow(paths) {
  queuedCompression.push(...paths);
  clearTimeout(compressionTimer);
  compressionTimer = setTimeout(() => {
    const inputs = [...new Set(queuedCompression)]; queuedCompression = [];
    createQuickWindow(inputs).catch((error) => dialog.showErrorBox("无法压缩", errorPayload(error).message));
  }, 350);
}

async function createWindow() {
  closing = false;
  mainWindow = new BrowserWindow({ width: 1320, height: 870, minWidth: 780, minHeight: 620, title: "MiniZip", icon: path.resolve(__dirname, "../assets/minizip.ico"), backgroundColor: "#f6f7f9", show: !testMode, autoHideMenuBar: true, webPreferences: { preload: path.join(__dirname, "preload.cjs"), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, navigateOnDragDrop: false, devTools: !app.isPackaged } });
  Menu.setApplicationMenu(null);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, url) => { if (url !== entryUrl) event.preventDefault(); });
  mainWindow.webContents.on("will-attach-webview", (event) => event.preventDefault());
  mainWindow.webContents.on("did-start-navigation", () => { rendererReady = false; });
  mainWindow.on("close", (event) => {
    if (closing) return;
    event.preventDefault();
    const active = [...tasks.values()].some((task) => task.status === "running");
    if (active && dialog.showMessageBoxSync(mainWindow, { type: "warning", title: "任务仍在进行", message: "取消当前任务并退出 MiniZip？", detail: "正在安全提交的任务会先完成提交。", buttons: ["继续等待", "取消任务并退出"], defaultId: 0, cancelId: 0, noLink: true }) !== 1) return;
    closing = true;
    for (const task of tasks.values()) if (task.status === "running" && task.canCancel) task.controller.abort();
    Promise.allSettled([...tasks.values()].map((task) => task.promise)).then(async () => {
      await Promise.allSettled([...sessions.values()].filter((current) => !current.archive.folder).map((current) => engine.close(current)));
      sessions.clear(); allowedDestinations.clear();
      mainWindow.destroy(); mainWindow = null; rendererReady = false;
      if (!quickWindows.size) app.quit();
    });
  });
  await mainWindow.loadFile(path.resolve(__dirname, "../index.html"));
}

if (!testMode && !app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", (_event, argv) => {
    const launch = parseLaunch(argv.slice(app.isPackaged ? 1 : 2));
    if (launch.mode === "compress") { queueQuickWindow(launch.paths); return; }
    if (launch.mode === "defaults") { shell.openExternal("ms-settings:defaultapps"); return; }
    pendingFiles.push(...launch.paths);
    if (!mainWindow || mainWindow.isDestroyed()) createWindow();
    else { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); drainFiles(); }
  });
  app.whenReady().then(async () => {
    app.setAppUserModelId("MiniZip.Desktop");
    const cacheRoot = path.join(app.getPath("temp"), "MiniZip", randomUUID());
    engine = new ArchiveEngine({ cacheRoot });
    electronSession.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    electronSession.defaultSession.setPermissionCheckHandler(() => false);
    electronSession.defaultSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] }, (_details, callback) => callback({ cancel: true }));
    updates = new UpdateService(releaseConfig, path.join(app.getPath("userData"), "updates"), (value) => send("update", value));
    await updates.init();
    registerHandlers();
    if (initialLaunch.mode === "compress") queueQuickWindow(initialLaunch.paths);
    else if (initialLaunch.mode === "defaults") { await shell.openExternal("ms-settings:defaultapps"); app.quit(); }
    else { await createWindow(); if (updates.state.autoCheck && releaseConfig.repository && !testMode) setTimeout(() => updates.check(), 4000); }
  }).catch((error) => { dialog.showErrorBox("MiniZip 启动失败", errorPayload(error).message); app.quit(); });
  app.on("window-all-closed", () => { if (!queuedCompression.length) app.quit(); });
}
