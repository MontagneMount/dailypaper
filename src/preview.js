// npm run preview -- <episode folder> [page] [--clip] [--theme academic|dark] [--voice …] [--rate …]
// Stills of every action in the cue table (before, moving, held, after), of the page turns and of
// the moments where actions overlap, with output/preview/index.html to check positions, timing and
// readability at phone size. With a page number and --clip it also makes a short video of that
// page, with its sound. It uses the same narration, theme, figures and action code as
// npm run render, and records what all of them were: when any of them changes, the preview is out
// of date, and npm run check and npm run render say so (visual-v2.md section 6).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FPS } from "./animation.js";
import { composeVideo } from "./compose.js";
import { CUES_FILE, scheduleAll, targetName } from "./cues.js";
import { runFfmpeg } from "./ffmpeg.js";
import { DEFAULT_THEME, fontWarnings, launchBrowser, listThemes, renderEnvironment, renderFrames, setUpSlide, showMoment, VIEWPORT } from "./frames.js";
import { buildSlides } from "./layouts.js";
import { parseScript } from "./parse-script.js";
import { createNarration, DEFAULT_RATE, DEFAULT_VOICE } from "./tts.js";

const USAGE = `用法：
  npm run preview -- <本期文件夹> [页码] [--clip] [--theme ${DEFAULT_THEME}|dark] [--voice ${DEFAULT_VOICE}] [--rate ${DEFAULT_RATE}]
  不写页码就预览每一页；--clip 要和页码一起用，把这一页做成带声音的短片`;
const RECORD_FILE = "preview.json";

// Everything a page's preview depends on (previewInputs). Code, dependencies and templates are the
// same for every episode; all of the code counts, since any of it can change what a page shows.
const SRC_DIR = fileURLToPath(new URL("./", import.meta.url));
const LOCK_FILE = fileURLToPath(new URL("../package-lock.json", import.meta.url));
const TEMPLATES_DIR = fileURLToPath(new URL("../templates/", import.meta.url));
const INPUT_NAMES = {
  code: "代码或依赖版本",
  templates: "模板和风格文件",
  script: "讲稿",
  cues: "镜头表",
  page: "页面内容（版式、文字、卡片或镜头动作）",
  figure: "原图",
  diagram: "示意图",
  theme: "所选风格",
  voice: "配音声音",
  rate: "语速",
  timing: "配音时间",
  fonts: "实际用到的字体",
  browser: "浏览器版本",
};

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.episodeDir || (options.clip && !options.page)) {
    console.log(USAGE);
    process.exitCode = 1;
    return;
  }
  if (!listThemes().includes(options.theme)) throw new Error(`没有「${options.theme}」这个风格，可选：${listThemes().join("、")}`);

  const episodeDir = path.resolve(options.episodeDir);
  const scriptFile = path.join(episodeDir, "script.md");
  if (!fs.existsSync(scriptFile)) throw new Error(`找不到讲解稿：${scriptFile}`);
  const script = parseScript(fs.readFileSync(scriptFile, "utf8"));
  const { slides, cues, errors, warnings } = buildSlides(script, episodeDir);
  warnings.forEach((warning) => console.warn(`⚠️  ${warning}`));
  if (errors.length > 0) {
    console.error(`讲解稿或镜头表有 ${errors.length} 个问题，改好之后再预览：`);
    errors.forEach((error) => console.error(`  - ${error}`));
    process.exitCode = 1;
    return;
  }
  const chosen = options.page ? slides.filter((slide) => slide.number === options.page) : slides;
  if (chosen.length === 0) throw new Error(`讲稿里没有第 ${options.page} 页`);

  const workDir = path.join(episodeDir, "output");
  const previewDir = path.join(workDir, "preview");
  fs.mkdirSync(previewDir, { recursive: true });

  // The real narration (cached clips make this quick), so the times are the ones the video will have.
  console.log(`[1/3] 配音（${options.voice}）`);
  const narration = await createNarration(slides, { voice: options.voice, rate: options.rate, pronunciations: script.pronunciations, workDir });
  const timed = scheduleAll(cues, narration);
  timed.warnings.forEach((warning) => console.warn(`⚠️  ${warning}`));
  if (timed.errors.length > 0) {
    console.error(`镜头表有 ${timed.errors.length} 个问题（按这次配音的时间算），改好之后再预览：`);
    timed.errors.forEach((error) => console.error(`  - ${error}`));
    process.exitCode = 1;
    return;
  }

  console.log(`[2/3] 截图（风格：${options.theme}）`);
  const record = readRecord(previewDir);
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    for (const slide of chosen) {
      const timing = narration.pages[slides.indexOf(slide)];
      const schedule = timed.schedules.get(slide.number);
      const entry = await previewPage(page, slide, { cuePage: cues.get(slide.number), timing, schedule, previewDir, options, episodeDir });
      record.pages[slide.number] = entry;
      console.log(`  第 ${slide.number} 页：${record.pages[slide.number].moments.length} 张`);
    }
  } finally {
    await browser.close();
  }
  const { environment, missingFonts } = record.pages[chosen[0].number];
  Object.assign(record, { episode: path.basename(episodeDir), made: new Date().toISOString(), environment });
  fs.writeFileSync(path.join(previewDir, RECORD_FILE), JSON.stringify(record, null, 2));
  const status = previewStatus(episodeDir, slides, cues, options.theme, { voice: options.voice, rate: options.rate, narration, environment }, { allPages: true });
  const indexFile = path.join(previewDir, "index.html");
  fs.writeFileSync(indexFile, indexPage(record, slides, status, { ...options, missingFonts }));

  if (options.clip) {
    console.log(`[3/3] 第 ${options.page} 页的短片`);
    const clip = await makeClip(chosen[0], narration.pages[slides.indexOf(chosen[0])], timed.schedules, { workDir, previewDir, theme: options.theme });
    console.log(`  短片：${clip}`);
  }
  missingFonts.forEach((warning) => console.warn(`⚠️  ${warning}`));
  status.problems.forEach((problem) => console.warn(`⚠️  ${problem}`));
  console.log(`\n完成！打开 ${indexFile} 看预览`);
}

