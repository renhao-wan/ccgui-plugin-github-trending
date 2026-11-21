import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 图标同源性：市场/侧栏缩略图是 docs/icon.png，侧栏与页签是 main.js 里的
 * Icon 组件。两处画不同的符号时，用户根本认不出是同一个插件——这正是
 * 上一版「PNG 是箭头、应用内是三根柱」的问题。
 *
 * PNG 的几何参数没法在这里直接读，但可以守住**硬约束**：
 * 1. 生成脚本与组件用的必须是同一套比例常量；
 * 2. 组件里不能再出现旧的柱状图路径。
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

/** 从 make-icon.mjs 抽出几何比例，供断言用。 */
function iconRatios() {
  const src = read("scripts/make-icon.mjs");
  const num = (re) => {
    const m = src.match(re);
    assert.ok(m, "make-icon.mjs 里找不到 " + re);
    return Number(m[1]);
  };
  return {
    tipY: num(/const tipY = CH \* ([0-9.]+);/),
    wingY: num(/const wingY = CH \* ([0-9.]+);/),
    // 翼端 x：**第一条** fillCapsule 里带 tipY 的那行是左翼；
    // 右翼是同 y 的镜像，宽度由包围盒断言兜住。
    wingX0: num(/fillCapsule\(cx, tipY, CW \* ([0-9.]+), wingY/),
  };
}

/** 从 main.head.js 的 ICON_GEOM 抽出同一个形状的 16 单位坐标。 */
function svgGeometry() {
  const src = read("src/main.head.js");
  const block = src.match(/const ICON_GEOM = \{([\s\S]*?)\};/);
  assert.ok(block, "找不到 ICON_GEOM");
  const paths = [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.equal(paths.length, 3, "箭头由箭杆 + 两条头部斜臂组成");
  const shaft = paths[0].match(/^M8 ([\d.]+)V([\d.]+)$/);
  assert.ok(shaft, "箭杆路径形状应为 M8 y1Vy2");
  const wing = paths[1].match(/^M8 ([\d.]+) ([\d.]+) ([\d.]+)$/);
  assert.ok(wing, "斜臂路径形状应为 M8 y1 x2 y2");
  return {
    shaftTop: Number(shaft[2]),
    tipY: Number(wing[1]),
    wingX: Number(wing[2]),
    wingY: Number(wing[3]),
  };
}

test("图标同源：应用内组件画的是箭头，不再是旧的三根柱", () => {
  const src = read("src/main.head.js");
  // 旧实现的路径：三根柱 + 一条基线
  assert.doesNotMatch(src, /M3\.2 12\.6V9\.4/, "旧的柱状图路径不该还在");
  assert.doesNotMatch(src, /M2\.2 12\.6h11\.6/, "旧的基线不该还在");
  assert.match(src, /const ICON_GEOM = \{/, "应有统一的几何常量");
});

test("图标同源：SVG 与 PNG 的几何比例一致", () => {
  const png = iconRatios();
  const svg = svgGeometry();
  // 两边都是「占画布的比例」：SVG 画布 16 单位，PNG 画布 1。
  const round = (n) => Math.round(n * 1000) / 1000;
  assert.equal(round(svg.tipY / 16), round(png.tipY), "箭尖高度不一致");
  assert.equal(round(svg.wingY / 16), round(png.wingY), "翼端高度不一致");
  assert.equal(round(svg.wingX / 16), round(png.wingX0), "翼端水平位置不一致");
  // 箭杆顶端要与箭尖对齐，否则 16px 下会看出一个空心缝
  assert.equal(round(svg.shaftTop / 16), round(png.tipY), "箭杆顶端没对齐箭尖");
});

test("图标同源：两处都只用一层笔画，不堆点缀", () => {
  const src = read("scripts/make-icon.mjs");
  // 底板 + 三个胶囊。再加圆点之类的东西，18px 下只会显得画面散。
  assert.doesNotMatch(src, /fillCircle\(/, "PNG 不该再画点缀圆点");
  const geom = read("src/main.head.js").match(/const ICON_GEOM = \{([\s\S]*?)\};/)[1];
  assert.equal((geom.match(/"M/g) || []).length, 3, "SVG 只该有三条路径");
});
