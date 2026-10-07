// Regression checks for the script checker (code review T18: R1–R5; later T24, T27).
// Each test edits the demo script a little and expects a specific error.
// Run with: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseScript } from "../src/parse-script.js";
import { buildSlides } from "../src/layouts.js";
import { applyPronunciations } from "../src/pronunciation.js";

const EXAMPLE_DIR = fileURLToPath(new URL("../episodes/example/", import.meta.url));
const EXAMPLE = fs.readFileSync(path.join(EXAMPLE_DIR, "script.md"), "utf8").replace(/\r\n/g, "\n");

/** Check a variant of the demo script. */
function check(edit = (text) => text, episodeDir = EXAMPLE_DIR) {
  return buildSlides(parseScript(edit(EXAMPLE)), episodeDir);
}

/** Replace text that must exist, so a test fails loudly if the demo script changes. */
function replaceOnce(text, from, to) {
  assert.ok(text.includes(from), `示例稿里找不到：${from}`);
  return text.replace(from, to);
}

function assertError(result, fragment) {
  const found = result.errors.some((error) => error.includes(fragment));
  assert.ok(found, `应该报错「${fragment}」，实际：\n${result.errors.join("\n") || "（没有错误）"}`);
}

test("示例稿通过检查，没有错误和警告", () => {
  const { errors, warnings } = check();
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test("R1 页码重复会报错", () => {
  const result = check((t) => replaceOnce(t, "### 第 2 页 · 方法总览", "### 第 1 页 · 方法总览"));
  assertError(result, "「第 1 页」重复了");
});

test("R1 页码不连续会报错", () => {
  const result = check((t) => replaceOnce(t, "### 第 6 页 · 一图看懂", "### 第 7 页 · 一图看懂"));
  assertError(result, "页码应该是「第 6 页」");
});

const BOX_LINE = "标注：合并模块 | 64%, 58%, 36%, 30%";
for (const [name, box, fragment] of [
  ["空坐标", "合并模块 | ", "缺少红框位置"],
  ["待定", "合并模块 | 待定", "还是「待定」"],
  ["非法数字", "合并模块 | 25abc, 58%, 36%, 30%", "格式不对"],
  ["缺少 %", "合并模块 | 64, 58, 36, 30", "格式不对"],
  ["只有 3 个数", "合并模块 | 64%, 58%, 36%", "格式不对"],
  ["宽为 0", "合并模块 | 64%, 58%, 0%, 30%", "大于 0"],
  ["超出原图", "合并模块 | 80%, 58%, 36%, 30%", "超出了原图范围"],
]) {
  test(`R2 红框：${name}会报错`, () => {
    const result = check((t) => replaceOnce(t, BOX_LINE, `标注：${box}`));
    assertError(result, fragment);
  });
}

const METRIC_LINE = "指标：推理速度 | ↑ | 2.3 | 倍 | 相同精度下的提速";
const POINT_LINE = "要点：分块计算 | 每次只处理一小块，显存占用更低";

test("R3 指标的必填部分为空会报错", () => {
  const result = check((t) => replaceOnce(t, METRIC_LINE, "指标： | | | | "));
  assertError(result, "第 1 部分是空的");
});

test("R3 指标的符号和单位可以留空", () => {
  const result = check((t) => replaceOnce(t, METRIC_LINE, "指标：准确率 |  | 92.3 |  | 相同数据集下"));
  assert.deepEqual(result.errors, []);
});

test("R3 要点多出一段会报错，不会被截断", () => {
  const result = check((t) => replaceOnce(t, POINT_LINE, "要点：分块计算 | 每次只处理一小块 | 被丢掉的限定条件"));
  assertError(result, "应该正好分成 2 部分");
});

test("R3 要点只写标题会报错", () => {
  const result = check((t) => replaceOnce(t, POINT_LINE, "要点：分块计算"));
  assertError(result, "应该正好分成 2 部分");
});

test("R3 同一字段写两次、字段名写错都会报错", () => {
  const twice = check((t) => replaceOnce(t, "- 主标题：把长序列切成小块", "- 主标题：把长序列切成小块\n- 主标题：重复的标题"));
  assertError(twice, "「主标题」写了不止一次");
  const typo = check((t) => replaceOnce(t, "- 主标题：把长序列切成小块", "- 主标提：把长序列切成小块"));
  assertError(typo, "「主标提」不是 figure_text 版式的字段");
});

test("R4 开头缺少字段会报错", () => {
  const removed = [
    "- arXiv：0000.00000v1\n",
    "- 状态：预印本\n",
    "- 链接：https://arxiv.org/abs/0000.00000v1\n",
    "- 简介：这是测试合成脚本用的示例稿，论文和数据都是虚构的。\n",
    "- 标签：示例、测试、注意力机制\n",
  ];
  const result = check((t) => removed.reduce((text, line) => replaceOnce(text, line, ""), t));
  for (const key of ["arXiv", "状态", "链接", "简介", "标签"]) assertError(result, `缺少「${key}」`);
});

test("R4 没有封面页时，照样检查开头", () => {
  const result = check((t) => {
    const withoutCover = t.replace(/### 第 1 页 · 开场[\s\S]*?(?=### 第 2 页)/, "");
    assert.notEqual(withoutCover, t, "没能删掉封面页");
    return replaceOnce(withoutCover, "- 链接：https://arxiv.org/abs/0000.00000v1\n", "");
  });
  assert.ok(result.slides.every((slide) => slide.layout !== "cover"), "封面页应该已经删掉");
  assertError(result, "缺少「链接」");
});

test("R4 arXiv 必须带版本号", () => {
  const result = check((t) => replaceOnce(t, "- arXiv：0000.00000v1", "- arXiv：0000.00000"));
  assertError(result, "带版本号");
});

test("R4 链接要和 arXiv 编号是同一个版本", () => {
  const result = check((t) =>
    replaceOnce(t, "- 链接：https://arxiv.org/abs/0000.00000v1", "- 链接：https://arxiv.org/abs/0000.00000v2"),
  );
  assertError(result, "同一个版本");
});

test("R4 预印本的「会议或期刊」必须写「无」", () => {
  const result = check((t) => replaceOnce(t, "- 会议或期刊：无", "- 会议或期刊：NeurIPS 2026"));
  assertError(result, "要写「无」");
});

test("T24 封面内容取自开头", () => {
  const { cover } = check();
  assert.equal(cover.layout, "bilibili-cover");
  assert.equal(cover.values.cover_title, "看懂分块注意力");
  assert.equal(cover.values.field_tag, "AI · 示例");
  assert.equal(cover.values.paper_status, "预印本");
  assert.equal(cover.values.brand_text, "DailyPaper · 每日论文");
  assert.deepEqual(cover.hidden, []);
});

test("T24 缺少「封面大字」会报错", () => {
  const result = check((t) => replaceOnce(t, "- 封面大字：看懂分块注意力\n", ""));
  assertError(result, "缺少「封面大字」");
});

test("T24 可选的封面字段可以不写，封面上整块隐藏", () => {
  const result = check((t) => {
    let text = replaceOnce(t, "- 封面副标题：FastAttn：一种虚构的注意力加速方法\n", "");
    text = replaceOnce(text, "- 封面卖点：显存减少 40%\n", "");
    return replaceOnce(text, "- 封面指标：提速 2.3 倍\n", "");
  });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.cover.hidden, [".cover-sub", ".highlight-pill", ".hero-graphic"]);
});

test("T24 封面字段不能写「无」，也不能带上「（可选）」", () => {
  const none = check((t) => replaceOnce(t, "- 封面卖点：显存减少 40%", "- 封面卖点：无"));
  assertError(none, "不用就整行删掉，不要写「无」");
  const note = check((t) => replaceOnce(t, "- 封面指标：提速 2.3 倍", "- 封面指标：提速 2.3 倍（可选）"));
  assertError(note, "「（可选）」只是格式说明");
});

test("T24 封面大字太长会提醒", () => {
  const result = check((t) => replaceOnce(t, "- 封面大字：看懂分块注意力", "- 封面大字：一分钟带你彻底看懂分块注意力机制"));
  assert.ok(
    result.warnings.some((warning) => warning.includes("「封面大字」有") && warning.includes("不超过 12 个字")),
    `应该提醒封面大字太长，实际：${result.warnings.join("\n") || "（没有警告）"}`,
  );
});

test("视频标题要以「【每日论文 #期数】」开头", () => {
  const result = check((t) =>
    replaceOnce(t, "- 视频标题：【每日论文 #0】FastAttn", "- 视频标题：FastAttn"),
  );
  assert.ok(
    result.warnings.some((warning) => warning.includes("【每日论文 #期数】")),
    `应该提醒加上系列标识，实际：${result.warnings.join("\n") || "（没有警告）"}`,
  );
});

test("视频标题超过 40 字会提醒", () => {
  const result = check((t) =>
    replaceOnce(t, "一种虚构的注意力加速方法（示例）", "一种虚构的注意力加速方法，让长文本推理又快又省显存（示例）"),
  );
  assert.ok(
    result.warnings.some((warning) => warning.includes("「视频标题」有") && warning.includes("不超过 40")),
    `应该提醒标题太长，实际：${result.warnings.join("\n") || "（没有警告）"}`,
  );
});

test("机构和作者相同时，第一页只写一次", () => {
  const same = check((t) => replaceOnce(t, "- 机构：示例大学", "- 机构：示例作者 A、示例作者 B"));
  assert.ok(same.slides[0].hidden.includes(".affiliations"), "机构和作者相同，应该隐藏机构");
  assert.ok(!check().slides[0].hidden.includes(".affiliations"), "机构和作者不同，应该显示机构");
});

test("视频第一页的标题去掉系列标识", () => {
  const { slides } = check();
  assert.equal(slides[0].values.video_title, "FastAttn｜一种虚构的注意力加速方法（示例）");
});

test("T27 核对表写 v10、开头是 v1 时会给出警告", () => {
  const result = check((t) => replaceOnce(t, "| v1 | Table 2 |", "| v10 | Table 2 |"));
  assert.ok(
    result.warnings.some((warning) => warning.includes("v10") && warning.includes("不一致")),
    `应该警告版本不一致，实际：${result.warnings.join("\n") || "（没有警告）"}`,
  );
});

test("T27 核对表写完整编号且版本一致时，不警告", () => {
  const result = check((t) => replaceOnce(t, "| v1 | Table 2 |", "| 0000.00000v1 | Table 2 |"));
  assert.deepEqual(result.warnings, []);
});

test("R5 发音替换只做一次，替换出的读法不会被再次替换", () => {
  const table = [
    { original: "GPT-4", reading: "GPT four" },
    { original: "GPT", reading: "G P T" },
  ];
  assert.equal(applyPronunciations("GPT-4 比 GPT 强", table), "GPT four 比 G P T 强");
});

test("同一图号有两个图片文件会报错", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dailypaper-test-"));
  try {
    fs.cpSync(EXAMPLE_DIR, tempDir, { recursive: true, filter: (source) => path.basename(source) !== "output" });
    fs.writeFileSync(path.join(tempDir, "figures", "figure1.png"), "not really a png");
    const result = check(undefined, tempDir);
    assertError(result, "只能保留一个");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
