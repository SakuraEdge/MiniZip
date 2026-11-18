"use strict";
const path = require("node:path");

function parseLaunch(argv) {
  let mode = "open", positional = false;
  const paths = [];
  for (const value of argv) {
    if (value === "--") { positional = true; continue; }
    if (!positional && ["--compress", "--compress-zip", "--compress-7z", "--extract-here", "--extract-to", "--extract-folder"].includes(value)) { mode = value.slice(2); continue; }
    if (!positional && value === "--open") { mode = "open"; continue; }
    if (!positional && value === "--default-apps") { mode = "defaults"; continue; }
    if (!positional && value.startsWith("-")) continue;
    if (path.isAbsolute(value) && !/[\r\n\0]/.test(value)) paths.push(path.resolve(value));
  }
  return { mode, paths: [...new Set(paths)].slice(0, 1000) };
}
module.exports = { parseLaunch };
