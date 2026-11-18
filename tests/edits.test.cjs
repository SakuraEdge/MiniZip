"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { ArchiveEngine, safeRemoveOwned } = require("../desktop/archive-engine.cjs");
const { EditSessions, isExecutable } = require("../desktop/edit-sessions.cjs");
const { parseLaunch } = require("../desktop/launch.cjs");
const { scanInputs } = require("../desktop/compress-engine.cjs");

test("Explorer launch actions preserve literal paths and select extraction or compression", () => {
  for (const mode of ["compress", "compress-zip", "compress-7z", "extract-here", "extract-to", "extract-folder"]) {
    const parsed = parseLaunch(["--" + mode, "--", "D:\\文件夹\\中文.zip"]);
    assert.equal(parsed.mode, mode); assert.deepEqual(parsed.paths, ["D:\\文件夹\\中文.zip"]);
  }
  assert.equal(parseLaunch(["--", "--extract-here", "D:\\a.zip"]).mode, "open");
});
test("executable and script types require the explicit run confirmation", () => {
  for (const filename of ["a.EXE", "a.cmd", "a.ps1", "a.lnk", "a.url", "a.hta", "a.reg", "a.js"]) assert.equal(isExecutable(filename), true);
  for (const filename of ["a.pdf", "a.txt", "a.zip", "a.docx"]) assert.equal(isExecutable(filename), false);
});
test("external atomic saves are detected, persisted and exported without deleting late editor copies", async () => {
  const base = path.resolve(__dirname, "../.test-work");
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, "edit-session-"));
  const engine = new ArchiveEngine({ cacheRoot: path.join(root, "cache") });
  const edits = new EditSessions(engine, path.join(root, "work"));
  try {
    const source = path.join(root, "source"); await fs.mkdir(source);
    await fs.writeFile(path.join(source, "说明.txt"), "same length");
    const archive = path.join(root, "source.zip");
    await engine.run(engine.sevenZip, ["a", "-tzip", archive, "*"], { cwd: source });
    if (process.platform === "win32") await fs.writeFile(archive + ":Zone.Identifier", "[ZoneTransfer]\r\nZoneId=3\r\n");
    const session = await engine.open(archive);
    const filePath = await edits.prepare(session, "说明.txt");
    if (process.platform === "win32") assert.match(await fs.readFile(filePath + ":Zone.Identifier", "utf8"), /ZoneId=3/);
    assert.equal(await edits.prepare(session, "说明.txt"), filePath);
    assert.equal((await edits.scan(session.archive.id, true)).count, 0);
    const swapped = filePath + ".new";
    await fs.writeFile(swapped, "edited data");
    await fs.rename(swapped, filePath);
    assert.equal((await edits.scan(session.archive.id, true)).count, 1);
    const result = await edits.save(session);
    assert.equal((await edits.scan(session.archive.id, true)).count, 0);
    assert.equal((await engine.preview(result.session, "说明.txt")).content, "edited data");
    await fs.writeFile(filePath, "late save");
    assert.equal((await edits.scan(session.archive.id, true)).count, 1);
    const exported = await edits.exportChanges(session.archive.id, root);
    assert.equal(await fs.readFile(path.join(exported, "说明.txt"), "utf8"), "late save");
    edits.close(session.archive.id);
    assert.equal(await fs.readFile(filePath, "utf8"), "late save");
    const manifest = await scanInputs([archive]);
    assert.equal(manifest.defaultName, "source.zip");
    await engine.close(result.session);
  } finally { edits.dispose(); await safeRemoveOwned(base, root); }
});
test("read-only archive edits retain changes and offer export without rewriting RAR", async () => {
  const base = path.resolve(__dirname, "../.test-work"); await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, "readonly-edit-"));
  const archive = path.join(root, "readonly.rar");
  await fs.copyFile(path.join(__dirname, "fixtures/archives/test_read_format_rar5_stored.rar"), archive);
  const original = await fs.readFile(archive);
  const engine = new ArchiveEngine({ cacheRoot: path.join(root, "cache") });
  const edits = new EditSessions(engine, path.join(root, "work"));
  try {
    const session = await engine.open(archive);
    const target = await edits.prepare(session, "helloworld.txt");
    await fs.writeFile(target, "changed read-only member");
    assert.equal((await edits.scan(session.archive.id, true)).canUpdate, false);
    await assert.rejects(edits.save(session), { code: "READ_ONLY" });
    assert.deepEqual(await fs.readFile(archive), original);
    assert.equal((await edits.scan(session.archive.id, true)).count, 1);
    await fs.unlink(target);
    assert.equal((await edits.scan(session.archive.id, true)).entries[0].missing, true);
    await assert.rejects(edits.save(session), { code: "EDIT_MISSING" });
    await engine.close(session);
  } finally { edits.dispose(); await safeRemoveOwned(base, root); }
});
