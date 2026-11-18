"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { parseTag, validRepository } = require("../desktop/updates.cjs");

(async () => {
  const root = path.resolve(__dirname, "..");
  const repository = process.env.GITHUB_REPOSITORY || process.argv[2];
  const tag = process.env.GITHUB_REF_NAME || process.argv[3] || "dev-v1.0.0";
  const parsed = parseTag(tag);
  if (!validRepository(repository) || !parsed) throw new Error("Expected owner/repository and dev-vX.Y.Z or rev-vX.Y.Z.");
  const config = { version: parsed.version, channel: parsed.channel, tag: parsed.tag, displayVersion: parsed.displayVersion, repository, installerName: `MiniZip-${parsed.channel}-${parsed.version}-Setup-x64.exe` };
  await fs.writeFile(path.join(root, "release-config.json"), JSON.stringify(config, null, 2) + "\n");
  const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  pkg.version = parsed.version + (parsed.channel === "Dev" ? "-dev.1" : "");
  pkg.repository = { type: "git", url: "https://github.com/" + repository + ".git" };
  pkg.homepage = "https://github.com/" + repository;
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
  console.log("Configured " + config.displayVersion + " for " + repository);
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
