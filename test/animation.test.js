// Checks for the screenshot plan of the animated video (visual v2, T63): reusing a still
// screenshot must not change the timing, and subtitles never show before their voice.
// Run with: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { FPS, PAGE_FADE_IN, PAGE_FADE_OUT, pageTurn, planPageFrames } from "../src/animation.js";
import { concatList } from "../src/compose.js";

// Shaped like the demo's second page: 7.148 seconds, three subtitle lines, 0.3 seconds before the first.
const PAGE = { start: 8.328, end: 15.476, lines: [{ start: 8.628 }, { start: 10.91 }, { start: 13.2 }] };
const FIRST_FRAME = Math.round(PAGE.start * FPS);
const END_FRAME = Math.round(PAGE.end * FPS);

/** The subtitle line a video frame should show, worked out on its own: -1 before the first one. */
function lineAt(frame, lines) {
  return lines.filter((line) => line.start <= frame / FPS + 1e-9).length - 1;
}

for (const [name, moves] of [
  ["静态（--static）", []],
  ["带翻页", pageTurn(PAGE.end - PAGE.start).moves],
]) {
  test(`${name}：截图一张接一张盖满本页的每一帧，不多不少`, () => {
    const shots = planPageFrames(PAGE, moves);
    assert.equal(shots[0].frame, FIRST_FRAME);
    for (const [index, shot] of shots.entries()) {
      const next = shots[index + 1]?.frame ?? END_FRAME;
      assert.equal(shot.frame + shot.count, next, `第 ${index + 1} 张截图之后接不上`);
    }
    assert.equal(shots.reduce((sum, shot) => sum + shot.count, 0), END_FRAME - FIRST_FRAME);
  });

  test(`${name}：复用的截图不改变每一帧显示的字幕`, () => {
    for (const shot of planPageFrames(PAGE, moves)) {
      for (let frame = shot.frame; frame < shot.frame + shot.count; frame++) {
        assert.equal(shot.line, lineAt(frame, PAGE.lines), `第 ${frame} 帧的字幕不对`);
      }
    }
  });

  test(`${name}：字幕不会早于开口出现`, () => {
    for (const shot of planPageFrames(PAGE, moves).filter((shot) => shot.line >= 0)) {
      assert.ok(shot.frame / FPS >= PAGE.lines[shot.line].start - 1e-9, `第 ${shot.line + 1} 句的字幕早了`);
    }
  });
}

test("静态时每句字幕一张截图，开口前的停顿一张空字幕", () => {
  const shots = planPageFrames(PAGE, []);
  assert.deepEqual(shots.map((shot) => shot.line), [-1, 0, 1, 2]);
  assert.ok(shots.every((shot) => !shot.moving));
});

test("翻页的淡入、淡出逐帧截图，中间静止时一句字幕一张", () => {
  const shots = planPageFrames(PAGE, pageTurn(PAGE.end - PAGE.start).moves);
  const fadeInFrames = Math.ceil(PAGE_FADE_IN * FPS);
  assert.ok(shots.slice(0, fadeInFrames).every((shot) => shot.moving && shot.count === 1));
  const still = shots.filter((shot) => !shot.moving);
  assert.deepEqual(still.map((shot) => shot.line), [0, 1, 2], "淡入结束后，三句字幕各一张");
  const fadeOut = shots.filter((shot) => shot.moving && shot.time >= PAGE.end - PAGE.start - PAGE_FADE_OUT - 1e-9);
  assert.ok(fadeOut.length >= Math.floor(PAGE_FADE_OUT * FPS), `淡出只有 ${fadeOut.length} 帧`);
  assert.ok(fadeOut.every((shot) => shot.line === 2), "淡出时最后一句字幕还在");
});

test("很短的页，淡入淡出各不超过页长的三分之一", () => {
  const turn = pageTurn(0.9);
  assert.equal(turn.fadeIn, 0.3);
  assert.equal(turn.fadeOut, 0.3);
  assert.deepEqual(pageTurn(10).moves, [[0, PAGE_FADE_IN], [10 - PAGE_FADE_OUT, 10]]);
});

test("几百张 1/30 秒的截图连起来，时长不会累积出误差", () => {
  const frames = Array.from({ length: 900 }, (_, index) => ({ file: `D:\\frames\\p01-${index}.png`, duration: 1 / FPS }));
  const list = concatList(frames);
  const total = [...list.matchAll(/^duration ([\d.]+)$/gm)].reduce((sum, match) => sum + Number(match[1]), 0);
  assert.ok(Math.abs(total - 30) < 0.001, `900 帧加起来是 ${total} 秒`);
  assert.ok(list.endsWith("file 'D:/frames/p01-899.png'"), "最后一张要再写一次，最后的时长才算数");
});
