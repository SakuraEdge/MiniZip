"use strict";

const { app, BrowserWindow, ipcMain, dialog, shell, Menu, session: electronSession } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { randomUUID } = require("node:crypto");
const { spawn } = require("node:child_process");
const { ArchiveEngine, ArchiveError, normalizeEntryPath, rejectLinks, assertInside, makeTree } = require("./archive-engine.cjs");
const { scanInputs, compress } = require("./compress-engine.cjs");
const { EditSessions, isExecutable } = require("./edit-sessions.cjs");
const { UpdateService } = require("./updates.cjs");
const { parseLaunch } = require("./launch.cjs");
const releaseConfig = require("../release-config.json");
const Core = require("../core.js");

const entryUrl = pathToFileURL(path.resolve(__dirname, "../index.html")).href;
const quickUrl = pathToFileURL(path.resolve(__dirname, "../quick.html")).href;
const quickWindows = new Map();
const sessions = new Map();
const workbenches = new Map();
const sessionOwners = new Map();
const tasks = new Map();
const activeArchives = new Set();
const activeDestinations = new Set();
const testMode = process.env.MINIZIP_TEST_MODE === "1";
let engine;
let edits;
const initialLaunch = parseLaunch(process.argv.slice(app.isPackaged ? 1 : 2));
let updates;
let queuedCompression = [];
let compressionTimer = null;
let queuedQuickMode = "compress";

if (testMode && process.env.MINIZIP_TEST_PROFILE) app.setPath("userData", process.env.MINIZIP_TEST_PROFILE);

function errorPayload(error) {
  return { code: error.code || "IO_ERROR", message: error instanceof ArchiveError ? error.message : error.code === "EACCES" || error.code === "EPERM" ? "没有访问权限，或文件正被其他程序占用。" : error.code === "ENOSPC" ? "磁盘空间不足。" : error.code === "ENOENT" ? "文件或目录不存在，请重新选择。" : "文件操作失败，请检查权限、磁盘空间与文件状态。" };
}
function validateSender(event) {
  const view = workbenches.get(event.sender.id);
  if (!view || event.senderFrame !== event.sender.mainFrame || event.senderFrame.url.split("#")[0] !== entryUrl) throw new ArchiveError("DENIED", "无法验证请求来源。");
  return view;
}
function handle(name, callback) {
  ipcMain.handle("minizip:" + name, async (event, payload) => {
    try { const view = validateSender(event); return { ok: true, value: await callback(payload || {}, view) }; }
    catch (error) { return { ok: false, error: errorPayload(error) }; }
  });
}
function getSession(id, view) {
  const current = sessions.get(id);
  if (!current || view && sessionOwners.get(id) !== view) throw new ArchiveError("SESSION_EXPIRED", "文件会话已关闭或不属于此窗口，请重新打开。");
  return current;
}
function assertIdle(id) {
  const current = sessions.get(id);
  if (sessionOwners.get(id)?.openingEntry || activeArchives.has(current?.archive.path.toLowerCase() || id)) throw new ArchiveError("BUSY", "当前文件仍有任务进行中，请完成或取消后再操作。");
}
function send(channel, payload, target) {
  const owner = target || (channel === "archive" ? sessionOwners.get(payload.id) : channel === "task" || channel === "edits" ? sessionOwners.get(payload.archiveId) : null);
  const recipients = owner ? [owner] : channel === "update" ? [...workbenches.values()] : [];
  for (const view of recipients) if (!view.window.isDestroyed() && view.ready) view.window.webContents.send("minizip:" + channel, payload);
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
  const lockKey = current.archive.path?.toLowerCase() || current.archive.id;
  if (activeArchives.has(lockKey)) throw new ArchiveError("BUSY", "此压缩包正在另一个窗口中处理。");
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
  activeArchives.add(lockKey);
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
      if (result?.session) { await engine.close(current); sessions.set(current.archive.id, result.session); edits.setSession(result.session); send("archive", result.session.archive); }
      updateTask(task, { status: "completed", progress: 100, phase: "completed", canCancel: false, result: result?.session ? { backupPath: result.backupPath, deleted: result.deleted, updated: result.updated } : result, finishedAt: Date.now() });
    } catch (error) {
      updateTask(task, { status: error.code === "CANCELLED" ? "cancelled" : "failed", phase: "finished", canCancel: false, error: errorPayload(error), finishedAt: Date.now() });
    } finally {
      activeArchives.delete(lockKey);
      if (destination) activeDestinations.delete(path.resolve(destination).toLowerCase());
    }
  });
  return publicTask(task);
}

