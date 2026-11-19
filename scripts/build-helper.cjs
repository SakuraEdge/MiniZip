"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const target = path.join(root, "engines/shell/MiniZip.ExternalFile.exe");
async function buildHelper() {
  const source = path.join(root, "native/ExternalFile.cs");
  const previous = await fs.stat(target).catch(() => null);
  if (previous && previous.mtimeMs >= (await fs.stat(source)).mtimeMs) return target;
  await fs.mkdir(path.dirname(target), { recursive: true });
  const compiler = path.join(process.env.SystemRoot, "Microsoft.NET/Framework64/v4.0.30319/csc.exe");
  execFileSync(compiler, ["/nologo", "/target:exe", "/optimize+", "/platform:x64", "/out:" + target, source], { windowsHide: true, stdio: "inherit" });
  return target;
}
module.exports = { buildHelper };
if (require.main === module) buildHelper().catch(error => { console.error(error.message); process.exitCode = 1; });
