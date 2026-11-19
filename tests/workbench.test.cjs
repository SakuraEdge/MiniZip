"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { _electron: electron, expect } = require("@playwright/test");
const { ArchiveEngine, safeRemoveOwned } = require("../desktop/archive-engine.cjs");
const base = path.resolve(__dirname, "../.test-work");
const workspace = path.resolve(__dirname, "..");

function onePagePdf() {
  const stream = 'BT /F1 18 Tf 24 110 Td (MiniZip PDF) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Count 1 /Kids [3 0 R] >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 220 150] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let doc = '%PDF-1.4\n'; const xref = [0];
  objects.forEach((o, i) => { xref.push(doc.length); doc += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const offset = doc.length;
  return doc + `xref\n0 ${xref.length}\n0000000000 65535 f \n` + xref.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('') + `trailer\n<< /Size ${xref.length} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`;
}
async function external(page, id) {
  await page.locator(`[data-file-id="${id}"]`).click({ button: "right" });
  await page.getByRole("menuitem", { name: "用外部应用打开" }).click();
}

test("real portable program in the workbench: prompt only on changes, save or discard and reclaim the run directory", { timeout: 90000 }, async () => {
  const { buildFixture } = require("./portable-fixture.cjs");
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, "program-workbench-"));
  const profile = path.join(root, "profile"), temp = path.join(profile, "MiniZip-runs");
  const archive = path.join(root, "portable.zip"), clean = path.join(root, "unchanged.zip");
  const absent = p => fs.stat(p).then(() => false, e => { if (e.code === "ENOENT") return true; throw e; });
  const engine = new ArchiveEngine({ cacheRoot: path.join(root, "cache") });
  let app;
  try {
    await buildFixture(root, archive); await buildFixture(root, clean, "unchanged");
    const exe = process.env.MINIZIP_PACKAGED_EXE;
    app = await electron.launch({ ...(exe ? { executablePath: exe } : {}), args: [...(exe ? [] : [workspace]), archive, clean], env: { ...process.env, MINIZIP_TEST_MODE: "1", MINIZIP_TEST_PROFILE: profile } });
    await expect.poll(() => app.windows().length).toBe(2);
    await app.evaluate(({ dialog }) => {
      globalThis.portableConsent = false; globalThis.portableQuestions = [];
      dialog.showMessageBox = async (_w, o) => { globalThis.portableQuestions.push({ title: o.title, detail: o.detail }); return { response: o.title === "运行程序" && globalThis.portableConsent ? 1 : 0 }; };
    });
    const pages = app.windows();
    for (const page of pages) await expect(page.locator('#archive-summary h2')).toHaveText(/^(portable|unchanged)\.zip$/);
    const page = await pages[0].locator('#archive-summary h2').textContent() === 'portable.zip' ? pages[0] : pages[1];
    const unchangedPage = pages.find(p => p !== page);
    const program = p => p.locator('[data-file-id="Portable/Counter.exe"]');
    for (const p of [page, unchangedPage]) await p.locator('[data-file-id="Portable"]').dblclick();
    await program(page).dblclick();
    await expect.poll(() => app.evaluate(() => globalThis.portableQuestions.length)).toBe(1);
    assert.match(await app.evaluate(() => globalThis.portableQuestions[0].detail), /Portable/);
    assert.equal(await absent(temp), true);
    await app.evaluate(() => { globalThis.portableConsent = true; });
    for (const decision of ['不更新', '更新压缩包']) {
      const before = await fs.readFile(archive);
      await program(page).dblclick();
      const notice = page.locator('#program-notice');
      await expect(notice).toContainText('程序已退出', { timeout: 15000 });
      await expect(notice).toContainText('修改 · Portable/config.txt');
      await expect(notice).toContainText('新增 · Portable/data/last-run.txt');
      await expect(unchangedPage.locator('#program-notice')).toBeHidden();
      const [directory] = await fs.readdir(temp);
      assert.equal(await fs.readFile(path.join(temp, directory, 'files/Portable/data/last-run.txt'), 'utf8'), 'saved=1');
      assert.deepEqual(await fs.readFile(archive), before);
      if (decision === '更新压缩包' && process.env.MINIZIP_CAPTURE_PROGRAM_REVIEW === '1') {
        await fs.mkdir(path.join(workspace, 'screenshots'), { recursive: true });
        // Hidden test windows can retain their last composited frame. Only show the
        // fixture window for an explicitly requested visual capture, without focusing it.
        const image = await app.evaluate(async ({ BrowserWindow }) => {
          const w = BrowserWindow.getAllWindows().find(win => win.getTitle().startsWith('portable.zip'));
          const visible = w.isVisible();
          try {
            if (!visible) w.showInactive();
            await w.webContents.executeJavaScript('new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))');
            await new Promise(done => setTimeout(done, 220));
            return (await w.webContents.capturePage()).toPNG().toString('base64');
          } finally { if (!visible) w.hide(); }
        });
        await fs.writeFile(path.join(workspace, 'screenshots/program-run-review.png'), Buffer.from(image, 'base64'));
      }
      await notice.getByRole('button', { name: decision, exact: true }).click();
      await expect(notice).toBeHidden({ timeout: 15000 });
      assert.equal(await absent(temp), true);
      if (decision === '不更新') assert.deepEqual(await fs.readFile(archive), before);
      else {
        const saved = await engine.open(archive);
        assert.equal((await engine.preview(saved, 'Portable/config.txt')).content, 'counter=1');
        assert.equal((await engine.preview(saved, 'Portable/data/last-run.txt')).content, 'saved=1');
        await engine.close(saved);
        await expect(page.locator('[data-file-id="Portable/data"]')).toHaveCount(1);
      }
    }
    await unchangedPage.evaluate(() => {
      globalThis.runPhases = [];
      window.miniZip.onProgram(s => globalThis.runPhases.push(s.phase));
    });
    const before = await fs.readFile(clean); await program(unchangedPage).dblclick();
    await expect.poll(() => unchangedPage.evaluate(() => globalThis.runPhases.at(-1)), { timeout: 15000 }).toBe('idle');
    assert.equal(await unchangedPage.evaluate(() => globalThis.runPhases.includes('review')), false);
    assert.deepEqual(await fs.readFile(clean), before); assert.equal(await absent(temp), true);
  } finally {
    if (app) { await app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) w.destroy(); }).catch(() => {}); await app.close().catch(() => {}); }
    await safeRemoveOwned(base, root);
  }
});

