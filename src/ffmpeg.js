// Run the FFmpeg binary that ships with the ffmpeg-static package.

import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";

export function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, ["-hide_banner", "-loglevel", "error", ...args], { windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg 出错（退出码 ${code}）：${stderr.trim().slice(-800)}`));
    });
  });
}
