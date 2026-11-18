"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { constants } = require("node:fs");
const { ArchiveError, normalizeEntryPath, assertInside, rejectLinks, fingerprint, sameFingerprint, hashFile, safeRemoveOwned } = require("./archive-engine.cjs");

const EXECUTABLE_EXTENSIONS = new Set(["exe", "com", "scr", "msi", "msp", "bat", "cmd", "ps1", "psm1", "vbs", "vbe", "js", "jse", "wsf", "wsh", "hta", "lnk", "url", "reg", "cpl", "msc", "jar", "application", "appref-ms", "gadget", "appx", "msix"]);
function isExecutable(name) { return EXECUTABLE_EXTENSIONS.has(path.extname(name).slice(1).toLowerCase()); }

async function inheritZone(source, target) {
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
  if (zone && Number(zone) >= 3) await fs.writeFile(target + ":Zone.Identifier", "[ZoneTransfer]\r\nZoneId=" + Math.min(4, Number(zone)) + "\r\n", "utf8");
}

class EditSessions {
  constructor(engine, directory, onChange = () => {}) {
    this.engine = engine;
    this.directory = directory;
    this.onChange = onChange;
    this.groups = new Map();
    this.timer = setInterval(() => { for (const group of this.groups.values()) this.scan(group.session.archive.id).catch(() => {}); }, 1000);
    this.timer.unref();
  }
  snapshot(archiveId) {
    const group = this.groups.get(archiveId);
    const entries = group ? [...group.entries.values()].filter((entry) => entry.changed).map((entry) => ({ entryId: entry.entryId, name: path.basename(entry.entryId), missing: entry.missing, error: entry.error || null })) : [];
    return { archiveId, entries, count: entries.length, canUpdate: Boolean(group?.session.archive.canUpdate), busy: Boolean(group?.busy) };
  }
  emit(group) { this.onChange(this.snapshot(group.session.archive.id)); }
  async prepare(session, entryId, dependencies = false) {
    entryId = normalizeEntryPath(entryId);
    const item = session.flat.find((entry) => entry.path === entryId && !entry.folder);
    if (!item) throw new ArchiveError("INVALID_SELECTION", "文件不在当前压缩包中。");
    await this.engine.assertUnchanged(session);
    let group = this.groups.get(session.archive.id);
    if (!group) {
      await fs.mkdir(this.directory, { recursive: true });
      const directory = await fs.mkdtemp(path.join(this.directory, "opened-"));
      group = { session, directory, entries: new Map(), busy: false, scanning: null };
      this.groups.set(session.archive.id, group);
      await fs.writeFile(path.join(directory, "origin.json"), JSON.stringify({ archive: session.archive.path, openedAt: new Date().toISOString(), note: "Files opened by MiniZip. Keep modified copies until changes have been saved." }, null, 2));
    }
    const existing = group.entries.get(entryId);
    if (existing && !dependencies) {
      await rejectLinks(existing.filePath);
      await fingerprint(existing.filePath);
      return existing.filePath;
    }
    if (group.busy) throw new ArchiveError("BUSY", "正在处理外部文件，请稍候。");
    await group.scanning;
    group.busy = true;
    try {
      const content = path.join(group.directory, "files");
      const parent = path.posix.dirname(entryId);
      const selection = dependencies ? parent === "." ? [] : [parent] : [entryId];
      await this.engine.extract(session, content, { selection, policy: "skip" });
      const extracted = this.engine.selected(session, selection).filter((entry) => !entry.folder);
      for (const entry of extracted) {
        if (group.entries.has(entry.path)) continue;
        const filePath = path.join(content, ...entry.path.split("/"));
        assertInside(content, filePath);
        await rejectLinks(filePath);
        await inheritZone(session.archive.path, filePath);
        const hash = await hashFile(filePath);
        group.entries.set(entry.path, { entryId: entry.path, filePath, baselineHash: hash, currentHash: hash, identity: await fingerprint(filePath), changed: false, missing: false, pendingIdentity: null });
      }
      return group.entries.get(entryId).filePath;
    } finally { group.busy = false; this.emit(group); }
  }
  async scan(archiveId, force = false) {
    const group = this.groups.get(archiveId);
    if (!group || group.busy) return this.snapshot(archiveId);
    if (group.scanning) { await group.scanning; if (!force) return this.snapshot(archiveId); }
    const scan = async () => {
      let changed = false;
      for (const entry of group.entries.values()) {
        try {
          await rejectLinks(entry.filePath);
          const stat = await fs.lstat(entry.filePath);
          if (stat.nlink > 1) throw new ArchiveError("UNSAFE_LINK", "修改副本被替换为链接，不能写回。");
          const identity = await fingerprint(entry.filePath);
          if (!force && !entry.missing && sameFingerprint(identity, entry.identity)) continue;
          if (!force && (!entry.pendingIdentity || !sameFingerprint(identity, entry.pendingIdentity))) { entry.pendingIdentity = identity; continue; }
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
    } finally { group.busy = false; await this.scan(session.archive.id, true); this.emit(group); }
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
  close(archiveId) { this.groups.delete(archiveId); }
  dispose() { clearInterval(this.timer); this.groups.clear(); }
}

module.exports = { EditSessions, isExecutable };
