(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MiniZipCore = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const collator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });
  const archiveExtensions = new Set(["zip", "zipx", "rar", "7z", "lz4", "tar", "gz", "tgz", "bz2", "xz", "zst", "zstd", "cab", "iso", "arj", "lzh", "lzma", "br", "001", "002"]);
  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  }
  function formatBytes(bytes, decimals = 1) {
    if (!Number.isFinite(bytes) || bytes < 0) return "—";
    if (bytes === 0) return "0 B";
    const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 4);
    return `${Number((bytes / 1024 ** index).toFixed(index === 0 ? 0 : decimals))} ${["B", "KB", "MB", "GB", "TB"][index]}`;
  }
  function extension(name) { return String(name).split(".").pop().toLowerCase(); }
  function isArchive(name) { return archiveExtensions.has(extension(name)); }
  const rasterMime = new Map(Object.entries({ jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", avif: "image/avif" }));
  function previewSpec(name) {
    const ext = extension(name);
    if (rasterMime.has(ext)) return { kind: "image", mime: rasterMime.get(ext), limit: 12 * 1024 ** 2 };
    if (ext === "pdf") return { kind: "pdf", mime: "application/pdf", limit: 24 * 1024 ** 2 };
    if (kindFor(name) === "text") return { kind: "text", mime: "text/plain", limit: 1024 ** 2 };
    return null;
  }
  function kindFor(name) {
    const ext = extension(name);
    if (["jpg", "jpeg", "png", "webp", "gif", "avif", "svg"].includes(ext)) return "image";
    if (["pdf"].includes(ext)) return "pdf";
    if (["fig", "sketch", "psd", "ai"].includes(ext)) return "design";
    if (["txt", "md", "json", "js", "css", "html", "xml", "csv"].includes(ext)) return "text";
    if (["mp4", "mov", "mkv", "webm"].includes(ext)) return "video";
    if (["ttf", "otf", "woff", "woff2"].includes(ext)) return "font";
    if (isArchive(name)) return "archive";
    return "file";
  }
  function filterAndSort(entries, query, key, direction) {
    const term = query.trim().toLocaleLowerCase("zh-CN");
    return entries.filter((item) => !term || item.name.toLocaleLowerCase("zh-CN").includes(term)).slice().sort((a, b) => {
      if ((a.kind === "folder") !== (b.kind === "folder")) return a.kind === "folder" ? -1 : 1;
      let value;
      if (key === "size") value = (a.size || 0) - (b.size || 0);
      else if (key === "date") value = String(a.date || "").localeCompare(String(b.date || ""));
      else if (key === "type") value = collator.compare(a.type || a.kind, b.type || b.kind);
      else value = collator.compare(a.name, b.name);
      return (value || collator.compare(a.name, b.name)) * (direction === "desc" ? -1 : 1);
    });
  }
  function visibleEntries(archive, path) {
    let entries = archive.entries || [];
    for (const id of path) {
      const folder = entries.find((entry) => entry.id === id && entry.kind === "folder");
      if (!folder) return [];
      entries = folder.children || [];
    }
    return entries;
  }
  function countEntries(entries) {
    return entries.reduce((result, entry) => {
      if (entry.kind === "folder") {
        result.folders += 1;
        const nested = countEntries(entry.children || []);
        result.files += nested.files;
        result.folders += nested.folders;
      } else result.files += 1;
      return result;
    }, { files: 0, folders: 0 });
  }
  function buildFolderTree(files) {
    const entries = [];
    let rootName = "本地文件夹";
    for (const file of files) {
      const parts = (file.webkitRelativePath || file.name).split("/").filter(Boolean);
      if (parts.length > 1) rootName = parts.shift();
      let current = entries;
      let fullPath = rootName;
      for (const part of parts.slice(0, -1)) {
        fullPath += "/" + part;
        let folder = current.find((entry) => entry.name === part && entry.kind === "folder");
        if (!folder) {
          folder = { id: fullPath, name: part, kind: "folder", type: "文件夹", size: 0, date: "", children: [] };
          current.push(folder);
        }
        current = folder.children;
      }
      const name = parts[parts.length - 1] || file.name;
      current.push({ id: fullPath + "/" + name, name, kind: kindFor(name), type: extension(name).toUpperCase() + " 文件", size: file.size, packed: null, date: new Date(file.lastModified || Date.now()).toISOString().slice(0, 16).replace("T", " "), file });
    }
    const updateSize = (items) => items.reduce((total, entry) => {
      if (entry.kind === "folder") { entry.size = updateSize(entry.children); entry.type = `${entry.children.length} 个项目`; }
      return total + entry.size;
    }, 0);
    return { name: rootName, entries, size: updateSize(entries) };
  }
  function validatePassword(password) { return typeof password === "string" && password.length > 0; }
  return { escapeHtml, formatBytes, extension, isArchive, kindFor, previewSpec, filterAndSort, visibleEntries, countEntries, buildFolderTree, validatePassword };
});
