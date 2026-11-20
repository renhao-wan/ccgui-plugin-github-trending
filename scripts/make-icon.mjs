#!/usr/bin/env node
// 生成 docs/icon.png：256×256、超采样抗锯齿、零依赖。
// 图形：圆角方形底板 + 时钟环 + 指针（「每日」），绿色取自 GitHub 的 contribution 色。
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

const PLATE_A = [22, 27, 34, 255];
const PLATE_B = [12, 60, 48, 255];
const RING = [57, 211, 153, 255];
const HAND = [240, 246, 252, 255];
const TICK = [72, 128, 110, 255];

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

// 1) 圆角方形底板，斜向渐变
const pad = CW * 0.045;
for (let y = 0; y < CH; y++) {
  for (let x = 0; x < CW; x++) {
    if (!insideRoundRect(x, y, pad, pad, CW - pad, CH - pad, CW * 0.22)) continue;
    const t = (x / CW + y / CH) / 2;
    blend(x, y, [
      Math.round(PLATE_A[0] + (PLATE_B[0] - PLATE_A[0]) * t),
      Math.round(PLATE_A[1] + (PLATE_B[1] - PLATE_A[1]) * t),
      Math.round(PLATE_A[2] + (PLATE_B[2] - PLATE_A[2]) * t),
      255,
    ]);
  }
}

const cx = CW / 2;
const cy = CH / 2;
const ringR = CW * 0.315;
const ringW = CW * 0.028;

// 2) 时钟外环
for (let y = 0; y < CH; y++) {
  for (let x = 0; x < CW; x++) {
    const d = Math.hypot(x - cx, y - cy);
    if (Math.abs(d - ringR) <= ringW) blend(x, y, RING);
  }
}

// 3) 12 个刻度，画在环内
for (let k = 0; k < 12; k++) {
  const ang = (k / 12) * Math.PI * 2 - Math.PI / 2;
  const r1 = ringR - ringW - CW * 0.012;
  const r2 = r1 - (k % 3 === 0 ? CW * 0.062 : CW * 0.036);
  const dotR = k % 3 === 0 ? CW * 0.0125 : CW * 0.0085;
  const steps = Math.ceil((r1 - r2) * 2);
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const r = r1 + (r2 - r1) * t;
    const px = cx + Math.cos(ang) * r;
    const py = cy + Math.sin(ang) * r;
    for (let oy = -dotR; oy <= dotR; oy += 0.5) {
      for (let ox = -dotR; ox <= dotR; ox += 0.5) {
        if (ox * ox + oy * oy > dotR * dotR) continue;
        blend(px + ox, py + oy, TICK);
      }
    }
  }
}

// 4) 指针：时针朝 10 点，分针朝 1 点
function hand(angle, length, width) {
  const steps = Math.ceil(length * 2);
  for (let s = 0; s <= steps; s++) {
    const r = (s / steps) * length;
    const px = cx + Math.cos(angle) * r;
    const py = cy + Math.sin(angle) * r;
    for (let oy = -width; oy <= width; oy += 0.5) {
      for (let ox = -width; ox <= width; ox += 0.5) {
        if (ox * ox + oy * oy > width * width) continue;
        blend(px + ox, py + oy, HAND);
      }
    }
  }
}

const deg = (d) => (d * Math.PI) / 180 - Math.PI / 2;
hand(deg(305), ringR * 0.6, CW * 0.022); // 时针
hand(deg(48), ringR * 0.82, CW * 0.016); // 分针

// 5) 中心轴
for (let oy = -CW * 0.042; oy <= CW * 0.042; oy += 0.5) {
  for (let ox = -CW * 0.042; ox <= CW * 0.042; ox += 0.5) {
    if (ox * ox + oy * oy > (CW * 0.042) ** 2) continue;
    blend(cx + ox, cy + oy, RING);
  }
}

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