/** Take the stills of one page; returns its entry for preview.json. */
async function previewPage(page, slide, { cuePage, timing, schedule, previewDir, options, episodeDir }) {
  const order = String(slide.number).padStart(2, "0");
  for (const file of fs.readdirSync(previewDir).filter((name) => name.startsWith(`p${order}-`))) fs.rmSync(path.join(previewDir, file));

  const htmlFile = path.join(previewDir, `page${order}.html`);
  const { turn, cameraWindows } = await setUpSlide(page, slide, { htmlFile, theme: options.theme, timing, animate: true, schedule });
  fs.rmSync(htmlFile, { force: true });
  const missingFonts = await fontWarnings(page, options.theme);
  const environment = await renderEnvironment(page);
  const duration = timing.end - timing.start;
  const moments = previewMoments(schedule?.tracks ?? [], turn, duration);
  const lineAt = (time) => timing.lines.findLastIndex((line) => line.start - timing.start <= time + 1e-9);

  for (const [index, moment] of moments.entries()) {
    const line = lineAt(moment.time);
    await showMoment(page, { time: moment.time, turnTime: moment.turnTime, subtitle: timing.lines[line]?.display ?? "" });
    moment.file = `p${order}-${String(index + 1).padStart(2, "0")}.png`;
    moment.line = line;
    moment.videoTime = timing.start + moment.time;
    await page.screenshot({ path: path.join(previewDir, moment.file) });
  }

  const readable = schedule?.readable ?? [];
  const actions = (schedule?.tracks ?? []).map((track) => describeTrack(track, readable, cameraWindows));
  return {
    topic: slide.topic,
    layout: slide.layout,
    duration,
    made: new Date().toISOString(),
    inputs: previewInputs(episodeDir, slide, cuePage, options.theme, { voice: options.voice, rate: options.rate, timing, environment }),
    environment,
    missingFonts,
    actions,
    moments,
  };
}

