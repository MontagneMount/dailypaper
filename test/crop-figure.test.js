// Regression checks for npm run figure (code review T38, fixed in T39).
// Run with: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { blankRuns, figureFile, parseRegion, pixelBox } from "../src/crop-figure.js";

const EPISODE = path.resolve("episodes/some-episode");

test("T39 R1 名字按图号写，存进本期的 figures/", () => {
  assert.equal(figureFile(EPISODE, "figure3b"), path.join(EPISODE, "figures", "figure3b.png"));
  assert.equal(figureFile(EPISODE, "table11"), path.join(EPISODE, "figures", "table11.png"));
});

test("T39 R1 名字不能带路径、大写字母或扩展名", () => {
  const names = ["../../../output/review-probe", "a/b", "a\\b", "..", ".hidden", "", "Figure1", "figure1.png"];
  for (const name of names) {
    assert.throws(() => figureFile(EPISODE, name), /名字/, `应该拒绝「${name}」`);
  }
});

test("T39 R2 范围要正好写 4 个 0～1 之间的数", () => {
  assert.deepEqual(parseRegion("0.11,0.12,0.30,0.88"), { top: 0.11, left: 0.12, bottom: 0.3, right: 0.88 });
  assert.deepEqual(parseRegion(" 0.1 , 0.2 , 0.7 , 0.8 "), { top: 0.1, left: 0.2, bottom: 0.7, right: 0.8 });

  const wrong = [
    ",0.2,0.7,0.8", // empty item
    "0.1,,0.7,0.8",
    "0.1,0.2,0.7,0.8,0.9", // extra item
    "0.1,0.2,0.7", // missing item
    "0.1,0.2,abc,0.8",
    "-0.1,0.2,0.7,0.8",
    "0.1,0.2,1.5,0.8", // beyond the page
    "0.7,0.2,0.1,0.8", // top below bottom
    "0.1,0.8,0.7,0.2", // left right of right
  ];
  for (const text of wrong) {
    assert.throws(() => parseRegion(text), /范围/, `应该拒绝「${text}」`);
  }
});

test("T39 R2 范围换算成像素后，宽和高不能是 0", () => {
  const page = { width: 1000, height: 2000 };
  assert.deepEqual(pixelBox({ top: 0.1, left: 0.2, bottom: 0.3, right: 0.8 }, page), { x: 200, y: 200, width: 600, height: 400 });
  assert.throws(() => pixelBox({ top: 0.5, left: 0.2, bottom: 0.5001, right: 0.8 }, page), /太小/);
});

test("T63 --gaps：找出连续的空白行，太窄的不算，开头和结尾的也算", () => {
  //               0  1  2  3  4  5  6  7  8  9
  const flags = [1, 1, 0, 0, 1, 0, 1, 1, 1, 1];
  assert.deepEqual(blankRuns(flags, 2), [[0, 2], [6, 10]]);
  assert.deepEqual(blankRuns(flags, 1), [[0, 2], [4, 5], [6, 10]]);
  assert.deepEqual(blankRuns([0, 0, 0], 1), []);
  assert.deepEqual(blankRuns([1, 1, 1], 2), [[0, 3]]);
});
