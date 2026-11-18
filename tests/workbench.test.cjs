"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { _electron: electron, expect } = require("@playwright/test");
const { ArchiveEngine, safeRemoveOwned } = require("../desktop/archive-engine.cjs");
const base = path.resolve(__dirname, "../.test-work");
const workspace = path.resolve(__dirname, "..");

test("independent workbenches open system documents, confirm programs and write back nested changes", { timeout: 120000 }, async () => {
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, "workbenches-"));
  const source = path.join(root, "source");
  const innerSource = path.join(root, "inner");
  await fs.mkdir(source); await fs.mkdir(innerSource);
  await fs.writeFile(path.join(source, "说明.txt"), "before edit");
  await fs.writeFile(path.join(source, "文档.pdf"), "%PDF-1.4\nMiniZip harmless test");
  await fs.writeFile(path.join(source, "程序.exe"), "not a real executable; shell call is intercepted by this test");
  await fs.writeFile(path.join(source, "support.dll"), "dependency");
  await fs.writeFile(path.join(innerSource, "inside.txt"), "nested original");
  const engine = new ArchiveEngine({ cacheRoot: path.join(root, "cache") });
  await engine.run(engine.sevenZip, ["a", "-tzip", path.join(source, "内层.zip"), "*"], { cwd: innerSource });
  const archive = path.join(root, "outer.zip");
  await engine.run(engine.sevenZip, ["a", "-tzip", archive, "*"], { cwd: source });
  const original = await fs.readFile(archive);
  let application;
  try {
    const executablePath = process.env.MINIZIP_PACKAGED_EXE;
    application = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: [...(executablePath ? [] : [workspace]), archive], env: { ...process.env, MINIZIP_TEST_MODE: "1", MINIZIP_TEST_PROFILE: path.join(root, "profile") }, timeout: 45000 });
    const page = await application.firstWindow();
    await expect(page.locator("#archive-summary h2")).toHaveText("outer.zip");
    await application.evaluate(({ shell, dialog }) => {
      globalThis.openedFiles = []; globalThis.confirmations = []; globalThis.confirmResponse = 0;
      shell.openPath = async (filePath) => { globalThis.openedFiles.push(filePath); return ""; };
      dialog.showMessageBox = async (_window, options) => { globalThis.confirmations.push(options); return { response: globalThis.confirmResponse }; };
    });
    await page.locator('[data-file-id="文档.pdf"]').dblclick();
    await expect.poll(() => application.evaluate(() => globalThis.openedFiles.length)).toBe(1);
    const pdf = await application.evaluate(() => globalThis.openedFiles[0]);
    assert.ok(pdf.endsWith("文档.pdf")); assert.equal(await fs.readFile(pdf, "utf8"), "%PDF-1.4\nMiniZip harmless test");
    await page.locator('[data-file-id="程序.exe"]').dblclick();
    await expect.poll(() => application.evaluate(() => globalThis.confirmations.length)).toBe(1);
    assert.equal(await application.evaluate(() => globalThis.openedFiles.length), 1);
    await application.evaluate(() => { globalThis.confirmResponse = 1; });
    await page.locator('[data-file-id="程序.exe"]').dblclick();
    await expect.poll(() => application.evaluate(() => globalThis.openedFiles.length)).toBe(2);
    const exe = await application.evaluate(() => globalThis.openedFiles[1]);
    assert.equal(await fs.readFile(path.join(path.dirname(exe), "support.dll"), "utf8"), "dependency");

    await page.locator('[data-file-id="说明.txt"]').dblclick();
    await expect.poll(() => application.evaluate(() => globalThis.openedFiles.length)).toBe(3);
    const textFile = await application.evaluate(() => globalThis.openedFiles[2]);
    await fs.writeFile(textFile, "外部保存后的内容");
    await expect(page.locator("#edit-notice")).toBeVisible({ timeout: 10000 });
    await expect(page.locator("#edit-notice")).toContainText("说明.txt");
    const noticeScreenshot = await application.evaluate(async ({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      await contents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
      return (await contents.capturePage()).toPNG().toString("base64");
    });
    await fs.mkdir(path.join(workspace, "screenshots"), { recursive: true });
    await fs.writeFile(path.join(workspace, "screenshots/external-edit-v101.png"), Buffer.from(noticeScreenshot, "base64"));
    await page.getByRole("button", { name: "保存到压缩包", exact: true }).click();
    await expect(page.locator("#edit-notice")).not.toBeVisible({ timeout: 20000 });
    const updated = await engine.open(archive);
    assert.equal((await engine.preview(updated, "说明.txt")).content, "外部保存后的内容");
    await engine.close(updated);
    const backups = (await fs.readdir(root)).filter((name) => name.includes("minizip-backup"));
    assert.equal(backups.length, 1); assert.deepEqual(await fs.readFile(path.join(root, backups[0])), original);

    const nextWindow = application.waitForEvent("window");
    await page.locator('[data-file-id="内层.zip"]').dblclick();
    const nested = await nextWindow;
    await expect(nested.locator("#archive-summary h2")).toHaveText("内层.zip");
    await expect(page.locator("#archive-summary h2")).toHaveText("outer.zip");
    await expect(nested.locator(".file-table tbody tr")).toHaveCount(1);
    const parentId = await page.evaluate(async () => (await window.miniZip.ready()).value.tasks[0].archiveId);
    const crossWindow = await nested.evaluate(async (archiveId) => window.miniZip.preview(archiveId, "说明.txt"), parentId);
    assert.equal(crossWindow.error.code, "SESSION_EXPIRED");
    await page.locator("#more-button").click();
    await page.getByRole("button", { name: "关闭当前压缩包", exact: true }).click();
    await expect(page.locator("#archive-summary h2")).toHaveText("outer.zip");
    await expect.poll(() => application.evaluate(() => globalThis.confirmations.some((choice) => choice.title === "嵌套压缩包仍在打开"))).toBe(true);
    const ids = await page.evaluate(async () => (await window.miniZip.editState("not-this-window")).error.code);
    assert.equal(ids, "SESSION_EXPIRED");
    await nested.locator('[data-file-id="inside.txt"]').dblclick();
    await expect.poll(() => application.evaluate(() => globalThis.openedFiles.length)).toBe(4);
    const innerFile = await application.evaluate(() => globalThis.openedFiles[3]);
    await fs.writeFile(innerFile, "nested updated");
    await expect(nested.locator("#edit-notice")).toBeVisible({ timeout: 10000 });
    await nested.getByRole("button", { name: "保存到压缩包", exact: true }).click();
    await expect(nested.locator("#edit-notice")).not.toBeVisible({ timeout: 20000 });
    await expect(page.locator("#edit-notice")).toContainText("内层.zip", { timeout: 10000 });
    await page.getByRole("button", { name: "保存到压缩包", exact: true }).click();
    await expect(page.locator("#edit-notice")).not.toBeVisible({ timeout: 20000 });
    const final = await engine.open(archive);
    const output = path.join(root, "verify");
    await engine.extract(final, output, { selection: ["内层.zip"] });
    const inner = await engine.open(path.join(output, "内层.zip"));
    assert.equal((await engine.preview(inner, "inside.txt")).content, "nested updated");
    await engine.close(inner); await engine.close(final);
    await nested.close();
    await expect.poll(() => application.windows().length).toBe(1);
    await expect(page.locator("#archive-summary h2")).toHaveText("outer.zip");
  } finally {
    await application?.close();
    await safeRemoveOwned(base, root);
  }
});

