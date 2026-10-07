// Entry point.
//   npm run render -- <episode folder>   turn episodes/<...>/script.md into a video
//   npm run check  -- <episode folder>   only check the script, no audio or video

import fs from "node:fs";
import path from "node:path";
import { parseScript } from "./parse-script.js";
import { buildSlides } from "./layouts.js";
import { createNarration, DEFAULT_RATE, DEFAULT_VOICE } from "./tts.js";
import { DEFAULT_THEME, listThemes, renderCover, renderFrames } from "./frames.js";
import { composeVideo, writeChapters, writeSrt } from "./compose.js";
import { episodeNumberProblem, readPublished } from "./episodes.js";

const USAGE = `用法：
  npm run render -- <本期文件夹> [--theme ${DEFAULT_THEME}|dark] [--voice ${DEFAULT_VOICE}] [--rate ${DEFAULT_RATE}]
  npm run check -- <本期文件夹>`;

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.episodeDir) {
    console.log(USAGE);
    process.exitCode = 1;
    return;
  }
  const themes = listThemes();
  if (!themes.includes(options.theme)) {
    const problem = options.theme ? `没有「${options.theme}」这个风格` : "--theme 后面要写风格名";
    throw new Error(`${problem}，可选：${themes.join("、")}`);
  }

  const episodeDir = path.resolve(options.episodeDir);
  const scriptFile = path.join(episodeDir, "script.md");
  if (!fs.existsSync(scriptFile)) throw new Error(`找不到讲解稿：${scriptFile}`);

  const script = parseScript(fs.readFileSync(scriptFile, "utf8"));
  const { slides, cover, errors, warnings } = buildSlides(script, episodeDir);
  // The number in the title follows the publishing order kept in episodes/published.json.
  const titleField = script.headerFields.find((field) => field.key === "视频标题");
  const numberProblem = episodeNumberProblem(path.basename(episodeDir), titleField?.value, readPublished());
  if (numberProblem) warnings.push(`开头（第 ${titleField.lineNo} 行）：「视频标题」的期数不对：${numberProblem}`);
  warnings.forEach((warning) => console.warn(`⚠️  ${warning}`));
  if (errors.length > 0) {
    console.error(`讲解稿有 ${errors.length} 个问题，改好之后再生成：`);
    errors.forEach((error) => console.error(`  - ${error}`));
    process.exitCode = 1;
    return;
  }

  printSummary(script, slides);
  if (options.check) {
    console.log("\n检查通过。");
    return;
  }

  const workDir = path.join(episodeDir, "output");
  fs.mkdirSync(workDir, { recursive: true });

  console.log(`\n[1/4] 生成配音（${options.voice}）`);
  const narration = await createNarration(slides, {
    voice: options.voice,
    rate: options.rate,
    pronunciations: script.pronunciations,
    workDir,
  });

  console.log(`[2/4] 渲染画面（风格：${options.theme}）`);
  const { frames, warnings: frameWarnings } = await renderFrames(slides, narration, workDir, { theme: options.theme });
  frameWarnings.forEach((warning) => console.warn(`⚠️  ${warning}`));

  console.log("[3/4] 合成视频");
  const videoFile = path.join(workDir, "video.mp4");
  const srtFile = path.join(workDir, "subtitles.srt");
  const chaptersFile = path.join(workDir, "chapters.txt");
  await composeVideo({ frames, audioFile: narration.audioFile, outFile: videoFile, workDir, duration: narration.duration });
  writeSrt(narration, srtFile);
  writeChapters(slides.map((slide, index) => ({ start: narration.pages[index].start, title: slide.topic })), chaptersFile);

  console.log("[4/4] 生成 B 站封面");
  const { file: coverFile, warnings: coverWarnings } = await renderCover(cover, workDir, { theme: options.theme });
  coverWarnings.forEach((warning) => console.warn(`⚠️  ${warning}`));

  console.log(`\n完成！视频时长 ${formatDuration(narration.duration)}`);
  console.log(`  视频：${videoFile}`);
  console.log(`  字幕：${srtFile}`);
  console.log(`  章节：${chaptersFile}（贴到 B 站的章节设置、简介或置顶评论，观众可以点时间跳转）`);
  console.log(`  封面：${coverFile}`);
}

function parseArgs(args) {
  const options = { episodeDir: null, check: false, theme: DEFAULT_THEME, voice: DEFAULT_VOICE, rate: DEFAULT_RATE };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--check") options.check = true;
    else if (arg === "--theme") options.theme = args[++i] ?? "";
    else if (arg === "--voice") options.voice = args[++i];
    else if (arg === "--rate") options.rate = args[++i];
    else if (!arg.startsWith("--")) options.episodeDir = arg;
  }
  return options;
}

function printSummary(script, slides) {
  const lineCount = slides.reduce((sum, slide) => sum + slide.narration.length, 0);
  const estimated = script.pages.reduce((sum, page) => sum + (page.estimatedSeconds ?? 0), 0);
  console.log(`讲解稿：${slides.length} 页，${lineCount} 句字幕，预估 ${formatDuration(estimated)}`);
  slides.forEach((slide) => console.log(`  第 ${slide.number} 页  ${slide.layout.padEnd(17)}${slide.topic}`));
}

function formatDuration(seconds) {
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return minutes > 0 ? `${minutes} 分 ${rest} 秒` : `${rest} 秒`;
}

main().catch((error) => {
  console.error(`\n出错了：${error.message}`);
  process.exitCode = 1;
});
