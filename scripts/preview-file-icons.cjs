"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { Resvg } = require("@resvg/resvg-js");

(async () => {
  const root = path.resolve(__dirname, "..");
  const folder = path.join(root, "design/file-icons");
  const variants = [
    ["a", "A", "拉链文件", "清晰的文件轮廓，经典压缩包识别"],
    ["b", "B", "收纳盒", "立体包裹轮廓，区别于普通文档"],
    ["c", "C", "叠页压缩包", "多文件叠放，延续 MiniZip 的 M 标识"]
  ];
  let content = "";
  for (let index = 0; index < variants.length; index++) {
    const [key, letter, title, subtitle] = variants[index];
    const source = await fs.readFile(path.join(folder, `archive-${key}.svg`), "utf8");
    const png = new Resvg(source, { fitTo: { mode: "width", value: 256 } }).render().asPng();
    await fs.writeFile(path.join(folder, `archive-${key}.png`), png);
    const image = "data:image/png;base64," + png.toString("base64");
    const x = 50 + index * 370;
    content += `<text x="${x}" y="138" fill="#EB6A52" font-size="18" font-weight="600">${letter}</text><text x="${x + 30}" y="138" fill="#2B2D32" font-size="22" font-weight="600">${title}</text><image href="${image}" x="${x + 64}" y="171" width="170" height="170"/><text x="${x}" y="377" fill="#58616D" font-size="15">${subtitle}</text><path d="M${x} 403H${x + 310}" stroke="#DEE3E9"/><text x="${x}" y="436" fill="#6A7380" font-size="13">资源管理器尺寸</text><image href="${image}" x="${x}" y="455" width="48" height="48"/><image href="${image}" x="${x + 84}" y="471" width="32" height="32"/><image href="${image}" x="${x + 155}" y="479" width="24" height="24"/><image href="${image}" x="${x + 217}" y="487" width="16" height="16"/><text x="${x + 10}" y="528" fill="#6A7380" font-size="12">48</text><text x="${x + 92}" y="528" fill="#6A7380" font-size="12">32</text><text x="${x + 159}" y="528" fill="#6A7380" font-size="12">24</text><text x="${x + 217}" y="528" fill="#6A7380" font-size="12">16</text><rect x="${x}" y="554" width="310" height="74" rx="6" fill="#25272C"/><image href="${image}" x="${x + 18}" y="570" width="40" height="40"/><text x="${x + 73}" y="598" fill="#F3F5F7" font-size="17">Archive.zip</text>`;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1160" height="682" viewBox="0 0 1160 682"><rect width="1160" height="682" fill="#FFFFFF"/><g font-family="Microsoft YaHei,Segoe UI,sans-serif"><text x="50" y="55" fill="#2B2D32" font-size="27" font-weight="600">MiniZip 压缩文件图标</text><text x="50" y="86" fill="#6A7380" font-size="15">文件关联图标候选 · 应用图标保持不变</text>${content}</g></svg>`;
  await fs.writeFile(path.join(folder, "comparison.png"), new Resvg(svg).render().asPng());
  console.log(path.join(folder, "comparison.png"));
})().catch((error) => { console.error(error); process.exitCode = 1; });
