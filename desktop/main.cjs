"use strict";

const { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeTheme, session: electronSession } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { randomUUID } = require("node:crypto");
const { spawn } = require("node:child_process");
const { ArchiveEngine, ArchiveError, normalizeEntryPath, rejectLinks, assertInside, makeTree } = require("./archive-engine.cjs");
const { scanInputs, compress } = require("./compress-engine.cjs");
const { EditSessions, isExecutable } = require("./edit-sessions.cjs");
const ExternalFile = require("./external-file.cjs");
const { ProgramRuns, describe: describeProgram } = require("./program-runs.cjs");
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
const openingPaths = new Set();
const activeDestinations = new Set();
const testMode = process.env.MINIZIP_TEST_MODE === "1";
let engine;
let edits;
let programs;
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
  const key = current?.archive.path.toLowerCase() || id;
  if (sessionOwners.get(id)?.openingEntry || openingPaths.has(key) || activeArchives.has(key)) throw new ArchiveError("BUSY", "当前文件仍有任务进行中，请完成或取消后再操作。");
}
function send(channel, payload, target) {
  const owner = target || (channel === "archive" ? sessionOwners.get(payload.id) : ["task", "edits", "program"].includes(channel) ? sessionOwners.get(payload.archiveId) : null);
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

function startTask(current, kind, destination, operation, programToken = null) {
  assertIdle(current.archive.id);
  const lockKey = current.archive.path?.toLowerCase() || current.archive.id;
  const run = programs?.forPath(lockKey);
  if (run && ["delete", "rename", "update", "compress"].includes(kind) && run.token !== programToken) throw new ArchiveError("PROGRAM_OPEN", "此压缩包有未结束的程序运行会话，请先处理运行结果。");
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
      const parentId = sessionOwners.get(current.archive.id)?.parentArchiveId;
      if (parentId && result?.backupPath) await edits.trackNestedBackup(parentId, current, result.backupPath).catch(() => {});
      if (result?.session) { await engine.close(current); sessions.set(current.archive.id, result.session); edits.setSession(result.session); send("archive", result.session.archive); }
      updateTask(task, { status: "completed", progress: 100, phase: "completed", canCancel: false, result: result?.session ? { backupPath: result.backupPath, deleted: result.deleted, updated: result.updated, renamedTo: result.renamedTo } : result, finishedAt: Date.now() });
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
    if (programs.forPath(current.archive.path)) throw new ArchiveError("PROGRAM_OPEN", "请先处理程序运行结果。");
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
    if (edits.touches(current.archive.path, selection)) throw new ArchiveError("EXTERNAL_OPEN", "所选文件仍有外部临时副本，请先结束编辑并处理修改。");
    const selected = engine.selected(current, selection);
    const choice = await dialog.showMessageBox(view.window, { type: "warning", title: current.archive.folder ? "移到回收站" : "删除压缩包内文件", message: `确认${current.archive.folder ? "移到回收站" : "删除"}所选 ${selection.length} 个项目？`, detail: `${current.archive.path}\n\n${selection.slice(0, 8).join("\n")}\n\n${current.archive.folder ? "文件将移至系统回收站。" : "原压缩包会在同目录保留 .minizip-backup 备份。"}`, buttons: ["取消", current.archive.folder ? "移到回收站" : "删除并保留备份"], defaultId: 0, cancelId: 0, noLink: true });
    if (choice.response !== 1) return null;
    if (!current.archive.folder) return startTask(current, "delete", null, (options) => {
      if (edits.touches(current.archive.path, selection)) throw new ArchiveError("EXTERNAL_OPEN", "所选文件还有外部临时副本。");
      return engine.deleteEntries(current, selection, options);
    });
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
  handle("rename", ({ archiveId, entryId, name }, view) => {
    const current = getSession(archiveId, view);
    if (!current.archive.canRename) throw new ArchiveError("READ_ONLY", "此位置不支持包内重命名。");
    if (edits.touches(current.archive.path, [entryId])) throw new ArchiveError("EXTERNAL_OPEN", "请先结束该项目的外部编辑并处理修改。");
    engine.renameTarget(current, entryId, name);
    return startTask(current, "rename", null, options => engine.renameEntry(current, entryId, name, options));
  });
  handle("preview", async ({ archiveId, entryId }, view) => {
    const current = getSession(archiveId, view);
    assertIdle(archiveId);
    if (current.archive.folder) throw new ArchiveError("NO_PREVIEW", "本地文件通过原始路径打开。");
    view.openingEntry = true;
    try { return await engine.preview(current, entryId); } finally { view.openingEntry = false; }
  });
  handle("openEntry", async ({ archiveId, entryId }, view) => {
    const current = getSession(archiveId, view);
    assertIdle(archiveId);
    const item = current.flat.find((entry) => entry.path === entryId && !entry.folder);
    if (!item) throw new ArchiveError("INVALID_SELECTION", "请选择当前压缩包中的文件。");
    if (view.openingEntry) throw new ArchiveError("BUSY", "正在打开文件，请稍候。");
    if (programs.forPath(current.archive.path)) throw new ArchiveError("PROGRAM_OPEN", "此压缩包已有程序运行目录，请先结束运行并处理改动。");
    const plan = !current.archive.folder && /\.exe$/i.test(entryId) ? describeProgram(current, entryId) : null;
    if (plan && edits.usesArchive(current.archive.path)) throw new ArchiveError("EXTERNAL_OPEN", "请先在工作台结束此外部编辑或关闭嵌套工作台，再运行程序。");
    view.openingEntry = true;
    const key = current.archive.path.toLowerCase(); openingPaths.add(key);
    try {
      const executable = isExecutable(entryId);
      if (executable) {
        const scope = plan ? `\n\n临时展开：${plan.scope || "压缩包根目录（整个包）"}\n${plan.files.length} 个文件 · ${Core.formatBytes(plan.bytes)}。退出后有数据变化时，将询问是否更新压缩包。` : "";
        const answer = await dialog.showMessageBox(view.window, { type: "warning", title: "运行程序", message: `运行 ${path.basename(entryId)}？`, detail: "程序将以当前用户身份运行。请只运行来源可信的程序。" + scope, buttons: ["取消", "确认运行"], defaultId: 0, cancelId: 0, noLink: true });
        if (answer.response !== 1) return { cancelled: true };
      }
      if (current.archive.encrypted && !view.approvedDecryption) {
        const answer = await dialog.showMessageBox(view.window, { type: "warning", title: "在外部应用打开加密文件", message: "将文件解密到本机工作副本后打开？", detail: "外部应用需要未加密的临时文件。为避免丢失外部修改，工作副本可能在关闭 MiniZip 后保留。", buttons: ["取消", "解密并打开"], defaultId: 0, cancelId: 0, noLink: true });
        if (answer.response !== 1) return { cancelled: true };
        view.approvedDecryption = true;
      }
      if (plan) return await programs.launch(current, entryId);
      let filePath, lease;
      if (current.archive.folder) {
        filePath = path.join(current.archive.path, ...normalizeEntryPath(entryId).split("/"));
        assertInside(current.archive.path, filePath); await rejectLinks(filePath);
        if (!(await fs.lstat(filePath)).isFile()) throw new ArchiveError("INVALID_FILE", "文件已不存在。");
      } else {
        lease = await edits.acquire(current, entryId, Core.isArchive(entryId) ? "nested" : "external");
        filePath = lease.filePath;
      }
      try {
        if (Core.isArchive(entryId)) {
          await createWindow(filePath, "open", lease ? archiveId : null, lease?.finish);
          return { nested: true };
        }
        if (lease) await ExternalFile.open(filePath, lease.finish);
        else if (await shell.openPath(filePath)) throw new ArchiveError("OPEN_FAILED", "无法调用此类型的默认应用，请检查 Windows 打开方式。");
      } catch (error) { await lease?.finish(); throw error; }
      return { opened: true };
    } finally { view.openingEntry = false; openingPaths.delete(key); }
  });
  handle("programAction", async ({ archiveId, token, revision, action }, view) => {
    const current = getSession(archiveId, view), run = programs.get(archiveId);
    if (!run || run.token !== token) throw new ArchiveError("SESSION_EXPIRED", "程序运行会话已结束。");
    if (action === "reveal" && run.dir) { await rejectLinks(run.dir); shell.showItemInFolder(run.contentRemoved ? run.dir : run.content); return null; }
    assertIdle(archiveId);
    if (action === "save") return saveProgram(current, token, revision);
    if (action === "discard") { await programs.decide(archiveId, token, revision, false); return null; }
    if (action === "retry" && run.phase === "cleanup-error") { await programs.cleanup(run); return null; }
    if (action === "retry" && run.phase === "scan-error") { await programs.finish(run); return null; }
    if (action === "finish" && run.phase === "untracked") {
      const answer = await dialog.showMessageBox(view.window, { type: "question", message: "程序和它启动的其他窗口都已关闭？", detail: "确认后会检查这次运行的文件变化。", buttons: ["仍在运行", "均已退出"], defaultId: 0, cancelId: 0, noLink: true });
      if (answer.response === 1 && run.phase === "untracked") await programs.finish(run);
      return null;
    }
    throw new ArchiveError("BUSY", "程序运行状态已变化，请查看最新提示。");
  });
  handle("editState", async ({ archiveId }, view) => { getSession(archiveId, view); return edits.scan(archiveId, true); });
  handle("finishEdits", async ({ archiveId, entryId }, view) => {
    getSession(archiveId, view); assertIdle(archiveId);
    if (!edits.snapshot(archiveId).copies.some(c => c.id === entryId && !c.nested)) throw new ArchiveError("INVALID_SELECTION", "当前没有这个外部编辑会话。");
    const choice = await dialog.showMessageBox(view.window, { type: "question", title: "结束外部编辑", message: "已在外部应用中关闭这个文件？", detail: `${entryId}\n未修改的临时文件将清理；有改动会先保留，等你决定是否更新压缩包。`, buttons: ["继续编辑", "已关闭文件"], defaultId: 0, cancelId: 0, noLink: true });
    if (choice.response === 1) return edits.finish(archiveId, [entryId]);
    return edits.snapshot(archiveId);
  });
  handle("discardEdits", async ({ archiveId }, view) => {
    getSession(archiveId, view); assertIdle(archiveId);
    await edits.scan(archiveId, true);
    const candidates = edits.discardCandidates(archiveId);
    if (!candidates.length) throw new ArchiveError("BUSY", "请先关闭文件并结束外部编辑。");
    const choice = await dialog.showMessageBox(view.window, { type: "warning", title: "不更新压缩包", message: `放弃这 ${candidates.length} 个已结束编辑的临时文件的修改？`, detail: candidates.map(([id]) => id).slice(0, 12).join("\n"), buttons: ["取消", "放弃修改并清理"], defaultId: 0, cancelId: 0, noLink: true });
    if (choice.response === 1) await edits.discard(archiveId, candidates);
    return edits.snapshot(archiveId);
  });
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
    for (const directory of [edits.directory, programs.directory, path.join(app.getPath("userData"), "work-files")]) {
      await rejectLinks(directory);
      try { if (!(await fs.readdir(directory)).length) continue; } catch (error) { if (error.code === "ENOENT") continue; throw error; }
      if (await shell.openPath(directory)) throw new ArchiveError("OPEN_FAILED", "无法打开临时文件目录。");
      return true;
    }
    return false;
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
    if (programs.runs.size) throw new ArchiveError("PROGRAM_OPEN", "请先关闭包内程序并处理运行结果，再安装更新。");
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
    const sourceKind = summary.sources.length > 1 ? "multiple" : entries[0]?.folder ? "folder" : Core.isArchive(summary.name) ? "archive" : "file";
    return { ...summary, sourceKind, format: current.format || "zip", level: current.format === "7z" ? "maximum" : "normal", version: releaseConfig.displayVersion };
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

function saveProgram(current, token, revision) {
  const id = current.archive.id;
  programs.reviewed(id, token, revision);
  return startTask(current, "update", null, options => programs.decide(id, token, revision, true, options), token);
}
async function resolveProgram(view) {
  const id = view.archiveId, run = programs.get(id);
  if (!run) return true;
  if (run.phase === "review") {
    const { token, revision, changes, writable } = programs.state(id);
    const buttons = writable ? ["返回工作台", "更新后关闭", "不更新并关闭"] : ["返回工作台", "不更新并关闭"];
    const answer = await dialog.showMessageBox(view.window, { type: "question", title: "程序已退出", message: `${changes.length} 个文件有变化，是否更新压缩包？`, detail: "不更新会放弃本次运行的改动，并清理临时目录。", buttons, defaultId: 0, cancelId: 0, noLink: true });
    if (!answer.response) return false;
    if (writable && answer.response === 1) {
      const task = saveProgram(getSession(id, view), token, revision); await tasks.get(task.id).promise;
      return tasks.get(task.id).status === "completed" && !programs.get(id);
    }
    await programs.decide(id, token, revision, false); return !programs.get(id);
  }
  if (["scan-error", "cleanup-error"].includes(run.phase)) {
    const answer = await dialog.showMessageBox(view.window, { type: "warning", message: "临时目录中还有未处理的文件。", detail: `${run.error}\n${run.dir}`, buttons: ["返回工作台", "保留临时目录并关闭"], defaultId: 0, cancelId: 0, noLink: true });
    if (answer.response === 1 && programs.get(id) === run && ["scan-error", "cleanup-error"].includes(run.phase)) { programs.drop(run); return true; }
    return false;
  }
  await dialog.showMessageBox(view.window, { type: "info", message: ["running", "untracked"].includes(run.phase) ? "请先退出包内程序，再处理运行结果。" : "正在处理程序临时目录，请稍候。", buttons: ["返回工作台"] }); return false;
}
async function resolveEdits(view) {
  if (!view.archiveId) return true;
  if (!await resolveProgram(view)) return false;
  if ([...workbenches.values()].some((current) => current.parentArchiveId === view.archiveId)) {
    await dialog.showMessageBox(view.window, { type: "info", title: "嵌套压缩包仍在打开", message: "请先关闭此压缩包中的嵌套工作台。", detail: "内层压缩包保存后，外层工作台会提示将修改写回原包。" });
    return false;
  }
  const changed = await edits.scan(view.archiveId, true);
  view.finishedCopies = false;
  if (!changed.count && !changed.copies.length) return true;
  if (!changed.count) {
    const choice = await dialog.showMessageBox(view.window, { type: "question", title: "关闭外部编辑", message: "外部应用中的文件都已关闭吗？", detail: "确认后清理未改动的临时文件。若仍在外部编辑，请返回工作台，或选择保留副本。", buttons: ["返回工作台", "已关闭文件，清理并关闭", "保留副本并关闭"], defaultId: 0, cancelId: 0, noLink: true });
    view.finishedCopies = choice.response === 1;
    return choice.response !== 0;
  }
  const choice = await dialog.showMessageBox(view.window, { type: "warning", title: "有尚未保存的修改", message: `${changed.count} 个文件已在外部应用中修改。`, detail: `请先在外部应用中保存并关闭文件。${changed.canUpdate ? "写回成功后清理已保存的临时文件，并保留原包备份。" : "此格式不支持写回，可另存修改后的文件。"}\n保留副本的位置：\n${edits.location(view.archiveId)}`, buttons: ["返回工作台", changed.canUpdate ? "已结束编辑，保存后关闭" : "另存副本后关闭", "保留副本并关闭"], defaultId: 0, cancelId: 0, noLink: true });
  if (choice.response === 0) return false;
  if (choice.response === 1) {
    if (changed.canUpdate) {
      const current = getSession(view.archiveId, view);
      const task = startTask(current, "update", null, (options) => edits.save(current, options));
      await tasks.get(task.id).promise;
      if (tasks.get(task.id).status !== "completed") return false;
      view.finishedCopies = true;
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
    await edits.close(view.archiveId, { finished: view.finishedCopies });
    if (current && !current.archive.folder) await engine.close(current);
    sessions.delete(view.archiveId); sessionOwners.delete(view.archiveId);
    view.archiveId = null;
  }
  if (view.finishParent) { const finish = view.finishParent; view.finishParent = null; view.parentArchiveId = null; await finish(); }
  view.approvedDecryption = false; view.finishedCopies = false;
  view.allowedDestinations.clear();
  if (!view.window.isDestroyed()) view.window.setTitle("MiniZip");
}
async function createWindow(initialPath = null, launchMode = "open", parentArchiveId = null, finishParent = null) {
  const window = new BrowserWindow({ width: 1320, height: 870, minWidth: 780, minHeight: 620, title: "MiniZip", icon: path.resolve(__dirname, "../assets/minizip.ico"), backgroundColor: "#eef6f7", show: !testMode, autoHideMenuBar: true, webPreferences: { preload: path.join(__dirname, "preload.cjs"), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, navigateOnDragDrop: false, backgroundThrottling: !testMode, devTools: !app.isPackaged } });
  const view = { window, ready: false, archiveId: null, allowedDestinations: new Set(), initialPath, launchMode, parentArchiveId, finishParent, closing: false, opening: false, openingEntry: false };
  const contentsId = window.webContents.id;
  workbenches.set(contentsId, view);
  Menu.setApplicationMenu(null);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => { if (url !== entryUrl) event.preventDefault(); });
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.webContents.on("will-frame-navigate", event => {
    if (!event.isMainFrame && !event.url.startsWith("blob:file:///") && !event.url.startsWith("chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/")) event.preventDefault();
  });
  window.webContents.on("did-start-navigation", event => { if (event.isMainFrame) view.ready = false; });
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
  window.on("closed", () => {
    workbenches.delete(contentsId);
    // A destroyed renderer can bypass the cancellable BrowserWindow close event.
    // Detach, preserve unresolved external edits and release the nested file lease.
    if (view.archiveId || view.finishParent) { view.finishedCopies = false; releaseWorkbench(view).catch(() => {}); }
  });
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
    nativeTheme.themeSource = "light";
    const cacheRoot = path.join(app.getPath("temp"), "MiniZip", randomUUID());
    engine = new ArchiveEngine({ cacheRoot });
    const tempRoot = testMode ? app.getPath("userData") : app.getPath("temp");
    programs = new ProgramRuns(engine, path.join(tempRoot, "MiniZip-runs"), value => send("program", value));
    edits = new EditSessions(engine, path.join(tempRoot, "MiniZip-edits"), (value) => send("edits", value));
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
  app.on("will-quit", () => { edits?.dispose(); ExternalFile.dispose(); });
}
