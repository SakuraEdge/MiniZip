"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { Resvg } = require("@resvg/resvg-js");

test("both distinct Explorer icons ship all eight frames from their production SVG", async () => {
  const assets = path.resolve(__dirname, "../assets");
  const sizes = [16, 20, 24, 32, 48, 64, 128, 256];
  const frames = [];
  for (const [source, output] of [["favicon", "minizip"], ["archive", "archive"]]) {
    const svg = await fs.readFile(path.join(assets, `${source}.svg`));
    const ico = await fs.readFile(path.join(assets, `${output}.ico`));
    assert.equal(ico.readUInt32LE(0), 0x10000);
    assert.equal(ico.readUInt16LE(4), sizes.length);
    const images = [];
    for (const [i, size] of sizes.entries()) {
      const slot = 6 + 16 * i;
      assert.equal(ico[slot] || 256, size);
      assert.equal(ico[slot + 1] || 256, size);
      const start = ico.readUInt32LE(slot + 12);
      const image = ico.subarray(start, start + ico.readUInt32LE(slot + 8));
      assert.deepEqual(image, new Resvg(svg, { fitTo: { mode: "width", value: size } }).render().asPng());
      images.push(image);
    }
    assert.deepEqual(images.at(-1), await fs.readFile(path.join(assets, `${output}.png`)));
    frames.push(images);
  }
  for (let i = 0; i < sizes.length; i++) assert.notDeepEqual(frames[0][i], frames[1][i]);
});