/**
 * The moments of a page to take stills of (seconds from the page start): the page turn, each
 * action before, while moving, held and after, and the middle of every stretch in which two or more
 * actions overlap. Moments before the page has faded in show the page fully in (turnTime), so the
 * first action's "before" is the page's starting picture.
 */
export function previewMoments(tracks, turn, duration) {
  const frame = 1 / FPS;
  const moments = [];
  const add = (time, label, real = false) => {
    const at = Math.min(Math.max(time, 0), duration - frame);
    moments.push({ time: at, turnTime: real || at >= turn.fadeIn ? at : turn.fadeIn, labels: [label] });
  };
  add(0, "页首：本页开始时的样子");
  add(turn.fadeIn / 2, "翻页：淡入中", true);
  add(duration - turn.fadeOut - frame, "页末：所有动作做完的样子");
  add(duration - turn.fadeOut / 2, "翻页：淡出中", true);

  for (const track of tracks) {
    const name = trackName(track);
    add(track.start - frame, `${name}：之前`);
    if (track.kind === "appear") {
      add((track.start + track.end) / 2, `${name}：出现中`);
      add(track.end + frame, `${name}：出现后（一直保留到页末）`);
    } else if (track.kind === "emphasize") {
      add(track.start + 0.12, `${name}：变大中`);
      add((track.start + track.end) / 2, `${name}：最明显的时候`);
      add(track.end + frame, `${name}：恢复之后`);
    } else {
      add((track.start + track.shown) / 2, `${name}：进场中`);
      add(track.shown + frame, `${name}：稳定`);
      if (track.leave < duration) add(track.end + frame, `${name}：${track.kind === "camera" ? "拉回全图之后" : "退场之后"}`);
      else add(duration - turn.fadeOut / 2, `${name}：随翻页淡出`, true);
    }
  }

  // Where two or more actions (not counting cards coming in) are on screen at once.
  const busy = tracks.filter((track) => track.kind !== "appear");
  const edges = [...new Set(busy.flatMap((track) => [track.start, track.end]))].sort((a, b) => a - b);
  edges.slice(0, -1).forEach((from, index) => {
    const to = edges[index + 1];
    const middle = (from + to) / 2;
    const together = busy.filter((track) => track.start <= middle && middle < track.end);
    if (together.length >= 2) add(middle, `重叠：${together.map(trackName).join(" + ")}`);
  });

  // One still per video frame: moments that land on the same frame share it.
  const byFrame = new Map();
  for (const moment of moments.sort((a, b) => a.time - b.time)) {
    const key = `${Math.round(moment.time * FPS)}|${Math.round(moment.turnTime * FPS)}`;
    if (byFrame.has(key)) byFrame.get(key).labels.push(...moment.labels);
    else byFrame.set(key, moment);
  }
  return [...byFrame.values()];
}

function trackName(track) {
  const row = `第 ${track.action.lineNo} 行`;
  if (track.kind === "appear") return `${row} 出现 ${targetName(track.target)}`;
  if (track.kind === "emphasize") return `${row} 强调 卡片${track.card}「${track.text}」`;
  return `${row} ${track.action.label}`;
}

/** An action for the index: what, where, when; for a camera, the always-readable regions it leaves out. */
function describeTrack(track, readable, cameraWindows) {
  const box = track.box ? `${track.box.top}%, ${track.box.left}%, ${track.box.width}%, ${track.box.height}%` : "";
  const window = track.kind === "camera" ? cameraWindows.find((item) => Math.abs(item.start - track.start) < 1e-6) : null;
  const outside = window ? readable.filter((region) => !inside(region.box, window)).map((region) => region.name) : [];
  return {
    name: trackName(track),
    box,
    note: track.action.note,
    start: track.start,
    end: track.end,
    window: window ? `${round(window.top)}%, ${round(window.left)}%, ${round(window.width)}%, ${round(window.height)}%` : "",
    outside,
  };
}

