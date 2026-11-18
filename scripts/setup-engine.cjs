"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { spawn } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const cache = path.join(root, ".cache");
const resources = [
  { name: "7z2606-x64.exe", url: "https://github.com/ip7z/7zip/releases/download/26.06/7z2606-x64.exe", sha256: "9b697f65ecc2d9b0152f5ee96d72dde522a7827690349d9307935dacf40f42ec", destination: "engines/7zip" },
  { name: "lz4_win64_v1_10_0.zip", url: "https://github.com/lz4/lz4/releases/download/v1.10.0/lz4_win64_v1_10_0.zip", sha256: "8cb562a53189dfc8a53ec12469b91f1b51a5075036061a86b55738183bf4ab74", destination: "engines/lz4" }
];
async function main() {
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("The current bundled engine targets Windows x64.");
  await fs.mkdir(cache, { recursive: true });
  for (const resource of resources) {
    const archive = path.join(cache, resource.name);
    let data;
    try { data = await fs.readFile(archive); } catch {
      const response = await fetch(resource.url);
      if (!response.ok) throw new Error("Download failed: " + response.status);
      data = Buffer.from(await response.arrayBuffer());
    }
    if (createHash("sha256").update(data).digest("hex") !== resource.sha256) throw new Error("Checksum mismatch for " + resource.name);
    await fs.writeFile(archive, data);
    const destination = path.join(root, resource.destination);
    await fs.mkdir(destination, { recursive: true });
    await new Promise((resolve, reject) => {
      const child = spawn(require("7zip-bin").path7za, ["x", archive, "-o" + destination, "-y"], { windowsHide: true, stdio: "inherit", shell: false });
      child.on("error", reject); child.on("close", (code) => code === 0 ? resolve() : reject(new Error("Engine extraction failed")));
    });
    console.log("Verified " + resource.name);
  }
  const license = await fetch("https://raw.githubusercontent.com/lz4/lz4/v1.10.0/programs/COPYING");
  if (!license.ok) throw new Error("LZ4 license download failed");
  await fs.writeFile(path.join(root, "engines/lz4/COPYING"), await license.text());
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
