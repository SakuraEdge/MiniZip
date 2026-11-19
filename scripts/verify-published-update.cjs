"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const config = require("../release-config.json");

(async () => {
  const [priorPath, priorTag] = process.argv.slice(2);
  if (!priorPath || !priorTag) throw new Error("Expected previous MiniZip resources/app path and release tag.");
  const previous = path.resolve(priorPath);
  const oldConfig = require(path.join(previous, "release-config.json"));
  assert.equal(oldConfig.tag, priorTag);
  assert.equal(oldConfig.repository, config.repository);
  const { UpdateService, sha256 } = require(path.join(previous, "desktop/updates.cjs"));
  const { safeRemoveOwned } = require(path.join(previous, "desktop/archive-engine.cjs"));
  const root = path.resolve(__dirname, ".."), base = path.join(root, ".test-work");
  await fs.mkdir(base, { recursive: true });
  const work = await fs.mkdtemp(path.join(base, "published-update-"));
  try {
    // Use the installed release's actual network transport without injected credentials or mocks.
    const updater = new UpdateService(oldConfig, work);
    await updater.init();
    const found = await updater.check();
    assert.equal(found.status, "available", found.error || found.status);
    assert.equal(found.available.tag, config.tag);
    assert.equal(found.available.canDownload, true);
    const normalize = (s) => s.replace(/\r\n/g, "\n").trim();
    const notes = await fs.readFile(path.join(root, "releases", `${config.tag}.md`), "utf8");
    assert.equal(normalize(found.available.notes), normalize(notes));
    console.log(`${oldConfig.displayVersion} detected ${found.available.displayVersion}; public release notes match.`);
    const downloaded = await updater.download();
    assert.equal(downloaded.status, "ready", downloaded.error || downloaded.status);
    const file = await updater.installer(); // Verify again, but never launch the installer.
    assert.equal(path.basename(file), config.installerName);
    assert.equal((await fs.stat(file)).size, found.available.size);
    console.log(`Verified public installer: ${config.installerName}, SHA-256 ${await sha256(file)}`);
  } finally { await safeRemoveOwned(base, work); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
