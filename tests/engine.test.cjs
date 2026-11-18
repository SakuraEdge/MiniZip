"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { ArchiveEngine, normalizeEntryPath, parseListing, safeRemoveOwned } = require("../desktop/archive-engine.cjs");
const zip = require("@zip.js/zip.js");

const workspace = path.resolve(__dirname, "..");
let root, source, engine;
const contents = "MiniZip 中文内容\nline two\n";
function run(binary, args, cwd = root) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (data) => { output += data.toString(); });
    child.stderr.on("data", (data) => { output += data.toString(); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(output) : reject(new Error(`Fixture command failed (${code}): ${output}`)));
  });
}
async function createArchive(name, type, extra = []) {
  const destination = path.join(root, name);
  await run(engine.sevenZip, ["a", "-t" + type, "-y", "-mx=1", ...extra, destination, "*"], source);
  return destination;
}
async function destination(name) { const value = path.join(root, name); await fs.mkdir(value, { recursive: true }); return value; }
async function createLz4(input, output) {
  const result = spawnSync(engine.lz4, ["-z", "-c", "-"], { input: await fs.readFile(input), windowsHide: true, maxBuffer: 16 * 1024 ** 2 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr.toString());
  await fs.writeFile(output, result.stdout, { flag: "wx" });
}

before(async () => {
  await fs.mkdir(path.join(workspace, ".test-work"), { recursive: true });
  root = await fs.mkdtemp(path.join(workspace, ".test-work", "engine-"));
  source = path.join(root, "输入 中文");
  await fs.mkdir(path.join(source, "文件夹"), { recursive: true });
  await fs.mkdir(path.join(source, "空目录"), { recursive: true });
  await fs.writeFile(path.join(source, "说明.txt"), contents);
  await fs.writeFile(path.join(source, "文件夹", "数据.json"), '{"title":"测试"}');
  await fs.writeFile(path.join(source, "@清单.txt"), "at sign");
  await fs.writeFile(path.join(source, "-选项.txt"), "dash prefix");
  engine = new ArchiveEngine({ cacheRoot: path.join(root, "cache") });
});
after(async () => { if (root) await safeRemoveOwned(path.join(workspace, ".test-work"), root); });

test("unsafe archive paths are rejected instead of sanitized", () => {
  for (const entry of ["../escape.txt", "a/../../escape", "C:\\Windows\\file", "/etc/passwd", "\\\\host\\share", "file:stream", "CON.txt", "a./b", "dir /x", "dir//x", "file\nPath = spoof", "a/./b"]) assert.throws(() => normalizeEntryPath(entry), { code: "UNSAFE_PATH" });
  assert.equal(normalizeEntryPath("中文\\文件.txt"), "中文/文件.txt");
});

test("listing parser rejects links, duplicated names and excessive declared size", () => {
  const listing = (entries) => `7-Zip\n--\nPath = a.zip\nType = zip\n\n----------\n${entries}`;
  assert.throws(() => parseListing(listing("Path = link\nSize = 1\nSymbolic Link = ../x\n")), { code: "UNSAFE_LINK" });
  assert.throws(() => parseListing(listing("Path = a\nSize = 1\n\nPath = A\nSize = 2\n")), { code: "DUPLICATE_PATH" });
  assert.throws(() => parseListing(listing("Path = a\nSize = 999999999999999\n")), { code: "LIMIT" });
  assert.throws(() => parseListing(listing("Path = a\nSize = 1\n\nPath = a/b\nSize = 1\n")), { code: "DUPLICATE_PATH" });
});

for (const format of ["zip", "7z", "tar"]) {
  test(`${format}: real list, CRC test, Unicode extraction and text preview`, async () => {
    const archivePath = await createArchive(`普通.${format}`, format);
    const session = await engine.open(archivePath);
    assert.equal(session.archive.native, true);
    assert.equal(session.archive.locked, false);
    assert.equal(session.flat.filter((entry) => !entry.folder).length, 4);
    await engine.test(session);
    const result = await engine.extract(session, await destination(`解压-${format}`), { policy: "rename" });
    assert.equal(result.files, 4);
    assert.equal(await fs.readFile(path.join(result.destination, "说明.txt"), "utf8"), contents);
    assert.equal(await fs.readFile(path.join(result.destination, "@清单.txt"), "utf8"), "at sign");
    const preview = await engine.preview(session, "说明.txt");
    assert.equal(preview.content, contents);
    await engine.close(session);
  });
}

test("Chinese passwords unlock header-encrypted 7z and AES ZIP via stdin", async () => {
  for (const [format, flags] of [["7z", ["-mhe=on"]], ["zip", ["-mem=AES256"]]]) {
    let archivePath;
    if (format === "zip") {
      archivePath = path.join(root, "密码.zip");
      const writer = new zip.ZipWriter(new zip.Uint8ArrayWriter(), { password: "迷你压缩2026", encryptionStrength: 3, useWebWorkers: false });
      await writer.add("说明.txt", new zip.TextReader(contents));
      await writer.add("文件夹/数据.json", new zip.TextReader('{"title":"测试"}'));
      await fs.writeFile(archivePath, await writer.close());
    } else archivePath = await createArchive(`密码.${format}`, format, ["-p迷你压缩2026", ...flags]);
    const locked = await engine.open(archivePath);
    assert.equal(locked.archive.locked, true);
    assert.equal(locked.archive.entries.length, 0);
    await assert.rejects(engine.open(archivePath, "错误密码"), { code: "WRONG_PASSWORD" });
    const unlocked = await engine.open(archivePath, "迷你压缩2026");
    assert.equal(unlocked.archive.locked, false);
    assert.equal(unlocked.archive.canDelete, false);
    const result = await engine.extract(unlocked, await destination(`密码解压-${format}`), { policy: "rename" });
    assert.equal(await fs.readFile(path.join(result.destination, "说明.txt"), "utf8"), contents);
    await engine.close(unlocked);
    assert.equal(unlocked.password, "");
  }
});

test("selection extraction does not expand wildcard-like command filenames", async () => {
  const session = await engine.open(await createArchive("selection.zip", "zip"));
  const result = await engine.extract(session, await destination("selected"), { selection: ["@清单.txt"], policy: "rename" });
  assert.equal(result.files, 1);
  assert.deepEqual(await fs.readdir(result.destination), ["@清单.txt"]);
  await engine.close(session);
});

test("rename, skip and overwrite policies preserve their distinct behavior", async () => {
  const session = await engine.open(await createArchive("conflict.zip", "zip"));
  for (const policy of ["rename", "skip", "overwrite"]) {
    const target = await destination("conflict-" + policy);
    await fs.writeFile(path.join(target, "说明.txt"), "existing");
    const result = await engine.extract(session, target, { selection: ["说明.txt"], policy });
    assert.equal(await fs.readFile(path.join(target, "说明.txt"), "utf8"), policy === "overwrite" ? contents : "existing");
    if (policy === "rename") { assert.equal(result.renamed, 1); assert.equal(await fs.readFile(path.join(target, "说明 (1).txt"), "utf8"), contents); }
    if (policy === "skip") assert.equal(result.skipped, 1);
    assert.equal((await fs.readdir(target)).some((name) => name.startsWith(".minizip-")), false);
  }
  await engine.close(session);
});

test("delete rewrites a validated copy and preserves byte-identical original backup", async () => {
  for (const format of ["zip", "7z", "tar"]) {
    const archivePath = await createArchive(`delete.${format}`, format);
    const original = await fs.readFile(archivePath);
    const session = await engine.open(archivePath);
    const result = await engine.deleteEntries(session, ["文件夹"]);
    assert.deepEqual(await fs.readFile(result.backupPath), original);
    assert.equal(result.session.flat.some((entry) => entry.path.startsWith("文件夹")), false);
    assert.equal(result.session.flat.some((entry) => entry.path === "说明.txt"), true);
    await engine.test(result.session);
    await engine.close(result.session);
  }
});

test("changing an archive externally invalidates an open session", async () => {
  const archivePath = await createArchive("changed.zip", "zip");
  const session = await engine.open(archivePath);
  await fs.appendFile(archivePath, "changed");
  await assert.rejects(engine.extract(session, path.join(root, "changed-output")), { code: "ARCHIVE_CHANGED" });
  await assert.rejects(engine.deleteEntries(session, ["说明.txt"]), { code: "ARCHIVE_CHANGED" });
});

test("cancelled extraction never commits staged files", async () => {
  const session = await engine.open(await createArchive("cancel.zip", "zip"));
  const controller = new AbortController();
  const target = await destination("cancel-output");
  await assert.rejects(engine.extract(session, target, { signal: controller.signal, onPhase: () => controller.abort(), policy: "rename" }), { code: "CANCELLED" });
  assert.deepEqual(await fs.readdir(target), []);
});

test("destination junctions cannot redirect extraction outside the chosen folder", async () => {
  const session = await engine.open(await createArchive("junction.zip", "zip"));
  const target = await destination("junction-output");
  const outside = await destination("outside");
  await fs.symlink(outside, path.join(target, "文件夹"), "junction");
  await assert.rejects(engine.extract(session, target, { policy: "rename" }), { code: "UNSAFE_LINK" });
  assert.deepEqual(await fs.readdir(outside), []);
});

test("LZ4 native decoding supports Unicode paths independent of Windows locale", async () => {
  const directory = await destination("LZ4-中文-\u{1F5C3}");
  const archivePath = path.join(directory, "真实内容.txt.lz4");
  await createLz4(path.join(source, "说明.txt"), archivePath);
  const session = await engine.open(archivePath);
  assert.equal(session.archive.format, "LZ4");
  assert.equal(session.archive.canDelete, false);
  await engine.test(session);
  const result = await engine.extract(session, await destination("lz4-output"), { policy: "rename" });
  assert.equal(await fs.readFile(path.join(result.destination, "真实内容.txt"), "utf8"), contents);
  await engine.close(session);
});

test("LZ4 rejects corrupt frames and cancelled extraction leaves no output", async () => {
  const archivePath = path.join(root, "cancel.lz4");
  await createLz4(path.join(source, "说明.txt"), archivePath);
  const session = await engine.open(archivePath);
  const controller = new AbortController();
  const target = await destination("cancel-lz4");
  await assert.rejects(engine.extract(session, target, { signal: controller.signal, onPhase: () => controller.abort(), policy: "rename" }), { code: "CANCELLED" });
  assert.deepEqual(await fs.readdir(target), []);
  await engine.close(session);
  const corrupt = path.join(root, "corrupt.lz4");
  const bytes = await fs.readFile(archivePath);
  bytes[bytes.length - 1] ^= 0xff;
  await fs.writeFile(corrupt, bytes);
  await assert.rejects(engine.open(corrupt), { code: "ENGINE_ERROR" });
});

test("nested tar.gz and tar.lz4 expose actual TAR contents", async () => {
  const tarPath = await createArchive("嵌套-\u{1F5C3}.tar", "tar");
  for (const kind of ["gz", "lz4"]) {
    const archivePath = tarPath + "." + kind;
    if (kind === "gz") await run(engine.sevenZip, ["a", "-tgzip", archivePath, tarPath]);
    else await createLz4(tarPath, archivePath);
    const session = await engine.open(archivePath);
    assert.equal(session.archive.format.startsWith("TAR."), true);
    assert.equal(session.archive.canDelete, false);
    const result = await engine.extract(session, await destination("nested-" + kind), { policy: "rename" });
    assert.equal(await fs.readFile(path.join(result.destination, "说明.txt"), "utf8"), contents);
    const cache = session.cache;
    await engine.close(session);
    await assert.rejects(fs.stat(cache), { code: "ENOENT" });
  }
});

test("corrupt archives fail without creating output or accepting a fake format", async () => {
  const filePath = path.join(root, "broken.rar");
  await fs.writeFile(filePath, "not an archive");
  await assert.rejects(engine.open(filePath), { code: "ENGINE_ERROR" });
});

test("RAR5 reads and extracts an independent upstream fixture", async () => {
  const session = await engine.open(path.join(__dirname, "fixtures/archives/test_read_format_rar5_stored.rar"));
  assert.equal(session.archive.format, "RAR5");
  assert.equal(session.archive.canDelete, false);
  await engine.test(session);
  const result = await engine.extract(session, await destination("rar5"), { policy: "rename" });
  assert.equal(await fs.readFile(path.join(result.destination, "helloworld.txt"), "utf8"), "hello libarchive test suite!\n");
  await assert.rejects(engine.deleteEntries(session, ["helloworld.txt"]), { code: "READ_ONLY" });
});

test("RAR symbolic links are rejected before extraction", async () => {
  await assert.rejects(engine.open(path.join(__dirname, "fixtures/archives/test_read_format_rar.rar")), { code: "UNSAFE_LINK" });
});

for (const [extension, format] of [["gz", "gzip"], ["bz2", "bzip2"], ["xz", "xz"]]) {
  test(`${extension}: single-file stream extraction returns exact contents`, async () => {
    const archivePath = path.join(root, "stream.txt." + extension);
    await run(engine.sevenZip, ["a", "-t" + format, archivePath, path.join(source, "说明.txt")]);
    const session = await engine.open(archivePath);
    const result = await engine.extract(session, await destination("stream-" + extension), { policy: "rename" });
    const files = await fs.readdir(result.destination);
    assert.equal(files.length, 1);
    assert.equal(await fs.readFile(path.join(result.destination, files[0]), "utf8"), contents);
  });
}

test("ZipCrypto UTF-8 Chinese password uses verified compatibility decoding", async () => {
  const archivePath = path.join(root, "zipcrypto.zip");
  const writer = new zip.ZipWriter(new zip.Uint8ArrayWriter(), { password: "中文传统密码", zipCrypto: true, useWebWorkers: false });
  await writer.add("说明.txt", new zip.TextReader(contents));
  await fs.writeFile(archivePath, await writer.close());
  const session = await engine.open(archivePath, "中文传统密码");
  await engine.test(session);
  const result = await engine.extract(session, await destination("zipcrypto"), { policy: "rename" });
  assert.equal(await fs.readFile(path.join(result.destination, "说明.txt"), "utf8"), contents);
});

test("deleting all entries produces a valid empty archive with original backup", async () => {
  for (const format of ["zip", "7z", "tar"]) {
    const archivePath = await createArchive(`empty-after-delete.${format}`, format);
    const session = await engine.open(archivePath);
    const original = await fs.readFile(archivePath);
    const result = await engine.deleteEntries(session, session.archive.entries.map((entry) => entry.id));
    assert.equal(result.session.flat.length, 0);
    assert.deepEqual(await fs.readFile(result.backupPath), original);
    await engine.test(result.session);
  }
});

test("cancelled delete preserves the original archive byte for byte", async () => {
  const archivePath = await createArchive("cancel-delete.zip", "zip");
  const session = await engine.open(archivePath);
  const original = await fs.readFile(archivePath);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(engine.deleteEntries(session, ["说明.txt"], { signal: controller.signal }), { code: "CANCELLED" });
  assert.deepEqual(await fs.readFile(archivePath), original);
});

test("ZSTD stream extraction uses a separately encoded frame", async () => {
  const { zstdCompressSync } = require("node:zlib");
  const archivePath = path.join(root, "content.txt.zst");
  await fs.writeFile(archivePath, zstdCompressSync(Buffer.from(contents)));
  const session = await engine.open(archivePath);
  const result = await engine.extract(session, await destination("zstd"), { policy: "rename" });
  const files = await fs.readdir(result.destination);
  assert.equal(files.length, 1);
  assert.equal(await fs.readFile(path.join(result.destination, files[0]), "utf8"), contents);
});
