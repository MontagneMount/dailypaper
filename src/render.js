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
import { assertCanRender, episodeNumberProblem, readPublished } from "./episodes.js";
import { scheduleAll } from "./cues.js";
import { previewStatus } from "./preview.js";

const USAGE = `用法：
  npm run render -- <本期文件夹> [--theme ${DEFAULT_THEME}|dark] [--static] [--force] [--voice ${DEFAULT_VOICE}] [--rate ${DEFAULT_RATE}]
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
  const { slides, cover, cues, errors, warnings } = buildSlides(script, episodeDir);
  // The number in the title follows the publishing order kept in episodes/published.json.
  const published = readPublished();
  const titleField = script.headerFields.find((field) => field.key === "视频标题");
  const numberProblem = episodeNumberProblem(path.basename(episodeDir), titleField?.value, published);
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
    // The cue table's timing needs a voice-over: use the last one if it still fits the script.
    const hasCues = [...cues.values()].some((page) => page.actions.length > 0);
    const last = hasCues ? lastNarration(path.join(episodeDir, "output"), slides, options) : null;
    if (last) {
      const timed = scheduleAll(cues, last);
      timed.warnings.forEach((warning) => console.warn(`⚠️  ${warning}`));
      if (timed.errors.length > 0) {
        console.error(`镜头表的时间有 ${timed.errors.length} 个问题（按上次生成的配音算）：`);
        timed.errors.forEach((error) => console.error(`  - ${error}`));
        process.exitCode = 1;
        return;
      }
    } else if (hasCues) {
      console.log("\n（镜头表的时间要按配音检查：运行 npm run preview 时会查）");
    }
    // The cue table is reviewed with its preview, which must have been made from the current inputs.
    const status = previewStatus(episodeDir, slides, cues, options.theme);
    status.problems.forEach((problem) => console.warn(`⚠️  ${problem}`));
    if (status.problems.length === 0 && status.fresh.length > 0) console.log(`\n预览是最新的（第 ${status.fresh.join("、")} 页），可以拿 output/preview/index.html 核对`);
    console.log("\n检查通过。");
    return;
  }

  assertCanRender(path.basename(episodeDir), published, { force: options.force });
  const workDir = path.join(episodeDir, "output");
  fs.mkdirSync(workDir, { recursive: true });

  console.log(`\n[1/4] 生成配音（${options.voice}）`);
  const narration = await createNarration(slides, {
    voice: options.voice,
    rate: options.rate,
    pronunciations: script.pronunciations,
    workDir,
  });

  // The cue table's timing can only be checked against the real narration.
  const timed = options.static ? { schedules: new Map(), errors: [], warnings: [] } : scheduleAll(cues, narration);
  timed.warnings.forEach((warning) => console.warn(`⚠️  ${warning}`));
  if (timed.errors.length > 0) {
    console.error(`镜头表有 ${timed.errors.length} 个问题（按这次配音的时间算），改好之后再生成：`);
    timed.errors.forEach((error) => console.error(`  - ${error}`));
    process.exitCode = 1;
    return;
  }

  console.log(`[2/4] 渲染画面（风格：${options.theme}${options.static ? "，静态" : ""}）`);
  const { frames, warnings: frameWarnings, fonts, environment } = await renderFrames(slides, narration, workDir, {
    theme: options.theme,
    animate: !options.static,
    schedules: timed.schedules,
  });
  [...frameWarnings, ...fonts].forEach((warning) => console.warn(`⚠️  ${warning}`));
  if (!options.static) {
    const status = previewStatus(episodeDir, slides, cues, options.theme, { voice: options.voice, rate: options.rate, narration, environment });
    status.problems.forEach((problem) => console.warn(`⚠️  ${problem}`));
  }

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
  const options = { episodeDir: null, check: false, static: false, force: false, theme: DEFAULT_THEME, voice: DEFAULT_VOICE, rate: DEFAULT_RATE };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--check") options.check = true;
    else if (arg === "--static") options.static = true;
    else if (arg === "--force") options.force = true;
    else if (arg === "--theme") options.theme = args[++i] ?? "";
    else if (arg === "--voice") options.voice = args[++i];
    else if (arg === "--rate") options.rate = args[++i];
    else if (!arg.startsWith("--")) options.episodeDir = arg;
    else throw new Error(`不认识「${arg}」这个选项\n${USAGE}`);
  }
  return options;
}

/**
 * The narration of the last render or preview (output/narration.json), when it was made from the
 * same lines with the same voice and rate, so its times are the ones the video will have; else null.
 */
function lastNarration(workDir, slides, { voice, rate }) {
  const file = path.join(workDir, "narration.json");
  if (!fs.existsSync(file)) return null;
  try {
    const narration = JSON.parse(fs.readFileSync(file, "utf8"));
    const sameLines = (page, slide) => page.number === slide.number && page.lines.map((line) => line.text).join("\n") === slide.narration.join("\n");
    const same = narration.voice === voice && narration.rate === rate && narration.pages.length === slides.length
      && narration.pages.every((page, index) => sameLines(page, slides[index]));
    return same ? narration : null;
  } catch {
    return null;
  }
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
