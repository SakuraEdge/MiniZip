"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { Resvg } = require("@resvg/resvg-js");

// Read the PNG frames directly from the release ICOs, including the smallest sizes.
function frame(ico, size, x, y, display = size) {
  for (let i = 0; i < ico.readUInt16LE(4); i++) {
    const entry = 6 + i * 16;
    if ((ico[entry] || 256) !== size) continue;
    const length = ico.readUInt32LE(entry + 8), start = ico.readUInt32LE(entry + 12);
    const data = ico.subarray(start, start + length).toString("base64");
    return `<image x="${x}" y="${y}" width="${display}" height="${display}" href="data:image/png;base64,${data}"/>`;
  }
  throw new Error(`Missing ${size}px frame`);
}

(async () => {
  const root = path.resolve(__dirname, "..");
  const icons = await Promise.all(["minizip", "archive"].map(name => fs.readFile(path.join(root, `assets/${name}.ico`))));
  const text = (x, y, content, size, color = "#263f48", weight = 400) => `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${color}">${content}</text>`;
  const sampleSizes = [32, 24, 16];
  const samples = (icon, x) => sampleSizes.map((size, i) => {
    const cx = x + 163 + i * 61;
    return frame(icon, size, cx - size / 2, 156 - size / 2) + frame(icon, size, cx - size / 2, 213 - size / 2) + text(cx - 12, 260, `${size} px`, 11, "#526d77");
  }).join("");
  const column = (icon, x, label) => text(x, 97, label, 18, "#294b54", 600) +
    `<rect x="${x}" y="118" width="121" height="121" rx="8" fill="#e7f2ef"/>` + frame(icon, 128, x + 10, 128, 101) +
    `<rect x="${x + 134}" y="132" width="182" height="48" rx="6" fill="#ffffff" stroke="#d4e4e6"/>
     <rect x="${x + 134}" y="189" width="182" height="48" rx="6" fill="#283d45"/>` + samples(icon, x);
  const board = `<svg xmlns="http://www.w3.org/2000/svg" width="744" height="290" viewBox="0 0 744 290"><rect width="744" height="290" fill="#f6faf9"/><g font-family="Microsoft YaHei,Segoe UI,sans-serif">${text(30, 43, "MiniZip", 27, "#1e4950", 600)}${text(580, 41, "Dev v1.0.1  ·  Windows", 13, "#526d77")}<path d="M30 60H714" stroke="#d1e1e1"/>${column(icons[0], 30, "应用图标")}${column(icons[1], 396, "压缩文件图标 · C 款")}</g></svg>`;
  await fs.writeFile(path.join(root, "design/file-icons/dev-v1.0.1.png"), new Resvg(board).render().asPng());
})().catch(error => { console.error(error); process.exitCode = 1; });
