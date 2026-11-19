"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");
const { constants } = require("node:fs");
const { ArchiveError, normalizeEntryPath, assertInside, rejectLinks, fingerprint, sameFingerprint, hashFile, safeRemoveOwned } = require("./archive-engine.cjs");
const ExternalFile = require("./external-file.cjs");

const EXECUTABLE_EXTENSIONS = new Set(["exe", "com", "scr", "msi", "msp", "bat", "cmd", "ps1", "psm1", "vbs", "vbe", "js", "jse", "wsf", "wsh", "hta", "lnk", "url", "reg", "cpl", "msc", "jar", "application", "appref-ms", "gadget", "appx", "msix"]);
function isExecutable(name) { return EXECUTABLE_EXTENSIONS.has(path.extname(name).slice(1).toLowerCase()); }

async function readZone(source) {
  if (process.platform !== "win32") return;
  let zone;
  try {
    const handle = await fs.open(source + ":Zone.Identifier", "r");
    try {
      const buffer = Buffer.alloc(4096);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      zone = /^ZoneId=(\d+)\s*$/im.exec(buffer.subarray(0, bytesRead).toString("utf8"))?.[1];
    } finally { await handle.close(); }
  } catch (error) { if (["ENOENT", "ENOTSUP", "EINVAL"].includes(error.code)) return; throw error; }
  return zone && Number(zone) >= 3 ? "[ZoneTransfer]\r\nZoneId=" + Math.min(4, Number(zone)) + "\r\n" : null;
}
async function applyZone(zone, target) { if (zone) await fs.writeFile(target + ":Zone.Identifier", zone, "utf8"); }
async function inheritZone(source, target) { await applyZone(await readZone(source), target); }

