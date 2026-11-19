"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { ArchiveEngine, safeRemoveOwned, hashFile } = require("../desktop/archive-engine.cjs");
const { ProgramRuns } = require("../desktop/program-runs.cjs");
const { buildFixture } = require("./portable-fixture.cjs");

const base = path.resolve(__dirname, "../.test-work");
let root, engine;
before(async () => {
  await fs.mkdir(base, { recursive: true }); root = await fs.mkdtemp(path.join(base, "real-exe-"));
  engine = new ArchiveEngine({ cacheRoot: path.join(root, "engine") });
});
after(async () => { if (root) await safeRemoveOwned(base, root); });

async function fixture(name, mode = "write") {
  const archive = path.join(root, name + ".zip"); await buildFixture(root, archive, mode);
  const session = await engine.open(archive), events = [];
  const runs = new ProgramRuns(engine, path.join(root, name + "-temp"), e => events.push(e));
  const original = await hashFile(archive);
  await runs.launch(session, "Portable/Counter.exe");
  const id = session.archive.id;
  const runDir = events.find(e => e.phase === "running").directory;
  async function wait(phase) {
    for (let n = 0; n < 150; n++) {
      const state = runs.state(id);
      if (state.phase === phase) return state;
      if (state.phase.endsWith("-error") || state.phase === "untracked" || state.phase === "idle") assert.fail(JSON.stringify(state));
      await delay(80);
    }
    assert.fail("No " + phase + " after " + events.map(e => e.phase));
  }
  return { runs, archive, id, session, runDir, original, events, wait };
}
const gone = p => assert.rejects(fs.stat(p), { code: "ENOENT" });

for (const action of ["save", "discard"]) test(`actual archived EXE: ${action} existing + new data and remove the entire workspace`, async () => {
  const f = await fixture(action);
  const notice = await f.wait("review");
  assert.deepEqual(notice.changes, [{ id: "Portable/config.txt", type: "modified" }, { id: "Portable/data/last-run.txt", type: "added" }]);
  await gone(path.join(f.runDir, "files", "outside.txt"));
  assert.equal(await hashFile(f.archive), f.original);
  assert.equal(await fs.readFile(path.join(f.runDir, "files/Portable/config.txt"), "utf8"), "counter=1");
  const result = await f.runs.decide(f.id, notice.token, notice.revision, action === "save");
  await gone(f.runDir); await gone(f.runs.directory);
  assert.equal(f.runs.state(f.id).phase, "idle");
  const reopened = await engine.open(f.archive);
  assert.equal((await engine.preview(reopened, "outside.txt")).content, "Not a program dependency");
  if (action === "save") {
    assert.equal(await hashFile(result.backupPath), f.original);
    assert.equal((await engine.preview(reopened, "Portable/config.txt")).content, "counter=1");
    assert.equal((await engine.preview(reopened, "Portable/data/last-run.txt")).content, "saved=1");
  } else {
    assert.equal(await hashFile(f.archive), f.original);
    assert.equal(reopened.flat.some(e => e.path === "Portable/data/last-run.txt"), false);
  }
});

test("fast, unchanged EXE exits without a prompt or any leftover directory", async () => {
  const f = await fixture("unchanged", "unchanged");
  await f.wait("idle"); assert.ok(!f.events.some(e => e.phase === "review"));
  await gone(f.runDir); await gone(f.runs.directory); assert.equal(await hashFile(f.archive), f.original);
});

test("waits for child writes; stale discard and changed source cannot lose data", async () => {
  const f = await fixture("child", "child"); const first = await f.wait("review");
  assert.equal(first.changes.length, 2);
  const copy = path.join(f.runDir, "files/Portable/config.txt");
  await fs.writeFile(copy, "counter=2");
  await assert.rejects(f.runs.decide(f.id, first.token, first.revision, false), { code: "SOURCE_CHANGED" });
  await assert.rejects(f.runs.decide(f.id, first.token, first.revision, true), { code: "STALE_DECISION" });
  await fs.appendFile(f.archive, "changed outside MiniZip");
  const diskHash = await hashFile(f.archive), next = f.runs.state(f.id);
  await assert.rejects(f.runs.decide(f.id, next.token, next.revision, true), { code: "ARCHIVE_CHANGED" });
  assert.equal(await fs.readFile(copy, "utf8"), "counter=2"); assert.equal(await hashFile(f.archive), diskHash);
  await f.runs.decide(f.id, next.token, next.revision, false); await gone(f.runDir);
});
