"use strict";

const fs = require("node:fs/promises");
const zip = require("@zip.js/zip.js");
zip.configure({ useWebWorkers: false });

class FileReader extends zip.Reader {
  constructor(filePath) { super(filePath); this.filePath = filePath; }
  async init() { if (!this.handle) this.handle = await fs.open(this.filePath, "r"); this.size = (await this.handle.stat()).size; }
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
  try { return await callback(await reader.getEntries(), reader); }
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
        if (bytes > (options.maxBytes ?? entry.uncompressedSize)) throw Object.assign(new Error("解压结果超过声明大小。"), { code: "LIMIT" });
        options.onChunk?.(chunk);
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

async function replaceEntries(filePath, destination, replacements, password, options = {}) {
  const handle = await fs.open(destination, "wx");
  const source = new FileReader(filePath);
  const writable = new WritableStream({ async write(chunk) {
    if (options.signal?.aborted) throw Object.assign(new Error("保存已取消。"), { code: "CANCELLED" });
    let offset = 0;
    while (offset < chunk.length) { const result = await handle.write(chunk, offset, chunk.length - offset); offset += result.bytesWritten; }
  } });
  const writer = new zip.ZipWriter(writable, { useWebWorkers: false });
  try {
    const names = new Set(replacements.map((item) => item.entryId));
    await writer.appendZip(source, { filter: (entry) => {
      if (options.signal?.aborted) throw Object.assign(new Error("保存已取消。"), { code: "CANCELLED" });
      return !names.has(entry.filename.replace(/\\/g, "/"));
    } });
    let archiveComment;
    await readEntries(filePath, async (entries, reader) => {
      archiveComment = reader.comment;
      const byName = new Map(entries.map(e => [e.filename.replace(/\\/g, "/"), e]));
      for (const replacement of replacements) {
        if (options.signal?.aborted) throw Object.assign(new Error("保存已取消。"), { code: "CANCELLED" });
        const entry = byName.get(replacement.entryId);
        if (replacement.added ? entry : !entry || entry.directory) throw new Error("Unexpected member in writeback plan");
        if (replacement.removed) continue;
        const input = new FileReader(replacement.stagedPath);
        try {
          const encryption = replacement.added ? { password, encryptionStrength: 3 } : entry.encrypted ? { password, zipCrypto: entry.zipCrypto, encryptionStrength: entry.extraFieldAES?.strength || 3 } : {};
          await writer.add(entry?.filename || replacement.entryId, input, { ...(entry ? { entry } : {}), lastModDate: new Date(), level: 5, signal: options.signal, ...encryption });
        } finally { await input.handle?.close(); }
      }
    });
    await writer.close(archiveComment);
  } catch (error) { throw normalizeZipError(error, options.signal?.aborted); }
  finally { await source.handle?.close(); await handle.close(); }
}

function normalizeZipError(error, aborted) {
  if (aborted || error.name === "AbortError") return Object.assign(new Error("操作已取消。"), { code: "CANCELLED" });
  if (/password/i.test(error.message)) return Object.assign(new Error("密码不正确，或加密数据已损坏。"), { code: "WRONG_PASSWORD" });
  return error;
}

module.exports = { readEntries, streamEntry, replaceEntries, normalizeZipError };
