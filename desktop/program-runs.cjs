"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { ArchiveError, assertInside, normalizeEntryPath, rejectLinks, fingerprint, sameFingerprint, hashFile, safeRemoveOwned } = require("./archive-engine.cjs");
const { readZone, applyZone } = require("./edit-sessions.cjs");
const external = require("./external-file.cjs");

const MAX_ITEMS = 8192, MAX_BYTES = 2 * 1024 ** 3;
const fail = (code, message) => { throw new ArchiveError(code, message); };
const changed = () => fail("SOURCE_CHANGED", "程序目录又发生了变化，请重新检查后再决定。");

function describe(session, entryId) {
  const id = normalizeEntryPath(entryId);
  if (id !== entryId || !/\.exe$/i.test(id) || !session.flat.some(e => !e.folder && e.path === id)) fail("INVALID_SELECTION", "请选择包内的 EXE 程序。");
  const scope = id.includes("/") ? id.slice(0, id.lastIndexOf("/")) : "";
  const members = session.flat.filter(e => !scope || e.path === scope || e.path.startsWith(scope + "/"));
  const files = members.filter(e => !e.folder), bytes = files.reduce((n, e) => n + e.size, 0);
  if (members.length > MAX_ITEMS || bytes > MAX_BYTES || files.some(e => !Number.isSafeInteger(e.size))) fail("LIMIT", "程序目录超过临时运行上限（8,192 项、2 GiB），或大小未知。请先解压到指定目录。");
  return { scope, files, bytes };
}

async function directoryKey(dir) {
  await rejectLinks(dir);
  const s = await fs.lstat(dir, { bigint: true });
  if (!s.isDirectory() || s.isSymbolicLink()) fail("UNSAFE_PATH", "运行目录不再是原始目录。");
  return String(s.dev) + ":" + String(s.ino);
}
async function checkRoot(run) {
  if (await directoryKey(run.dir) !== run.dirKey || await directoryKey(run.content) !== run.contentKey) fail("UNSAFE_PATH", "临时目录已被替换，未写回或清理。");
}

// Enumerate only the owned tree. Never follow links or import files outside the
// program's archive scope. Hashes, not timestamps, decide whether to prompt.
async function walk(run, visit) {
  await checkRoot(run);
  const dirs = [], names = new Set(); let count = 0, bytes = 0;
  async function enter(dir, prefix) {
    await rejectLinks(dir);
    const handle = await fs.opendir(dir);
    for await (const child of handle) {
      const id = normalizeEntryPath(prefix + child.name), key = id.toLowerCase();
      const filePath = path.join(run.content, ...id.split("/"));
      assertInside(run.content, filePath);
      if (names.has(key)) fail("NAME_CONFLICT", "运行目录中存在同名项目，不能自动处理。");
      names.add(key);
      const stat = await fs.lstat(filePath);
      if (++count > MAX_ITEMS) fail("LIMIT", "程序运行后产生的项目过多，已保留临时目录。");
      if (stat.isSymbolicLink() || !(stat.isFile() || stat.isDirectory()) || (stat.isFile() && stat.nlink !== 1)) fail("UNSAFE_LINK", "运行目录包含链接或特殊文件，已保留目录，未自动处理。");
      if (run.scope && id !== run.scope && !id.startsWith(run.scope + "/") && !(stat.isDirectory() && run.scope.startsWith(id + "/"))) fail("OUTSIDE_SCOPE", "程序在所选目录之外写入了文件，已保留临时目录供检查。");
      if (stat.isDirectory()) { await enter(filePath, id + "/"); dirs.push(filePath); }
      else {
        bytes += stat.size;
        if (bytes > MAX_BYTES) fail("LIMIT", "程序数据超过 2 GiB，已保留临时目录。");
        await visit(id, filePath, stat);
      }
    }
  }
  await enter(run.content, "");
  return dirs;
}
async function snapshot(run, initialZone, cache) {
  const result = new Map();
  await walk(run, async (id, filePath, stat) => {
    if (initialZone) await applyZone(initialZone, filePath);
    const before = initialZone ? await fingerprint(filePath) : stat, known = cache?.get(id);
    const hash = known && sameFingerprint(known.identity, before) ? known.hash : await hashFile(filePath);
    if (!sameFingerprint(before, await fingerprint(filePath))) changed();
    result.set(id, { id, hash, identity: before });
  });
  return result;
}
function changes(before, after) {
  const entries = [];
  for (const [id, file] of after) {
    const old = before.get(id);
    if (old?.hash !== file.hash) entries.push({ id, type: old ? "modified" : "added" });
  }
  for (const id of before.keys()) if (!after.has(id)) entries.push({ id, type: "removed" });
  return entries.sort((a, b) => a.id.localeCompare(b.id));
}
const errorText = error => error instanceof ArchiveError ? error.message : "部分文件无法安全读取或清理，临时目录已保留。";

