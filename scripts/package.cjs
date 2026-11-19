"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { safeRemoveOwned } = require("../desktop/archive-engine.cjs");
const root = path.resolve(__dirname, "..");

async function findCachedElectron(directory) {
  const expected = `electron-v${require("electron/package.json").version}-win32-x64.zip`;
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
  for (const item of entries) {
    if (!item.isDirectory()) continue;
    const file = path.join(directory, item.name, expected);
    try { await fs.access(file); return path.dirname(file); } catch { /* Another cached release. */ }
  }
  return undefined;
}

async function main() {
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("This release targets Windows x64.");
  const stagingRoot = path.join(root, ".cache");
  await fs.mkdir(stagingRoot, { recursive: true });
  const staging = await fs.mkdtemp(path.join(stagingRoot, "package-"));
  const config = require("../release-config.json");
  const release = path.join(root, "release", `MiniZip-${config.channel}-${config.version}`);
  try {
    for (const file of ["index.html", "theme.css", "styles.css", "app.js", "core.js", "quick.html", "quick.css", "quick.js", "release-config.json", "package.json", "README.md", "THIRD_PARTY_NOTICES.md"]) await fs.copyFile(path.join(root, file), path.join(staging, file));
    for (const folder of ["desktop", "vendor"]) await fs.cp(path.join(root, folder), path.join(staging, folder), { recursive: true });
    await fs.mkdir(path.join(staging, "assets"));
    for (const asset of ["favicon.svg", "minizip.ico", "minizip.png", "archive.svg", "archive.ico"]) await fs.copyFile(path.join(root, "assets", asset), path.join(staging, "assets", asset));
    await fs.mkdir(path.join(staging, "node_modules/@zip.js"), { recursive: true });
    await fs.cp(path.join(root, "node_modules/@zip.js/zip.js"), path.join(staging, "node_modules/@zip.js/zip.js"), { recursive: true });
    await fs.mkdir(path.join(staging, "engines/7zip"), { recursive: true });
    await fs.mkdir(path.join(staging, "engines/lz4"), { recursive: true });
    for (const file of ["7z.exe", "7z.dll", "License.txt", "readme.txt", "History.txt"]) await fs.copyFile(path.join(root, "engines/7zip", file), path.join(staging, "engines/7zip", file));
    for (const file of ["lz4.exe", "COPYING", "README.md", "NEWS"]) await fs.copyFile(path.join(root, "engines/lz4", file), path.join(staging, "engines/lz4", file));
    const { packager } = await import("@electron/packager");
    const cached = await findCachedElectron(path.join(process.env.LOCALAPPDATA, "electron/Cache"));
    const outputPath = path.join(release, "MiniZip-win32-x64");
    try { await fs.access(outputPath); await safeRemoveOwned(path.join(root, "release"), outputPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
    const outputs = await packager({ dir: staging, out: release, name: "MiniZip", executableName: "MiniZip", icon: path.join(root, "assets/minizip.ico"), platform: "win32", arch: "x64", appVersion: config.version, buildVersion: config.version, electronVersion: require("electron/package.json").version, electronZipDir: cached, asar: false, prune: false, overwrite: false, win32metadata: { CompanyName: "MiniZip", ProductName: "MiniZip", FileDescription: "MiniZip " + config.displayVersion } });
    console.log("Built MiniZip: " + outputs.join(", "));
  } finally { await safeRemoveOwned(stagingRoot, staging); }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