test("independent workbenches open system documents, confirm programs and write back nested changes", { timeout: 120000 }, async () => {
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, "workbenches-"));
  const source = path.join(root, "source");
  const innerSource = path.join(root, "inner");
  await fs.mkdir(source); await fs.mkdir(innerSource);
  await fs.writeFile(path.join(source, "说明.txt"), "before edit");
  await fs.writeFile(path.join(source, "文档.pdf"), onePagePdf());
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
    await expect(page.locator('#archive-summary .archive-glyph')).toHaveAttribute('src', 'assets/archive.svg');
    await expect(page.locator('[data-file-id="内层.zip"] .archive-glyph')).toHaveAttribute('src', 'assets/archive.svg');
    await expect(page.locator('#details-panel .archive-glyph')).toHaveJSProperty('naturalWidth', 256);
    await application.evaluate(({ app, shell, dialog }) => {
      globalThis.openedFiles = []; globalThis.closers = []; globalThis.confirmations = []; globalThis.confirmResponse = 0;
      // Stub only application dispatch, not extraction, close handling, hashing or removal.
      const load = process.getBuiltinModule('node:module').createRequire(process.getBuiltinModule('node:path').join(app.getAppPath(), 'package.json'));
      load('./desktop/external-file.cjs').open = async (file, finish) => { globalThis.openedFiles.push(file); globalThis.closers.push(finish); };
      shell.openPath = async (filePath) => { globalThis.openedFiles.push(filePath); return ""; };
      dialog.showMessageBox = async (_window, options) => { globalThis.confirmations.push(options); return { response: globalThis.confirmResponse }; };
    });
    await page.locator('[data-file-id="文档.pdf"]').dblclick();
    await expect(page.locator(".preview-pdf")).toBeVisible();
    await expect(page.locator(".preview-pdf")).toHaveAttribute("src", /^blob:/);
    // Chromium's PDF extension must have a parsed one-page document, not just an iframe.
    await expect.poll(() => application.evaluate(async ({ webContents }) => {
      for (const contents of webContents.getAllWebContents()) for (const f of contents.mainFrame.framesInSubtree) {
        if (!f.url.startsWith("chrome-extension://")) continue;
        try { if (await f.executeJavaScript('(() => { const v = document.querySelector("pdf-viewer"); return v?.loadProgress_ === 100 && v.viewport.getPageScreenRect(0).height > 0; })()')) return true; } catch { /* viewer still loading */ }
      }
      return false;
    }), { timeout: 10000 }).toBe(true).catch(async error => {
      const details = await application.evaluate(async ({ webContents }) => {
        const frames = [];
        for (const c of webContents.getAllWebContents()) for (const f of c.mainFrame.framesInSubtree) {
          try { frames.push([c.getType(), f.url, await f.executeJavaScript('({text:document.body?.innerText?.slice(0,100), elements:[...document.body?.children||[]].map(n=>n.tagName), viewer:document.querySelector("pdf-viewer")?.loadProgress_, viewport:!!document.querySelector("pdf-viewer")?.viewport})')]); } catch { /* detached frame */ }
        }
        return frames;
      });
      throw new Error(error.message + '\nPDF frames: ' + JSON.stringify(details));
    });
    assert.equal(await application.evaluate(() => globalThis.openedFiles.length), 0);
    await assert.rejects(fs.stat(path.join(root, "profile", "MiniZip-edits")), { code: "ENOENT" });
    await page.locator('dialog [data-action="external-item"]').click();
    await expect.poll(() => application.evaluate(() => globalThis.openedFiles.length)).toBe(1);
    const pdf = await application.evaluate(() => globalThis.openedFiles[0]);
    assert.ok(pdf.endsWith("文档.pdf")); assert.equal(await fs.readFile(pdf, "utf8"), onePagePdf());
    await application.evaluate(() => globalThis.closers[0]());
    await assert.rejects(fs.stat(pdf), { code: "ENOENT" });
    await page.locator('[data-file-id="程序.exe"]').dblclick();
    await expect.poll(() => application.evaluate(() => globalThis.confirmations.length)).toBe(1);
    assert.equal(await application.evaluate(() => globalThis.openedFiles.length), 1);
    await application.evaluate(() => { globalThis.confirmResponse = 1; });
    await external(page, "程序.exe");
    await expect.poll(() => application.evaluate(() => globalThis.openedFiles.length)).toBe(2);
    const exe = await application.evaluate(() => globalThis.openedFiles[1]);
    assert.equal(await fs.readFile(path.join(path.dirname(exe), "support.dll"), "utf8"), "dependency");
    await application.evaluate(() => globalThis.closers[1]());
    await assert.rejects(fs.stat(exe), { code: "ENOENT" });

    await page.locator('[data-file-id="说明.txt"]').dblclick();
    await expect(page.locator(".preview-code")).toHaveText("before edit");
    await page.keyboard.press("Escape"); await expect(page.locator(".preview-code")).toHaveCount(0);
    await external(page, "说明.txt");
    await expect.poll(() => application.evaluate(() => globalThis.openedFiles.length)).toBe(3);
    const textFile = await application.evaluate(() => globalThis.openedFiles[2]);
    await fs.writeFile(textFile, "外部保存后的内容");
    await page.locator('[data-action="finish-edits"]').click();
    await expect(page.locator("#edit-notice")).toBeVisible({ timeout: 10000 });
    await expect(page.locator("#edit-notice")).toContainText("有改动");
    const noticeScreenshot = await application.evaluate(async ({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      await contents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
      return (await contents.capturePage()).toPNG().toString("base64");
    });
    await fs.mkdir(path.join(workspace, "screenshots"), { recursive: true });
    await fs.writeFile(path.join(workspace, "screenshots/external-edit-v101.png"), Buffer.from(noticeScreenshot, "base64"));
    await page.getByRole("button", { name: "保存到压缩包", exact: true }).click();
    await expect(page.locator("#edit-notice")).not.toBeVisible({ timeout: 20000 });
    await assert.rejects(fs.stat(textFile), { code: "ENOENT" });
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
    await external(nested, "inside.txt");
    await expect.poll(() => application.evaluate(() => globalThis.openedFiles.length)).toBe(4);
    const innerFile = await application.evaluate(() => globalThis.openedFiles[3]);
    await fs.writeFile(innerFile, "nested updated");
    await application.evaluate(() => globalThis.closers[3]());
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
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.getTitle().startsWith('内层.zip')).close());
    await expect.poll(() => application.windows().length).toBe(1);
    await expect.poll(() => fs.stat(path.join(root, 'profile/MiniZip-edits')).then(() => true, err => err.code !== 'ENOENT')).toBe(false);
    await expect(page.locator("#archive-summary h2")).toHaveText("outer.zip");
    await page.locator('[data-file-id="说明.txt"]').click({ button: 'right' });
    await page.getByRole('menuitem', { name: '重命名' }).click();
    await page.locator('#entry-name').fill('support.dll');
    await page.locator('dialog [type="submit"]').click(); await expect(page.locator('#rename-error')).toContainText('同名');
    await page.locator('#entry-name').fill('新说明.txt'); await page.locator('dialog [type="submit"]').click();
    await expect(page.locator('[data-file-id="新说明.txt"]')).toHaveClass(/selected/);
    await expect(page.locator('#archive-summary h2')).toHaveText('outer.zip');
    assert.equal(application.windows().length, 1);
    const check = await engine.open(archive); assert.equal((await engine.preview(check, '新说明.txt')).content, '外部保存后的内容'); await engine.close(check);
    const beforeDiscard = await fs.readFile(archive);
    await external(page, '新说明.txt'); await expect.poll(() => application.evaluate(() => globalThis.openedFiles.length)).toBe(5);
    const discarded = await application.evaluate(() => globalThis.openedFiles[4]); await fs.writeFile(discarded, 'discard this edit');
    await application.evaluate(() => globalThis.closers[4]());
    await page.getByRole('button', { name: '不更新', exact: true }).click();
    await expect(page.locator('#edit-notice')).not.toBeVisible();
    await assert.rejects(fs.stat(discarded), { code: 'ENOENT' }); assert.deepEqual(await fs.readFile(archive), beforeDiscard);
    await page.locator('[data-file-id="程序.exe"]').click();
    await page.locator('[data-file-id="support.dll"]').click({ modifiers: ['Control'] });
    await page.locator('[data-file-id="程序.exe"]').click({ button: 'right' });
    await page.getByRole('menuitem', { name: '删除', exact: true }).click();
    await expect(page.locator('.task-card-state').first()).toHaveText('已完成');
    await page.locator('.nav-item[data-page="browser"]').click();
    await expect(page.locator('[data-file-id="support.dll"], [data-file-id="程序.exe"]')).toHaveCount(0);
    await expect(page.locator('[data-file-id="新说明.txt"]')).toHaveCount(1);
    await page.locator('#more-button').click(); await page.getByRole('button', { name: '关闭当前压缩包', exact: true }).click();
    await expect(page.getByText('尚未打开压缩包')).toBeVisible();
  } finally {
    // Test failures must not wait on a real modal dialog while the harness tears down.
    if (application) { await application.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) w.destroy(); }).catch(() => {}); await application.close().catch(() => {}); }
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
    await expect(quick.locator('.source-icon img')).toHaveAttribute('src', 'assets/archive.svg');
    await expect(quick.locator('.quick-titlebar img')).toHaveAttribute('src', 'assets/favicon.svg');
    await quick.getByRole("button", { name: "压缩", exact: true }).click();
    await expect(quick.locator("#phase")).toHaveText("压缩完成", { timeout: 20000 });
    assert.ok(await fs.stat(path.join(root, "menu.zip.7z")));
  } finally { await application?.close(); await safeRemoveOwned(base, root); }
});