class ProgramRuns {
  constructor(engine, directory, onChange = () => {}) {
    this.engine = engine; this.directory = directory; this.onChange = onChange; this.runs = new Map();
  }
  get(id) { return this.runs.get(id); }
  forPath(p) { return [...this.runs.values()].find(r => r.session.archive.path.toLowerCase() === p.toLowerCase()); }
  state(id) {
    const r = this.get(id);
    return r ? { archiveId: id, token: r.token, revision: r.revision, phase: r.phase, entryId: r.entryId, directory: r.dir, changes: r.changes, error: r.error, writable: !!r.session.archive.canUpdate } : { archiveId: id, phase: "idle" };
  }
  set(run, phase, error = "") { run.phase = phase; run.error = error; this.onChange(this.state(run.id)); }
  drop(run) { if (this.get(run.id) === run) { this.runs.delete(run.id); this.onChange(this.state(run.id)); } }
  async launch(session, entryId) {
    const plan = describe(session, entryId), id = session.archive.id;
    if (this.forPath(session.archive.path)) fail("BUSY", "此压缩包已有运行目录，请先处理完上一次运行。");
    const run = { id, entryId, session, scope: plan.scope, token: randomUUID(), revision: 0, changes: [] };
    this.runs.set(id, run); this.set(run, "preparing");
    try {
      await this.engine.assertUnchanged(session);
      await rejectLinks(this.directory); await fs.mkdir(this.directory, { recursive: true });
      run.dir = await fs.mkdtemp(path.join(this.directory, "run-")); run.dirKey = await directoryKey(run.dir);
      run.content = path.join(run.dir, "files"); await fs.mkdir(run.content); run.contentKey = await directoryKey(run.content);
      const origin = JSON.stringify({ archive: session.archive.path, program: entryId, openedAt: new Date().toISOString() });
      await fs.writeFile(path.join(run.dir, "origin.json"), origin, { flag: "wx" });
      run.originHash = createHash("sha256").update(origin).digest("hex");
      const extracted = await this.engine.extract(session, run.content, { selection: plan.scope ? [plan.scope] : [], policy: "skip" });
      run.before = await snapshot(run, await readZone(session.archive.path));
      if (extracted.skipped || extracted.files !== plan.files.length || run.before.size !== plan.files.length || plan.files.some(e => run.before.get(e.path)?.identity.size !== e.size)) fail("INVALID_LISTING", "程序运行目录与包内清单不一致，未启动。");
      await this.engine.assertUnchanged(session);
    } catch (error) {
      // No external code has been dispatched at this point.
      if (run.dir && await directoryKey(run.dir) === run.dirKey) await safeRemoveOwned(this.directory, run.dir);
      await fs.rmdir(this.directory).catch(() => {}); this.drop(run); throw error;
    }
    this.set(run, "running");
    try {
      await external.open(path.join(run.content, ...entryId.split("/")), () => this.finish(run), { program: true, onUntracked: () => { if (run.phase === "running") this.set(run, "untracked"); } });
    } catch (error) { await this.finish(run); throw error; }
    return { opened: true };
  }
  async finish(run) {
    if (this.get(run.id) !== run || !["running", "untracked", "scan-error", "review"].includes(run.phase)) return;
    this.set(run, "checking");
    try {
      run.after = await snapshot(run);
      run.changes = changes(run.before, run.after); run.revision++;
      if (run.changes.length) this.set(run, "review");
      else await this.cleanup(run);
    } catch (error) { this.set(run, "scan-error", errorText(error)); }
  }
  async validateDecision(run) {
    const now = await snapshot(run, null, run.after);
    if (changes(run.after, now).length) {
      run.after = now; run.changes = changes(run.before, now); run.revision++;
      if (!run.changes.length) await this.cleanup(run);
      changed();
    }
  }
  reviewed(id, token, revision) {
    const run = this.get(id);
    if (!run || run.token !== token || run.phase !== "review" || run.revision !== revision) fail("STALE_DECISION", "运行结果已变化，请检查最新提示。");
    return run;
  }
  async decide(id, token, revision, save, options = {}) {
    const run = this.reviewed(id, token, revision);
    if (save && !run.session.archive.canUpdate) fail("READ_ONLY", "此格式不能写回，可打开临时目录另存数据。");
    this.set(run, save ? "saving" : "checking");
    try {
      await this.validateDecision(run);
      let result;
      if (save) {
        const items = run.changes.map(c => c.type === "removed" ? { entryId: c.id, removed: true } : { entryId: c.id, added: c.type === "added", sourcePath: path.join(run.content, ...c.id.split("/")), expectedHash: run.after.get(c.id).hash });
        result = await this.engine.updateEntries(run.session, items, { ...options, beforeCommit: () => this.validateDecision(run) });
        run.session = result.session;
      }
      // The decision has succeeded. Cleanup failure must never repeat a committed write.
      await this.cleanup(run); return result || { discarded: true };
    } catch (error) {
      if (this.get(id) === run && run.phase !== "cleanup-error") this.set(run, "review", errorText(error));
      throw error;
    }
  }
  async cleanup(run) {
    this.set(run, "cleaning");
    try {
      if (!run.contentRemoved) {
        const files = [];
        const dirs = await walk(run, async id => {
          const approved = run.after.get(id);
          if (!approved) changed();
          files.push({ id, hash: approved.hash });
        });
        if (!(await external.removeBatch(run.content, files))) fail("FILE_BUSY", "文件仍被占用或又被修改。已保留剩余文件，请检查后重试清理。");
        for (const dir of dirs) { await rejectLinks(dir); await fs.rmdir(dir); }
        await checkRoot(run); await fs.rmdir(run.content); run.contentRemoved = true;
      }
      if (await directoryKey(run.dir) !== run.dirKey) fail("UNSAFE_PATH", "临时目录已被替换。");
      if (!run.originRemoved) {
        if (!(await external.removeVerified(path.join(run.dir, "origin.json"), run.originHash))) fail("FILE_BUSY", "运行记录已变化，已保留临时目录。");
        run.originRemoved = true;
      }
      await fs.rmdir(run.dir); await fs.rmdir(this.directory).catch(() => {});
      this.drop(run);
    } catch (error) { this.set(run, "cleanup-error", errorText(error)); }
  }
}

module.exports = { ProgramRuns, describe };
