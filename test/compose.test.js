// Checks for the chapter list written next to the video, and for the frames FFmpeg puts in it.
// Run with: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";
import { FPS, planPageFrames } from "../src/animation.js";
import { composeVideo, formatChapters } from "../src/compose.js";
import { runFfmpeg } from "../src/ffmpeg.js";

test("章节按每页开始的时间写，秒数向下取整", () => {
  const chapters = [
    { start: 0, title: "开场" },
    { start: 17.04, title: "任务" },
    { start: 61.9, title: "方法" },
    { start: 600, title: "结尾" },
  ];
  assert.deepEqual(formatChapters(chapters), ["00:00 开场", "00:17 任务", "01:01 方法", "10:00 结尾"]);
});

test("T66 R1 经过真实的 FFmpeg：每一帧都是截图计划里的那张，不丢帧、不重复，字幕在开口那一帧换", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dailypaper-compose-"));
  try {
    // 2.5 seconds: fades in until 0.3 s, a line starts at 0.3 s and another at 1.0 s, something moves 1.2–1.5 s.
    const timing = { start: 0, end: 2.5, lines: [{ start: 0.3 }, { start: 1.0 }] };
    const shots = planPageFrames(timing, [[0, 0.3], [1.2, 1.5]]);
    // Each screenshot is a flat grey of its own, 10 levels apart.
    const frames = [];
    for (const [index, shot] of shots.entries()) {
      const file = path.join(dir, `shot${index}.png`);
      const grey = ((index + 1) * 10).toString(16).padStart(2, "0").repeat(3);
      await runFfmpeg(["-y", "-f", "lavfi", "-i", `color=c=0x${grey}:s=64x64`, "-frames:v", "1", file]);
      frames.push({ file, duration: shot.count / FPS });
    }
    const audioFile = path.join(dir, "silence.wav");
    await runFfmpeg(["-y", "-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono", "-t", "2.5", audioFile]);
    const outFile = path.join(dir, "video.mp4");
    await composeVideo({ frames, audioFile, outFile, workDir: dir, duration: 2.5 });

    // Every frame before the closing fade-out (the last 0.8 s) is the screenshot the plan puts there.
    const checked = Math.round(1.7 * FPS);
    const decoded = spawnSync(ffmpegPath, ["-v", "error", "-i", outFile, "-frames:v", String(checked), "-f", "rawvideo", "-pix_fmt", "gray", "-"], { maxBuffer: 1 << 24 });
    const actual = Array.from({ length: checked }, (_, frame) => Math.round(decoded.stdout[frame * 64 * 64 + 2080] / 10));
    const expected = shots.flatMap((shot, index) => Array(shot.count).fill(index + 1)).slice(0, checked);
    assert.deepEqual(actual, expected);
    // The second line's subtitle comes in on the frame at 1.0 s, not a frame early or late.
    assert.notEqual(actual[29], actual[30]);
    assert.equal(actual[30], actual[31]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
