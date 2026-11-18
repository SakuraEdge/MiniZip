"use strict";

const fs = require("node:fs/promises");
const { createReadStream } = require("node:fs");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const path = require("node:path");
const zip = require("@zip.js/zip.js");
const { ArchiveError, normalizeEntryPath, rejectLinks, safeRemoveOwned, fingerprint, sameFingerprint } = require("./archive-engine.cjs");

function fail(code, message) { throw new ArchiveError(code, message); }
async function exists(target) { try { return await fs.lstat(target); } catch (error) { if (error.code === "ENOENT") return null; throw error; } }
function within(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
}
async function scanInputs(inputPaths, options = {}) {
  if (!Array.isArray(inputPaths) || !inputPaths.length || inputPaths.length > 1000) fail("INPUT", "请选择 1 至 1000 个文件或文件夹。");
  const sources = [...new Set(inputPaths.map((item) => {
    if (typeof item !== "string" || !path.isAbsolute(item)) fail("INPUT", "输入路径无效。");
    return path.resolve(item);
  }))].filter((item, _index, all) => !all.some((other) => other !== item && within(other, item)));
  const entries = [], names = new Set();
  let files = 0, folders = 0, size = 0;
  const visit = async (absolute, entryName, depth) => {
    if (options.signal?.aborted) fail("CANCELLED", "已取消压缩。");
    if (depth > 64 || entries.length >= 100000) fail("LIMIT", "文件数量或目录层级超过当前安全上限。");
    await rejectLinks(absolute);
    const stat = await fs.lstat(absolute);
    if (stat.isSymbolicLink() || !stat.isDirectory() && !stat.isFile()) fail("UNSAFE_LINK", "不支持压缩符号链接或特殊文件。");
    const name = normalizeEntryPath(entryName);
    const key = name.toLowerCase();
    if (names.has(key)) fail("DUPLICATE_PATH", "多个输入含同名文件，请分别压缩或重命名后再试。");
    names.add(key);
    const identity = { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, ino: stat.ino };
    entries.push({ absolute, name, folder: stat.isDirectory(), size: stat.isFile() ? stat.size : 0, modified: stat.mtime, identity });
    if (stat.isDirectory()) {
      folders++;
      for (const child of await fs.readdir(absolute)) await visit(path.join(absolute, child), name + "/" + child, depth + 1);
    } else { files++; size += stat.size; }
    if (size > 128 * 1024 ** 3) fail("LIMIT", "输入大小超过当前的 128 GiB 安全上限。");
  };
  for (const source of sources) await visit(source, path.basename(source), 0);
  const singleName = sources.length === 1 ? (entries[0].folder ? path.basename(sources[0]) : path.basename(sources[0], path.extname(sources[0]))) : "压缩文件";
  return { sources, entries, files, folders, size, name: sources.length === 1 ? path.basename(sources[0]) : `${sources.length} 个项目`, defaultName: singleName || "压缩文件", destination: path.dirname(sources[0]) };
}
async function verifyInputs(manifest) {
  for (const entry of manifest.entries) {
    await rejectLinks(entry.absolute);
    const current = await fs.lstat(entry.absolute);
    if (current.isSymbolicLink() || current.isDirectory() !== entry.folder || !sameFingerprint(entry.identity, { size: current.size, mtimeMs: current.mtimeMs, ctimeMs: current.ctimeMs, ino: current.ino })) fail("SOURCE_CHANGED", "输入文件在压缩期间发生变化，已停止提交，请重试。");
  }
}

async function createZip(manifest, temporary, password, level, options) {
  const handle = await fs.open(temporary, "wx");
  let completed = 0;
  const stream = new WritableStream({ async write(chunk) {
    let offset = 0;
    while (offset < chunk.length) { const result = await handle.write(chunk, offset, chunk.length - offset); offset += result.bytesWritten; }
  } });
  const writer = new zip.ZipWriter(stream, { useWebWorkers: false, ...(password ? { password, encryptionStrength: 3 } : {}), level: { fast: 1, normal: 5, maximum: 9 }[level] });
  try {
    for (const entry of manifest.entries) {
      if (options.signal?.aborted) fail("CANCELLED", "已取消压缩。");
      await rejectLinks(entry.absolute);
      if (entry.folder) await writer.add(entry.name + "/", undefined, { directory: true, lastModDate: entry.modified, signal: options.signal });
      else {
        const input = createReadStream(entry.absolute);
        try { await writer.add(entry.name, Readable.toWeb(input), { lastModDate: entry.modified, signal: options.signal, onprogress: (value) => options.onProgress?.(manifest.size ? Math.min(95, Math.floor((completed + value) / manifest.size * 95)) : 0) }); }
        finally { input.destroy(); }
        completed += entry.size;
      }
    }
    await writer.close();
  } catch (error) {
    if (options.signal?.aborted || error.name === "AbortError") fail("CANCELLED", "已取消压缩，未生成输出文件。");
    throw error;
  } finally { await handle.close(); }
}

