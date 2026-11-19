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
    await edits.close(session.archive.id);
    assert.equal(await fs.readFile(filePath, "utf8"), "late save");
    const manifest = await scanInputs([archive]);
    assert.equal(manifest.defaultName, "source.zip");
    await engine.close(result.session);
  } finally { edits.dispose(); await safeRemoveOwned(base, root); }
});

test("last external close reclaims clean copies; dirty files wait for verified writeback or explicit discard", async () => {
  const base = path.resolve(__dirname, "../.test-work"); await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, "edit-lifetime-"));
  const engine = new ArchiveEngine({ cacheRoot: path.join(root, "cache") });
  const edits = new EditSessions(engine, path.join(root, "temp"));
  try {
    const source = path.join(root, "source"); await fs.mkdir(source);
    await fs.writeFile(path.join(source, "one.txt"), "original"); await fs.writeFile(path.join(source, "other.dll"), "not selected");
    const archive = path.join(root, "source.zip"); await engine.run(engine.sevenZip, ["a", "-tzip", archive, "*"], { cwd: source });
    const session = await engine.open(archive), id = session.archive.id;
    const a = await edits.acquire(session, "one.txt"), b = await edits.acquire(session, "one.txt");
    assert.equal(a.filePath, b.filePath); assert.deepEqual(await fs.readdir(path.dirname(a.filePath)), ["one.txt"]);
    await a.finish(); assert.equal(await fs.readFile(b.filePath, "utf8"), "original");
    await b.finish(); await assert.rejects(fs.stat(edits.directory), { code: "ENOENT" });
    const c = await edits.acquire(session, "one.txt");
    await fs.writeFile(c.filePath, "write this"); await c.finish(); assert.equal(edits.snapshot(id).count, 1);
    assert.equal(await fs.readFile(c.filePath, "utf8"), "write this");
    const result = await edits.save(session);
    assert.equal((await engine.preview(result.session, "one.txt")).content, "write this");
    await assert.rejects(fs.stat(c.filePath), { code: "ENOENT" });
    const d = await edits.acquire(result.session, "one.txt");
    await fs.writeFile(d.filePath, "do not save"); await d.finish();
    const confirmation = edits.discardCandidates(id); await fs.writeFile(d.filePath, "late edit");
    await assert.rejects(edits.discard(id, confirmation), { code: "SOURCE_CHANGED" });
    assert.equal(await fs.readFile(d.filePath, "utf8"), "late edit");
    await edits.scan(id, true); await edits.discard(id, edits.discardCandidates(id));
    await assert.rejects(fs.stat(d.filePath), { code: "ENOENT" });
    assert.equal((await engine.preview(result.session, "one.txt")).content, "write this");
    const last = await edits.acquire(result.session, "one.txt");
    const other = path.join(path.dirname(last.filePath), "editor notes.bak"); await fs.writeFile(other, "not ours");
    await edits.close(id, { finished: true });
    assert.equal(await fs.readFile(other, "utf8"), "not ours"); await assert.rejects(fs.stat(last.filePath), { code: "ENOENT" });
  } finally { edits.dispose(); await safeRemoveOwned(base, root); }
});

test("Windows external helper observes a real launched program exit and refuses cleanup during an exclusive lock", { timeout: 20000 }, async () => {
  const external = require("../desktop/external-file.cjs");
  const { execFileSync, spawn } = require("node:child_process"), { createHash } = require("node:crypto");
  const base = path.resolve(__dirname, "../.test-work"); await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, "helper-test-"));
  let locker, release, timeout;
  try {
    const file = path.join(root, "held.txt"), exe = path.join(root, "holder.exe"), cs = path.join(root, "holder.cs");
    const contents = "keep until unlocked", hash = createHash("sha256").update(contents).digest("hex");
    await fs.writeFile(file, contents);
    await fs.writeFile(cs, 'using System; using System.IO; using System.Threading; class Holder { static void Main(string[] args) { if(args.Length > 0) { using(var f = File.Open(args[0], FileMode.Open, FileAccess.Read, FileShare.None)) { Console.WriteLine("locked"); Console.ReadLine(); } } else Thread.Sleep(200); } }');
    execFileSync(path.join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'), ['/nologo', '/out:' + exe, cs], { windowsHide: true });
    locker = spawn(exe, [file], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    release = new Promise(resolve => locker.once("close", resolve));
    await new Promise((resolve, reject) => { locker.stdout.once("data", resolve); locker.once("error", reject); });
    assert.equal(await external.removeVerified(file, hash), false);
    locker.stdin.end("\n"); await release;
    assert.equal(await external.removeVerified(file, hash), true);
    const closed = new Promise((resolve, reject) => { timeout = setTimeout(() => reject(new Error("no confirmed exit")), 8000); external.open(exe, resolve).catch(reject); });
    await closed;
  } finally { clearTimeout(timeout); locker?.kill(); await release; external.dispose(); await safeRemoveOwned(base, root); }
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
