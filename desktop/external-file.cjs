"use strict";
const path = require("node:path");
const { spawn, execFile } = require("node:child_process");
const { createInterface } = require("node:readline");
const { ArchiveError, rejectLinks } = require("./archive-engine.cjs");
const helper = path.resolve(__dirname, "../engines/shell/MiniZip.ExternalFile.exe");
const monitors = new Set();

function open(file, onClosed, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(helper, [options.program ? "program" : "open", file], { windowsHide: true, shell: false, stdio: ["ignore", "pipe", "ignore"] });
    monitors.add(child);
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    let opened = false, closed = false;
    lines.on("line", line => {
      if (line === "OPENED") { opened = true; resolve(); }
      if (line === "CLOSED" && opened && !closed) { closed = true; Promise.resolve().then(onClosed).catch(() => {}); }
    });
    const finished = () => {
      monitors.delete(child); lines.close();
      if (!opened) reject(new ArchiveError("OPEN_FAILED", "无法启动此文件的默认应用，请检查 Windows 打开方式，或先解压到指定目录。"));
      else if (!closed) options.onUntracked?.();
    };
    child.once("error", finished); child.once("close", finished);
  });
}
async function removeBatch(root, entries) {
  await rejectLinks(root);
  if (!entries.length) return true;
  return new Promise(resolve => {
    const child = spawn(helper, ["clean-batch", root], { windowsHide: true, shell: false, stdio: ["pipe", "ignore", "ignore"] });
    child.once("error", () => resolve(false)); child.once("close", code => resolve(code === 0));
    child.stdin.on("error", () => {});
    child.stdin.end(entries.map(x => x.hash + "\t" + Buffer.from(x.id).toString("base64") + "\n").join(""), "ascii");
  });
}
async function removeVerified(file, hash) {
  await rejectLinks(file);
  return new Promise(resolve => execFile(helper, ["clean", file, hash], { windowsHide: true, shell: false }, error => resolve(!error)));
}
// Releasing a monitor never terminates the associated editor.
function dispose() { for (const child of monitors) child.kill(); }
module.exports = { open, removeVerified, removeBatch, dispose };
