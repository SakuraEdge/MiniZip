"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { ArchiveEngine, safeRemoveOwned } = require("../desktop/archive-engine.cjs");
const { scanInputs, compress } = require("../desktop/compress-engine.cjs");
let root, source, engine;
const base = path.resolve(__dirname, "../.test-work");
before(async () => {
  await fs.mkdir(base, { recursive: true }); root = await fs.mkdtemp(path.join(base, "compress-"));
  source = path.join(root, "输入 文档"); await fs.mkdir(path.join(source, "子目录"), { recursive: true });
  await fs.mkdir(path.join(source, "空目录"));
  await fs.writeFile(path.join(source, "说明.txt"), "中文内容与文件名\n");
  await fs.writeFile(path.join(source, "子目录", "@-特殊名称.txt"), "special filename");
  engine = new ArchiveEngine({ cacheRoot: path.join(root, "cache") });
});
after(async () => { await safeRemoveOwned(base, root); });

for (const format of ["zip", "7z"]) for (const password of ["", "中文密码 2026"]) {
  test(`${format} creates verified archive${password ? " with Chinese password" : ""} and keeps inputs`, async () => {
    const manifest = await scanInputs([source]);
    assert.equal(manifest.files, 2);
    const target = path.join(root, `created-${format}-${password ? "encrypted" : "plain"}.${format}`);
    const result = await compress(engine, manifest, target, { format, password, level: "fast" });
    assert.equal(result.files, 2);
    assert.ok(result.size > 0);
    assert.equal(await fs.readFile(path.join(source, "说明.txt"), "utf8"), "中文内容与文件名\n");
    const session = await engine.open(target, password);
    assert.equal(session.archive.locked, false);
    await engine.test(session);
    const destination = path.join(root, `unzip-${format}-${password ? "encrypted" : "plain"}`);
    await engine.extract(session, destination, { policy: "rename" });
    assert.equal(await fs.readFile(path.join(destination, "输入 文档/说明.txt"), "utf8"), "中文内容与文件名\n");
    await engine.close(session);
  });
}
test("output inside source and overwriting source are denied", async () => {
  const manifest = await scanInputs([source]);
  await assert.rejects(compress(engine, manifest, path.join(source, "bad.zip"), { format: "zip" }), { code: "SOURCE_COLLISION" });
});
test("overwrite requires opt-in and preserves backup", async () => {
  const manifest = await scanInputs([source]); const target = path.join(root, "overwrite.zip");
  await fs.writeFile(target, "existing archive bytes");
  await assert.rejects(compress(engine, manifest, target, { format: "zip" }), { code: "EXISTS" });
  const result = await compress(engine, manifest, target, { format: "zip", overwrite: true });
  assert.equal(await fs.readFile(result.backupPath, "utf8"), "existing archive bytes");
});
test("cancel leaves no output and keeps source", async () => {
  const manifest = await scanInputs([source]); const target = path.join(root, "cancel.zip");
  const controller = new AbortController(); controller.abort();
  await assert.rejects(compress(engine, manifest, target, { format: "zip" }, { signal: controller.signal }), { code: "CANCELLED" });
  await assert.rejects(fs.access(target), { code: "ENOENT" });
  assert.equal((await fs.readdir(root)).some((entry) => entry.startsWith(".minizip-compress-")), false);
});
test("modified source and unsafe junction inputs are rejected", async () => {
  const temporary = path.join(root, "change.txt"); await fs.writeFile(temporary, "before");
  const manifest = await scanInputs([temporary]); await fs.writeFile(temporary, "after changes");
  await assert.rejects(compress(engine, manifest, path.join(root, "change.zip"), { format: "zip" }), { code: "SOURCE_CHANGED" });
  const junction = path.join(root, "junction"); await fs.symlink(source, junction, "junction");
  await assert.rejects(scanInputs([junction]), { code: "UNSAFE_LINK" });
});
