"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const { ArchiveEngine, safeRemoveOwned } = require("../desktop/archive-engine.cjs");

async function buildFixture(root, archive, mode = "write") {
  const src = await fs.mkdtemp(path.join(root, "fixture-"));
  try {
    const program = path.join(src, "Portable");
    await fs.mkdir(path.join(program, "assets"), { recursive: true });
    const compiler = path.join(process.env.SystemRoot, "Microsoft.NET/Framework64/v4.0.30319/csc.exe");
    execFileSync(compiler, ["/nologo", "/target:winexe", "/optimize+", "/out:" + path.join(program, "Counter.exe"), path.join(__dirname, "fixtures/portable-program/Counter.cs")], { windowsHide: true });
    await fs.writeFile(path.join(program, "config.txt"), "counter=0");
    if (mode !== "write") await fs.writeFile(path.join(program, "mode.txt"), mode);
    await fs.writeFile(path.join(program, "assets/runtime.txt"), "MiniZip portable QA");
    await fs.writeFile(path.join(src, "outside.txt"), "Not a program dependency");
    const engine = new ArchiveEngine({ cacheRoot: path.join(root, "cache") });
    await engine.run(engine.sevenZip, ["a", "-tzip", archive, "*"], { cwd: src });
  } finally { await safeRemoveOwned(root, src); }
}

async function baseline(root, archive, installedApp) {
  const { ArchiveEngine: InstalledEngine } = require(path.join(installedApp, "desktop/archive-engine.cjs"));
  const { EditSessions } = require(path.join(installedApp, "desktop/edit-sessions.cjs"));
  const external = require(path.join(installedApp, "desktop/external-file.cjs"));
  const engine = new InstalledEngine({ cacheRoot: path.join(root, "baseline-cache") });
  const edits = new EditSessions(engine, path.join(root, "isolated-temp"));
  let timer;
  try {
    const session = await engine.open(archive);
    const id = "Portable/Counter.exe", lease = await edits.acquire(session, id), folder = path.dirname(lease.filePath);
    const filesBefore = await fs.readdir(folder);
    await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("No process exit confirmation")), 15000);
      external.open(lease.filePath, async () => { try { await lease.finish(); resolve(); } catch (err) { reject(err); } }).catch(reject);
    });
    const report = { filesBefore, programResult: await fs.readFile(path.join(folder, "probe-missing.txt"), "utf8"), changed: edits.snapshot(session.archive.id).count, archivedConfig: (await engine.preview(session, "Portable/config.txt")).content };
    await engine.close(session); return report;
  } finally { clearTimeout(timer); external.dispose(); edits.dispose(); }
}
module.exports = { buildFixture };
if (require.main === module) (async () => {
  const output = path.resolve(__dirname, "../release");
  await fs.mkdir(output, { recursive: true });
  const folder = await fs.mkdtemp(path.join(output, "portable-check-")), archive = path.join(folder, "MiniZip-EXE-Test.zip");
  await buildFixture(folder, archive); console.log(archive);
  if (process.argv[2]) {
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "MiniZip-QA-baseline-"));
    try { console.log(JSON.stringify(await baseline(scratch, archive, path.resolve(process.argv[2])))); }
    finally { await safeRemoveOwned(os.tmpdir(), scratch); }
  }
})().catch(err => { console.error(err.message); process.exitCode = 1; });
