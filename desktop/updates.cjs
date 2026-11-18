"use strict";

const https = require("node:https");
const fs = require("node:fs/promises");
const { createReadStream, createWriteStream } = require("node:fs");
const { createHash, randomUUID } = require("node:crypto");
const path = require("node:path");
const { Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { ArchiveError, safeRemoveOwned } = require("./archive-engine.cjs");

function parseTag(tag) {
  const match = /^(dev|rev)-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/i.exec(String(tag));
  if (!match) return null;
  const numbers = match.slice(2).map(Number);
  if (numbers.some((number) => !Number.isSafeInteger(number))) return null;
  const channel = match[1].toLowerCase() === "dev" ? "Dev" : "Rev";
  return { channel, version: numbers.join("."), numbers, tag: String(tag), displayVersion: `${channel} v${numbers.join(".")}` };
}
function compareVersions(a, b) {
  for (let index = 0; index < 3; index++) if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] - b.numbers[index];
  return (a.channel === "Rev" ? 1 : 0) - (b.channel === "Rev" ? 1 : 0);
}
function validRepository(value) { return typeof value === "string" && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]{1,100}$/.test(value) && !value.endsWith("/.") && !value.endsWith("/.."); }
function selectRelease(releases, current, allowDev) {
  if (!Array.isArray(releases)) throw new ArchiveError("UPDATE_RESPONSE", "GitHub 返回了无效的版本列表。");
  return releases.map((release) => ({ release, parsed: parseTag(release.tag_name) }))
    .filter(({ release, parsed }) => parsed && !release.draft && (allowDev || parsed.channel === "Rev") && !(parsed.channel === "Rev" && release.prerelease) && compareVersions(parsed, current) > 0)
    .sort((a, b) => compareVersions(b.parsed, a.parsed))[0] || null;
}
function validateAssetUrl(value, repository, tag, filename) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password || url.port || url.hash || url.search) throw new ArchiveError("UPDATE_SOURCE", "更新文件地址不属于已配置的 GitHub 项目。");
  const expected = `/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(filename)}`;
  if (url.pathname !== expected) throw new ArchiveError("UPDATE_SOURCE", "更新文件地址与发布版本不一致。");
  return url;
}
function request(url, options = {}, redirects = 0) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const hosts = ["api.github.com", "github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"];
    if (target.protocol !== "https:" || !hosts.includes(target.hostname) || target.username || target.password || target.port) { reject(new ArchiveError("UPDATE_SOURCE", "更新请求地址不受信任。")); return; }
    const req = https.get(target, { headers: { "User-Agent": "MiniZip-Update-Check", "Accept": options.json ? "application/vnd.github+json" : "application/octet-stream", ...(options.json ? { "X-GitHub-Api-Version": "2022-11-28" } : {}) }, signal: options.signal }, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.resume();
        if (redirects >= 5 || !response.headers.location) { reject(new ArchiveError("UPDATE_REDIRECT", "更新下载重定向过多。")); return; }
        request(new URL(response.headers.location, target).href, options, redirects + 1).then(resolve, reject); return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new ArchiveError("UPDATE_HTTP", response.statusCode === 403 || response.statusCode === 429 ? "GitHub 请求受到限流，请稍后重试。" : response.statusCode === 404 ? "尚未找到公开的项目或发布版本。" : `更新服务返回 HTTP ${response.statusCode}。`)); return;
      }
      resolve(response);
    });
    req.setTimeout(options.timeout || 30000, () => req.destroy(new ArchiveError("UPDATE_TIMEOUT", "连接 GitHub 超时，请检查网络后重试。")));
    req.on("error", reject);
  });
}
async function getText(url, options = {}) {
  const response = await request(url, options);
  const chunks = []; let size = 0;
  for await (const chunk of response) { size += chunk.length; if (size > (options.limit || 4 * 1024 ** 2)) { response.destroy(); throw new ArchiveError("UPDATE_LIMIT", "更新信息超过大小限制。"); } chunks.push(chunk); }
  return Buffer.concat(chunks).toString("utf8");
}
async function sha256(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

class UpdateService {
  constructor(config, directory, onChange = () => {}, transport = {}) {
    this.config = config; this.directory = directory; this.onChange = onChange; this.release = null; this.downloaded = null; this.checking = false; this.downloading = false;
    this.getText = transport.getText || getText;
    this.request = transport.request || request;
    this.state = { status: "idle", current: config.displayVersion, repository: config.repository, allowDev: config.channel === "Dev", autoCheck: true, checkedAt: null, available: null, progress: 0, error: null };
  }
  async init() {
    await fs.mkdir(this.directory, { recursive: true });
    try { const value = JSON.parse(await fs.readFile(path.join(this.directory, "preferences.json"), "utf8")); if (typeof value.autoCheck === "boolean") this.state.autoCheck = value.autoCheck; if (typeof value.allowDev === "boolean") this.state.allowDev = value.allowDev; } catch { /* Fresh installation. */ }
    return this.snapshot();
  }
  snapshot() { return structuredClone(this.state); }
  emit(changes) { Object.assign(this.state, changes); this.onChange(this.snapshot()); }
  async preferences(value) {
    if (typeof value.autoCheck !== "boolean" || typeof value.allowDev !== "boolean") throw new ArchiveError("UPDATE_SETTINGS", "更新设置无效。");
    if (this.checking || this.downloading) throw new ArchiveError("UPDATE_BUSY", "更新操作进行中，请稍后修改设置。");
    this.emit({ autoCheck: value.autoCheck, allowDev: value.allowDev, status: "idle", available: null, error: null }); this.release = null;
    await fs.writeFile(path.join(this.directory, "preferences.json"), JSON.stringify({ autoCheck: value.autoCheck, allowDev: value.allowDev }), "utf8");
    return this.snapshot();
  }
  async check() {
    if (this.checking || this.downloading) return this.snapshot();
    this.checking = true; this.emit({ status: "checking", error: null });
    try {
      if (!validRepository(this.config.repository)) throw new ArchiveError("UPDATE_CONFIG", "发布仓库尚未配置。完成 GitHub 发布后即可检查更新。");
      const releases = [];
      for (let page = 1; page <= 3; page++) {
        const batch = JSON.parse(await this.getText(`https://api.github.com/repos/${this.config.repository}/releases?per_page=100&page=${page}`, { json: true }));
        if (!Array.isArray(batch)) throw new ArchiveError("UPDATE_RESPONSE", "无法读取 GitHub 版本列表。");
        releases.push(...batch); if (batch.length < 100) break;
      }
      const selected = selectRelease(releases, parseTag(this.config.tag), this.state.allowDev);
      this.release = selected;
      if (!selected) this.emit({ status: "current", available: null, checkedAt: new Date().toISOString() });
      else {
        const { parsed, release } = selected;
        const filename = `MiniZip-${parsed.channel}-${parsed.version}-Setup-x64.exe`;
        const asset = release.assets?.find((item) => item.name === filename);
        const checksum = release.assets?.find((item) => item.name === filename + ".sha256");
        if (asset) validateAssetUrl(asset.browser_download_url, this.config.repository, parsed.tag, filename);
        if (checksum) validateAssetUrl(checksum.browser_download_url, this.config.repository, parsed.tag, filename + ".sha256");
        selected.asset = asset; selected.checksum = checksum;
        this.emit({ status: "available", checkedAt: new Date().toISOString(), available: { ...parsed, notes: String(release.body || "暂无更新说明。").slice(0, 100000), publishedAt: release.published_at, canDownload: Boolean(asset && (checksum || /^sha256:[a-f0-9]{64}$/i.test(asset.digest || ""))), size: asset?.size || null } });
      }
    } catch (error) { this.emit({ status: "error", error: error instanceof ArchiveError ? error.message : "无法连接 GitHub，请检查网络后重试。", checkedAt: new Date().toISOString() }); }
    finally { this.checking = false; }
    return this.snapshot();
  }
  async download() {
    if (this.checking || this.downloading) throw new ArchiveError("UPDATE_BUSY", "更新操作正在进行。");
    if (!this.release?.asset || !this.state.available?.canDownload) throw new ArchiveError("UPDATE_ASSET", "此版本尚未提供可校验的 Windows 安装包。");
    this.downloading = true; this.controller = new AbortController();
    const work = path.join(this.directory, "download-" + randomUUID());
    this.emit({ status: "downloading", progress: 0, error: null });
    try {
      await fs.mkdir(work);
      const { asset, checksum, parsed } = this.release;
      let expected = /^sha256:([a-f0-9]{64})$/i.exec(asset.digest || "")?.[1]?.toLowerCase();
      if (checksum) {
        const content = await this.getText(checksum.browser_download_url, { signal: this.controller.signal, limit: 4096 });
        const match = /^([a-f0-9]{64})\s+\*?([^\r\n]+)\s*$/i.exec(content.trim());
        if (!match || match[2] !== asset.name || expected && expected !== match[1].toLowerCase()) throw new ArchiveError("UPDATE_HASH", "发布的校验信息无效或不一致。");
        expected = match[1].toLowerCase();
      }
      if (!expected) throw new ArchiveError("UPDATE_HASH", "缺少安装包校验信息。");
      validateAssetUrl(asset.browser_download_url, this.config.repository, parsed.tag, asset.name);
      const response = await this.request(asset.browser_download_url, { signal: this.controller.signal, timeout: 60000 });
      const target = path.join(work, asset.name); let size = 0;
      const hash = createHash("sha256"); let lastProgress = -1;
      const limiter = new Transform({ transform: (chunk, _encoding, callback) => {
        size += chunk.length;
        if (size > 768 * 1024 ** 2 || asset.size && size > asset.size) { callback(new ArchiveError("UPDATE_LIMIT", "安装包超过声明大小。")); return; }
        hash.update(chunk);
        const progress = asset.size ? Math.min(99, Math.floor(size / asset.size * 100)) : 0;
        if (progress !== lastProgress) { lastProgress = progress; this.emit({ progress }); }
        callback(null, chunk);
      } });
      await pipeline(response, limiter, createWriteStream(target, { flags: "wx" }), { signal: this.controller.signal });
      if (hash.digest("hex") !== expected || asset.size && size !== asset.size) throw new ArchiveError("UPDATE_HASH", "安装包校验失败，已拒绝安装。");
      const oldDownload = this.downloaded;
      this.downloaded = { target, expected, work };
      if (oldDownload) await safeRemoveOwned(this.directory, oldDownload.work).catch(() => {});
      this.emit({ status: "ready", progress: 100 });
    } catch (error) {
      await safeRemoveOwned(this.directory, work);
      this.emit({ status: this.controller.signal.aborted ? "available" : "error", error: this.controller.signal.aborted ? null : error instanceof ArchiveError ? error.message : "下载失败，请重试。" });
    } finally { this.downloading = false; this.controller = null; }
    return this.snapshot();
  }
  cancel() { this.controller?.abort(); }
  async installer() {
    if (this.state.status !== "ready" || !this.downloaded) throw new ArchiveError("UPDATE_ASSET", "请先完成下载和校验。");
    if (await sha256(this.downloaded.target) !== this.downloaded.expected) throw new ArchiveError("UPDATE_HASH", "安装包下载后被修改，已拒绝运行。");
    return this.downloaded.target;
  }
}
module.exports = { UpdateService, parseTag, compareVersions, selectRelease, validRepository, validateAssetUrl, sha256 };
