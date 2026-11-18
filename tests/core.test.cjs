const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../core.js");

test("formatBytes distinguishes missing sizes from zero-byte files", () => {
  assert.equal(core.formatBytes(0), "0 B");
  assert.equal(core.formatBytes(null), "—");
  assert.equal(core.formatBytes(-1), "—");
  assert.equal(core.formatBytes(1536), "1.5 KB");
  assert.equal(core.formatBytes(1024 ** 3), "1 GB");
});

test("filenames are escaped before being placed in HTML", () => {
  assert.equal(core.escapeHtml('<img src="x" onerror=\'alert(1)\'>'), "&lt;img src=&quot;x&quot; onerror=&#39;alert(1)&#39;&gt;");
});

test("archive extension recognition is case insensitive", () => {
  for (const name of ["中文.ZIP", "归档.rar", "a.7z", "backup.tar.gz", "log.LZ4", "multi.001", "data.zst"]) assert.equal(core.isArchive(name), true);
  assert.equal(core.isArchive("file.zip.exe"), false);
  assert.equal(core.kindFor("图片.JPEG"), "image");
});

test("search and sort keep folders first in both directions", () => {
  const entries = [
    { id: "one", name: "File 10.txt", kind: "text", size: 10 },
    { id: "two", name: "file 2.txt", kind: "text", size: 20 },
    { id: "folder", name: "目录", kind: "folder", size: 30 }
  ];
  assert.deepEqual(core.filterAndSort(entries, "", "name", "asc").map((entry) => entry.id), ["folder", "two", "one"]);
  assert.deepEqual(core.filterAndSort(entries, "", "name", "desc").map((entry) => entry.id), ["folder", "one", "two"]);
  assert.equal(core.filterAndSort(entries, "  FILE  ", "size", "desc").length, 2);
  assert.equal(entries[0].id, "one");
});

test("folder traversal and recursive counts handle missing paths", () => {
  const archive = { entries: [{ id: "a", kind: "folder", children: [{ id: "b", kind: "text" }] }, { id: "c", kind: "image" }] };
  assert.equal(core.visibleEntries(archive, ["a"])[0].id, "b");
  assert.deepEqual(core.visibleEntries(archive, ["missing"]), []);
  assert.deepEqual(core.countEntries(archive.entries), { files: 2, folders: 1 });
});

test("local folder tree preserves Unicode and aggregates bytes", () => {
  const result = core.buildFolderTree([
    { name: "中文.md", webkitRelativePath: "项目/文档/中文.md", size: 120, lastModified: 1 },
    { name: "第二份.txt", webkitRelativePath: "项目/文档/第二份.txt", size: 80, lastModified: 2 },
    { name: "封面.jpg", webkitRelativePath: "项目/封面.jpg", size: 900, lastModified: 3 }
  ]);
  assert.equal(result.name, "项目");
  assert.equal(result.size, 1100);
  assert.equal(result.entries[0].size, 200);
  assert.equal(result.entries[0].children[0].name, "中文.md");
  assert.equal(result.entries[0].children[0].file.size, 120);
});

test("Unicode passwords are accepted without trimming or normalization", () => {
  assert.equal(core.validatePassword("迷你压缩2026"), true);
  assert.equal(core.validatePassword(" 中文 密码 "), true);
  assert.equal(core.validatePassword(""), false);
  assert.equal(core.validatePassword(null), false);
});