test("Explorer extraction actions and external second-instance opens use independent windows", { timeout: 90000 }, async () => {
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, "explorer-workflows-"));
  let application;
  try {
    const source = path.join(root, "source"); await fs.mkdir(source);
    await fs.writeFile(path.join(source, "file.txt"), "extracted from Explorer");
    const engine = new ArchiveEngine({ cacheRoot: path.join(root, "cache") });
    const archive = path.join(root, "menu.zip");
    await engine.run(engine.sevenZip, ["a", "-tzip", archive, "*"], { cwd: source });
    const executablePath = process.env.MINIZIP_PACKAGED_EXE;
    application = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: [...(executablePath ? [] : [workspace]), "--extract-folder", "--", archive], env: { ...process.env, MINIZIP_TEST_MODE: "1", MINIZIP_TEST_PROFILE: path.join(root, "profile") }, timeout: 45000 });
    const first = await application.firstWindow();
    await expect(first.locator(".task-card-state")).toHaveText("已完成", { timeout: 15000 });
    assert.equal(await fs.readFile(path.join(root, "menu/file.txt"), "utf8"), "extracted from Explorer");
    for (const mode of ["extract-here", "extract-to"]) {
      const newWindow = application.waitForEvent("window");
      await application.evaluate(({ app }, input) => { app.emit("second-instance", {}, [app.getPath("exe"), ...(app.isPackaged ? [] : [input.workspace]), "--" + input.mode, "--", input.archive]); }, { workspace, archive, mode });
      const page = await newWindow;
      if (mode === "extract-here") {
        await expect(page.locator(".task-card-state")).toHaveText("已完成", { timeout: 15000 });
        assert.equal(await fs.readFile(path.join(root, "file.txt"), "utf8"), "extracted from Explorer");
      } else {
        await expect(page.locator("#extract-form")).toBeVisible({ timeout: 15000 });
        await page.getByRole("button", { name: "取消", exact: true }).click();
      }
      await expect(first.locator(".task-card")).toHaveCount(1);
    }
    assert.equal(application.windows().length, 3);
    const quickWindow = application.waitForEvent("window");
    await application.evaluate(({ app }, input) => { app.emit("second-instance", {}, [app.getPath("exe"), ...(app.isPackaged ? [] : [input.workspace]), "--compress-7z", "--", input.archive]); }, { workspace, archive });
    const quick = await quickWindow;
    await expect(quick.locator("#archive-format")).toHaveValue("7z");
    await expect(quick.locator("#archive-name")).toHaveValue("menu.zip");
    await quick.getByRole("button", { name: "压缩", exact: true }).click();
    await expect(quick.locator("#phase")).toHaveText("压缩完成", { timeout: 20000 });
    assert.ok(await fs.stat(path.join(root, "menu.zip.7z")));
  } finally { await application?.close(); await safeRemoveOwned(base, root); }
});
