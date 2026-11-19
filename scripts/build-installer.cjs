"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { build, Platform, Arch } = require("electron-builder");
const { sha256 } = require("../desktop/updates.cjs");
const config = require("../release-config.json");

(async () => {
  const root = path.resolve(__dirname, "..");
  const preview = process.argv.includes("--preview");
  const output = path.join(root, "release", preview ? "MiniZip-local-preview" : `MiniZip-${config.channel}-${config.version}`);
  const installerName = preview ? `MiniZip-${config.channel}-${config.version}-LocalPreview-Setup-x64.exe` : config.installerName;
  const prepackaged = path.join(output, "MiniZip-win32-x64");
  await fs.access(path.join(prepackaged, "MiniZip.exe"));
  for (const name of await fs.readdir(output)) {
    if (/^minizip-.*\.nsis\.7z$/.test(name)) await fs.unlink(path.join(output, name));
  }
  await build({ targets: Platform.WINDOWS.createTarget(["nsis"], Arch.x64), prepackaged, publish: "never", config: {
    appId: "MiniZip.Desktop", productName: "MiniZip", artifactName: installerName,
    directories: { output },
    win: { icon: path.join(root, "assets/minizip.ico"), requestedExecutionLevel: "asInvoker", signAndEditExecutable: false },
    nsis: { oneClick: false, perMachine: false, allowElevation: false, allowToChangeInstallationDirectory: true, createDesktopShortcut: true, createStartMenuShortcut: true, runAfterFinish: false, installerLanguages: ["zh_CN", "en_US"], language: "2052", displayLanguageSelector: false, include: path.join(root, "installer/integration.nsh"), installerIcon: path.join(root, "assets/minizip.ico"), uninstallerIcon: path.join(root, "assets/minizip.ico"), uninstallDisplayName: "MiniZip " + config.displayVersion, deleteAppDataOnUninstall: false },
    extraMetadata: { version: require("../package.json").version }
  } });
  const installer = path.join(output, installerName);
  const digest = await sha256(installer);
  await fs.writeFile(installer + ".sha256", `${digest}  ${installerName}\n`, "utf8");
  console.log("Installer: " + installer);
  console.log("SHA-256: " + digest);
})().catch((error) => { console.error(error); process.exitCode = 1; });