async function compress(engine, manifest, target, settings = {}, options = {}) {
  if (!path.isAbsolute(target)) fail("DESTINATION", "请选择完整的输出文件路径。");
  target = path.resolve(target);
  const format = settings.format || "zip", level = settings.level || "normal", password = settings.password || "";
  if (!["zip", "7z"].includes(format) || !["fast", "normal", "maximum"].includes(level)) fail("FORMAT", "不支持的压缩格式或级别。");
  if (typeof password !== "string" || password.length > 4096 || /[\r\n\0]/.test(password)) fail("PASSWORD", "密码包含不支持的控制字符或超过长度限制。");
  if (path.extname(target).toLowerCase() !== "." + format) fail("FORMAT", "输出文件扩展名与格式不匹配。");
  normalizeEntryPath(path.basename(target));
  for (const source of manifest.sources) if (within(source, target)) fail("SOURCE_COLLISION", "压缩包不能保存在所选文件夹内部，也不能覆盖输入文件。");
  await rejectLinks(target);
  const parent = path.dirname(target);
  const parentStat = await fs.stat(parent);
  if (!parentStat.isDirectory()) fail("DESTINATION", "保存位置不是有效文件夹。");
  const old = await exists(target);
  if (old && !settings.overwrite) fail("EXISTS", "已存在同名压缩包，请更换名称或确认覆盖。");
  if (old && !old.isFile()) fail("EXISTS", "目标位置存在同名文件夹。");
  const oldIdentity = old ? await fingerprint(target) : null;
  const disk = await fs.statfs(parent);
  if (Number(disk.bavail) * Number(disk.bsize) < manifest.size * 1.05 + 64 * 1024 ** 2) fail("DISK_SPACE", "磁盘空间不足，无法安全创建压缩包。");
  await verifyInputs(manifest);
  const work = await fs.mkdtemp(path.join(parent, ".minizip-compress-"));
  const temporary = path.join(work, "output." + format);
  let backup = null;
  try {
    options.onPhase?.("compressing");
    if (format === "zip") await createZip(manifest, temporary, password, level, options);
    else {
      const commonParent = path.dirname(manifest.sources[0]);
      if (manifest.sources.some((source) => path.dirname(source).toLowerCase() !== commonParent.toLowerCase())) fail("INPUT", "7Z 多选压缩暂需文件位于同一目录，可改选 ZIP。");
      const listFile = path.join(work, "input.txt");
      await fs.writeFile(listFile, manifest.sources.map((source) => path.basename(source)).join("\n") + "\n", "utf8");
      await engine.run(engine.sevenZip, ["a", "-t7z", "-y", "-spd", "-scsUTF-8", "-sccUTF-8", "-bsp1", "-mx=" + { fast: 1, normal: 5, maximum: 9 }[level], ...(password ? ["-p", "-mhe=on"] : []), temporary, "@" + listFile], { ...options, cwd: commonParent, password, input: password ? password + "\n" + password + "\n" : "\n" });
    }
    if (options.signal?.aborted) fail("CANCELLED", "已取消压缩，未生成输出文件。");
    options.onPhase?.("verifying");
    const session = await engine.open(temporary, password, options);
    try {
      await engine.test(session, options);
      const actual = session.flat.filter((entry) => !entry.folder);
      const expected = manifest.entries.filter((entry) => !entry.folder);
      if (actual.length !== expected.length || expected.some((entry) => !actual.some((item) => item.path === entry.name && item.size === entry.size))) fail("VERIFY", "压缩结果与输入清单不一致，未提交输出。");
    } finally { await engine.close(session); }
    await verifyInputs(manifest);
    if (options.signal?.aborted) fail("CANCELLED", "已取消压缩，未生成输出文件。");
    await rejectLinks(target);
    if (oldIdentity && !sameFingerprint(oldIdentity, await fingerprint(target))) fail("DESTINATION_CHANGED", "目标文件已被其他程序修改，已取消覆盖。");
    if (!oldIdentity && await exists(target)) fail("EXISTS", "压缩期间出现了同名文件，未覆盖。");
    options.onPhase?.("committing");
    if (oldIdentity) { backup = target + ".minizip-backup-" + Date.now(); await fs.rename(target, backup); }
    try {
      try { await fs.link(temporary, target); }
      catch (error) {
        if (error.code === "EEXIST") throw error;
        const output = await fs.open(target, "wx");
        try { await pipeline(createReadStream(temporary), output.createWriteStream()); }
        catch (copyError) { await output.close().catch(() => {}); await fs.unlink(target).catch(() => {}); throw copyError; }
      }
    } catch (error) {
      if (backup) {
        if (await exists(target)) fail("RECOVERY_REQUIRED", "目标被其他程序占用，原压缩包备份保留在：" + backup);
        await fs.rename(backup, target);
      }
      throw error;
    }
    options.onProgress?.(100);
    return { path: target, size: (await fs.stat(target)).size, files: manifest.files, backupPath: backup };
  } finally { await safeRemoveOwned(parent, work); }
}

module.exports = { scanInputs, compress, verifyInputs, within };