function inside(box, window) {
  const e = 0.01;
  return box.top >= window.top - e && box.left >= window.left - e
    && box.top + box.height <= window.top + window.height + e && box.left + box.width <= window.left + window.width + e;
}

function round(number) {
  return Math.round(number * 10) / 10;
}

// ---- What the preview depends on ----

/**
 * Everything a page's preview depends on, as short hashes (T65; T66 R2): all of the code and the
 * locked dependency versions, the templates and themes, the script and cue table, what the page
 * actually shows (its slide after layout mapping, and its cue actions), its figure and diagram,
 * and the theme. With `timed` also what only a voice-over and a browser know: voice, rate, the
 * page's line times, the fonts really used and the browser version. Without it, only what
 * npm run check can see.
 * @param {{ voice, rate, timing, environment } | null} timed  timing: the page in narration.json;
 *   environment: renderEnvironment() of frames.js
 */
export function previewInputs(episodeDir, slide, cuePage, theme, timed = null) {
  const inputs = {
    code: hashFiles([...listFiles(SRC_DIR).filter((file) => file.endsWith(".js")), LOCK_FILE]),
    templates: hashFiles(listFiles(TEMPLATES_DIR).filter((file) => /\.(html|css)$/.test(file))),
    script: hashFiles([path.join(episodeDir, "script.md")]),
    cues: hashFiles([path.join(episodeDir, CUES_FILE)]),
    page: hash(JSON.stringify({ slide, cues: cuePage ?? null })),
    figure: hashFiles(slide.values.figure_image_path ? [fileURLToPath(slide.values.figure_image_path)] : []),
    diagram: hashFiles(slide.values.diagram_image_path ? [fileURLToPath(slide.values.diagram_image_path)] : []),
    theme,
  };
  if (!timed) return inputs;
  const { timing, environment } = timed;
  const times = [timing.start, timing.end, ...timing.lines.map((line) => line.start)].map((time) => time.toFixed(3));
  return {
    ...inputs,
    voice: timed.voice,
    rate: timed.rate,
    timing: hash(times.join(",")),
    fonts: hash(environment.fonts.join("\n")),
    browser: environment.browser,
  };
}

/**
 * Whether the previews can be trusted: pages with cue actions that have no preview, or whose
 * preview was made from other inputs (previewInputs). Without `timed` only what npm run check can
 * see is compared; npm run render and npm run preview pass { voice, rate, narration, environment }.
 * The index page is only a snapshot: this is the live check (T66 R2).
 * @returns {{ problems: string[], fresh: number[], stale: Map<number, string[]> }}
 *   warnings; the pages whose preview is up to date; for each out-of-date page, what changed
 */
export function previewStatus(episodeDir, slides, cues, theme, timed = null, { allPages = false } = {}) {
  const pages = slides.filter((slide) => allPages || cues.get(slide.number)?.actions.length > 0);
  const record = readRecord(path.join(episodeDir, "output", "preview"));
  const problems = [];
  const missing = pages.filter((slide) => !record.pages[slide.number]).map((slide) => slide.number);
  if (missing.length > 0 && !allPages) problems.push(`第 ${missing.join("、")} 页有镜头表，但还没有预览（npm run preview），位置和时间还没核对过`);

  const fresh = [];
  const stale = new Map();
  for (const slide of pages.filter((item) => record.pages[item.number])) {
    const pageTimed = timed && { ...timed, timing: timed.narration.pages[slides.indexOf(slide)] };
    const now = previewInputs(episodeDir, slide, cues.get(slide.number), theme, pageTimed);
    const changed = Object.keys(now).filter((key) => record.pages[slide.number].inputs[key] !== now[key]);
    if (changed.length === 0) fresh.push(slide.number);
    else stale.set(slide.number, changed.map((key) => INPUT_NAMES[key] ?? key));
  }
  // Pages out of date for the same reasons share one warning.
  const byReasons = new Map();
  for (const [number, reasons] of stale) byReasons.set(reasons.join("、"), [...(byReasons.get(reasons.join("、")) ?? []), number]);
  for (const [reasons, numbers] of byReasons) {
    problems.push(`第 ${numbers.join("、")} 页的预览过期了（变了：${reasons}），重新运行 npm run preview 核对`);
  }
  return { problems, fresh, stale };
}

