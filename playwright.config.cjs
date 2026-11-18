const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests",
  testMatch: "app-ui.spec.cjs",
  fullyParallel: true,
  workers: 3,
  timeout: 30000,
  reporter: "list",
  use: {
    browserName: "chromium",
    launchOptions: process.env.MINIZIP_USE_BUNDLED_BROWSER === "1" ? {} : process.platform === "win32" ? { executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" } : {},
    viewport: { width: 1440, height: 900 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure"
  }
});
