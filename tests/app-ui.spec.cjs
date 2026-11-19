const { test, expect } = require("@playwright/test");
const path = require("node:path");
const { displayVersion } = require("../release-config.json");
const { pathToFileURL } = require("node:url");
const url = pathToFileURL(path.resolve(__dirname, "../index.html")).href;

test.beforeEach(async ({ page }) => {
  await page.goto(url); await page.evaluate(() => localStorage.clear()); await page.reload();
});
test("fresh app has approved icon, collapsed sidebar and no sample content", async ({ page }) => {
  await expect(page.locator("body")).toHaveClass(/sidebar-collapsed/);
  await expect(page.getByText("尚未打开压缩包")).toBeVisible();
  await expect(page.locator("body")).not.toContainText("设计素材包");
  await expect(page.locator("body")).not.toContainText("项目归档");
  await expect(page.locator("body")).not.toContainText("示例");
  await expect(page.locator(".brand-logo")).toHaveAttribute("src", "assets/favicon.svg");
  await expect(page.locator(".preview-tag")).toHaveText(displayVersion);
  await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
  await expect(page.locator("body")).toHaveClass(/sidebar-expanded/);
  await page.reload(); await expect(page.locator("body")).toHaveClass(/sidebar-expanded/);
  await page.getByRole("button", { name: "收起侧栏", exact: true }).click();
  await expect(page.locator("body")).toHaveClass(/sidebar-collapsed/);
  await page.screenshot({ path: path.resolve(__dirname, "../screenshots/dev-empty.png"), fullPage: true });
});
test("real folder reads, sorts, searches, previews and maintains selection", async ({ page }) => {
  await page.locator("#folder-input").setInputFiles(path.resolve(__dirname, "fixtures/本地样例"));
  await expect(page.locator("#archive-summary h2")).toHaveText("本地样例");
  await expect(page.locator(".file-table tbody tr")).toHaveCount(2);
  await expect(page.locator("#extract-button")).toBeDisabled();
  await expect(page.locator("#extract-here-button")).toBeVisible();
  await expect(page.locator("#delete-button")).toBeVisible();
  await page.locator('[data-file-id="本地样例/说明.md"]').click();
  await expect(page.locator("#selection-text")).toHaveText("已选择 1 个项目");
  await page.locator('[data-file-id="本地样例/说明.md"]').dblclick();
  await expect(page.locator(".preview-code")).toContainText("<script>");
  await expect(page.locator("dialog script")).toHaveCount(0);
  await page.getByRole("button", { name: "关闭对话框" }).click();
  await page.locator("#file-search").fill("没有的文件");
  await expect(page.getByText("没有找到匹配的文件")).toBeVisible();
  await page.getByRole("button", { name: "清除搜索", exact: true }).click();
  await page.getByRole("button", { name: "网格视图", exact: true }).click();
  await expect(page.locator(".file-tile")).toHaveCount(2);
  await page.locator('[data-file-id="本地样例/文档"]').dblclick();
  await expect(page.locator(".file-tile")).toHaveCount(1);
  await page.getByRole("button", { name: "上一级", exact: true }).click();
  await expect(page.locator(".file-tile")).toHaveCount(2);
});
test("recent and favorites contain only actually opened files", async ({ page }) => {
  await page.getByRole("button", { name: "最近打开", exact: true }).click();
  await expect(page.getByText("暂无最近打开的文件")).toBeVisible();
  await page.locator("#folder-input").setInputFiles(path.resolve(__dirname, "fixtures/本地样例"));
  await page.locator("#favorite-button").click();
  await page.getByRole("button", { name: "我的收藏", exact: true }).click();
  await expect(page.locator(".archive-card")).toHaveCount(1);
  await page.getByRole("button", { name: "打开", exact: true }).click();
  await expect(page.locator("#archive-summary h2")).toHaveText("本地样例");
});

