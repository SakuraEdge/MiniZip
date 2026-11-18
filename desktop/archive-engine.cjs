"use strict";

const fs = require("node:fs/promises");
const { constants, createWriteStream, createReadStream } = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const Core = require("../core.js");
const ZipCompat = require("./zip-compat.cjs");

const MAX_ENTRIES = 100000;
const MAX_BYTES = 128 * 1024 ** 3;
const MAX_LISTING = 64 * 1024 ** 2;
const MUTABLE_TYPES = new Set(["7z", "zip", "tar"]);
const STREAM_TYPES = new Set(["xz", "bzip2", "gzip", "lzma", "lzma86", "zstd", "Z", "Split"]);
const PASSWORD_ERROR = /wrong password|password is incorrect|encrypted archive|can not open encrypted|data error in encrypted/i;

class ArchiveError extends Error {
  constructor(code, message) { super(message); this.name = "ArchiveError"; this.code = code; }
}
function fail(code, message) { throw new ArchiveError(code, message); }
function assertInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) fail("UNSAFE_PATH", "目标路径超出了允许的目录。");
}
function normalizeEntryPath(value) {
  if (typeof value !== "string" || !value || /[\x00-\x1f\x7f]/.test(value)) fail("UNSAFE_PATH", "压缩包含有无法安全处理的文件名。");
  const normalized = value.replace(/\\/g, "/").replace(/\/$/, "");
  if (/^(\/|[a-z]:)/i.test(normalized) || normalized.length > 30000) fail("UNSAFE_PATH", "已拦截压缩包中的绝对路径。");
  const parts = normalized.split("/");
  if (parts.length > 64 || parts.some((part) => !part || part === "." || part === ".." || /[<>:"|?*]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) fail("UNSAFE_PATH", "压缩包含有不安全或 Windows 不支持的路径：" + value);
  return parts.join("/");
}
function parseProperties(text) {
  const result = {};
  for (const line of text.split(/\r?\n/)) {
    const index = line.indexOf(" =");
    if (index < 0) { if (line.trim()) fail("INVALID_LISTING", "压缩包目录包含不支持的多行文件名。"); continue; }
    const key = line.slice(0, index);
    if (Object.hasOwn(result, key)) fail("INVALID_LISTING", "压缩包目录信息有歧义，已停止处理。");
    result[key] = line.slice(index + 2).replace(/^ /, "");
  }
  return result;
}
function parseListing(text) {
  const normalized = text.replace(/\r\n/g, "\n");
  const split = normalized.indexOf("\n----------\n");
  const headerStart = normalized.indexOf("\n--\n");
  if (split < 0 || headerStart < 0) fail("INVALID_LISTING", "无法读取压缩包目录。");
  const metadata = parseProperties(normalized.slice(headerStart + 4, split).trim());
  const blocks = normalized.slice(split + 12).trim().split(/\n\n+/).filter(Boolean);
  if (blocks.length > MAX_ENTRIES) fail("LIMIT", "目录项目超过 100,000 项，当前版本已停止读取。");
  const seen = new Set();
  let total = 0;
  const entries = blocks.map((block) => {
    const props = parseProperties(block);
    const unnamed = props.Path === undefined && STREAM_TYPES.has(metadata.Type);
    const entryPath = normalizeEntryPath(unnamed ? path.win32.basename(metadata.Path).replace(/\.[^.]+$/, "") || "output" : props.Path);
    if (props["Symbolic Link"] || props["Hard Link"] || props["Reparse"] || /(^|\s)l[rwx-]{3}/.test(props.Attributes || "") || /^l/.test(props.Mode || "")) fail("UNSAFE_LINK", "压缩包含有符号链接或硬链接，当前安全策略不允许解压。");
    if (props["Alternate Stream"] === "+") fail("UNSAFE_PATH", "不允许解压 NTFS 备用数据流。");
    const canonical = entryPath.toLocaleLowerCase("en-US");
    if (seen.has(canonical)) fail("DUPLICATE_PATH", "压缩包含有大小写冲突或重复的文件名。");
    seen.add(canonical);
    const folder = props.Folder === "+" || /^D/.test(props.Attributes || "") || /\sd[rwx-]{3}/.test(props.Attributes || "");
    const size = props.Size === "" || props.Size === undefined ? unnamed ? null : 0 : Number(props.Size);
    if (size !== null && (!Number.isSafeInteger(size) || size < 0)) fail("INVALID_SIZE", "压缩包包含无效的文件大小。");
    if (!folder) total += size;
    if (!Number.isSafeInteger(total) || total > MAX_BYTES) fail("LIMIT", "解压后大小超过当前版本的 128 GiB 安全上限。");
    return { path: entryPath, folder, size, unnamed, packed: props["Packed Size"] ? Number(props["Packed Size"]) : null, date: (props.Modified || "").slice(0, 16), encrypted: props.Encrypted === "+", method: props.Method || metadata.Method || "", crc: props.CRC || "" };
  });
  const files = new Set(entries.filter((entry) => !entry.folder).map((entry) => entry.path.toLowerCase()));
  for (const entry of entries) {
    const parts = entry.path.split("/");
    for (let i = 1; i < parts.length; i++) if (files.has(parts.slice(0, i).join("/").toLowerCase())) fail("DUPLICATE_PATH", "目录与文件存在路径冲突。");
  }
  return { metadata, entries, total };
}
function makeTree(flat) {
  const roots = [];
  const folders = new Map();
  const getFolder = (folderPath) => {
    if (folders.has(folderPath)) return folders.get(folderPath);
    const parts = folderPath.split("/");
    const name = parts.pop();
    const parent = parts.length ? getFolder(parts.join("/")).children : roots;
    const folder = { id: folderPath, name, kind: "folder", type: "文件夹", size: 0, packed: 0, date: "", children: [] };
    folders.set(folderPath, folder); parent.push(folder); return folder;
  };
  for (const entry of flat) {
    if (entry.folder) { getFolder(entry.path).date = entry.date; continue; }
    const parts = entry.path.split("/");
    const name = parts.pop();
    const parent = parts.length ? getFolder(parts.join("/")).children : roots;
    parent.push({ id: entry.path, name, kind: Core.kindFor(name), type: Core.extension(name).toUpperCase() + " 文件", size: entry.size, packed: entry.packed, date: entry.date, encrypted: entry.encrypted });
  }
  const aggregate = (items) => {
    for (const entry of items) if (entry.kind === "folder") {
      aggregate(entry.children);
      entry.size = entry.children.reduce((sum, child) => sum + (child.size || 0), 0);
      entry.packed = entry.children.reduce((sum, child) => sum + (child.packed || 0), 0);
      entry.type = `${entry.children.length} 个项目`;
    }
  };
  aggregate(roots);
  return roots;
}
async function exists(filePath) { try { return await fs.lstat(filePath); } catch (error) { if (error.code === "ENOENT") return null; throw error; } }
async function rejectLinks(target) {
  let current = path.resolve(target);
  for (;;) {
    const stat = await exists(current);
    if (stat?.isSymbolicLink()) fail("UNSAFE_LINK", "目标路径包含符号链接或目录联接，已停止操作。");
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
async function safeRemoveOwned(root, target) {
  assertInside(root, target);
  if (path.resolve(root) === path.resolve(target)) fail("UNSAFE_PATH", "不能删除工作区根目录。");
  await fs.rm(target, { recursive: true, force: true });
}
async function fingerprint(filePath) {
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) fail("INVALID_FILE", "请选择普通压缩文件，不支持链接文件。");
  return { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, ino: stat.ino };
}
function sameFingerprint(a, b) { return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.ino === b.ino; }

class ArchiveEngine {
  constructor(options = {}) {
    this.sevenZip = options.sevenZip || path.resolve(__dirname, "../engines/7zip/7z.exe");
    this.lz4 = options.lz4 || path.resolve(__dirname, "../engines/lz4/lz4.exe");
    this.cacheRoot = options.cacheRoot || path.join(os.tmpdir(), "MiniZip");
  }
  async run(binary, args, options = {}) {
    if (options.signal?.aborted) fail("CANCELLED", "操作已取消。");
    const child = spawn(binary, args, { windowsHide: true, shell: false, cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.on("error", () => {});
    child.stdin.end(options.input ?? ((options.password || "") + "\n"), "utf8");
    let stdout = "";
    let stderr = "";
    let overflow = false;
    let bytes = 0;
    const cancel = () => child.kill();
    options.signal?.addEventListener("abort", cancel, { once: true });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { if (stderr.length < 1024 * 1024) stderr += chunk; });
    let streamPromise = null;
    if (options.outputFile) {
      const limiter = new Transform({ transform(chunk, encoding, callback) {
        bytes += chunk.length;
        if (bytes > (options.maxBytes || MAX_BYTES)) { overflow = true; child.kill(); callback(new ArchiveError("LIMIT", "输出超过安全大小上限。")); return; }
        options.onBytes?.(bytes);
        callback(null, chunk);
      } });
      streamPromise = pipeline(child.stdout, limiter, createWriteStream(options.outputFile, { flags: "wx" })).catch((error) => { child.kill(); return error; });
    } else {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        if (stdout.length + chunk.length > (options.maxOutput || MAX_LISTING)) { overflow = true; child.kill(); return; }
        stdout += chunk;
        const matches = [...chunk.matchAll(/(\d{1,3})%/g)];
        if (matches.length) options.onProgress?.(Math.min(99, Number(matches.at(-1)[1])));
      });
    }
    let code;
    try { code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }); }
    finally { options.signal?.removeEventListener("abort", cancel); }
    const streamError = streamPromise ? await streamPromise : null;
    if (options.signal?.aborted) fail("CANCELLED", "操作已取消，未提交解压结果。");
    if (overflow) fail("LIMIT", "数据量超过当前安全上限，操作已停止。");
    if (streamError) throw streamError;
    if (code !== 0) {
      if (PASSWORD_ERROR.test(stdout + stderr)) fail(options.password ? "WRONG_PASSWORD" : "PASSWORD_REQUIRED", options.password ? "密码不正确，或加密数据已损坏。" : "此压缩包需要密码。");
      fail("ENGINE_ERROR", /not enough space|disk full/i.test(stdout + stderr) ? "磁盘空间不足。" : "压缩包读取失败，可能已损坏、缺少分卷或使用了不受支持的编码。");
    }
    return { stdout, stderr, bytes };
  }
  async list(filePath, password = "", options = {}) {
    const result = await this.run(this.sevenZip, ["l", "-slt", "-sccUTF-8", "-bd", "--", filePath], { ...options, password });
    return parseListing(result.stdout);
  }
  async selectionFile(entries, directory) {
    const filePath = path.join(directory, "selection.txt");
    await fs.writeFile(filePath, entries.map((entry) => entry.path).join("\n") + "\n", { encoding: "utf8", flag: "wx" });
    return filePath;
  }
  async open(filePath, password = "", options = {}) {
    filePath = path.resolve(filePath);
    if (typeof password !== "string" || password.length > 4096 || /[\r\n\0]/.test(password)) fail("INVALID_PASSWORD", "密码包含当前输入通道不支持的换行或控制字符。");
    const identity = await fingerprint(filePath);
    await fs.mkdir(this.cacheRoot, { recursive: true });
    const name = path.basename(filePath);
    const archive = { id: randomUUID(), path: filePath, name, format: path.extname(name).slice(1).toUpperCase(), size: identity.size, originalSize: null, date: new Date(identity.mtimeMs).toISOString().slice(0, 16).replace("T", " "), source: path.dirname(filePath), native: true, demo: false, folder: false, encrypted: false, locked: false, canDelete: false, entries: [], method: "", defaultDestination: path.dirname(filePath) };
    let session = { archive, identity, password, actualPath: filePath, type: "7zip", flat: [], cache: null };
    archive.date = new Date(identity.mtimeMs).toLocaleString("sv-SE").slice(0, 16);
    try {
      if (/\.lz4$/i.test(name)) {
        await this.run(this.lz4, ["--list", filePath], options);
        archive.format = "LZ4"; archive.method = "LZ4"; session.type = "lz4";
        const outName = normalizeEntryPath(name.replace(/\.lz4$/i, "") || "output");
        session.flat = [{ path: outName, folder: false, size: null, packed: identity.size, date: archive.date, encrypted: false }];
      } else {
        const listing = await this.list(filePath, password, options);
        session.flat = listing.entries;
        archive.format = (listing.metadata.Type || archive.format).toUpperCase();
        archive.method = listing.metadata.Method || "—";
        archive.encrypted = session.flat.some((entry) => entry.encrypted) || /AES/i.test(archive.method);
        archive.originalSize = listing.entries.some((item) => item.size === null) ? null : listing.total;
        if (listing.entries.length === 1 && listing.entries[0].unnamed) session.type = "stream";
        archive.canDelete = MUTABLE_TYPES.has(listing.metadata.Type) && !archive.encrypted && !listing.metadata.Volumes && listing.metadata["Multivolume"] !== "+";
        if (archive.encrypted && !password) { archive.locked = true; session.flat = []; }
        else if (archive.encrypted && password) {
          const smallest = listing.entries.filter((entry) => !entry.folder && entry.encrypted).sort((a, b) => a.size - b.size)[0];
          if (smallest) {
            try { await this.run(this.sevenZip, ["t", "-sccUTF-8", "-spd", "--", filePath, smallest.path], { ...options, password }); }
            catch (error) {
              if (listing.metadata.Type !== "zip" || error.code !== "WRONG_PASSWORD") throw error;
              try {
                await ZipCompat.readEntries(filePath, async (entries) => {
                  const entry = entries.find((item) => item.filename.replace(/\\/g, "/") === smallest.path);
                  if (!entry) fail("INVALID_LISTING", "ZIP 目录信息不一致。");
                  await ZipCompat.streamEntry(entry, password, null, options);
                });
                session.type = "zip-compat";
                archive.method += " · UTF-8";
              } catch (zipError) { const normalized = ZipCompat.normalizeZipError(zipError, options.signal?.aborted); fail(normalized.code || "ENGINE_ERROR", normalized.code === "WRONG_PASSWORD" ? normalized.message : "加密 ZIP 读取失败，可能已损坏。"); }
            }
          }
        }
      }
      if (!archive.locked && /(?:\.tar\.(?:gz|bz2|xz|zst|lz4)|\.(?:tgz|tbz2|txz|tzst))$/i.test(name)) {
        session.cache = await fs.mkdtemp(path.join(this.cacheRoot, "container-"));
        const innerPath = path.join(session.cache, "content.tar");
        if (session.type === "lz4") await this.run(this.lz4, ["-d", "-c", filePath], { ...options, outputFile: innerPath });
        else {
          if (session.flat.filter((entry) => !entry.folder).length !== 1) fail("INVALID_ARCHIVE", "嵌套 TAR 容器结构不正确。");
          await this.run(this.sevenZip, ["x", "-so", "-sccUTF-8", "-bsp0", "--", filePath], { ...options, password, outputFile: innerPath });
        }
        const inner = await this.list(innerPath, "", options);
        if (inner.metadata.Type !== "tar") fail("INVALID_ARCHIVE", "容器内部不是有效的 TAR 归档。");
        session.flat = inner.entries; session.actualPath = innerPath; session.type = "7zip";
        archive.format = "TAR." + archive.format; archive.originalSize = inner.total; archive.canDelete = false;
      }
      archive.entries = makeTree(session.flat);
      return session;
    } catch (error) {
      if (session.cache) await safeRemoveOwned(this.cacheRoot, session.cache);
      if (error.code === "PASSWORD_REQUIRED") { archive.encrypted = true; archive.locked = true; archive.entries = []; archive.method = "加密"; return { ...session, flat: [], cache: null }; }
      throw error;
    }
  }
  async assertUnchanged(session) {
    if (!sameFingerprint(session.identity, await fingerprint(session.archive.path))) fail("ARCHIVE_CHANGED", "原压缩包已被其他程序修改，请重新打开后再操作。");
    if (session.archive.locked) fail("PASSWORD_REQUIRED", "请先输入压缩包密码。");
  }
  selected(session, selection) {
    if (!selection?.length) return session.flat;
    if (!Array.isArray(selection) || selection.length > MAX_ENTRIES) fail("INVALID_SELECTION", "所选项目无效。");
    const ids = selection.map(normalizeEntryPath);
    for (const id of ids) if (!session.flat.some((entry) => entry.path === id || entry.path.startsWith(id + "/"))) fail("INVALID_SELECTION", "所选项目不在当前压缩包内。");
    return session.flat.filter((entry) => ids.some((id) => entry.path === id || entry.path.startsWith(id + "/")));
  }
  async test(session, options = {}) {
    await this.assertUnchanged(session);
    if (session.type === "zip-compat") await this.zipOperation(session, session.flat, null, options);
    else if (session.type === "lz4") await this.run(this.lz4, ["-t", session.actualPath], options);
    else await this.run(this.sevenZip, ["t", "-sccUTF-8", "-bsp1", "--", session.actualPath], { ...options, password: session.password });
    return { files: session.flat.filter((entry) => !entry.folder).length };
  }
  async extract(session, destination, options = {}) {
    await this.assertUnchanged(session);
    if (!path.isAbsolute(destination)) fail("INVALID_DESTINATION", "请选择绝对目标路径。");
    destination = path.resolve(destination);
    await rejectLinks(destination);
    const flat = this.selected(session, options.selection);
    if (!flat.length) fail("EMPTY_ARCHIVE", "压缩包没有可解压的内容。");
    if (!["rename", "skip", "overwrite"].includes(options.policy || "rename")) fail("INVALID_POLICY", "请选择同名文件处理方式。");
    const protectedPaths = [session.archive.path, session.actualPath].map((item) => path.resolve(item).toLowerCase());
    for (const entry of flat) {
      const target = path.resolve(destination, ...entry.path.split("/"));
      assertInside(destination, target);
      if (protectedPaths.includes(target.toLowerCase())) fail("SOURCE_COLLISION", "解压结果会覆盖原压缩包，请改用其他目录。");
      await rejectLinks(target);
    }
    await fs.mkdir(destination, { recursive: true });
    const stat = await fs.stat(destination);
    if (!stat.isDirectory()) fail("INVALID_DESTINATION", "目标路径不是文件夹。");
    const disk = await fs.statfs(destination);
    const available = Number(disk.bavail) * Number(disk.bsize);
    const total = flat.reduce((sum, entry) => sum + (entry.size || 0), 0);
    if (total * 2 + 64 * 1024 ** 2 > available) fail("DISK_SPACE", "目标磁盘空间不足，解压和安全提交需要额外临时空间。");
    const work = await fs.mkdtemp(path.join(destination, ".minizip-"));
    const stage = path.join(work, "files");
    await fs.mkdir(stage);
    let preserveRecovery = false;
    try {
      options.onPhase?.("extracting");
      if (session.type === "zip-compat") {
        await this.zipOperation(session, flat, stage, options);
      } else if (session.type === "lz4" || session.type === "stream") {
        const target = path.join(stage, flat[0].path);
        const binary = session.type === "lz4" ? this.lz4 : this.sevenZip;
        const args = session.type === "lz4" ? ["-d", "-c", session.actualPath] : ["x", "-so", "-bsp0", "--", session.actualPath];
        await this.run(binary, args, { ...options, outputFile: target, maxBytes: Math.min(MAX_BYTES, Math.floor(available / 2) - 64 * 1024 ** 2) });
      } else {
        const selectionFile = await this.selectionFile(flat, work);
        await this.run(this.sevenZip, ["x", "-y", "-aoa", "-sccUTF-8", "-scsUTF-8", "-bsp1", "-bb0", "-spd", "-o" + stage, session.actualPath, "@" + selectionFile], { ...options, password: session.password });
      }
      if (options.signal?.aborted) fail("CANCELLED", "解压已取消，未提交文件。");
      const staged = await this.scanStage(stage);
      const allowed = new Set(flat.map((entry) => entry.path.toLowerCase()));
      for (const entry of staged) if (!entry.folder && !allowed.has(entry.path.toLowerCase())) fail("UNEXPECTED_ENTRY", "解压结果出现未声明文件，已停止提交。");
      await this.assertUnchanged(session);
      options.onPhase?.("committing");
      const result = await this.commitFiles(stage, destination, staged, options.policy || "rename", work);
      options.onProgress?.(100);
      return { ...result, destination };
    } catch (error) { preserveRecovery = Boolean(error.recoveryPath); throw error; }
    finally { if (!preserveRecovery) await safeRemoveOwned(destination, work); }
  }
  async scanStage(root) {
    const result = [];
    let total = 0;
    const visit = async (directory, prefix = "") => {
      for (const name of await fs.readdir(directory)) {
        const relative = normalizeEntryPath(prefix + name);
        const fullPath = path.join(directory, name);
        const stat = await fs.lstat(fullPath);
        if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()) || (stat.isFile() && stat.nlink > 1)) fail("UNSAFE_LINK", "解压结果包含链接或特殊文件，已停止提交。");
        total += stat.isFile() ? stat.size : 0;
        if (total > MAX_BYTES || result.length >= MAX_ENTRIES) fail("LIMIT", "解压结果超过安全上限。");
        result.push({ path: relative, folder: stat.isDirectory(), size: stat.size });
        if (stat.isDirectory()) await visit(fullPath, relative + "/");
      }
    };
    await visit(root);
    return result;
  }
  async zipOperation(session, flat, stage, options = {}) {
    const total = flat.reduce((sum, item) => sum + (item.size || 0), 0);
    let finished = 0;
    try {
      await ZipCompat.readEntries(session.actualPath, async (entries) => {
        const selected = new Map(entries.map((entry) => [normalizeEntryPath(entry.filename), entry]));
        for (const item of flat) {
          if (options.signal?.aborted) fail("CANCELLED", "操作已取消。");
          const target = stage ? path.join(stage, ...item.path.split("/")) : null;
          if (item.folder) { if (target) await fs.mkdir(target, { recursive: true }); continue; }
          const entry = selected.get(item.path);
          if (!entry || entry.uncompressedSize !== item.size) fail("INVALID_LISTING", "ZIP 目录信息不一致。");
          if (target) { assertInside(stage, target); await fs.mkdir(path.dirname(target), { recursive: true }); }
          await ZipCompat.streamEntry(entry, session.password, target, { signal: options.signal, maxBytes: item.size || 1, onProgress: (value) => options.onProgress?.(total ? Math.floor((finished + value) / total * 99) : 0) });
          finished += item.size;
        }
      });
    } catch (error) { const normalized = ZipCompat.normalizeZipError(error, options.signal?.aborted); fail(normalized.code || "ENGINE_ERROR", normalized.code === "WRONG_PASSWORD" || normalized.code === "CANCELLED" ? normalized.message : "ZIP 解码或校验失败，未提交解压结果。"); }
  }
  async commitFiles(stage, destination, entries, policy, work) {
    const created = [], backups = [], directories = [];
    let skipped = 0, renamed = 0, bytes = 0;
    const ensureDirectory = async (directory) => {
      assertInside(destination, directory);
      await rejectLinks(directory);
      if (await exists(directory)) {
        if (!(await fs.stat(directory)).isDirectory()) fail("PATH_CONFLICT", "目标中存在与文件夹同名的文件。");
        return;
      }
      await ensureDirectory(path.dirname(directory));
      try { await fs.mkdir(directory); directories.push(directory); } catch (error) { if (error.code !== "EEXIST") throw error; }
    };
    try {
      for (const entry of entries) {
        let target = path.join(destination, ...entry.path.split("/"));
        assertInside(destination, target);
        await rejectLinks(target);
        if (entry.folder) { await ensureDirectory(target); continue; }
        await ensureDirectory(path.dirname(target));
        const existing = await exists(target);
        if (existing) {
          if (!existing.isFile()) fail("PATH_CONFLICT", "目标中存在与文件同名的目录。");
          if (policy === "skip") { skipped++; continue; }
          if (policy === "overwrite") {
            const backup = path.join(work, "backup-" + backups.length);
            await fs.rename(target, backup); backups.push({ target, backup });
          } else {
            const ext = path.extname(target), base = target.slice(0, target.length - ext.length);
            let number = 1;
            while (await exists(target)) target = `${base} (${number++})${ext}`;
            renamed++;
          }
        }
        await rejectLinks(target);
        const source = path.join(stage, ...entry.path.split("/"));
        try {
          await fs.link(source, target);
          created.push(target);
        } catch (error) {
          if (error.code === "EEXIST") throw error;
          const handle = await fs.open(target, "wx");
          created.push(target);
          await pipeline(createReadStream(source), handle.createWriteStream());
        }
        bytes += entry.size;
      }
      return { files: created.length, skipped, renamed, bytes };
    } catch (error) {
      let recoveryFailed = false;
      for (const target of created.reverse()) { assertInside(destination, target); try { await fs.unlink(target); } catch { recoveryFailed = true; } }
      for (const { target, backup } of backups.reverse()) {
        assertInside(destination, target);
        try { if (await exists(target)) throw new Error("Target occupied during rollback"); await fs.rename(backup, target); }
        catch { recoveryFailed = true; }
      }
      for (const directory of directories.reverse()) await fs.rmdir(directory).catch(() => {});
      if (recoveryFailed) { const recovery = new ArchiveError("RECOVERY_REQUIRED", "提交失败且部分文件无法自动恢复。备份已保留，请检查：" + work); recovery.recoveryPath = work; throw recovery; }
      throw error;
    }
  }
  async deleteEntries(session, selection, options = {}) {
    await this.assertUnchanged(session);
    if (!session.archive.canDelete) fail("READ_ONLY", "此格式或加密方式暂不支持直接删除包内文件。");
    if (!selection?.length) fail("INVALID_SELECTION", "请先选择要删除的文件。");
    const selected = this.selected(session, selection);
    const parent = path.dirname(session.archive.path);
    await rejectLinks(parent);
    const work = await fs.mkdtemp(path.join(parent, ".minizip-update-"));
    const temporary = path.join(work, "archive" + path.extname(session.archive.path));
    let backupPath;
    try {
      await fs.copyFile(session.archive.path, temporary, constants.COPYFILE_EXCL);
      const selectionFile = await this.selectionFile(selected, work);
      await this.run(this.sevenZip, ["d", "-y", "-sccUTF-8", "-scsUTF-8", "-spd", "-bsp1", temporary, "@" + selectionFile], options);
      const result = await this.list(temporary);
      const deleted = new Set(selected.map((item) => item.path.toLowerCase()));
      if (result.entries.some((entry) => deleted.has(entry.path.toLowerCase()))) fail("UPDATE_FAILED", "删除结果与所选项目不一致，原压缩包未更改。");
      const remaining = session.flat.filter((entry) => !deleted.has(entry.path.toLowerCase()));
      const current = new Map(result.entries.map((entry) => [entry.path, entry]));
      if (remaining.some((entry) => !current.has(entry.path) || current.get(entry.path).size !== entry.size || current.get(entry.path).crc !== entry.crc)) fail("UPDATE_FAILED", "未选中文件的完整性校验不一致，原压缩包未更改。");
      await this.run(this.sevenZip, ["t", "-sccUTF-8", "--", temporary], options);
      if (options.signal?.aborted) fail("CANCELLED", "删除已取消，原压缩包未更改。");
      await this.assertUnchanged(session);
      options.onPhase?.("committing");
      backupPath = session.archive.path + ".minizip-backup-" + new Date().toISOString().replace(/[:.]/g, "-") + "-" + randomUUID().slice(0, 6);
      await fs.rename(session.archive.path, backupPath);
      try { await fs.rename(temporary, session.archive.path); }
      catch (error) { await fs.rename(backupPath, session.archive.path); throw error; }
      const updated = await this.open(session.archive.path);
      updated.archive.id = session.archive.id;
      return { session: updated, backupPath, deleted: selected.length };
    } finally { await safeRemoveOwned(parent, work); }
  }
  async preview(session, id) {
    await this.assertUnchanged(session);
    const item = session.flat.find((entry) => entry.path === id && !entry.folder);
    if (!item) fail("INVALID_SELECTION", "无法预览此项目。");
    const ext = Core.extension(id);
    const imageTypes = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", avif: "image/avif" };
    const kind = imageTypes[ext] ? "image" : Core.kindFor(id) === "text" ? "text" : null;
    if (!kind) fail("NO_PREVIEW", "此类型暂不支持预览。");
    const limit = kind === "text" ? 1024 ** 2 : 12 * 1024 ** 2;
    if (item.size === null || item.size > limit || session.type === "lz4") fail("PREVIEW_LIMIT", "文件超过当前预览上限，请先解压。");
    const work = await fs.mkdtemp(path.join(this.cacheRoot, "preview-"));
    const target = path.join(work, "content");
    try {
      if (session.type === "zip-compat") {
        await ZipCompat.readEntries(session.actualPath, async (entries) => {
          const entry = entries.find((value) => normalizeEntryPath(value.filename) === id);
          if (!entry) fail("INVALID_SELECTION", "预览项目不存在。");
          await ZipCompat.streamEntry(entry, session.password, target, { maxBytes: limit });
        });
      } else await this.run(this.sevenZip, ["x", "-so", "-sccUTF-8", "-bsp0", "-spd", "--", session.actualPath, ...(session.type === "stream" ? [] : [id])], { password: session.password, outputFile: target, maxBytes: limit });
      const buffer = await fs.readFile(target);
      return kind === "text" ? { kind, content: buffer.toString("utf8") } : { kind, dataUrl: `data:${imageTypes[ext]};base64,${buffer.toString("base64")}` };
    } finally { await safeRemoveOwned(this.cacheRoot, work); }
  }
  async close(session) { session.password = ""; if (session.cache) { await safeRemoveOwned(this.cacheRoot, session.cache); session.cache = null; } }
}

module.exports = { ArchiveEngine, ArchiveError, parseListing, makeTree, normalizeEntryPath, assertInside, rejectLinks, safeRemoveOwned, fingerprint, sameFingerprint };