function readRecord(previewDir) {
  const file = path.join(previewDir, RECORD_FILE);
  if (!fs.existsSync(file)) return { pages: {} };
  try {
    return { pages: {}, ...JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch {
    return { pages: {} };
  }
}

function hashFiles(files) {
  const digest = crypto.createHash("sha256");
  for (const file of files) {
    digest.update(path.basename(file));
    if (fs.existsSync(file)) digest.update(fs.readFileSync(file));
  }
  return digest.digest("hex").slice(0, 12);
}

function hash(text) {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 12);
}

function listFiles(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => (entry.isDirectory() ? listFiles(path.join(dir, entry.name)) : [path.join(dir, entry.name)]))
    .sort();
}

// ---- The index page ----

/** The index of the stills; `status` is previewStatus() right after they were taken. */
function indexPage(record, slides, status, options) {
  const pages = slides.filter((slide) => record.pages[slide.number]);
  const sections = pages.map((slide) => {
    const entry = record.pages[slide.number];
    const stale = status.stale.get(slide.number);
    const actions = entry.actions.length
      ? `<table><tr><th>动作</th><th>位置</th><th>时间（本页）</th><th>说明</th></tr>${entry.actions
          .map((action) => {
            const outside = action.window
              ? `<br><small>镜头放大后看到：${escape(action.window)}；窗口外的始终可读区：${escape(action.outside.join("、") || "无")}</small>`
              : "";
            return `<tr><td>${escape(action.name)}</td><td>${escape(action.box)}</td><td>${seconds(action.start)}–${seconds(action.end)}</td><td>${escape(action.note)}${outside}</td></tr>`;
          })
          .join("")}</table>`
      : "<p class=\"quiet\">这一页没有镜头表的动作，只有翻页。</p>";
    const shots = entry.moments
      .map(
        (moment) => `<figure><a href="${moment.file}"><img src="${moment.file}" width="640" height="360" alt=""></a><figcaption>
<b>${seconds(moment.time)}</b><span class="quiet">（视频 ${clock(moment.videoTime)}）</span>
<ul>${moment.labels.map((label) => `<li>${escape(label)}</li>`).join("")}</ul>
<q>${escape(slide.narration[moment.line] ?? "（还没开口）")}</q></figcaption></figure>`,
      )
      .join("\n");
    const state = stale ? `<span class="stale">生成时就已过期（变了：${escape(stale.join("、"))}），重新运行 npm run preview</span>` : "";
    return `<section id="p${slide.number}"><h2>第 ${slide.number} 页 · ${escape(entry.topic)} <span class="quiet">${entry.layout} · ${seconds(entry.duration)}</span>${state}</h2>
${actions}<div class="grid">${shots}</div></section>`;
  });
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><title>预览 · ${escape(record.episode)}</title><style>
  body { margin: 0; padding: 24px 32px 48px; background: #f5f1e8; color: #1f2328; font-family: "Noto Sans SC", "Microsoft YaHei", sans-serif; }
  h1 { font-family: "Noto Serif SC", serif; margin: 0 0 6px; }
  h2 { font-family: "Noto Serif SC", serif; margin: 36px 0 12px; border-top: 1px solid #ded6c6; padding-top: 20px; }
  .quiet { color: #6b6457; font-weight: normal; font-size: 0.85em; }
  .stale { margin-left: 12px; padding: 2px 10px; border-radius: 6px; background: #b91c1c; color: #fff; font-size: 0.7em; }
  .snapshot { padding: 10px 14px; border-left: 4px solid #c2410c; background: #fffdf8; line-height: 1.6; }
  nav a { margin-right: 10px; }
  table { border-collapse: collapse; margin: 8px 0 16px; background: #fffdf8; font-size: 14px; }
  td, th { border: 1px solid #ded6c6; padding: 6px 10px; text-align: left; vertical-align: top; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, 640px); gap: 20px; }
  figure { margin: 0; background: #fffdf8; border: 1px solid #ded6c6; border-radius: 8px; overflow: hidden; }
  figure img { display: block; width: 640px; height: 360px; }
  figcaption { padding: 10px 14px 12px; font-size: 14px; line-height: 1.5; }
  figcaption ul { margin: 4px 0; padding-left: 18px; }
  q { color: #4b4639; }
</style></head><body>
<h1>预览 · ${escape(record.episode)}</h1>
<p class="snapshot">这是 ${escape(new Date(record.made).toLocaleString("zh-CN", { hour12: false }))} 生成时的快照，打开它不会重新检查。审核前先运行 <code>npm run check -- episodes/${escape(record.episode)}</code>：
它会实时比对讲稿、镜头表、原图、示意图、页面内容、模板和风格、代码和依赖版本；看到「预览是最新的」，再拿这里的图核对。
配音时间、实际字体和浏览器版本只有 <code>npm run render</code> 和 <code>npm run preview</code> 才查得到，它们发现过期也会提醒。</p>
<p class="quiet">风格 ${escape(options.theme)} · 配音 ${escape(options.voice)} ${escape(options.rate)} · 浏览器 ${escape(record.environment?.browser)} · 每张缩图是手机上的大小（640×360），点开看原尺寸。声音要另外听。</p>
${options.missingFonts?.length ? `<p class="stale">${options.missingFonts.map(escape).join("<br>")}</p>` : ""}
<nav>${pages.map((slide) => `<a href="#p${slide.number}">第 ${slide.number} 页</a>`).join("")}</nav>
${sections.join("\n")}
</body></html>`;
}

function escape(text) {
  return String(text ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function seconds(value) {
  return `${value.toFixed(2)} 秒`;
}

function clock(value) {
  const minutes = Math.floor(value / 60);
  return `${minutes}:${(value - minutes * 60).toFixed(2).padStart(5, "0")}`;
}

// ---- One page as a short video ----

async function makeClip(slide, timing, schedules, { workDir, previewDir, theme }) {
  const duration = timing.end - timing.start;
  const shift = (time) => time - timing.start;
  const local = { ...timing, start: 0, end: duration, lines: timing.lines.map((line) => ({ ...line, start: shift(line.start), end: shift(line.end) })) };
  const clipDir = path.join(previewDir, `clip-p${slide.number}`);
  fs.mkdirSync(clipDir, { recursive: true });
  const { frames } = await renderFrames([slide], { pages: [local] }, clipDir, { theme, animate: true, schedules });
  const audioFile = path.join(clipDir, "narration.wav");
  await runFfmpeg(["-y", "-ss", timing.start.toFixed(3), "-t", duration.toFixed(3), "-i", path.join(workDir, "narration.wav"), audioFile]);
  const outFile = path.join(previewDir, `page${slide.number}.mp4`);
  await composeVideo({ frames, audioFile, outFile, workDir: clipDir, duration });
  return outFile;
}

function parseArgs(args) {
  const options = { episodeDir: null, page: null, clip: false, theme: DEFAULT_THEME, voice: DEFAULT_VOICE, rate: DEFAULT_RATE };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--clip") options.clip = true;
    else if (arg === "--theme") options.theme = args[++i] ?? "";
    else if (arg === "--voice") options.voice = args[++i];
    else if (arg === "--rate") options.rate = args[++i];
    else if (/^\d+$/.test(arg) && options.episodeDir) options.page = Number(arg);
    else if (!arg.startsWith("--") && !options.episodeDir) options.episodeDir = arg;
    else throw new Error(`不认识「${arg}」\n${USAGE}`);
  }
  return options;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(`\n出错了：${error.message}`);
    process.exitCode = 1;
  });
}