async function filesForGestures(page, n = 12) {
  await page.evaluate(count => {
    const data = new DataTransfer();
    for (let i = 0; i < count; i++) {
      const file = new File([String(i)], `file-${i}.txt`);
      Object.defineProperty(file, "webkitRelativePath", { value: "Test/" + file.name }); data.items.add(file);
    }
    const input = document.querySelector('#folder-input'); input.files = data.files; input.dispatchEvent(new Event('change', { bubbles: true }));
  }, n);
}
for (const view of ["list", "grid"]) test(`${view}: marquee selects intersecting items and context menu preserves its target`, async ({ page }) => {
  await filesForGestures(page);
  if (view === "grid") await page.locator('[data-view="grid"]').click();
  const files = page.locator("[data-file-id]"); await expect(files).toHaveCount(12);
  const a = await files.nth(0).boundingBox(), b = await files.nth(2).boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2); await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
  await expect(page.locator(".selection-marquee")).toBeVisible(); await page.mouse.up();
  await expect(page.locator("[data-file-id].selected")).toHaveCount(3);
  await files.nth(1).click({ button: 'right' });
  await expect(page.getByRole('menu')).toBeVisible();
  await expect(page.locator("[data-file-id].selected")).toHaveCount(3);
  await expect(page.getByRole('menuitem', { name: '重命名' })).toBeDisabled();
  await page.keyboard.press('Escape'); await expect(page.getByRole('menu')).toBeHidden();
  await files.nth(3).click({ button: 'right' });
  await expect(page.locator("[data-file-id].selected")).toHaveCount(1);
  await expect(files.nth(3)).toHaveClass(/selected/);
  await page.keyboard.press('Escape');
  await files.nth(0).focus(); await page.keyboard.press('Shift+F10');
  await expect(page.getByRole('menu')).toBeVisible(); await expect(files.nth(0)).toHaveClass(/selected/);
  await page.keyboard.press('Escape');
  await files.nth(4).locator('input').check(); await expect(page.locator('[data-file-id].selected')).toHaveCount(2);
});
test('opening a context menu after a scroll keeps it open until the list moves again', async ({ page }) => {
  await filesForGestures(page, 70);
  const menu = page.getByRole('menu');
  const visibleAfterScrollEvent = await page.locator('#file-content').evaluate(async content => {
    const row = content.querySelectorAll('[data-file-id]')[30];
    // Moving the row into view queues a scroll event; the menu opens at the new position.
    const scrolled = new Promise(resolve => content.addEventListener('scroll', resolve, { once: true }));
    row.scrollIntoView({ block: 'center', behavior: 'instant' });
    const rect = row.getBoundingClientRect();
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: rect.left + 48, clientY: rect.top + 12 }));
    await scrolled;
    return !document.getElementById('file-menu').hidden;
  });
  expect(visibleAfterScrollEvent).toBe(true);
  await expect(menu).toBeVisible();
  await page.locator('#file-content').evaluate(el => { el.scrollTop += 40; });
  await expect(menu).toBeHidden();
});
test('drag near lower edge autoscrolls and Escape restores the selection', async ({ page }) => {
  await filesForGestures(page, 70);
  const first = page.locator('[data-file-id]').first(); await first.click();
  const rect = await page.locator('#file-content').boundingBox(), f = await first.boundingBox();
  await page.mouse.move(f.x + 100, f.y + f.height / 2); await page.mouse.down();
  await page.mouse.move(f.x + 120, rect.y + rect.height - 1, { steps: 5 });
  await expect.poll(() => page.locator('#file-content').evaluate(el => el.scrollTop)).toBeGreaterThan(30);
  await page.keyboard.press('Escape'); await page.mouse.up();
  await expect(page.locator('[data-file-id].selected')).toHaveCount(1); await expect(first).toHaveClass(/selected/);
});
test("update view has channels, preferences and honest browser error", async ({ page }) => {
  await page.getByRole("button", { name: "软件更新", exact: true }).click();
  await expect(page.locator(".update-current")).toContainText(displayVersion);
  await expect(page.getByRole("checkbox", { name: "接收 Dev 开发版本" })).toBeChecked();
  await page.getByRole("checkbox", { name: "接收 Dev 开发版本" }).uncheck();
  await page.getByRole("button", { name: "检查更新", exact: true }).click();
  await expect(page.locator(".update-error")).toContainText("请使用 MiniZip 桌面版");
});
test("browser imports never fabricate archive contents", async ({ page }) => {
  await page.locator("#archive-input").setInputFiles({ name: "真实文件.zip", mimeType: "application/zip", buffer: Buffer.from("test") });
  await expect(page.locator(".file-table")).toHaveCount(0);
  await expect(page.getByText("文件已在浏览器中打开", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "解压到…", exact: true }).click();
  await expect(page.getByRole("heading", { name: "请使用 MiniZip 桌面版" })).toBeVisible();
});
for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }, { width: 390, height: 844 }, { width: 360, height: 640 }]) {
  test(`layout ${viewport.width} keeps all main actions accessible`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.locator("#folder-input").setInputFiles(path.resolve(__dirname, "fixtures/本地样例"));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    await expect(page.locator("#extract-here-button")).toBeVisible();
    await expect(page.locator("#extract-button")).toBeVisible();
    await expect(page.locator("#delete-button")).toBeVisible();
    await page.screenshot({ path: path.resolve(__dirname, `../screenshots/dev-${viewport.width}.png`), fullPage: true });
    if (viewport.width < 600) {
      await page.getByRole("button", { name: "打开导航" }).click();
      await page.getByRole("button", { name: "软件更新", exact: true }).click();
      await expect(page.locator("#updates-view")).toBeVisible();
    }
  });
}
