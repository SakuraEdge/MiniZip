"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

function decodeUU(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let started = false;
  const chunks = [];
  for (const line of lines) {
    if (/^begin \d+ /.test(line)) { started = true; continue; }
    if (!started || !line) continue;
    if (line === "end") break;
    const length = (line.charCodeAt(0) - 32) & 63;
    if (!length) continue;
    const bytes = [];
    for (let index = 1; index < line.length; index += 4) {
      const a = (line.charCodeAt(index) - 32) & 63, b = (line.charCodeAt(index + 1) - 32) & 63;
      const c = (line.charCodeAt(index + 2) - 32) & 63, d = (line.charCodeAt(index + 3) - 32) & 63;
      bytes.push((a << 2) | (b >> 4), ((b & 15) << 4) | (c >> 2), ((c & 3) << 6) | d);
    }
    chunks.push(Buffer.from(bytes.slice(0, length)));
  }
  return Buffer.concat(chunks);
}

(async () => {
  const root = path.resolve(__dirname, "..");
  const directory = path.join(root, "tests/fixtures/archives");
  await fs.mkdir(directory, { recursive: true });
  for (const name of ["test_read_format_rar.rar", "test_read_format_rar5_stored.rar"]) {
    const content = await fs.readFile(path.join(root, ".cache", name + ".uu"), "utf8");
    await fs.writeFile(path.join(directory, name), decodeUU(content));
    console.log("Decoded test fixture: " + name);
  }
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
