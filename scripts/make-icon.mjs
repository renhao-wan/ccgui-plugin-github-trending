#!/usr/bin/env node
// 生成 docs/icon.png：256×256、超采样抗锯齿、零依赖。
//
// 风格对齐 CC GUI 生态里的插件图标（工作志、斜杠命令面板、CLI 安装审计）：
// 大圆角纯色底板 + 扁平白色符号，不用渐变、不堆细节——图标在侧栏里只有
// 18~20px，双层配色 + 12 个刻度这种复杂度到这里全糊成一团。
//
// 符号选「递增的三根柱」：GitHub Trending 说的是什么在升温，柱状图一眼就懂，
// 而且不依赖文字。最右最高的一根用琥珀色，表示榜首/最热。
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "..", "docs", "icon.png");

const W = 256;
const H = 256;
const S = 4;
const CW = W * S;
const CH = H * S;

// 底板：比宿主深色界面（约 #17191c）明显亮一档，否则图标贴在深色侧栏上
// 会失去边界、看起来像没加载。同时避开工作志的绿、斜杠面板的蓝。
const PLATE = [45, 52, 63, 255];
const BAR = [230, 237, 243, 255];
const BAR_HOT = [240, 136, 62, 255];

const canvas = new Float32Array(CW * CH * 4);

function blend(x, y, color) {
  const px = Math.round(x);
  const py = Math.round(y);
  if (px < 0 || py < 0 || px >= CW || py >= CH) return;
  const i = (py * CW + px) * 4;
  const a = color[3] / 255;
  canvas[i] = canvas[i] * (1 - a) + color[0] * a;
  canvas[i + 1] = canvas[i + 1] * (1 - a) + color[1] * a;
  canvas[i + 2] = canvas[i + 2] * (1 - a) + color[2] * a;
  canvas[i + 3] = Math.max(canvas[i + 3], color[3]);
}

function insideRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

/** 填充一个圆角矩形（整像素扫描，配合 4× 超采样即为抗锯齿）。 */
function fillRoundRect(x0, y0, x1, y1, r, color) {
  for (let y = Math.floor(y0); y <= Math.ceil(y1); y++) {
    for (let x = Math.floor(x0); x <= Math.ceil(x1); x++) {
      if (insideRoundRect(x, y, x0, y0, x1, y1, r)) blend(x, y, color);
    }
  }
}

// 1) 圆角方形底板（纯色，无渐变）
const pad = CW * 0.045;
fillRoundRect(pad, pad, CW - pad, CH - pad, CW * 0.235, PLATE);

// 2) 三根递增柱：底部对齐，高度递增，最右一根高亮
const barW = CW * 0.148;
const barGap = CW * 0.086;
const totalW = barW * 3 + barGap * 2;
const left = (CW - totalW) / 2;
const bottom = CH * 0.79;
const heights = [0.273, 0.437, 0.602].map((t) => CH * t);
const radius = CW * 0.039;

heights.forEach((h, i) => {
  const x0 = left + i * (barW + barGap);
  const color = i === heights.length - 1 ? BAR_HOT : BAR;
  fillRoundRect(x0, bottom - h, x0 + barW, bottom, radius, color);
});

// 下采样（预乘 alpha）
const rgba = Buffer.alloc(W * H * 4);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    for (let sy = 0; sy < S; sy++) {
      for (let sx = 0; sx < S; sx++) {
        const i = ((y * S + sy) * CW + (x * S + sx)) * 4;
        const alpha = canvas[i + 3] / 255;
        r += canvas[i] * alpha;
        g += canvas[i + 1] * alpha;
        b += canvas[i + 2] * alpha;
        a += alpha;
      }
    }
    const n = S * S;
    const out = (y * W + x) * 4;
    if (a > 0) {
      rgba[out] = Math.round(r / a);
      rgba[out + 1] = Math.round(g / a);
      rgba[out + 2] = Math.round(b / a);
    }
    rgba[out + 3] = Math.round((a / n) * 255);
  }
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  let crc = -1;
  for (const byte of body) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE((crc ^ -1) >>> 0, 0);
  return Buffer.concat([len, body, crcBuf]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;
ihdr[9] = 6;

const raw = Buffer.alloc((W * 4 + 1) * H);
for (let y = 0; y < H; y++) {
  raw[y * (W * 4 + 1)] = 0;
  rgba.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, png);
process.stdout.write("docs/icon.png " + png.length + " bytes\n");
