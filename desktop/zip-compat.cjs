"use strict";

const fs = require("node:fs/promises");
const zip = require("@zip.js/zip.js");
zip.configure({ useWebWorkers: false });

class FileReader extends zip.Reader {
  constructor(filePath) { super(filePath); this.filePath = filePath; }
  async init() { this.handle = await fs.open(this.filePath, "r"); this.size = (await this.handle.stat()).size; }
  async readUint8Array(index, length) {
    const buffer = Buffer.alloc(Math.min(length, this.size - index));
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await this.handle.read(buffer, offset, buffer.length - offset, index + offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    return new Uint8Array(buffer.buffer, buffer.byteOffset, offset);
  }
}

async function readEntries(filePath, callback) {
  const source = new FileReader(filePath);
  const reader = new zip.ZipReader(source);
  try { return await callback(await reader.getEntries()); }
  finally { await reader.close(); await source.handle?.close(); }
}

async function streamEntry(entry, password, destination, options = {}) {
  let handle;
  let bytes = 0;
  try {
    if (destination) handle = await fs.open(destination, "wx");
    const writable = new WritableStream({
      async write(chunk) {
        bytes += chunk.length;
        if (bytes > (options.maxBytes || entry.uncompressedSize)) throw Object.assign(new Error("解压结果超过声明大小。"), { code: "LIMIT" });
        if (handle) {
          let offset = 0;
          while (offset < chunk.length) {
            const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
            offset += bytesWritten;
          }
        }
      }
    });
    await entry.getData(writable, { password, checkSignature: true, signal: options.signal, onprogress: options.onProgress, useWebWorkers: false });
    return bytes;
  } finally { await handle?.close(); }
}

function normalizeZipError(error, aborted) {
  if (aborted || error.name === "AbortError") return Object.assign(new Error("操作已取消。"), { code: "CANCELLED" });
  if (/password/i.test(error.message)) return Object.assign(new Error("密码不正确，或加密数据已损坏。"), { code: "WRONG_PASSWORD" });
  return error;
}

module.exports = { readEntries, streamEntry, normalizeZipError };
