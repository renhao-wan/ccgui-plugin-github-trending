#!/usr/bin/env node
// 生成 docs/icon.png：256×256、超采样抗锯齿、零依赖。
//
// 风格对齐 CC GUI 插件市场里规范的那一档（斜杠命令面板为参考）：
// **高饱和纯色圆角底板 + 单个粗白符号 + 两点浅色点缀**，两层配色、零细节。
// 图标在侧栏里只有 18~20px，多一层配色、多两根细柱都会糊成一团；早先那版
// 灰蓝底板 + 三根细柱 + 橙色高亮正是这样糊掉的。
//
// 符号选「向上的箭头」：Trending 说的就是什么在升温，箭头不依赖文字、不依赖
// 语言，20px 下仍然认得出。两侧两点浅色圆点与斜杠面板同构，让同生态的图标
// 摆在一起时像一套。
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "..", "docs", "icon.png");

const W = 256;
const H = 256;
// 4× 超采样：整像素扫描 + 下采样即为抗锯齿，不需要任何图形库。
const S = 4;
const CW = W * S;
const CH = H * S;

/**
 * 底板用高饱和的橙红：Trending = 升温，别的插件已经占了蓝（斜杠面板）与
 * 绿（工作志）。同时压得足够深，白符号贴上去对比度够（~4.7:1）；
 * 亮橙（如 #F4883E）白字只有 3.3:1，缩到 18px 会发虚。
 */
const PLATE = [222, 78, 22, 255];
const INK = [255, 255, 255, 255];

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

/**
 * 填充一条圆头线段（胶囊）。
 *
 * 箭头由三段胶囊组成：箭杆 + 两条 45° 的头部斜臂。用圆头而不是三角箭头，
 * 是为了和斜杠面板的圆头斜杠保持同一种笔触——方角在 18px 下会显脏。
 */
function fillCapsule(x0, y0, x1, y1, r, color) {
  const minX = Math.floor(Math.min(x0, x1) - r);
  const maxX = Math.ceil(Math.max(x0, x1) + r);
  const minY = Math.floor(Math.min(y0, y1) - r);
  const maxY = Math.ceil(Math.max(y0, y1) + r);
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len2 = dx * dx + dy * dy || 1;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      // 点到线段的距离：投影落在段内就用垂直距离，落在段外就用端点距离。
      let t = ((x - x0) * dx + (y - y0) * dy) / len2;
      t = Math.min(1, Math.max(0, t));
      const ex = x0 + t * dx - x;
      const ey = y0 + t * dy - y;
      if (ex * ex + ey * ey <= r * r) blend(x, y, color);
    }
  }
}

// 1) 圆角方形底板：纯色、无渐变、无描边。留白与圆角比例抄斜杠面板，
//    这样两枚图标并排时轮廓完全一致。
const pad = CW * 0.045;
fillRoundRect(pad, pad, CW - pad, CH - pad, CW * 0.235, PLATE);

// 2) 三根递增的圆头柱。选柱状图而不是箭头：箭头单看是「向上」，柱状图才
//    一眼是「榜 / 排名 / 谁在涨」——这是这个插件真正在讲的事，也更容易和
//    别的图标区分开（整个生态里还没人用柱状图）。
//
//    三条约束：
//    - 三根柱**同色**。带一根高亮的那版看着像两个图标拼在一起，18px 下
//      高亮那根只会变成一个偏色的点；
//    - **间距必须大于柱宽**。等宽或更窄时，缩到 16px 下三根柱会糊成一块，
//      看不出是柱状图（实测过：柱宽 8%、间距 4.8% 就是这样糊掉的）；
//    - **白色包围盒占画布的比例对齐斜杠面板**（它约 32%×62%）——
//      符号画得比别人的大，缩到 18px 就会显得「填满了」，看着比别人的重。
const BAR_W = CW * 0.055;
const BAR_GAP = CW * 0.085;
const BAR_BOTTOM = CH * 0.80;
/** 递增的三档高度（占画布比例）。最短那根也要在 16px 下站得住。 */
const BAR_HEIGHTS = [0.3, 0.46, 0.62];
const BAR_R = BAR_W / 2;
const BAR_TOTAL = BAR_W * 3 + BAR_GAP * 2;
const BAR_LEFT = (CW - BAR_TOTAL) / 2;

BAR_HEIGHTS.forEach((h, i) => {
  const x = BAR_LEFT + i * (BAR_W + BAR_GAP) + BAR_W / 2;
  // 圆头胶囊：两端各留一个半径，视觉高度才是 h * CH
  const y0 = BAR_BOTTOM - h * CH + BAR_R;
  const y1 = BAR_BOTTOM - BAR_R;
  fillCapsule(x, y0, x, y1, BAR_R, INK);
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
