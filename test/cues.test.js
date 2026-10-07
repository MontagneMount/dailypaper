// Checks for the cue table (cues.md, visual v2, T63): finding the narration line, the cards and
// diagram parts, positions, the figure's size and checksum, and the timing rules
// (docs/proposals/visual-v2.md sections 4 and 6).
// Run with: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { countText, CUE_TIMING, findLine, parseCues, parsePosition, scheduleCues } from "../src/cues.js";
import { buildSlides } from "../src/layouts.js";
import { parseScript } from "../src/parse-script.js";
import { previewMoments } from "../src/preview.js";
import { pageTurn } from "../src/animation.js";

const EXAMPLE_DIR = fileURLToPath(new URL("../episodes/example/", import.meta.url));
const EXAMPLE_CUES = fs.readFileSync(path.join(EXAMPLE_DIR, "cues.md"), "utf8").replace(/\r\n/g, "\n");

/** Check the demo episode with another cue table, in a temporary copy; `prepare` may change its files. */
function checkWith(cues, prepare = () => {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dailypaper-cues-"));
  try {
    fs.cpSync(EXAMPLE_DIR, dir, { recursive: true, filter: (source) => path.basename(source) !== "output" });
    fs.writeFileSync(path.join(dir, "cues.md"), cues);
    prepare(dir);
    const script = parseScript(fs.readFileSync(path.join(dir, "script.md"), "utf8"));
    return buildSlides(script, dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function assertError(result, fragment) {
  assert.ok(result.errors.some((error) => error.includes(fragment)), `应该报错「${fragment}」，实际：\n${result.errors.join("\n") || "（没有错误）"}`);
}

/** The demo's cue table with one page section replaced or added. */
function withPage(number, section) {
  const pages = EXAMPLE_CUES.split(/(?=^## 第 \d+ 页)/m);
  const others = pages.filter((page) => !page.startsWith(`## 第 ${number} 页`));
  return `${others.join("")}\n## 第 ${number} 页\n\n${section}\n`;
}

const TABLE = "| 从哪句 | 到哪句 | 动作 | 目标 | 位置 | 说明 |\n|---|---|---|---|---|---|";
const FIGURE_LINE = "- 原图：figures/figure1.svg（1200×700，校验 b7f84621）";

// ---- Finding the line ----

const MEMORY_LINES = ["在这 75 个受控样本里，", "不提供记忆时，总体准确率是 96.0%；", "提供记忆后，降到 77.3%。"];

test("句子只比开头：「提供记忆后」不会撞上「不提供记忆时」", () => {
  const problems = [];
  const report = (message) => problems.push(message);
  assert.equal(findLine("提供记忆后", MEMORY_LINES, "从哪句", report), 2);
  assert.equal(findLine("不提供记忆时", MEMORY_LINES, "从哪句", report), 1);
  assert.equal(findLine("提供记忆", MEMORY_LINES, "从哪句", report), 2, "「不提供记忆时」不是以「提供记忆」开头");
  assert.equal(findLine("在 这 75个受控样本里，", MEMORY_LINES, "从哪句", report), 0, "空格和末尾的标点不算");
  assert.deepEqual(problems, []);
});

test("两句开头相同要多写几个字，找不到也报错", () => {
  const lines = ["假如最看重成本，", "熟悉某个客户端，", "假如要比较恢复能力，"];
  const problems = [];
  assert.equal(findLine("假如", lines, "从哪句", (message) => problems.push(message)), null);
  assert.match(problems[0], /有 2 句旁白都以「假如」开头（第 1、3 句）/);
  assert.equal(findLine("假如要比较", lines, "从哪句", (message) => problems.push(message)), 2);
  assert.equal(findLine("如果", lines, "到哪句", (message) => problems.push(message)), null);
  assert.match(problems[1], /「到哪句」：本页找不到以「如果」开头的旁白/);
});

// ---- Words, positions ----

test("强调的文字不能是更长数字的一部分：80 不算 80.0 里的", () => {
  assert.equal(countText("Direct Gen. 80.0% → MemAdapter 53.5%", "80"), 0);
  assert.equal(countText("Direct Gen. 80.0% → MemAdapter 53.5%", "80.0%"), 1);
  assert.equal(countText("180 和 80", "80"), 1);
  assert.equal(countText("0.80", "80"), 0);
  assert.equal(countText("提速 2.3 倍，2.3 倍", "2.3 倍"), 2);
});

test("位置是 4 个带 % 的数，左 + 宽、上 + 高都不能超过 100%", () => {
  const problems = [];
  const report = (message) => problems.push(message);
  assert.deepEqual(parsePosition("10%, 20%, 30%, 40%", report), { top: 10, left: 20, width: 30, height: 40 });
  assert.equal(parsePosition("10%, 95%, 10%, 5%", report), null);
  assert.equal(parsePosition("80%, 0%, 10%, 30%", report), null);
  assert.equal(parsePosition("10, 20, 30, 40", report), null);
  assert.equal(parsePosition("-5%, 20%, 30%, 40%", report), null);
  assert.equal(parsePosition("10%, 20%, 0%, 40%", report), null);
  assert.equal(problems.length, 5);
  assert.match(problems[0], /超出了原图/);
  assert.match(problems[2], /格式不对/);
});

// ---- The demo episode's cue table against its script and files ----

test("示例的镜头表通过检查", () => {
  const { cues, errors, warnings } = checkWith(EXAMPLE_CUES);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
  assert.deepEqual([...cues.keys()], [2, 3, 4, 5, 6]);
  const page6 = cues.get(6).actions[0];
  assert.deepEqual(page6.groups.map((group) => group.map((target) => target.id)), [["step1"], ["arrow1"], ["step2"], ["arrow2"], ["step3"]]);
});

for (const [name, section, fragment] of [
  ["讲稿里没有的页", `${TABLE}\n| 大家好 | | 出现 | 卡片1 | | |`, "讲稿里没有这一页"],
  ["卡片序号超出", `${TABLE}\n| FastAttn 的思路很简单 | | 出现 | 卡片3 | | |`, "这一页只有 2 张卡片，没有卡片3"],
  ["强调卡片上没有的字", `${TABLE}\n| FastAttn 的思路很简单 | | 强调 | 卡片1「合并」 | | |`, "卡片1 里找不到「合并」"],
  ["同一个目标出现两次", `${TABLE}\n| FastAttn 的思路很简单 | | 出现 | 卡片1 | | |\n| 先把长序列 | | 出现 | 卡片1 | | |`, "已经在第"],
  ["到哪句在从哪句前面", `${FIGURE_LINE}\n\n${TABLE}\n| 每次只算一小块 | 先把长序列 | 框 | 原图 | 10%, 10%, 20%, 20% | |`, "在「从哪句」（第 3 句）前面"],
  ["出现写了到哪句", `${TABLE}\n| FastAttn 的思路很简单 | 先把长序列 | 出现 | 卡片1 | | |`, "「出现」不写「到哪句」"],
  ["框没写原图那一行", `${TABLE}\n| FastAttn 的思路很简单 | | 框 | 原图 | 10%, 10%, 20%, 20% | |`, "要先写「- 原图：」这一行"],
  ["原图的校验码不对", `- 原图：figures/figure1.svg（1200×700，校验 00000000）\n\n${TABLE}\n| FastAttn 的思路很简单 | | 框 | 原图 | 10%, 10%, 20%, 20% | |`, "现在的文件是「1200×700，校验 b7f84621」"],
  ["原图的尺寸不对", `- 原图：figures/figure1.svg（2400×1400，校验 b7f84621）\n\n${TABLE}\n| FastAttn 的思路很简单 | | 框 | 原图 | 10%, 10%, 20%, 20% | |`, "表里是「2400×1400，校验 b7f84621」"],
  ["一行少了一格", `${TABLE}\n| FastAttn 的思路很简单 | | 出现 | 卡片1 | |`, "这一行有 5 格"],
  ["不认识的动作", `${TABLE}\n| FastAttn 的思路很简单 | | 闪烁 | 卡片1 | | |`, "不认识动作「闪烁」"],
]) {
  test(`镜头表：${name}会报错`, () => {
    const number = name === "讲稿里没有的页" ? 9 : 2;
    assertError(checkWith(withPage(number, section)), fragment);
  });
}

test("镜头表：没有原图的页不能框，示意图里没有的部件不能出现", () => {
  assertError(checkWith(withPage(1, `${TABLE}\n| 大家好 | | 框 | 原图 | 10%, 10%, 20%, 20% | |`)), "这一页没有论文原图，不能「框」");
  assertError(checkWith(withPage(6, `${TABLE}\n| 最后用一张示意图 | | 出现 | #step9 | | |`)), "示意图里没有「#step9」这个部件");
  assertError(checkWith(withPage(2, `${TABLE}\n| FastAttn 的思路很简单 | | 出现 | #step1 | | |`)), "这一页没有 SVG 示意图");
});

test("T66 R4 没写「示意图」那一行，也会查出重复的部件 id，并要求补上这一行", () => {
  const duplicate = (dir) => {
    const file = path.join(dir, "diagrams", "page6.svg");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("</svg>", '  <g id="step1"></g>\n</svg>'));
  };
  const withoutLine = withPage(6, `${TABLE}\n| 最后用一张示意图 | | 出现 | #step1 | | |`);
  const result = checkWith(withoutLine, duplicate);
  assertError(result, "示意图里有两个部件都叫「step1」，id 不能重复");
  assertError(result, "要先写「- 示意图：」这一行");
  // With the line written, the duplicate is still reported; without a duplicate, only the line is asked for.
  const withLine = withPage(6, `- 示意图：diagrams/page6.svg（部件：step1）\n\n${TABLE}\n| 最后用一张示意图 | | 出现 | #step1 | | |`);
  assertError(checkWith(withLine, duplicate), "id 不能重复");
  const plain = checkWith(withoutLine);
  assert.deepEqual(plain.errors.filter((error) => error.includes("id 不能重复")), []);
  assertError(plain, "要先写「- 示意图：」这一行");
});

test("镜头表：页码重复、表头写错都会报错", () => {
  const { errors } = parseCues(`## 第 2 页\n\n${TABLE}\n\n## 第 2 页\n\n| 从哪里 | 到哪句 | 动作 | 目标 | 位置 | 说明 |\n|---|---|---|---|---|---|`);
  assert.ok(errors.some((error) => error.includes("「第 2 页」写了两次")), errors.join("\n"));
  assert.ok(errors.some((error) => error.includes("表头要写成")), errors.join("\n"));
});

// ---- Timing ----

// A page of 8 seconds with four lines; actions are given directly, as checkCues returns them.
const TIMING = { number: 3, start: 10, end: 18, lines: [{ start: 10.3 }, { start: 12 }, { start: 14 }, { start: 16 }] };
const FADE_OUT = pageTurn(8).fadeOut;
const box = { top: 10, left: 10, width: 20, height: 20 };
const action = (lineNo, kind, fromLine, toLine = fromLine, extra = {}) => ({ lineNo, kind, label: { box: "框", spotlight: "聚光", camera: "镜头", appear: "出现", emphasize: "强调" }[kind], fromLine, toLine, ...extra });
const schedule = (actions) => scheduleCues({ number: 3, actions, readable: [] }, TIMING, FADE_OUT);

test("时间：框从开口淡入，到「到哪句」结束时淡出", () => {
  const { tracks, moves, errors } = schedule([action(7, "box", 1, 2, { box })]);
  assert.deepEqual(errors, []);
  const [track] = tracks;
  assert.equal(track.start, 2);
  assert.equal(track.shown, 2 + CUE_TIMING.box[0]);
  assert.equal(track.leave, 6);
  assert.equal(track.end, 6 + CUE_TIMING.box[1]);
  assert.deepEqual(moves, [[2, 2 + CUE_TIMING.box[0]], [6, 6 + CUE_TIMING.box[1]]]);
});

test("时间：框到最后一句时随翻页淡出，不另算退场", () => {
  const { tracks, moves, errors } = schedule([action(7, "box", 2, 3, { box })]);
  assert.deepEqual(errors, []);
  assert.equal(tracks[0].end, 8);
  assert.deepEqual(moves, [[4, 4 + CUE_TIMING.box[0]]]);
});

test("T66 R3 到最后一句的框和聚光也要在翻页淡出前进完场，正好赶上的可以，并随翻页淡出", () => {
  // An 8-second page whose last line starts at 7.6 s; it starts fading out at 7.65 s.
  const late = { number: 3, start: 10, end: 18, lines: [{ start: 10.3 }, { start: 12 }, { start: 17.6 }] };
  const run = (timing, kind) => scheduleCues({ number: 3, actions: [action(7, kind, 2, 2, { box })], readable: [] }, timing, FADE_OUT);
  assert.match(run(late, "box").errors[0], /「框」的进场要到第 7\.95 秒才做完，可本页在第 7\.65 秒就开始翻页了/);
  assert.match(run(late, "spotlight").errors[0], /「聚光」的进场要到第 8\.00 秒才做完/);
  // Fully in exactly when the fade-out starts: fine, and it leaves with the page.
  const justInTime = { ...late, lines: [{ start: 10.3 }, { start: 12 }, { start: 17.3 }] };
  const box1 = run(justInTime, "box");
  assert.deepEqual(box1.errors, []);
  assert.equal(box1.tracks[0].end, 8);
});

test("时间：镜头要在页末前 1 秒拉回，拉回到最后一句就报错", () => {
  assert.match(schedule([action(7, "camera", 3, 3, { box })]).errors[0], /镜头要在本页最后 1 秒之前拉回全图/);
  assert.deepEqual(schedule([action(7, "camera", 1, 1, { box })]).errors, []);
});

test("时间：两个镜头、两个聚光的完整时段重叠会报错，拉回还没完也算", () => {
  // The first camera leaves at 4 s and is back at 4.9 s; the second starts at 4 s.
  const errors = schedule([action(7, "camera", 1, 1, { box }), action(8, "camera", 2, 2, { box })]).errors;
  assert.match(errors[0], /和第 7 行的镜头时间重叠/);
  assert.match(schedule([action(7, "spotlight", 0, 1, { box }), action(8, "spotlight", 1, 1, { box })]).errors[0], /和第 7 行的聚光时间重叠/);
  assert.deepEqual(schedule([action(7, "camera", 0, 0, { box }), action(8, "spotlight", 0, 1, { box })]).errors, [], "镜头和聚光可以同时");
});

test("时间：先强调还没出现的卡片会报错，同一句里先出现再强调可以", () => {
  const card = (index) => [[{ type: "card", index }]];
  const late = schedule([action(7, "emphasize", 0, 0, { card: 2, text: "77.3%" }), action(8, "appear", 1, 1, { groups: card(2) })]);
  assert.match(late.errors[0], /卡片2 要到第 8 行才出现，不能先强调它/);
  const same = schedule([action(7, "appear", 1, 1, { groups: card(2) }), action(8, "emphasize", 1, 1, { card: 2, text: "77.3%" })]);
  assert.deepEqual(same.errors, []);
});

test("时间：「、」每隔 0.3 秒出现一个，「+」同时出现；来不及在翻页前出现就报错", () => {
  const part = (id) => ({ type: "part", id });
  const { tracks, errors } = schedule([action(7, "appear", 0, 0, { groups: [[part("memory"), part("note")], [part("pill")]] })]);
  assert.deepEqual(errors, []);
  assert.deepEqual(tracks.map((track) => [track.target.id, Number(track.start.toFixed(3))]), [["memory", 0.3], ["note", 0.3], ["pill", 0.6]]);
  const crowded = schedule([action(7, "appear", 3, 3, { groups: [1, 2, 3, 4, 5, 6, 7].map((id) => [part(`p${id}`)]) })]);
  assert.match(crowded.errors[0], /本页在第 7\.65 秒就开始翻页了/);
});

test("时间：同一时间超过 3 个框只提醒", () => {
  const { errors, warnings } = schedule([1, 2, 3, 4].map((lineNo) => action(lineNo, "box", 1, 1, { box })));
  assert.deepEqual(errors, []);
  assert.match(warnings[0], /同一时间有 4 个框/);
});

// ---- Preview moments ----

test("预览：每个动作截之前、进场中、稳定、之后，页首的「之前」是完整显示的页面", () => {
  const { tracks } = schedule([action(7, "box", 0, 1, { box }), action(8, "spotlight", 1, 1, { box })]);
  const turn = pageTurn(8);
  const moments = previewMoments(tracks, turn, 8);
  const labelled = (text) => moments.filter((moment) => moment.labels.some((label) => label.includes(text)));
  for (const stage of ["之前", "进场中", "稳定", "退场之后"]) assert.equal(labelled(`第 7 行 框：${stage}`).length, 1, stage);
  const before = labelled("第 7 行 框：之前")[0];
  assert.ok(before.time < turn.fadeIn && before.turnTime === turn.fadeIn, "页首的动作之前，页面要已经完整显示");
  assert.equal(labelled("重叠：第 7 行 框 + 第 8 行 聚光").length, 1);
  assert.ok(moments.every((moment, index) => index === 0 || moment.time >= moments[index - 1].time));
});
