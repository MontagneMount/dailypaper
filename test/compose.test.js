// Checks for the chapter list written next to the video.
// Run with: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { formatChapters } from "../src/compose.js";

test("章节按每页开始的时间写，秒数向下取整", () => {
  const chapters = [
    { start: 0, title: "开场" },
    { start: 17.04, title: "任务" },
    { start: 61.9, title: "方法" },
    { start: 600, title: "结尾" },
  ];
  assert.deepEqual(formatChapters(chapters), ["00:00 开场", "00:17 任务", "01:01 方法", "10:00 结尾"]);
});
