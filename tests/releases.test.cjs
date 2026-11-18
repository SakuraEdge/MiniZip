"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseTag, compareVersions, selectRelease, validRepository, validateAssetUrl } = require("../desktop/updates.cjs");
const { parseLaunch } = require("../desktop/launch.cjs");
const { UpdateService } = require("../desktop/updates.cjs");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { Readable } = require("node:stream");
const { safeRemoveOwned } = require("../desktop/archive-engine.cjs");

test("Dev and Rev tags parse with numeric versions", () => {
  assert.equal(parseTag("dev-v1.0.0").displayVersion, "Dev v1.0.0");
  assert.equal(parseTag("rev-v1.0.0").channel, "Rev");
  assert.equal(parseTag("dev-v01.0.0"), null);
  assert.ok(compareVersions(parseTag("dev-v1.10.0"), parseTag("dev-v1.9.0")) > 0);
  assert.ok(compareVersions(parseTag("rev-v1.0.0"), parseTag("dev-v1.0.0")) > 0);
});
test("release filtering excludes drafts and Dev when disabled", () => {
  const releases = [{ tag_name: "dev-v2.0.0", prerelease: true }, { tag_name: "rev-v1.0.0", prerelease: false }, { tag_name: "rev-v3.0.0", draft: true }, { tag_name: "rev-v4.0.0", prerelease: true }];
  assert.equal(selectRelease(releases, parseTag("dev-v1.0.0"), false).parsed.tag, "rev-v1.0.0");
  assert.equal(selectRelease(releases, parseTag("dev-v1.0.0"), true).parsed.tag, "dev-v2.0.0");
  assert.equal(selectRelease(releases, parseTag("rev-v2.0.0"), false), null);
});
test("updates only accept matching GitHub release asset URLs", () => {
  assert.equal(validRepository("example/MiniZip"), true);
  assert.equal(validRepository("../private"), false);
  assert.equal(validRepository(null), false);
  const good = "https://github.com/example/MiniZip/releases/download/dev-v1.0.1/MiniZip-Dev-1.0.1-Setup-x64.exe";
  assert.doesNotThrow(() => validateAssetUrl(good, "example/MiniZip", "dev-v1.0.1", "MiniZip-Dev-1.0.1-Setup-x64.exe"));
  for (const bad of [good.replace("https:", "http:"), good.replace("github.com", "github.com.evil.test"), good.replace("example", "other"), good + "?redirect=1", good.replace("dev-v1.0.1", "dev-v9.0.0")]) assert.throws(() => validateAssetUrl(bad, "example/MiniZip", "dev-v1.0.1", "MiniZip-Dev-1.0.1-Setup-x64.exe"));
});
test("launch parser separates mode and literal Unicode paths", () => {
  const value = parseLaunch(["--compress", "--", "D:\\文件夹\\中文 文件.txt", "D:\\数据\\-option.txt"]);
  assert.equal(value.mode, "compress"); assert.equal(value.paths.length, 2);
  assert.equal(parseLaunch(["--open", "--", "D:\\test.zip"]).paths.length, 1);
  assert.equal(parseLaunch(["--default-apps"]).mode, "defaults");
  assert.equal(parseLaunch(["--compress", "relative.txt", "D:\\bad\nfile.txt"]).paths.length, 0);
});

test("update service checks releases, verifies downloads and detects later tampering", async () => {
  const base = path.resolve(__dirname, "../.test-work"); await fs.mkdir(base, { recursive: true });
  const directory = await fs.mkdtemp(path.join(base, "updates-"));
  const bytes = Buffer.from("installer test payload");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const name = "MiniZip-Dev-1.0.1-Setup-x64.exe";
  const assetUrl = `https://github.com/example/MiniZip/releases/download/dev-v1.0.1/${name}`;
  const releases = [{ tag_name: "dev-v1.0.1", prerelease: true, body: "# Changes\nFixes and improvements", assets: [{ name, browser_download_url: assetUrl, size: bytes.length, digest: "sha256:" + digest }] }];
  const transport = { getText: async () => JSON.stringify(releases), request: async () => Readable.from([bytes]) };
  const service = new UpdateService({ displayVersion: "Dev v1.0.0", channel: "Dev", tag: "dev-v1.0.0", repository: "example/MiniZip" }, directory, () => {}, transport);
  try {
    await service.init();
    const available = await service.check();
    assert.equal(available.status, "available"); assert.equal(available.available.displayVersion, "Dev v1.0.1");
    assert.equal(available.available.notes, releases[0].body);
    assert.equal((await service.download()).status, "ready");
    const installer = await service.installer(); assert.deepEqual(await fs.readFile(installer), bytes);
    await fs.appendFile(installer, "tampered");
    await assert.rejects(service.installer(), { code: "UPDATE_HASH" });
    await service.preferences({ autoCheck: false, allowDev: false });
    assert.equal((await service.check()).status, "current");
    const restored = new UpdateService(service.config, directory); await restored.init();
    assert.equal(restored.state.autoCheck, false); assert.equal(restored.state.allowDev, false);
  } finally { await safeRemoveOwned(base, directory); }
});

test("hash mismatch never exposes an installable file and missing repository is explicit", async () => {
  const base = path.resolve(__dirname, "../.test-work"); await fs.mkdir(base, { recursive: true });
  const directory = await fs.mkdtemp(path.join(base, "updates-invalid-"));
  const name = "MiniZip-Rev-1.0.0-Setup-x64.exe";
  const releases = [{ tag_name: "rev-v1.0.0", assets: [{ name, browser_download_url: `https://github.com/example/MiniZip/releases/download/rev-v1.0.0/${name}`, digest: "sha256:" + "0".repeat(64), size: 4 }] }];
  try {
    const service = new UpdateService({ displayVersion: "Dev v1.0.0", channel: "Dev", tag: "dev-v1.0.0", repository: "example/MiniZip" }, directory, () => {}, { getText: async () => JSON.stringify(releases), request: async () => Readable.from([Buffer.from("data")]) });
    await service.init(); await service.check();
    assert.equal((await service.download()).status, "error");
    assert.match(service.state.error, /校验失败/);
    await assert.rejects(service.installer(), { code: "UPDATE_ASSET" });
    assert.equal((await fs.readdir(directory)).some((item) => item.startsWith("download-")), false);
    service.config.repository = null;
    assert.equal((await service.check()).status, "error");
    assert.match(service.state.error, /仓库尚未配置/);
  } finally { await safeRemoveOwned(base, directory); }
});
