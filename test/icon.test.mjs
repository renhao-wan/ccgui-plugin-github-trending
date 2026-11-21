import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 图标同源性：市场/侧栏缩略图是 docs/icon.png，侧栏与页签是 main.js 里的
 * Icon 组件。两处画不同的符号时，用户根本认不出是同一个插件——这正是
 * 曾经出现过的问题（PNG 是箭头、应用内是三根柱）。
 *
 * 这里从两边源码里抽出**实际数值**做比对，改了一边忘了另一边会直接失败。
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

const SVG_CANVAS = 16;

/** 从 make-icon.mjs 抽出几何比例（全部是「占画布的比例」，0..1）。 */
function iconRatios() {
  const src = read("scripts/make-icon.mjs");
  const num = (re, what) => {
    const m = src.match(re);
    assert.ok(m, "make-icon.mjs 里找不到 " + what);
    return Number(m[1]);
  };
  const heights = src.match(/const BAR_HEIGHTS = \[([^\]]+)\];/);
  assert.ok(heights, "找不到 BAR_HEIGHTS");
  return {
    barW: num(/const BAR_W = CW \* ([0-9.]+);/, "BAR_W"),
    gap: num(/const BAR_GAP = CW \* ([0-9.]+);/, "BAR_GAP"),
    bottom: num(/const BAR_BOTTOM = CH \* ([0-9.]+);/, "BAR_BOTTOM"),
    heights: heights[1].split(",").map((s) => Number(s.trim())),
  };
}

/** 从 main.head.js 的 ICON_GEOM 抽出 16 单位坐标。 */
function svgGeometry() {
  const src = read("src/main.head.js");
  const block = src.match(/const ICON_GEOM = \{([\s\S]*?)\n\};/);
  assert.ok(block, "找不到 ICON_GEOM");
  const sw = block[1].match(/strokeWidth: ([\d.]+)/);
  assert.ok(sw, "ICON_GEOM 缺少 strokeWidth");
  const bars = block[1].match(/bars: \[([\s\S]*?)\]/);
  assert.ok(bars, "ICON_GEOM 缺少 bars");
  const paths = [...bars[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const parsed = paths.map((d) => {
    const m = d.match(/^M([\d.]+) ([\d.]+)V([\d.]+)$/);
    assert.ok(m, "每根柱都应是 M<sub>x> <top>V<bottom>：" + d);
    return { x: Number(m[1]), top: Number(m[2]), bottom: Number(m[3]) };
  });
  return { strokeWidth: Number(sw[1]), bars: parsed };
}

test("图标同源：应用内组件画的是三根递增柱", () => {
  const svg = svgGeometry();
  assert.equal(svg.bars.length, 3, "应该正好三根柱");
  // 递增：每根比前一根更长、顶端更高
  for (let i = 1; i < svg.bars.length; i += 1) {
    assert.ok(svg.bars[i].top < svg.bars[i - 1].top, "第 " + (i + 1) + " 根应比前一根高");
  }
  // 底端对齐
  const bottoms = new Set(svg.bars.map((b) => b.bottom));
  assert.equal(bottoms.size, 1, "三根柱底边必须对齐");

  // 旧实现留下的痕迹不该还在
  const src = read("src/main.head.js");
  assert.doesNotMatch(src, /M2\.2 12\.6h11\.6/, "旧的基线不该还在");
  assert.doesNotMatch(src, /wingL|shaft:/, "不该还留着箭头的几何");
});

test("图标同源：SVG 与 PNG 的几何比例一致", () => {
  const png = iconRatios();
  const svg = svgGeometry();
  const round = (n) => Math.round(n * 1000) / 1000;

  // 柱宽 = 描边宽度
  assert.equal(round(svg.strokeWidth / SVG_CANVAS), round(png.barW), "柱宽与 PNG 不一致");

  // 三根柱的 x、顶、底都要能由 PNG 的比例还原出来。
  //
  // 比的是**视觉边界**而不是路径端点：两边的圆头都会从端点再向外伸出一个
  // 半径。PNG 里胶囊从 y0 画到 y1，视觉上是 y0-R..y1+R；SVG 的 `V` 端点同理。
  const barTotal = png.barW * 3 + png.gap * 2;
  const left = (1 - barTotal) / 2;
  const r = png.barW / 2;
  png.heights.forEach((h, i) => {
    const centerX = left + i * (png.barW + png.gap) + png.barW / 2;
    const visualTop = png.bottom - h;
    const visualBottom = png.bottom;

    const svgR = svg.strokeWidth / 2 / SVG_CANVAS;
    const svgTop = svg.bars[i].top / SVG_CANVAS - svgR;
    const svgBottom = svg.bars[i].bottom / SVG_CANVAS + svgR;

    assert.equal(round(svg.bars[i].x / SVG_CANVAS), round(centerX), "第 " + (i + 1) + " 根柱 x 不一致");
    assert.equal(round(svgTop), round(visualTop), "第 " + (i + 1) + " 根柱顶端不一致");
    assert.equal(round(svgBottom), round(visualBottom), "第 " + (i + 1) + " 根柱底端不一致");
  });
});

test("图标同源：两层配色、不堆点缀", () => {
  const src = read("scripts/make-icon.mjs");
  // 底板 + 三根柱。再加圆点、基线、异色柱之类的东西，18px 下只会显得画面散。
  assert.doesNotMatch(src, /fillCircle\(/, "PNG 不该再画点缀圆点");
  assert.doesNotMatch(src, /BAR_HOT|HOT/, "不该再有异色的高亮柱");
  // 三根柱必须在同一个循环里画（`forEach` 里的那一次调用），而不是手写三份。
  const loop = src.match(/BAR_HEIGHTS\.forEach\([\s\S]*?\n\}\);/);
  assert.ok(loop, "找不到柱状图绘制循环");
  assert.equal((loop[0].match(/fillCapsule\(/g) || []).length, 1, "三根柱应共用同一个绘制调用");

  const svg = read("src/main.head.js").match(/const ICON_GEOM = \{([\s\S]*?)\n\};/)[1];
  assert.equal((svg.match(/"M/g) || []).length, 3, "SVG 只该有三条路径");
});

test("图标同源：符号尺度对齐斜杠面板，别把画面填满", () => {
  const png = iconRatios();
  // 包围盒宽 = 三根柱 + 两个间距；斜杠面板实测约 32%。
  const width = png.barW * 3 + png.gap * 2;
  assert.ok(width > 0.25 && width < 0.4, "符号宽度应在画布 25%~40% 之间，实际 " + (width * 100).toFixed(1) + "%");
  // 包围盒高：最高的那根柱
  assert.ok(png.heights[2] > 0.5 && png.heights[2] < 0.7, "最高柱应在画布 50%~70%，实际 " + (png.heights[2] * 100).toFixed(1) + "%");
});