async function acceptArchive(filePath, view) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) throw new ArchiveError("INVALID_FILE", "请选择有效的本地文件。");
  const current = await engine.open(filePath);
  sessions.set(current.archive.id, current);
  sessionOwners.set(current.archive.id, view);
  view.archiveId = current.archive.id;
  view.allowedDestinations.add(path.dirname(current.archive.path));
  view.window.setTitle(current.archive.name + " - MiniZip");
  return current.archive;
}
async function openFolder(folderPath, view) {
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
  sessionOwners.set(archive.id, view); view.archiveId = archive.id;
  view.window.setTitle(archive.name + " - MiniZip");
  return archive;
}

async function openInWorkbench(filePath, view, mode = "open", forceNew = false) {
  if (!view || view.archiveId || view.opening || forceNew) { await createWindow(filePath, mode); return null; }
  view.opening = true;
  try {
    const stat = await fs.lstat(filePath);
    return stat.isDirectory() ? await openFolder(filePath, view) : await acceptArchive(filePath, view);
  } finally { view.opening = false; }
}

function registerHandlers() {
  handle("ready", async (_payload, view) => {
    view.ready = true;
    if (view.initialPath) setImmediate(() => initializeWorkbench(view));
    return { version: releaseConfig.displayVersion, engine: "7-Zip 26.06 · LZ4 1.10", tasks: [...tasks.values()].filter((task) => sessionOwners.get(task.archiveId) === view).map(publicTask), updates: updates.snapshot() };
  });
  handle("openArchive", async (_payload, view) => {
    const result = await dialog.showOpenDialog(view.window, { title: "打开压缩包", properties: ["openFile", "multiSelections"], filters: [{ name: "压缩文件", extensions: ["zip", "rar", "7z", "lz4", "tar", "gz", "tgz", "bz2", "xz", "zst", "cab", "iso", "arj", "lzh", "lzma", "001", "zipx"] }, { name: "所有文件", extensions: ["*"] }] });
    if (result.canceled) return null;
    let first = null;
    for (const filePath of result.filePaths) { const opened = await openInWorkbench(filePath, view); if (opened) first = opened; }
    return first;
  });
  handle("openDropped", async ({ path: filePath }, view) => {
    if (!filePath || typeof filePath !== "string") throw new ArchiveError("INVALID_FILE", "无法读取拖入文件的路径。");
    return openInWorkbench(filePath, view);
  });
  handle("openFolder", async (_payload, view) => {
    const result = await dialog.showOpenDialog(view.window, { title: "打开文件夹", properties: ["openDirectory"] });
    return result.canceled ? null : openInWorkbench(result.filePaths[0], view);
  });
  handle("chooseDestination", async ({ archiveId }, view) => {
    const current = getSession(archiveId, view);
    const result = await dialog.showOpenDialog(view.window, { title: "选择解压目录", defaultPath: current.archive.defaultDestination, properties: ["openDirectory", "createDirectory"] });
    if (result.canceled) return null;
    const selected = path.resolve(result.filePaths[0]);
    await rejectLinks(selected);
    view.allowedDestinations.add(selected);
    return selected;
  });
  handle("unlock", async ({ archiveId, password }, view) => {
    assertIdle(archiveId);
    const current = getSession(archiveId, view);
    const unlocked = await engine.open(current.archive.path, password);
    if (unlocked.archive.locked) throw new ArchiveError("WRONG_PASSWORD", "密码不正确，请重试。");
    unlocked.archive.id = archiveId;
    await engine.close(current);
    sessions.set(archiveId, unlocked);
    edits.setSession(unlocked);
    return unlocked.archive;
  });
  handle("extract", async ({ archiveId, destination, here, subfolder, policy, selection }, view) => {
    const current = getSession(archiveId, view);
    if (current.archive.folder) throw new ArchiveError("INVALID_FILE", "当前是文件夹，无需解压。");
    const base = here ? path.dirname(current.archive.path) : destination;
    if (typeof base !== "string" || !view.allowedDestinations.has(path.resolve(base))) throw new ArchiveError("DENIED", "请通过文件夹选择器指定解压目录。");
    let target = path.resolve(base);
    if (subfolder && !here) target = path.join(target, normalizeEntryPath(current.archive.name.replace(/\.(?:tar\.(?:gz|bz2|xz|zst|lz4)|tgz|tbz2|txz|tzst|[^.]+)$/i, "") || "output"));
    if (policy === "overwrite") {
      const choice = await dialog.showMessageBox(view.window, { type: "warning", title: "确认覆盖同名文件", message: "解压时覆盖目标目录中的同名文件？", detail: target, buttons: ["取消", "覆盖并解压"], defaultId: 0, cancelId: 0, noLink: true });
      if (choice.response !== 1) return null;
    }
    return startTask(current, "extract", target, (options) => engine.extract(current, target, { ...options, policy: policy || "rename", selection }));
  });
  handle("test", ({ archiveId }, view) => {
    const current = getSession(archiveId, view);
    if (current.archive.folder) throw new ArchiveError("INVALID_FILE", "文件夹不需要压缩包测试。");
    return startTask(current, "test", null, (options) => engine.test(current, options));
  });
  handle("remove", async ({ archiveId, selection }, view) => {
    const current = getSession(archiveId, view);
    assertIdle(archiveId);
    if (!Array.isArray(selection) || !selection.length) throw new ArchiveError("INVALID_SELECTION", "请先选择要删除的文件。");
    if (!current.archive.canDelete) throw new ArchiveError("READ_ONLY", "此格式或加密方式暂不支持直接删除内部文件。");
    if ((await edits.scan(archiveId, true)).count) throw new ArchiveError("UNSAVED_EDITS", "有外部修改尚未保存，请先处理修改再删除文件。");
    const selected = engine.selected(current, selection);
    const choice = await dialog.showMessageBox(view.window, { type: "warning", title: current.archive.folder ? "移到回收站" : "删除压缩包内文件", message: `确认${current.archive.folder ? "移到回收站" : "删除"}所选 ${selection.length} 个项目？`, detail: `${current.archive.path}\n\n${selection.slice(0, 8).join("\n")}\n\n${current.archive.folder ? "文件将移至系统回收站。" : "原压缩包会在同目录保留 .minizip-backup 备份。"}`, buttons: ["取消", current.archive.folder ? "移到回收站" : "删除并保留备份"], defaultId: 0, cancelId: 0, noLink: true });
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
        const refreshed = await openFolder(current.archive.path, view);
        const refreshedSession = sessions.get(refreshed.id); sessions.delete(refreshed.id);
        sessionOwners.delete(refreshed.id); view.archiveId = archiveId;
        refreshedSession.archive.id = archiveId; sessions.set(archiveId, refreshedSession); send("archive", refreshedSession.archive);
      }
      return { deleted, recycleBin: true };
    });
  });
  handle("preview", async ({ archiveId, entryId }, view) => {
    const current = getSession(archiveId, view);
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
  handle("openEntry", async ({ archiveId, entryId }, view) => {
    const current = getSession(archiveId, view);
    assertIdle(archiveId);
    const item = current.flat.find((entry) => entry.path === entryId && !entry.folder);
    if (!item) throw new ArchiveError("INVALID_SELECTION", "请选择当前压缩包中的文件。");
    if (view.openingEntry) throw new ArchiveError("BUSY", "正在打开文件，请稍候。");
    view.openingEntry = true;
    try {
      const executable = isExecutable(entryId);
      if (executable) {
        const answer = await dialog.showMessageBox(view.window, { type: "warning", title: "运行压缩包中的程序", message: `运行 ${path.basename(entryId)}？`, detail: "此文件将在你的电脑上执行，可能修改文件或系统设置。请仅运行来源可信的程序。相关目录会先解压到临时工作区。", buttons: ["取消", "确认运行"], defaultId: 0, cancelId: 0, noLink: true });
        if (answer.response !== 1) return { cancelled: true };
      }
      if (current.archive.encrypted && !view.approvedDecryption) {
        const answer = await dialog.showMessageBox(view.window, { type: "warning", title: "在外部应用打开加密文件", message: "将文件解密到本机工作副本后打开？", detail: "外部应用需要未加密的临时文件。为避免丢失外部修改，工作副本可能在关闭 MiniZip 后保留。", buttons: ["取消", "解密并打开"], defaultId: 0, cancelId: 0, noLink: true });
        if (answer.response !== 1) return { cancelled: true };
        view.approvedDecryption = true;
      }
      let filePath;
      if (current.archive.folder) {
        filePath = path.join(current.archive.path, ...normalizeEntryPath(entryId).split("/"));
        assertInside(current.archive.path, filePath); await rejectLinks(filePath);
        if (!(await fs.lstat(filePath)).isFile()) throw new ArchiveError("INVALID_FILE", "文件已不存在。");
      } else filePath = await edits.prepare(current, entryId, executable);
      if (Core.isArchive(entryId)) {
        await createWindow(filePath, "open", current.archive.folder ? null : archiveId);
        return { nested: true };
      }
      const error = await shell.openPath(filePath);
      if (error) throw new ArchiveError("OPEN_FAILED", "无法调用此类型的默认应用，请在 Windows 中设置打开方式后重试。");
      return { opened: true };
    } finally { view.openingEntry = false; }
  });
  handle("editState", async ({ archiveId }, view) => { getSession(archiveId, view); return edits.scan(archiveId, true); });
  handle("saveEdits", async ({ archiveId }, view) => {
    const current = getSession(archiveId, view);
    assertIdle(archiveId);
    if (view.openingEntry) throw new ArchiveError("BUSY", "文件仍在打开中，请稍候。");
    return startTask(current, "update", null, (options) => edits.save(current, options));
  });
  handle("exportEdits", async ({ archiveId }, view) => {
    getSession(archiveId, view); assertIdle(archiveId);
    const result = await dialog.showOpenDialog(view.window, { title: "另存修改后的文件", properties: ["openDirectory", "createDirectory"] });
    if (result.canceled) return null;
    const folder = await edits.exportChanges(archiveId, result.filePaths[0]);
    shell.showItemInFolder(folder); return folder;
  });
  handle("revealEdits", ({ archiveId }, view) => {
    getSession(archiveId, view);
    const location = edits.location(archiveId);
    if (location) shell.showItemInFolder(location);
    return Boolean(location);
  });
  handle("workFiles", async () => {
    const directory = path.join(app.getPath("userData"), "work-files");
    await fs.mkdir(directory, { recursive: true });
    const error = await shell.openPath(directory);
    if (error) throw new ArchiveError("OPEN_FAILED", "无法打开工作副本目录。");
    return true;
  });
  handle("cancelTask", ({ taskId }, view) => {
    const task = tasks.get(taskId);
    if (!task || sessionOwners.get(task.archiveId) !== view || task.status !== "running" || !task.canCancel) throw new ArchiveError("NOT_CANCELLABLE", "该任务当前不能取消。");
    task.controller.abort(); return true;
  });
  handle("revealTask", async ({ taskId }, view) => {
    const task = tasks.get(taskId);
    if (!task || sessionOwners.get(task.archiveId) !== view || task.status !== "completed") throw new ArchiveError("INVALID_TASK", "任务尚未完成。");
    const location = task.result?.backupPath || task.destination;
    if (task.result?.backupPath || task.kind !== "extract") shell.showItemInFolder(location);
    else { const error = await shell.openPath(location); if (error) throw new ArchiveError("OPEN_FAILED", "无法打开目标文件夹。"); }
    return true;
  });
  handle("closeArchive", async ({ archiveId }, view) => {
    assertIdle(archiveId);
    getSession(archiveId, view);
    if (!await resolveEdits(view)) return false;
    await releaseWorkbench(view); return true;
  });
  handle("createArchive", async (_payload, view) => {
    const result = await dialog.showOpenDialog(view.window, { title: "选择要压缩的文件", properties: ["openFile", "multiSelections"] });
    if (!result.canceled) await createQuickWindow(result.filePaths);
    return true;
  });
  handle("updateState", () => updates.snapshot());
  handle("checkUpdates", () => updates.check());
  handle("updatePreferences", (settings) => updates.preferences(settings));
  handle("downloadUpdate", () => { updates.download().catch(() => {}); return updates.snapshot(); });
  handle("cancelUpdate", () => { updates.cancel(); return true; });
  handle("installUpdate", async (_payload, view) => {
    if ([...tasks.values()].some((task) => task.status === "running")) throw new ArchiveError("BUSY", "请先完成或取消文件任务再安装更新。");
    if ([...workbenches.values()].some((current) => current.opening || current.openingEntry || current.confirmingClose)) throw new ArchiveError("BUSY", "请先完成当前文件或窗口操作。");
    for (const current of workbenches.values()) if (current.archiveId && (await edits.scan(current.archiveId, true)).count) throw new ArchiveError("UNSAVED_EDITS", "请先处理所有工作台中尚未保存的外部修改。");
    const target = await updates.installer();
    const result = await dialog.showMessageBox(view.window, { type: "question", title: "安装更新", message: "关闭 MiniZip 并启动已校验的安装程序？", detail: "请在安装向导中确认升级。", buttons: ["取消", "安装更新"], defaultId: 0, cancelId: 0, noLink: true });
    if (result.response !== 1) return false;
    const child = spawn(target, [], { detached: true, stdio: "ignore", windowsHide: false, shell: false });
    await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    child.unref();
    for (const current of quickWindows.values()) current.window.close();
    for (const current of [...workbenches.values()].reverse()) { await releaseWorkbench(current); current.closing = true; current.window.destroy(); }
    return true;
  });
  handle("defaultApps", () => shell.openExternal("ms-settings:defaultapps"));
  handle("repository", async () => { if (!releaseConfig.repository) throw new ArchiveError("UPDATE_CONFIG", "GitHub 仓库尚未配置。"); await shell.openExternal("https://github.com/" + releaseConfig.repository); return true; });
  registerQuickHandlers();
}

async function initializeWorkbench(view) {
  const filePath = view.initialPath;
  view.initialPath = null;
  if (!filePath) return;
  try {
    const archive = await openInWorkbench(filePath, view);
    if (archive) send("archive", { ...archive, launchAction: view.launchMode }, view);
  } catch (error) { await dialog.showMessageBox(view.window, { type: "error", title: "无法打开压缩包", message: errorPayload(error).message }); }
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
    return { ...summary, format: current.format || "zip", level: current.format === "7z" ? "maximum" : "normal", version: releaseConfig.displayVersion };
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
async function createQuickWindow(paths, format = "zip") {
  const window = new BrowserWindow({ width: 506, height: 486, useContentSize: true, resizable: false, maximizable: false, title: "MiniZip · 快速压缩", icon: path.resolve(__dirname, "../assets/minizip.ico"), backgroundColor: "#ffffff", show: !testMode, autoHideMenuBar: true, webPreferences: { preload: path.join(__dirname, "preload.cjs"), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, backgroundThrottling: false, devTools: !app.isPackaged } });
  const current = { window, manifest: null, manifestPromise: scanInputs(paths), allowed: new Set(), taskId: null, closing: false, format };
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
function queueQuickWindow(paths, mode = "compress") {
  if (queuedCompression.length && mode !== queuedQuickMode) {
    const previous = [...new Set(queuedCompression)]; queuedCompression = [];
    createQuickWindow(previous, queuedQuickMode === "compress-7z" ? "7z" : "zip").catch((error) => dialog.showErrorBox("无法压缩", errorPayload(error).message));
  }
  queuedQuickMode = mode;
  queuedCompression.push(...paths);
  clearTimeout(compressionTimer);
  compressionTimer = setTimeout(() => {
    const inputs = [...new Set(queuedCompression)]; queuedCompression = [];
    createQuickWindow(inputs, mode === "compress-7z" ? "7z" : "zip").catch((error) => dialog.showErrorBox("无法压缩", errorPayload(error).message));
  }, 350);
}

async function resolveEdits(view) {
  if (!view.archiveId) return true;
  if ([...workbenches.values()].some((current) => current.parentArchiveId === view.archiveId)) {
    await dialog.showMessageBox(view.window, { type: "info", title: "嵌套压缩包仍在打开", message: "请先关闭此压缩包中的嵌套工作台。", detail: "内层压缩包保存后，外层工作台会提示将修改写回原包。" });
    return false;
  }
  const changed = await edits.scan(view.archiveId, true);
  if (!changed.count) return true;
  const choice = await dialog.showMessageBox(view.window, { type: "warning", title: "有尚未保存的修改", message: `${changed.count} 个文件已在外部应用中修改。`, detail: `关闭前是否保存到压缩包？\n${changed.canUpdate ? "原包会保留备份。" : "此格式不支持写回，可另存修改后的文件。"}\n继续关闭会保留工作副本：\n${edits.location(view.archiveId)}`, buttons: ["返回工作台", changed.canUpdate ? "保存后关闭" : "另存副本后关闭", "保留副本并关闭"], defaultId: 0, cancelId: 0, noLink: true });
  if (choice.response === 0) return false;
  if (choice.response === 1) {
    if (changed.canUpdate) {
      const current = getSession(view.archiveId, view);
      const task = startTask(current, "update", null, (options) => edits.save(current, options));
      await tasks.get(task.id).promise;
      if (tasks.get(task.id).status !== "completed") return false;
    } else {
      const result = await dialog.showOpenDialog(view.window, { title: "另存修改后的文件", properties: ["openDirectory", "createDirectory"] });
      if (result.canceled) return false;
      await edits.exportChanges(view.archiveId, result.filePaths[0]);
    }
  }
  return true;
}
async function releaseWorkbench(view) {
  if (view.archiveId) {
    const current = sessions.get(view.archiveId);
    if (current && !current.archive.folder) await engine.close(current);
    edits.close(view.archiveId); sessions.delete(view.archiveId); sessionOwners.delete(view.archiveId);
    view.archiveId = null;
  }
  view.allowedDestinations.clear();
  if (!view.window.isDestroyed()) view.window.setTitle("MiniZip");
}
async function createWindow(initialPath = null, launchMode = "open", parentArchiveId = null) {
  const window = new BrowserWindow({ width: 1320, height: 870, minWidth: 780, minHeight: 620, title: "MiniZip", icon: path.resolve(__dirname, "../assets/minizip.ico"), backgroundColor: "#f6f7f9", show: !testMode, autoHideMenuBar: true, webPreferences: { preload: path.join(__dirname, "preload.cjs"), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, navigateOnDragDrop: false, backgroundThrottling: !testMode, devTools: !app.isPackaged } });
  const view = { window, ready: false, archiveId: null, allowedDestinations: new Set(), initialPath, launchMode, parentArchiveId, closing: false, opening: false, openingEntry: false };
  const contentsId = window.webContents.id;
  workbenches.set(contentsId, view);
  Menu.setApplicationMenu(null);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => { if (url !== entryUrl) event.preventDefault(); });
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.webContents.on("did-start-navigation", () => { view.ready = false; });
  window.on("focus", () => { if (view.archiveId) edits.scan(view.archiveId, true).catch(() => {}); });
  window.on("close", (event) => {
    if (view.closing) return;
    event.preventDefault();
    if (view.confirmingClose || view.opening || view.openingEntry) return;
    view.confirmingClose = true;
    (async () => {
      const owned = [...tasks.values()].filter((task) => sessionOwners.get(task.archiveId) === view);
      if (owned.some((task) => task.status === "running") && (await dialog.showMessageBox(window, { type: "warning", title: "任务仍在进行", message: "取消此窗口的任务并关闭？", detail: "其他工作台不受影响，正在安全提交的任务会先完成提交。", buttons: ["继续等待", "取消任务并关闭"], defaultId: 0, cancelId: 0, noLink: true })).response !== 1) return;
      for (const task of owned) if (task.status === "running" && task.canCancel) task.controller.abort();
      await Promise.allSettled(owned.map((task) => task.promise));
      if (!await resolveEdits(view)) return;
      await releaseWorkbench(view);
      view.closing = true; window.destroy();
    })().catch((error) => dialog.showErrorBox("无法关闭工作台", errorPayload(error).message)).finally(() => { view.confirmingClose = false; });
  });
  window.on("closed", () => { workbenches.delete(contentsId); });
  await window.loadFile(path.resolve(__dirname, "../index.html"));
  return view;
}

if (!testMode && !app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", (_event, argv) => {
    const launch = parseLaunch(argv.slice(app.isPackaged ? 1 : 2));
    if (launch.mode.startsWith("compress")) { queueQuickWindow(launch.paths, launch.mode); return; }
    if (launch.mode === "defaults") { shell.openExternal("ms-settings:defaultapps"); return; }
    if (launch.paths.length) for (const filePath of launch.paths) createWindow(filePath, launch.mode).catch((error) => dialog.showErrorBox("无法打开工作台", errorPayload(error).message));
    else createWindow();
  });
  app.whenReady().then(async () => {
    app.setAppUserModelId("MiniZip.Desktop");
    const cacheRoot = path.join(app.getPath("temp"), "MiniZip", randomUUID());
    engine = new ArchiveEngine({ cacheRoot });
    edits = new EditSessions(engine, path.join(app.getPath("userData"), "work-files"), (value) => send("edits", value));
    electronSession.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    electronSession.defaultSession.setPermissionCheckHandler(() => false);
    electronSession.defaultSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] }, (_details, callback) => callback({ cancel: true }));
    updates = new UpdateService(releaseConfig, path.join(app.getPath("userData"), "updates"), (value) => send("update", value));
    await updates.init();
    registerHandlers();
    if (initialLaunch.mode.startsWith("compress")) queueQuickWindow(initialLaunch.paths, initialLaunch.mode);
    else if (initialLaunch.mode === "defaults") { await shell.openExternal("ms-settings:defaultapps"); app.quit(); }
    else {
      if (initialLaunch.paths.length) for (const filePath of initialLaunch.paths) await createWindow(filePath, initialLaunch.mode);
      else await createWindow();
      if (updates.state.autoCheck && releaseConfig.repository && !testMode) setTimeout(() => updates.check(), 4000);
    }
  }).catch((error) => { dialog.showErrorBox("MiniZip 启动失败", errorPayload(error).message); app.quit(); });
  app.on("window-all-closed", () => { if (!queuedCompression.length) app.quit(); });
  app.on("will-quit", () => edits?.dispose());
}
