const { test, expect } = require("@playwright/test");
const path = require("node:path");
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
  await expect(page.locator(".preview-tag")).toHaveText("Dev v1.0.0");
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
test("update view has channels, preferences and honest browser error", async ({ page }) => {
  await page.getByRole("button", { name: "软件更新", exact: true }).click();
  await expect(page.locator(".update-current")).toContainText("Dev v1.0.0");
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
