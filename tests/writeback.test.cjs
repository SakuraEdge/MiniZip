"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { ArchiveEngine, safeRemoveOwned, hashFile } = require("../desktop/archive-engine.cjs");
const base = path.resolve(__dirname, "../.test-work");
let root, engine;

before(async () => {
  await fs.mkdir(base, { recursive: true });
  root = await fs.mkdtemp(path.join(base, "writeback-"));
  engine = new ArchiveEngine({ cacheRoot: path.join(root, "cache") });
});
after(async () => { if (root) await safeRemoveOwned(base, root); });

async function fixture(format, name = format) {
  const source = path.join(root, name + "-source");
  await fs.mkdir(path.join(source, "文档"), { recursive: true });
  await fs.writeFile(path.join(source, "文档/说明.txt"), "original content");
  await fs.writeFile(path.join(source, "unchanged.txt"), "unchanged");
  const archive = path.join(root, name + "." + format);
  await engine.run(engine.sevenZip, ["a", "-t" + format, archive, "*"], { cwd: source });
  return engine.open(archive);
}
async function replacement(name, content = "外部编辑后的内容") {
  const filePath = path.join(root, name + ".txt");
  await fs.writeFile(filePath, content);
  await fs.utimes(filePath, new Date("2000-01-01"), new Date("2000-01-01"));
  return { entryId: "文档/说明.txt", sourcePath: filePath, expectedHash: await hashFile(filePath) };
}

for (const format of ["zip", "7z", "tar"]) {
  test(`${format}: external changes replace older timestamps and preserve exact backup`, async () => {
    const session = await fixture(format);
    const original = await fs.readFile(session.archive.path);
    const result = await engine.updateEntries(session, [await replacement(format)]);
    assert.equal(result.updated, 1);
    assert.equal(result.session.archive.id, session.archive.id);
    assert.deepEqual(await fs.readFile(result.backupPath), original);
    assert.equal((await engine.preview(result.session, "文档/说明.txt")).content, "外部编辑后的内容");
    assert.equal((await engine.preview(result.session, "unchanged.txt")).content, "unchanged");
    await engine.close(result.session);
  });
}
test("writeback rejects stale archives, unexpected paths and mismatched editor snapshots", async () => {
  const session = await fixture("zip", "guards");
  const item = await replacement("guards");
  for (const entryId of ["../escape.txt", "new.txt"]) await assert.rejects(engine.updateEntries(session, [{ ...item, entryId }]));
  await assert.rejects(engine.updateEntries(session, [{ ...item, expectedHash: "0".repeat(64) }]), { code: "SOURCE_CHANGED" });
  const bytes = await fs.readFile(session.archive.path);
  await fs.appendFile(session.archive.path, "changed externally");
  await assert.rejects(engine.updateEntries(session, [item]), { code: "ARCHIVE_CHANGED" });
  assert.equal((await fs.readdir(root)).some((name) => name.startsWith("guards.zip.minizip-backup")), false);
  assert.ok(bytes.length);
});
test("cancelled or concurrently modified edit never replaces the original archive", async () => {
  const session = await fixture("zip", "cancel");
  const original = await fs.readFile(session.archive.path);
  const item = await replacement("cancel");
  const controller = new AbortController();
  await assert.rejects(engine.updateEntries(session, [item], { signal: controller.signal, onPhase: () => controller.abort() }), { code: "CANCELLED" });
  assert.deepEqual(await fs.readFile(session.archive.path), original);
  const changed = engine.updateEntries(session, [item], { onPhase(phase) { if (phase === "updating") require("node:fs").writeFileSync(item.sourcePath, "changed again"); } });
  await assert.rejects(changed, { code: "SOURCE_CHANGED" });
  assert.deepEqual(await fs.readFile(session.archive.path), original);
});
test("writeback rejects hard-linked editor files", async () => {
  const session = await fixture("zip", "links");
  const item = await replacement("links");
  const linked = path.join(root, "linked.txt");
  await fs.link(item.sourcePath, linked);
  await assert.rejects(engine.updateEntries(session, [{ ...item, sourcePath: linked }]), { code: "UNSAFE_LINK" });
});

for (const format of ["zip-aes", "zip-crypto", "7z"]) {
  test(`${format}: Chinese-password updates preserve encryption and unchanged entries`, async () => {
    const password = "中文密码 2026";
    const archive = path.join(root, "encrypted-" + format + (format === "7z" ? ".7z" : ".zip"));
    if (format.startsWith("zip")) {
      const zip = require("@zip.js/zip.js");
      const writer = new zip.ZipWriter(new zip.Uint8ArrayWriter(), { password, zipCrypto: format === "zip-crypto", useWebWorkers: false });
      await writer.add("文档/说明.txt", new zip.TextReader("original content"));
      await writer.add("unchanged.txt", new zip.TextReader("still encrypted"));
      await fs.writeFile(archive, await writer.close());
    } else {
      const source = path.join(root, "encrypted-seven");
      await fs.mkdir(path.join(source, "文档"), { recursive: true });
      await fs.writeFile(path.join(source, "文档/说明.txt"), "original content");
      await fs.writeFile(path.join(source, "unchanged.txt"), "still encrypted");
      await engine.run(engine.sevenZip, ["a", "-t7z", "-sccUTF-8", "-p", "-mhe=on", archive, "*"], { cwd: source, input: password + "\n" + password + "\n" });
    }
    const session = await engine.open(archive, password);
    assert.equal(session.archive.canUpdate, true);
    const original = await fs.readFile(archive);
    const result = await engine.updateEntries(session, [await replacement("encrypted-" + format)]);
    assert.deepEqual(await fs.readFile(result.backupPath), original);
    assert.equal((await engine.open(archive)).archive.locked, true);
    assert.equal((await engine.preview(result.session, "文档/说明.txt")).content, "外部编辑后的内容");
    assert.equal((await engine.preview(result.session, "unchanged.txt")).content, "still encrypted");
    const savedBytes = await fs.readFile(archive);
    const cancelled = new AbortController();
    await assert.rejects(engine.updateEntries(result.session, [await replacement("cancel-" + format)], { signal: cancelled.signal, onPhase(phase) { if (phase === "updating") cancelled.abort(); } }), { code: "CANCELLED" });
    assert.deepEqual(await fs.readFile(archive), savedBytes);
    await engine.close(result.session);
  });
}
