"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { parseTag, validRepository } = require("../desktop/updates.cjs");

(async () => {
  const root = path.resolve(__dirname, "..");
  const repository = process.env.GITHUB_REPOSITORY || process.argv[2];
  const tag = process.env.GITHUB_REF_NAME || process.argv[3];
  const parsed = parseTag(tag);
  if (!validRepository(repository) || !parsed) throw new Error("Expected owner/repository and dev-vX.Y.Z or rev-vX.Y.Z.");
  const config = { version: parsed.version, channel: parsed.channel, tag: parsed.tag, displayVersion: parsed.displayVersion, repository, installerName: `MiniZip-${parsed.channel}-${parsed.version}-Setup-x64.exe` };
  await fs.writeFile(path.join(root, "release-config.json"), JSON.stringify(config, null, 2) + "\n");
  const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  pkg.version = parsed.version + (parsed.channel === "Dev" ? "-dev.1" : "");
  pkg.repository = { type: "git", url: "https://github.com/" + repository + ".git" };
  pkg.homepage = "https://github.com/" + repository;
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
  const lockPath = path.join(root, "package-lock.json");
  const lock = JSON.parse(await fs.readFile(lockPath, "utf8"));
  lock.version = lock.packages[""].version = pkg.version;
  await fs.writeFile(lockPath, JSON.stringify(lock, null, 2) + "\n");
  for (const [file, className] of [["index.html", "preview-tag"], ["quick.html", "version"]]) {
    const target = path.join(root, file);
    const html = await fs.readFile(target, "utf8");
    const stamp = new RegExp(`(<span class="${className}">)(?:Dev|Rev) v\\d+\\.\\d+\\.\\d+(</span>)`);
    if (!stamp.test(html)) throw new Error("Release badge not found: " + file);
    await fs.writeFile(target, html.replace(stamp, "$1" + config.displayVersion + "$2"), "utf8");
  }
  console.log("Configured " + config.displayVersion + " for " + repository);
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
