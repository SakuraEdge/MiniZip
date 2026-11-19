"use strict";

const fs = require("node:fs/promises");
const { constants, createWriteStream, createReadStream } = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { randomUUID, createHash } = require("node:crypto");
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
async function hashFile(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

class ArchiveEngine {
  constructor(options = {}) {
    this.sevenZip = options.sevenZip || path.resolve(__dirname, "../engines/7zip/7z.exe");
    this.lz4 = options.lz4 || path.resolve(__dirname, "../engines/lz4/lz4.exe");
    this.cacheRoot = options.cacheRoot || path.join(os.tmpdir(), "MiniZip");
  }
  async run(binary, args, options = {}) {
    if (options.signal?.aborted) fail("CANCELLED", "操作已取消。");
    // Open paths in Node so native tools with ANSI-only argv can read Unicode files.
    const input = options.inputFile ? await fs.open(options.inputFile, "r") : null;
    try {
      const child = spawn(binary, args, { windowsHide: true, shell: false, cwd: options.cwd, stdio: [input ? input.fd : "pipe", "pipe", "pipe"] });
      const completion = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
      if (child.stdin) {
        child.stdin.on("error", () => {});
        child.stdin.end(options.input ?? ((options.password || "") + "\n"), "utf8");
      }
      let stdout = "";
      let stderr = "";
      let overflow = false;
      let bytes = 0;
      const cancel = () => child.kill();
      options.signal?.addEventListener("abort", cancel, { once: true });
      if (options.signal?.aborted) cancel();
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => { if (stderr.length < 1024 * 1024) stderr += chunk; });
      let streamPromise = null;
      if (options.onChunk) {
        child.stdout.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > options.maxBytes) { if (!overflow) child.kill(); overflow = true; return; }
          options.onChunk(chunk);
        });
      } else if (options.outputFile) {
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
      try { code = await completion; }
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
    } finally { await input?.close(); }
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
    const name = path.basename(filePath);
    const archive = { id: randomUUID(), path: filePath, name, format: path.extname(name).slice(1).toUpperCase(), size: identity.size, originalSize: null, date: new Date(identity.mtimeMs).toISOString().slice(0, 16).replace("T", " "), source: path.dirname(filePath), native: true, demo: false, folder: false, encrypted: false, locked: false, canDelete: false, entries: [], method: "", defaultDestination: path.dirname(filePath) };
    let session = { archive, identity, password, actualPath: filePath, type: "7zip", flat: [], cache: null };
    archive.date = new Date(identity.mtimeMs).toLocaleString("sv-SE").slice(0, 16);
    try {
      if (/\.lz4$/i.test(name)) {
        await this.run(this.lz4, ["-t", "-"], { ...options, inputFile: filePath });
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
        session.mutable = MUTABLE_TYPES.has(listing.metadata.Type) && !listing.metadata.Volumes && listing.metadata["Multivolume"] !== "+";
        archive.canDelete = session.mutable && !archive.encrypted;
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
        await fs.mkdir(this.cacheRoot, { recursive: true });
        session.cache = await fs.mkdtemp(path.join(this.cacheRoot, "container-"));
        const innerPath = path.join(session.cache, "content.tar");
        if (session.type === "lz4") await this.run(this.lz4, ["-d", "-c", "-"], { ...options, inputFile: filePath, outputFile: innerPath });
        else {
          if (session.flat.filter((entry) => !entry.folder).length !== 1) fail("INVALID_ARCHIVE", "嵌套 TAR 容器结构不正确。");
          await this.run(this.sevenZip, ["x", "-so", "-sccUTF-8", "-bsp0", "--", filePath], { ...options, password, outputFile: innerPath });
        }
        const inner = await this.list(innerPath, "", options);
        if (inner.metadata.Type !== "tar") fail("INVALID_ARCHIVE", "容器内部不是有效的 TAR 归档。");
        session.flat = inner.entries; session.actualPath = innerPath; session.type = "7zip";
        archive.format = "TAR." + archive.format; archive.originalSize = inner.total; archive.canDelete = false; session.mutable = false;
      }
      archive.entries = makeTree(session.flat);
      archive.canRename = Boolean(archive.canDelete && !archive.locked);
      archive.canUpdate = Boolean(!archive.locked && session.mutable && (!archive.encrypted || password));
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
    const ids = new Set(selection.map(normalizeEntryPath)), found = new Set();
    const selected = session.flat.filter(entry => {
      let p = entry.path, match = false;
      while (p) {
        if (ids.has(p)) { found.add(p); match = true; }
        const slash = p.lastIndexOf("/"); if (slash < 0) break;
        p = p.slice(0, slash);
      }
      return match;
    });
    if (found.size !== ids.size) fail("INVALID_SELECTION", "所选项目不在当前压缩包内。");
    return selected;
  }
  async test(session, options = {}) {
    await this.assertUnchanged(session);
    if (session.type === "zip-compat") await this.zipOperation(session, session.flat, null, options);
    else if (session.type === "lz4") await this.run(this.lz4, ["-t", "-"], { ...options, inputFile: session.actualPath });
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
        const args = session.type === "lz4" ? ["-d", "-c", "-"] : ["x", "-so", "-bsp0", "--", session.actualPath];
        await this.run(binary, args, { ...options, inputFile: session.type === "lz4" ? session.actualPath : undefined, outputFile: target, maxBytes: Math.min(MAX_BYTES, Math.floor(available / 2) - 64 * 1024 ** 2) });
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
  renameTarget(session, id, name) {
    if (!session.archive.canRename) fail("READ_ONLY", "此格式或加密方式不支持重命名。");
    if (typeof name !== "string" || !name.length || name.length > 255 || /[\\/]/.test(name) || /^(?:conin\$|conout\$|(?:com|lpt)[¹²³])(?:\.|$)/i.test(name)) fail("INVALID_NAME", "请输入有效的单个文件名，不要包含路径。");
    normalizeEntryPath(name);
    if (normalizeEntryPath(id) !== id || !session.flat.some(entry => entry.path === id || entry.path.startsWith(id + "/"))) fail("INVALID_SELECTION", "所选项目不属于此压缩包。");
    const target = normalizeEntryPath(id.slice(0, id.lastIndexOf("/") + 1) + name);
    if (target === id) fail("INVALID_NAME", "名称没有变化。");
    const lower = target.toLowerCase();
    if (session.flat.some(({ path: p }) => p !== id && !p.startsWith(id + "/") && (p.toLowerCase() === lower || p.toLowerCase().startsWith(lower + "/")))) fail("NAME_CONFLICT", "当前目录已存在同名的文件或文件夹。");
    return target;
  }
  async renameEntry(session, id, name, options = {}) {
    await this.assertUnchanged(session);
    const target = this.renameTarget(session, id, name);
    const parent = path.dirname(session.archive.path);
    await rejectLinks(session.archive.path);
    const work = await fs.mkdtemp(path.join(parent, ".minizip-rename-"));
    const temporary = path.join(work, "archive" + path.extname(session.archive.path));
    try {
      options.onPhase?.("updating");
      await fs.copyFile(session.archive.path, temporary, constants.COPYFILE_EXCL);
      await this.run(this.sevenZip, ["rn", "-y", "-sccUTF-8", "-spd", "-bsp1", "--", temporary, id, target], options);
      options.onPhase?.("verifying");
      const listing = await this.list(temporary, "", options);
      const actual = new Map(listing.entries.map(entry => [entry.path, entry]));
      const mapped = p => p === id || p.startsWith(id + "/") ? target + p.slice(id.length) : p;
      if (actual.size !== session.flat.length || session.flat.some(src => {
        const dest = actual.get(mapped(src.path));
        return !dest || dest.folder !== src.folder || dest.size !== src.size || dest.crc !== src.crc || dest.encrypted !== src.encrypted;
      })) fail("UPDATE_FAILED", "重命名后的清单不一致，原压缩包未更改。");
      await this.run(this.sevenZip, ["t", "-sccUTF-8", "--", temporary], options);
      if (session.flat.some(entry => !entry.folder && entry.size > 0 && !entry.crc)) {
        // TAR has no member CRC. Compare the ordered payload stream without extracting files.
        const before = session.flat.filter(e => !e.folder), after = listing.entries.filter(e => !e.folder);
        const digest = async file => {
          const hash = createHash("sha256");
          await this.run(this.sevenZip, ["x", "-so", "-bsp0", "--", file], { signal: options.signal, maxBytes: MAX_BYTES, onChunk: b => hash.update(b) });
          return hash.digest("hex");
        };
        if (before.some((e, i) => mapped(e.path) !== after[i].path) || await digest(session.archive.path) !== await digest(temporary)) fail("UPDATE_FAILED", "文件内容校验失败，原压缩包未更改。");
      }
      const result = await this.commitArchive(session, temporary, options);
      return { ...result, renamedTo: target };
    } finally { await safeRemoveOwned(parent, work); }
  }
  async commitArchive(session, temporary, options) {
    if (options.signal?.aborted) fail("CANCELLED", "操作已取消，原压缩包未更改。");
    await this.assertUnchanged(session);
    options.onPhase?.("committing");
    const backupPath = session.archive.path + ".minizip-backup-" + new Date().toISOString().replace(/[:.]/g, "-") + "-" + randomUUID().slice(0, 6);
    await fs.rename(session.archive.path, backupPath);
    try { await fs.rename(temporary, session.archive.path); }
    catch (error) { await fs.rename(backupPath, session.archive.path); throw error; }
    const updated = await this.open(session.archive.path, session.password);
    updated.archive.id = session.archive.id;
    return { session: updated, backupPath };
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
      return { ...await this.commitArchive(session, temporary, options), deleted: selected.length };
    } finally { await safeRemoveOwned(parent, work); }
  }
  async preview(session, id, options = {}) {
    await this.assertUnchanged(session);
    const item = session.flat.find((entry) => entry.path === id && !entry.folder);
    if (!item) fail("INVALID_SELECTION", "无法预览此项目。");
    const spec = Core.previewSpec(id);
    if (!spec) fail("NO_PREVIEW", "此类型暂不支持内存预览。");
    if (item.size > spec.limit) fail("PREVIEW_LIMIT", "文件超过内存预览上限。");
    const chunks = [], maxBytes = item.size ?? spec.limit;
    const known = item.size == null ? null : Buffer.alloc(item.size);
    let offset = 0;
    const output = { signal: options.signal, maxBytes, onChunk(chunk) {
      if (known) { known.set(chunk, offset); offset += chunk.length; }
      else chunks.push(Buffer.from(chunk));
    } };
    let bytes;
    try {
      if (session.type === "zip-compat") {
        bytes = await ZipCompat.readEntries(session.actualPath, async (entries) => {
          const entry = entries.find((value) => normalizeEntryPath(value.filename) === id);
          if (!entry || entry.uncompressedSize !== item.size) fail("INVALID_SELECTION", "预览项目不存在或已更改。");
          return ZipCompat.streamEntry(entry, session.password, null, output);
        });
      } else if (session.type === "lz4") {
        ({ bytes } = await this.run(this.lz4, ["-d", "-c", "-"], { ...output, inputFile: session.actualPath }));
      } else {
        ({ bytes } = await this.run(this.sevenZip, ["x", "-so", "-sccUTF-8", "-bsp0", "-spd", "--", session.actualPath, ...(session.type === "stream" ? [] : [id])], { ...output, password: session.password }));
      }
      if (item.size != null && bytes !== item.size) fail("INVALID_SIZE", "预览输出与归档声明的大小不符。");
      await this.assertUnchanged(session);
      const data = known || Buffer.concat(chunks, bytes);
      if (spec.kind === "pdf" && !data.subarray(0, 1024).includes("%PDF-")) fail("NO_PREVIEW", "内容不是可预览的 PDF 文档。");
      return spec.kind === "text" ? { kind: "text", content: data.toString("utf8") } : { kind: spec.kind, mime: spec.mime, bytes: data };
    } catch (error) { if (error.code === "LIMIT") fail("PREVIEW_LIMIT", "文件超过内存预览上限。"); throw error; }
  }
  async updateEntries(session, replacements, options = {}) {
    await this.assertUnchanged(session);
    if (!session.archive.canUpdate) fail("READ_ONLY", "此格式或加密方式不支持写回，请另存修改后的文件。");
    if (!Array.isArray(replacements) || !replacements.length || replacements.length > MAX_ENTRIES) fail("INVALID_SELECTION", "没有可保存的修改。");
    const selected = new Map(), originals = new Map(), occupied = new Map();
    const reserve = (id, folder) => {
      let p = "";
      for (const part of id.split("/")) {
        p = p ? p + "/" + part : part;
        const key = p.toLowerCase(), dir = p !== id || folder, old = occupied.get(key);
        if (old && (old.path !== p || old.folder !== dir)) fail("NAME_CONFLICT", "文件或目录名称存在冲突：" + p);
        occupied.set(key, { path: p, folder: dir });
      }
    };
    let finalBytes = 0, finalCount = session.flat.length, total = 0;
    for (const item of session.flat) { originals.set(item.path, item); reserve(item.path, item.folder); finalBytes += item.size || 0; }
    for (const value of replacements) {
      const entryId = normalizeEntryPath(value.entryId);
      const original = originals.get(entryId), key = entryId.toLowerCase();
      if (selected.has(key) || (value.added && value.removed)) fail("INVALID_SELECTION", "同一项目不能重复修改。");
      if (value.added === true) {
        if (occupied.has(key)) fail("NAME_CONFLICT", "新增文件与包内项目同名：" + entryId);
        reserve(entryId, false); finalCount++;
      } else if (!original || original.folder) fail("INVALID_SELECTION", "修改的文件不属于当前压缩包。");
      finalBytes -= original?.size || 0;
      if (value.removed === true) { selected.set(key, { entryId, removed: true }); finalCount--; continue; }
      if (typeof value.sourcePath !== "string" || !path.isAbsolute(value.sourcePath)) fail("INVALID_SELECTION", "无效的修改副本。");
      await rejectLinks(value.sourcePath);
      const stat = await fs.lstat(value.sourcePath);
      if (!stat.isFile() || stat.nlink > 1) fail("UNSAFE_LINK", "不能将链接或特殊文件写回压缩包。");
      if (value.expectedHash && !/^[a-f0-9]{64}$/i.test(value.expectedHash)) fail("INVALID_SELECTION", "修改文件的校验信息无效。");
      total += stat.size; finalBytes += stat.size;
      selected.set(entryId.toLowerCase(), { ...value, entryId, identity: await fingerprint(value.sourcePath), size: stat.size });
    }
    if (finalBytes > MAX_BYTES || finalCount > MAX_ENTRIES) fail("LIMIT", "修改后的压缩包超过安全上限。");
    const writes = [...selected.values()].filter(v => !v.removed), removed = [...selected.values()].filter(v => v.removed);
    const parent = path.dirname(session.archive.path);
    await rejectLinks(session.archive.path);
    const disk = await fs.statfs(parent);
    if (Number(disk.bavail) * Number(disk.bsize) < session.identity.size * 2 + total * 2 + 64 * 1024 ** 2) fail("DISK_SPACE", "磁盘空间不足，无法安全保存修改。");
    const work = await fs.mkdtemp(path.join(parent, ".minizip-edit-"));
    const stage = path.join(work, "files");
    const temporary = path.join(work, "archive" + path.extname(session.archive.path));
    try {
      options.onPhase?.("preparing");
      for (const item of writes) {
        if (options.signal?.aborted) fail("CANCELLED", "保存已取消，原压缩包未更改。");
        const target = path.join(stage, ...item.entryId.split("/"));
        item.stagedPath = target;
        assertInside(stage, target);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.copyFile(item.sourcePath, target, constants.COPYFILE_EXCL);
        item.hash = await hashFile(target);
        if ((item.expectedHash && item.hash !== item.expectedHash) || !sameFingerprint(item.identity, await fingerprint(item.sourcePath)) || item.hash !== await hashFile(item.sourcePath)) fail("SOURCE_CHANGED", "外部文件仍在保存中，请稍后再试。");
      }
      options.onPhase?.("updating");
      if (session.archive.format === "ZIP" && session.archive.encrypted) await ZipCompat.replaceEntries(session.archive.path, temporary, [...selected.values()], session.password, options);
      else {
        await fs.copyFile(session.archive.path, temporary, constants.COPYFILE_EXCL);
        const run = async (command, items) => {
          if (!items.length) return;
          const listFile = await this.selectionFile(items.map(x => ({ path: x.entryId })), work);
          try { await this.run(this.sevenZip, [command, "-y", "-sccUTF-8", "-scsUTF-8", "-spd", "-bsp1", ...(session.archive.encrypted ? ["-p", "-mhe=on"] : []), temporary, "@" + listFile], { ...options, cwd: writes.length ? stage : work, password: session.password, ...(session.archive.encrypted ? { input: (session.password + "\n").repeat(3) } : {}) }); }
          finally { await fs.unlink(listFile); }
        };
        await run("d", removed); await run("a", writes);
      }
      const listing = await this.list(temporary, session.password, options);
      const actual = new Map(listing.entries.map((entry) => [entry.path, entry]));
      if (actual.size !== finalCount || writes.some(v => v.added && (!actual.has(v.entryId) || actual.get(v.entryId).folder || actual.get(v.entryId).size !== v.size || Boolean(actual.get(v.entryId).encrypted) !== Boolean(session.archive.encrypted))) || session.flat.some((entry) => {
        const updated = actual.get(entry.path), replacement = selected.get(entry.path.toLowerCase());
        if (replacement?.removed) return Boolean(updated);
        return !updated || updated.folder !== entry.folder || updated.encrypted !== entry.encrypted || (replacement ? updated.size !== replacement.size : updated.size !== entry.size || updated.crc !== entry.crc);
      })) fail("UPDATE_FAILED", "修改后的文件清单或未修改文件校验不一致，原包未更改。");
      options.onPhase?.("verifying");
      const verificationSession = await this.open(temporary, session.password, options);
      try { await this.test(verificationSession, options); } finally { await this.close(verificationSession); }
      for (const item of writes) {
        const verification = path.join(work, "verify-" + randomUUID());
        if (session.archive.format === "ZIP" && session.archive.encrypted) await ZipCompat.readEntries(temporary, async (entries) => {
          const entry = entries.find((value) => value.filename.replace(/\\/g, "/") === item.entryId);
          if (!entry) fail("UPDATE_FAILED", "写回内容不存在。");
          await ZipCompat.streamEntry(entry, session.password, verification, { ...options, maxBytes: item.size || 1 });
        });
        else await this.run(this.sevenZip, ["x", "-so", "-sccUTF-8", "-bsp0", "-spd", "--", temporary, item.entryId], { ...options, password: session.password, outputFile: verification, maxBytes: item.size || 1 });
        if (await hashFile(verification) !== item.hash) fail("UPDATE_FAILED", "写回内容校验失败，原压缩包未更改。");
        await fs.unlink(verification);
        await rejectLinks(item.sourcePath);
        if (!sameFingerprint(item.identity, await fingerprint(item.sourcePath)) || await hashFile(item.sourcePath) !== item.hash) fail("SOURCE_CHANGED", "文件在写回期间再次变化，原压缩包未更改，请重新保存。");
      }
      await options.beforeCommit?.();
      return { ...await this.commitArchive(session, temporary, options), updated: selected.size };
    } finally { await safeRemoveOwned(parent, work); }
  }
  async close(session) { session.password = ""; if (session.cache) { await safeRemoveOwned(this.cacheRoot, session.cache); session.cache = null; } }
}

module.exports = { ArchiveEngine, ArchiveError, parseListing, makeTree, normalizeEntryPath, assertInside, rejectLinks, safeRemoveOwned, fingerprint, sameFingerprint, hashFile };
