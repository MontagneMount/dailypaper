// Checks for subtitle text and timing (from Gemini's video pre-review, T21).
// Run with: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { spreadLines, subtitleText, toSpeech } from "../src/timing.js";

test("字幕去掉行末的逗号、句号和冒号，保留问号和感叹号", () => {
  assert.equal(subtitleText("今天用一篇虚构的论文，"), "今天用一篇虚构的论文");
  assert.equal(subtitleText("最后总结一下："), "最后总结一下");
  assert.equal(subtitleText("这是一种方法。"), "这是一种方法");
  assert.equal(subtitleText("我们下期再见！"), "我们下期再见！");
  assert.equal(subtitleText("真的吗？"), "真的吗？");
  assert.equal(subtitleText("中间的，逗号不动"), "中间的，逗号不动");
});

test("含替换读法的英文词，按实际读音分到更多时间", () => {
  const lines = ["它叫 FastAttn，", "是一种加速方法。"];
  const table = [{ original: "FastAttn", reading: "Fast Attention" }];
  const { speech, spoken } = toSpeech(lines, table);
  assert.equal(speech, "它叫 Fast Attention，是一种加速方法。");

  const withReading = spreadLines(lines, spoken, 0, 4);
  const withoutReading = spreadLines(lines, lines, 0, 4);
  assert.ok(withReading[0].end > withoutReading[0].end, "第一行应该分到更多时间");
  assert.equal(withReading[0].text, "它叫 FastAttn，", "字幕原文保留缩写");
  assert.equal(withReading[0].display, "它叫 FastAttn", "屏幕上去掉行末逗号");
  assert.ok(Math.abs(withReading.at(-1).end - 4) < 1e-9, "整句的时间要正好分完");
});
