"use strict";

const { chromium, expect } = require("@playwright/test");
const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

async function main() {
  const output = path.join(__dirname, "screenshots");
  await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch(process.platform === "win32" ? { executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" } : {});
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1300 }, deviceScaleFactor: 1 });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const requests = [];
    page.on("request", (request) => { if (/^https?:/i.test(request.url())) requests.push(request.url()); });
    await page.goto(pathToFileURL(path.join(__dirname, "index.html")).href);
    await page.locator(".icon-options img").first().waitFor();
    await page.evaluate(async () => { await Promise.all([...document.images].map((image) => image.decode())); });
    await expect(page.locator(".icon-option")).toHaveCount(4);
    await page.locator(".icon-section").screenshot({ path: path.join(output, "icon-comparison.png") });
    await page.locator(".quick-stage").screenshot({ path: path.join(output, "quick-compress.png") });
    await page.screenshot({ path: path.join(output, "review-desktop.png"), fullPage: true });
    await page.getByRole("radio", { name: "选择 C M 字母标" }).check();
    await expect(page.locator(".quick-titlebar .chosen-icon")).toHaveAttribute("src", "icons/c-m-mark.svg");
    await page.getByRole("radio", { name: "选择 A 拉链盒" }).check();
    await page.getByRole("button", { name: "深色背景" }).click();
    await page.locator(".icon-section").screenshot({ path: path.join(output, "icon-comparison-dark.png") });
    await page.getByRole("button", { name: "浅色背景" }).click();
    await page.locator("#archive-format").selectOption("7z");
    await expect(page.locator("#extension")).toHaveText(".7z");
    await page.locator("#encrypt").check();
    await page.getByRole("button", { name: "压缩", exact: true }).click();
    await expect(page.locator("#quick-error")).toHaveText("请输入压缩密码。");
    await page.locator("#quick-password").fill("中文密码");
    await page.getByRole("button", { name: "压缩", exact: true }).click();
    await expect(page.locator("#quick-status")).toHaveText("设置已确认 · 预览");
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await expect(page.locator("#password-field")).not.toBeVisible();
    await expect(page.locator("#quick-password")).toHaveValue("");
    await page.locator("#archive-format").selectOption("7z");
    await page.locator("#encrypt").check();
    await page.locator("#quick-password").fill("中文密码");
    await page.locator(".quick-stage").screenshot({ path: path.join(output, "quick-compress-password.png") });
    for (const width of [1024, 736, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      const metrics = await page.evaluate(() => ({ width: window.innerWidth, scroll: document.documentElement.scrollWidth }));
      if (metrics.scroll > metrics.width) throw new Error(`Layout overflow at ${width}: ${metrics.scroll}`);
      await page.screenshot({ path: path.join(output, `review-${width}.png`), fullPage: true });
    }
    if (errors.length || requests.length) throw new Error(JSON.stringify({ errors, requests }));
    console.log("Review checks passed: 4 icon options, local-only resources, format switching, password validation, cancellation and 320-1440px layouts.");
    console.log("Screenshots: " + output);
  } finally { await browser.close(); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
