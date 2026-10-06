// Turn the frames and the narration into an MP4, and write an SRT subtitle file.

import fs from "node:fs";
import path from "node:path";
import { runFfmpeg } from "./ffmpeg.js";

export async function composeVideo({ frames, audioFile, outFile, workDir }) {
  const listFile = path.join(workDir, "frames.txt");
  const lines = ["ffconcat version 1.0"];
  for (const frame of frames) {
    lines.push(`file '${toFfmpegPath(frame.file)}'`, `duration ${frame.duration.toFixed(3)}`);
  }
  // The concat demuxer only honours the last duration if the last file is listed again.
  lines.push(`file '${toFfmpegPath(frames.at(-1).file)}'`);
  fs.writeFileSync(listFile, lines.join("\n"));

  await runFfmpeg([
    "-y",
    "-f", "concat", "-safe", "0", "-i", listFile,
    "-i", audioFile,
    "-vf", "fps=30,format=yuv420p",
    "-c:v", "libx264", "-preset", "medium", "-crf", "20",
    "-c:a", "aac", "-b:a", "160k",
    "-shortest", "-movflags", "+faststart",
    outFile,
  ]);
}

export function writeSrt(narration, file) {
  const lines = narration.pages.flatMap((page) => page.lines);
  const body = lines
    .map((line, index) => `${index + 1}\n${srtTime(line.start)} --> ${srtTime(line.end)}\n${line.text}\n`)
    .join("\n");
  fs.writeFileSync(file, body);
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