class EditSessions {
  constructor(engine, directory, onChange = () => {}) {
    this.engine = engine;
    this.directory = directory;
    this.onChange = onChange;
    this.groups = new Map();
    this.preparing = new Set();
    this.timer = setInterval(() => { for (const group of this.groups.values()) this.maintain(group).catch(() => {}); }, 1000);
    this.timer.unref();
  }
  snapshot(archiveId) {
    const group = this.groups.get(archiveId);
    const entries = group ? [...group.entries.values()].filter((entry) => entry.changed).map((entry) => ({ entryId: entry.entryId, name: path.basename(entry.entryId), missing: entry.missing, error: entry.error || null })) : [];
    const copies = group ? [...group.entries.values()].map(entry => ({ id: entry.entryId, ended: entry.ended, nested: [...entry.leases.values()].includes("nested") })) : [];
    return { archiveId, entries, count: entries.length, copies, canUpdate: Boolean(group?.session.archive.canUpdate), busy: Boolean(group?.busy) };
  }
  emit(group) { this.onChange(this.snapshot(group.session.archive.id)); }
  async prepare(session, entryId, lease = null) {
    const id = session.archive.id;
    if (this.preparing.has(id)) throw new ArchiveError("BUSY", "正在准备临时文件，请稍候。");
    this.preparing.add(id);
    try { return await this.prepareOne(session, entryId, lease); } finally { this.preparing.delete(id); }
  }
  async prepareOne(session, entryId, lease) {
    entryId = normalizeEntryPath(entryId);
    const item = session.flat.find((entry) => entry.path === entryId && !entry.folder);
    if (!item) throw new ArchiveError("INVALID_SELECTION", "文件不在当前压缩包中。");
    await this.engine.assertUnchanged(session);
    let group = this.groups.get(session.archive.id);
    if (!group) {
      await rejectLinks(this.directory);
      await fs.mkdir(this.directory, { recursive: true });
      const directory = await fs.mkdtemp(path.join(this.directory, "opened-"));
      group = { session, directory, entries: new Map(), busy: false, scanning: null };
      this.groups.set(session.archive.id, group);
      const info = JSON.stringify({ archive: session.archive.path, openedAt: new Date().toISOString(), note: "Files opened by MiniZip. Keep modified copies until changes have been saved." }, null, 2);
      await fs.writeFile(path.join(directory, "origin.json"), info, { flag: "wx" });
      group.originHash = createHash("sha256").update(info).digest("hex");
    }
    if (group.busy) throw new ArchiveError("BUSY", "正在处理临时文件，请稍候。");
    group.busy = true;
    try {
      await group.scanning;
      const existing = group.entries.get(entryId);
      if (existing) {
        await rejectLinks(existing.filePath); await fingerprint(existing.filePath);
        if ((await fs.lstat(existing.filePath)).nlink !== 1) throw new ArchiveError("UNSAFE_LINK", "不能打开已替换为链接的临时文件。");
        if (lease) { existing.leases.set(lease.token, lease.kind); existing.ended = false; }
        return existing.filePath;
      }
      const content = path.join(group.directory, "files");
      const filePath = path.join(content, ...entryId.split("/"));
      assertInside(content, filePath);
      const result = await this.engine.extract(session, content, { selection: [entryId], policy: "skip" });
      if (result.files !== 1 || result.skipped) throw new ArchiveError("PATH_CONFLICT", "临时目录存在其他应用创建的同名文件，未打开或覆盖它。");
      await rejectLinks(filePath);
      await inheritZone(session.archive.path, filePath);
      const identity = await fingerprint(filePath);
      const hash = await hashFile(filePath);
      if (!sameFingerprint(identity, await fingerprint(filePath))) throw new ArchiveError("SOURCE_CHANGED", "临时文件在打开前已被修改。");
      group.entries.set(entryId, { entryId, filePath, baselineHash: hash, currentHash: hash, identity, changed: false, missing: false, pendingIdentity: null, leases: new Map(lease ? [[lease.token, lease.kind]] : []), backups: new Map(), ended: false });
      return filePath;
    } catch (error) {
      if (!group.entries.size) {
        await fs.rmdir(path.join(group.directory, "files")).catch(() => {});
        await this.pruneGroup(group).catch(() => {});
      }
      throw error;
    } finally { group.busy = false; this.emit(group); }
  }
  async acquire(session, entryId, kind = "external") {
    const token = randomUUID();
    const filePath = await this.prepare(session, entryId, { token, kind });
    return { filePath, finish: () => this.finish(session.archive.id, [entryId], token) };
  }
  async trackNestedBackup(parentId, source, backup) {
    const group = this.groups.get(parentId);
    const entry = group && [...group.entries.values()].find(x => x.filePath === source.archive.path && [...x.leases.values()].includes("nested"));
    if (!entry || path.dirname(backup) !== path.dirname(entry.filePath) || !backup.startsWith(entry.filePath + ".minizip-backup-")) return;
    assertInside(group.directory, backup); await rejectLinks(backup);
    const before = await fingerprint(backup);
    if (before.ino !== source.identity.ino || before.mtimeMs !== source.identity.mtimeMs || before.size !== source.identity.size) return;
    const hash = await hashFile(backup);
    if (sameFingerprint(before, await fingerprint(backup))) entry.backups.set(backup, hash);
  }
  touches(archivePath, selection) {
    for (const group of this.groups.values()) if (group.session.archive.path.toLowerCase() === archivePath.toLowerCase()) {
      for (const id of group.entries.keys()) if (selection.some(parent => id === parent || id.startsWith(parent + "/"))) return true;
    }
    return false;
  }
  usesArchive(archivePath) { return [...this.groups.values()].some(group => group.session.archive.path.toLowerCase() === archivePath.toLowerCase()); }
  async finish(id, ids, token) {
    const group = this.groups.get(id);
    if (!group) return this.snapshot(id);
    for (const name of ids) {
      const entry = group.entries.get(name);
      if (!entry) continue;
      if (token) { if (!entry.leases.delete(token)) continue; }
      else {
        if ([...entry.leases.values()].includes("nested")) throw new ArchiveError("BUSY", "请先关闭嵌套工作台。");
        entry.leases.clear();
      }
      entry.ended = !entry.leases.size;
    }
    await this.maintain(group, true);
    this.emit(group);
    return this.snapshot(id);
  }
  async removeCopy(group, entry, expectedHash) {
    assertInside(group.directory, entry.filePath);
    if (!(await ExternalFile.removeVerified(entry.filePath, expectedHash))) return false;
    group.entries.delete(entry.entryId);
    for (const [backup, hash] of entry.backups) await ExternalFile.removeVerified(backup, hash).catch(() => false);
    // Remove only empty parents of this known file. Never recurse into editor sidecars.
    for (let dir = path.dirname(entry.filePath); dir !== group.directory; dir = path.dirname(dir)) {
      assertInside(group.directory, dir); await rejectLinks(dir);
      try { await fs.rmdir(dir); } catch { break; }
    }
    return true;
  }
  async pruneGroup(group) {
    if (group.entries.size || this.groups.get(group.session.archive.id) !== group) return;
    await rejectLinks(group.directory);
    const names = await fs.readdir(group.directory);
    if (names.length === 1 && names[0] === "origin.json" && await ExternalFile.removeVerified(path.join(group.directory, "origin.json"), group.originHash)) {
      await fs.rmdir(group.directory).catch(() => {});
      await fs.rmdir(this.directory).catch(() => {});
    }
    this.groups.delete(group.session.archive.id);
  }
  async maintain(group, force = false) {
    if (group.busy || this.preparing.has(group.session.archive.id) || this.groups.get(group.session.archive.id) !== group) return;
    await this.scan(group.session.archive.id, force);
    if (group.busy || this.preparing.has(group.session.archive.id) || this.groups.get(group.session.archive.id) !== group || ![...group.entries.values()].some(x => x.ended && !x.changed && (force || Date.now() >= (x.retryAt || 0)))) return;
    group.busy = true;
    try {
      for (const entry of group.entries.values()) if (entry.ended && !entry.changed && (force || Date.now() >= (entry.retryAt || 0))) {
        entry.retryAt = Date.now() + 10000;
        await this.removeCopy(group, entry, entry.baselineHash).catch(() => false);
      }
      await this.pruneGroup(group).catch(() => {});
    } finally { group.busy = false; this.emit(group); }
  }
  async discard(id, expected) {
    const group = this.groups.get(id);
    if (!group || group.busy) throw new ArchiveError("BUSY", "临时文件正在使用中。");
    group.busy = true;
    try {
      await group.scanning;
      for (const [name, hash] of expected) {
        const entry = group.entries.get(name);
        if (!entry?.ended || !await this.removeCopy(group, entry, hash)) throw new ArchiveError("SOURCE_CHANGED", "临时文件已变化或仍被占用，已保留，请重新检查。");
      }
      await this.pruneGroup(group);
    } finally { group.busy = false; this.emit(group); }
  }
  discardCandidates(id) { return [...(this.groups.get(id)?.entries.values() || [])].filter(e => e.ended && e.changed && !e.missing).map(e => [e.entryId, e.currentHash]); }
  async scan(archiveId, force = false) {
    const group = this.groups.get(archiveId);
    if (!group || group.busy) return this.snapshot(archiveId);
    if (group.scanning) { await group.scanning; if (!force) return this.snapshot(archiveId); }
    const scan = async () => {
      let changed = false;
      for (const entry of group.entries.values()) {
        try {
          const stat = await fs.lstat(entry.filePath);
          if (stat.nlink !== 1 || !stat.isFile() || stat.isSymbolicLink()) throw new ArchiveError("UNSAFE_LINK", "修改副本被替换为链接，不能写回。");
          const { ino, size, mtimeMs, ctimeMs } = stat, identity = { ino, size, mtimeMs, ctimeMs };
          if (!force && !entry.missing && sameFingerprint(identity, entry.identity)) continue;
          if (!force && (!entry.pendingIdentity || !sameFingerprint(identity, entry.pendingIdentity))) { entry.pendingIdentity = identity; continue; }
          await rejectLinks(entry.filePath);
          const hash = await hashFile(entry.filePath);
          if (!sameFingerprint(identity, await fingerprint(entry.filePath))) continue;
          const wasChanged = entry.changed;
          entry.currentHash = hash; entry.identity = identity; entry.pendingIdentity = null;
          entry.changed = hash !== entry.baselineHash;
          changed ||= wasChanged !== entry.changed || entry.missing || Boolean(entry.error);
          entry.missing = false; entry.error = null;
        } catch (error) {
          changed ||= !entry.missing;
          entry.missing = true; entry.changed = true;
          entry.error = error.code === "ENOENT" ? "外部副本已被移走或删除" : "外部副本不可读取";
        }
      }
      if (changed) this.emit(group);
    };
    group.scanning = scan();
    try { await group.scanning; } finally { group.scanning = null; }
    return this.snapshot(archiveId);
  }
  async save(session, options = {}) {
    const group = this.groups.get(session.archive.id);
    if (!group) throw new ArchiveError("NO_CHANGES", "没有待保存的修改。");
    if (group.busy) throw new ArchiveError("BUSY", "正在处理外部文件，请稍候。");
    await this.scan(session.archive.id, true);
    if (group.busy) throw new ArchiveError("BUSY", "临时文件正在清理，请稍候。");
    const changed = [...group.entries.values()].filter((entry) => entry.changed);
    if (!changed.length) throw new ArchiveError("NO_CHANGES", "没有待保存的修改。");
    if (changed.some((entry) => entry.missing)) throw new ArchiveError("EDIT_MISSING", "部分修改副本不可读取，请先在外部应用中恢复文件。");
    const replacements = changed.map((entry) => ({ entryId: entry.entryId, sourcePath: entry.filePath, expectedHash: entry.currentHash }));
    group.busy = true; this.emit(group);
    try {
      const result = await this.engine.updateEntries(session, replacements, options);
      group.session = result.session;
      for (const value of replacements) {
        const entry = group.entries.get(value.entryId);
        entry.baselineHash = value.expectedHash; entry.changed = false;
      }
      return result;
    } finally { group.busy = false; await this.maintain(group, true); this.emit(group); }
  }
  setSession(session) { const group = this.groups.get(session.archive.id); if (group) group.session = session; }
  location(archiveId) { return this.groups.get(archiveId)?.directory || null; }
  async exportChanges(archiveId, destination) {
    await this.scan(archiveId, true);
    const group = this.groups.get(archiveId);
    if (group?.busy) throw new ArchiveError("BUSY", "正在处理外部文件，请稍候。");
    const entries = group ? [...group.entries.values()].filter((entry) => entry.changed && !entry.missing) : [];
    if (!entries.length) throw new ArchiveError("NO_CHANGES", "没有可另存的修改文件。");
    await rejectLinks(destination);
    const folder = path.join(destination, "MiniZip-修改副本-" + randomUUID().slice(0, 8));
    await fs.mkdir(folder);
    try {
      for (const entry of entries) {
        await rejectLinks(entry.filePath);
        const target = path.join(folder, ...entry.entryId.split("/"));
        assertInside(folder, target);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.copyFile(entry.filePath, target, constants.COPYFILE_EXCL);
        await inheritZone(entry.filePath, target);
        if (await hashFile(target) !== entry.currentHash || !sameFingerprint(entry.identity, await fingerprint(entry.filePath))) throw new ArchiveError("SOURCE_CHANGED", "文件仍在外部应用保存中，请稍后重新另存。");
      }
    } catch (error) { await safeRemoveOwned(destination, folder); throw error; }
    return folder;
  }
  async close(archiveId, { finished = false } = {}) {
    const group = this.groups.get(archiveId);
    if (!group) return;
    if (finished) {
      const after = await this.finish(archiveId, [...group.entries.keys()]);
      if (after.count) throw new ArchiveError("UNSAVED_EDITS", "文件在关闭期间又发生了变化或仍被占用，临时副本已保留，请再检查一次。");
      if (after.copies.length) throw new ArchiveError("FILE_BUSY", "临时文件尚未释放。请稍后重试，或选择保留副本并关闭。");
    }
    this.groups.delete(archiveId);
  }
  dispose() { clearInterval(this.timer); this.groups.clear(); }
}

module.exports = { EditSessions, isExecutable, readZone, applyZone };
