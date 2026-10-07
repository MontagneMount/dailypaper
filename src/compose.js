// Turn the frames and the narration into an MP4, and write the SRT subtitles and the chapter list.

import fs from "node:fs";
import path from "node:path";
import { runFfmpeg } from "./ffmpeg.js";

const FADE_OUT_SECONDS = 0.8;

export async function composeVideo({ frames, audioFile, outFile, workDir, duration }) {
  const listFile = path.join(workDir, "frames.txt");
  fs.writeFileSync(listFile, concatList(frames));

  await runFfmpeg([
    "-y",
    "-f", "concat", "-safe", "0", "-i", listFile,
    "-i", audioFile,
    "-vf", `fps=30,format=yuv420p,fade=t=out:st=${Math.max(0, duration - FADE_OUT_SECONDS).toFixed(3)}:d=${FADE_OUT_SECONDS}`,
    "-c:v", "libx264", "-preset", "medium", "-crf", "20",
    "-c:a", "aac", "-b:a", "160k",
    "-shortest", "-movflags", "+faststart",
    outFile,
  ]);
}

/**
 * The ffconcat list: each screenshot and how long it stays on screen. Durations keep microseconds,
 * so hundreds of 1/30-second animation frames do not add up to a visible drift.
 */
export function concatList(frames) {
  const lines = ["ffconcat version 1.0"];
  for (const frame of frames) {
    lines.push(`file '${toFfmpegPath(frame.file)}'`, `duration ${frame.duration.toFixed(6)}`);
  }
  // The concat demuxer only honours the last duration if the last file is listed again.
  lines.push(`file '${toFfmpegPath(frames.at(-1).file)}'`);
  return lines.join("\n");
}

export function writeSrt(narration, file) {
  const lines = narration.pages.flatMap((page) => page.lines);
  const body = lines
    .map((line, index) => `${index + 1}\n${srtTime(line.start)} --> ${srtTime(line.end)}\n${line.display}\n`)
    .join("\n");
  fs.writeFileSync(file, body);
}

/**
 * One "mm:ss 标题" line per page. Pasted into Bilibili's chapter setting, or into the description
 * or a pinned comment (where the timestamps are clickable), it lets viewers jump between parts.
 */
export function writeChapters(chapters, file) {
  fs.writeFileSync(file, `${formatChapters(chapters).join("\n")}\n`);
}

/** [{ start: 17.04, title: "任务" }] -> ["00:17 任务"] */
export function formatChapters(chapters) {
  const two = (n) => String(n).padStart(2, "0");
  return chapters.map(({ start, title }) => {
    const seconds = Math.floor(start);
    return `${two(Math.floor(seconds / 60))}:${two(seconds % 60)} ${title}`;
  });
}

/** 83.5 -> "00:01:23,500" */
function srtTime(seconds) {
  const totalMs = Math.round(seconds * 1000);
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const secs = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  const two = (n) => String(n).padStart(2, "0");
  return `${two(hours)}:${two(minutes)}:${two(secs)},${String(ms).padStart(3, "0")}`;
}

function toFfmpegPath(file) {
  return file.replace(/\\/g, "/").replace(/'/g, "'\\''");
}
