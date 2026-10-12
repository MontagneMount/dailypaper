// Machine checks supplement (and never replace) independent source and visual review.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { parseScript } from "./parse-script.js";
import { buildSlides } from "./layouts.js";
import { scheduleAll } from "./cues.js";
import { previewStatus } from "./preview.js";
import { launchBrowser, renderEnvironment, setUpSlide, VIEWPORT } from "./frames.js";
import { episodeNumberProblem, readPublished } from "./episodes.js";
import { DEFAULT_VOICE, DEFAULT_RATE } from "./tts.js";

export function inside(base, candidate) {
  const relative = path.relative(path.resolve(base), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/** Do not follow symlinks/junctions into other folders when reading or deleting managed files. */
export function safePath(base, relative) {
  if (typeof relative !== "string" || path.isAbsolute(relative) || !inside(base, path.resolve(base, relative))) throw new Error("文件路径超出工作目录");
  let cursor = path.resolve(base);
  if (fs.lstatSync(cursor, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("工作目录不能是符号链接");
  for (const part of path.relative(cursor, path.resolve(base, relative)).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    if (fs.lstatSync(cursor, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`不能使用符号链接：${cursor}`);
  }
  return path.resolve(base, relative);
}

export function filesUnder(base, relative) {
  const full = safePath(base, relative);
  if (!fs.existsSync(full)) return [];
  if (fs.lstatSync(full).isFile()) return [relative.replaceAll("\\", "/")];
  return fs.readdirSync(full).sort().flatMap((name) => filesUnder(base, path.join(relative, name)));
}

export function fingerprint(base, names) {
  const hashes = {};
  for (const name of [...new Set(names)].sort()) {
    const full = safePath(base, name);
    hashes[name] = fs.existsSync(full) ? crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex") : null;
  }
  return crypto.createHash("sha256").update(JSON.stringify(hashes)).digest("hex");
}

export function protectedFingerprint(root, folder) {
  const git = fs.existsSync(path.join(root, ".git"));
  // Git supplies both tracked (including deleted) and untracked, non-ignored paths.
  // A Git failure must stop protection checks, never silently reduce their scope.
  const candidates = git
    ? execFileSync("git", ["-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "utf8", windowsHide: true }).split("\0").filter(Boolean)
    : fs.readdirSync(root).filter((name) => ![".production", ".git"].includes(name)).flatMap((name) => filesUnder(root, name));
  const names = candidates.filter((name) => name !== "WORKLOG.md" && !name.startsWith(`episodes/${folder}/`));
  for (const dir of [".claude", ".codex", ".git/refs/remotes"]) names.push(...filesUnder(root, dir));
  // Paper figures stay local/ignored, but another episode's originals must not be edited.
  const episodes = safePath(root, "episodes");
  if (fs.existsSync(episodes)) {
    for (const name of fs.readdirSync(episodes)) {
      if (name !== folder && fs.lstatSync(path.join(episodes, name)).isDirectory()) names.push(...filesUnder(root, `episodes/${name}/figures`));
    }
  }
  const headFile = path.join(root, ".git", "HEAD");
  if (fs.existsSync(headFile)) {
    names.push(".git/HEAD", ".git/packed-refs");
    const ref = fs.readFileSync(headFile, "utf8").match(/^ref: (refs\/[\w./-]+)\s*$/)?.[1];
    if (ref) names.push(`.git/${ref}`);
  }
  return fingerprint(root, names);
}

export class GateError extends Error {
  constructor(message, kind) { super(message); this.kind = kind; }
}

function withoutLineNumbers(value) {
  if (Array.isArray(value)) return value.map(withoutLineNumbers);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "lineNo").map(([key, item]) => [key, withoutLineNumbers(item)]));
  return value;
}

function hashValue(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function pageReviewData(entry, content) {
  if (!content?.slide) throw new Error("缺少逐页画面和镜头输入，不能使用含行号的预览哈希复用审核");
  const rows = new Map((content.cues?.actions ?? []).map((action, index) => [action.lineNo, index + 1]));
  const label = (text) => text.replace(/(^|重叠：| \+ )第\s+(\d+)\s+行/g, (match, prefix, line) => {
    const ordinal = rows.get(Number(line));
    if (!ordinal) throw new Error(`预览动作引用了本页镜头表以外的行号：${line}`);
    return `${prefix}本页动作 ${ordinal}`;
  });
  // Timing calculations can differ in their last floating-point bits after an earlier page edit.
  const seconds = (value) => typeof value === "number" ? Math.round(value * 1e6) / 1e6 : value;
  const actions = (entry.actions ?? []).map((action) => ({ ...action, name: label(action.name), start: seconds(action.start), end: seconds(action.end) }));
  const moments = entry.moments.map(({ videoTime, ...moment }) => ({ ...moment, time: seconds(moment.time), turnTime: seconds(moment.turnTime), labels: moment.labels.map(label) }));
  return { page: hashValue(withoutLineNumbers(content)), actions, moments };
}

/** Whole-file script/cue hashes govern freshness, but page approval uses actual page inputs.
 * Absolute episode offsets and generation timestamps alone do not alter the page picture.
 */
export function previewPageHashes(root, job, record, narration, common = {}, pageContents = {}) {
  const result = {};
  for (const [number, entry] of Object.entries(record.pages)) {
    const { script, cues, timing, page, ...inputs } = entry.inputs ?? {};
    const review = pageReviewData(entry, pageContents[number]);
    inputs.page = review.page;
    const pageTiming = narration.pages.find((p) => p.number === Number(number));
    if (!pageTiming) throw new Error(`第 ${number} 页缺少时间轴`);
    const local = (time) => Math.round((time - pageTiming.start) * 1000) / 1000;
    const times = { duration: local(pageTiming.end), lines: pageTiming.lines.map((line) => ({ text: line.text, start: local(line.start), end: local(line.end) })) };
    const images = entry.moments.map((m) => `episodes/${job.folder}/output/preview/${m.file}`);
    result[number] = hashValue({ common: withoutLineNumbers(common), inputs, times, actions: review.actions, moments: review.moments, images: fingerprint(root, images) });
  }
  return result;
}

export function inputFingerprint(root, folder, { preview = false } = {}) {
  const dir = `episodes/${folder}`;
  const names = ["script.md", "materials.md", "cues.md"].map((name) => `${dir}/${name}`);
  for (const name of ["figures", "diagrams", "related"]) names.push(...filesUnder(root, `${dir}/${name}`));
  const full = safePath(root, dir);
  if (fs.existsSync(full)) names.push(...fs.readdirSync(full).filter((name) => name.endsWith(".pdf")).map((name) => `${dir}/${name}`));
  if (preview) {
    names.push(`${dir}/output/narration.json`, ...filesUnder(root, `${dir}/output/preview`));
  }
  return fingerprint(root, names);
}

export function inspectDraft(root, job, { allowMissing = false } = {}) {
  const dir = safePath(root, `episodes/${job.folder}`);
  const script = parseScript(fs.readFileSync(safePath(dir, "script.md"), "utf8"));
  const built = buildSlides(script, dir);
  const errors = built.errors.filter((error) => !allowMissing || !/找不到(?:「[^」]+」|示意图)的图片文件 (?:figures|diagrams)\//.test(error));
  const id = script.headerFields.find((f) => f.key === "arXiv")?.value;
  if (id !== job.paper.versionedId) errors.push(`论文版本必须是 ${job.paper.versionedId}，不能改成 ${id}`);
  if (script.sourceRows.length === 0) errors.push("原文核对表不能为空");
  const title = script.headerFields.find((f) => f.key === "视频标题")?.value;
  const numberProblem = episodeNumberProblem(job.folder, title, readPublished(path.join(root, "episodes")));
  if (numberProblem) errors.push(numberProblem);
  const materials = safePath(dir, "materials.md");
  if (!fs.existsSync(materials) || fs.readFileSync(materials, "utf8").trim().length < 30) errors.push("缺少有效的 materials.md 素材清单");
  const pdf = safePath(dir, `${job.paper.versionedId}.pdf`);
  if (!fs.existsSync(pdf) || fs.readFileSync(pdf).subarray(0, 5).toString() !== "%PDF-") errors.push("缺少所选版本的论文 PDF");
  return { ...built, script, errors, dir };
}

export function validatePreviewRecord(record, slides, previewDir) {
  const images = [];
  for (const slide of slides) {
    const entry = record.pages?.[slide.number];
    if (!entry || !Array.isArray(entry.moments) || entry.moments.length === 0) throw new Error(`第 ${slide.number} 页缺少预览（包括没有动作的页）`);
    for (const moment of entry.moments) {
      if (!/^p\d{2,}-\d{2,}\.png$/.test(moment.file) || !moment.file.startsWith(`p${String(slide.number).padStart(2, "0")}-`)) throw new Error("预览文件名或页码异常");
      const full = safePath(previewDir, moment.file);
      if (!fs.existsSync(full) || fs.statSync(full).size < 8) throw new Error(`缺少预览图片：${moment.file}`);
      images.push({ page: slide.number, file: moment.file, time: moment.time, turnTime: moment.turnTime, labels: moment.labels ?? [] });
    }
  }
  return images;
}

/** Runtime font/browser + timings, all pages, files present; default npm check alone is insufficient. */
export async function inspectPreview(root, job, { measure = true } = {}) {
  const built = inspectDraft(root, job);
  if (built.errors.length) throw new GateError(built.errors.join("；"), "content");
  const narration = JSON.parse(fs.readFileSync(safePath(built.dir, "output/narration.json"), "utf8"));
  if (narration.voice !== DEFAULT_VOICE || narration.rate !== DEFAULT_RATE || narration.pages?.length !== built.slides.length
    || !Number.isFinite(narration.duration) || narration.duration <= 0) throw new Error("配音设置或时间轴不完整");
  for (const [i, slide] of built.slides.entries()) {
    const timing = narration.pages[i];
    if (timing.number !== slide.number || timing.lines?.map((line) => line.text).join("\n") !== slide.narration.join("\n")) throw new Error("配音时间轴与当前旁白不一致");
  }
  const timed = scheduleAll(built.cues, narration);
  if (timed.errors.length) throw new GateError(timed.errors.join("；"), "content");
  const previewDir = safePath(built.dir, "output/preview");
  const record = JSON.parse(fs.readFileSync(safePath(previewDir, "preview.json"), "utf8"));
  const images = validatePreviewRecord(record, built.slides, previewDir);
  if (!fs.existsSync(safePath(previewDir, "index.html"))) throw new Error("缺少预览索引");
  let environment = record.environment;
  if (measure) {
    const browser = await launchBrowser();
    const htmlFile = path.join(built.dir, "output", "production-font-probe.html");
    try {
      const page = await browser.newPage({ viewport: VIEWPORT });
      await setUpSlide(page, built.slides[0], { htmlFile, theme: "academic", timing: narration.pages[0], animate: true, schedule: timed.schedules.get(built.slides[0].number) });
      environment = await renderEnvironment(page);
    } finally {
      await browser.close();
      fs.rmSync(htmlFile, { force: true });
    }
  }
  const status = previewStatus(built.dir, built.slides, built.cues, "academic", { voice: DEFAULT_VOICE, rate: DEFAULT_RATE, narration, environment }, { allPages: true });
  if (status.fresh.length !== built.slides.length || status.problems.length) throw new GateError(`预览未全部更新：${status.problems.join("；")}`, "stale");
  const common = { header: built.script.headerFields, sourceRows: built.script.sourceRows, materials: fingerprint(root, [`episodes/${job.folder}/materials.md`]), paper: job.paper.versionedId };
  const pageContents = Object.fromEntries(built.slides.map((slide) => [slide.number, { slide, cues: built.cues.get(slide.number) ?? null }]));
  return { pages: built.slides.map((s) => s.number), images, pageHashes: previewPageHashes(root, job, record, narration, common, pageContents), duration: narration.duration, warnings: [...built.warnings, ...timed.warnings] };
}

/** Make a literal 640×360 copy as well as attach the original; all preview moments are reviewed. */
export async function makePhoneImages(root, job, images) {
  const folder = safePath(root, `episodes/${job.folder}`);
  const out = safePath(folder, "output/production-phone");
  fs.mkdirSync(out, { recursive: true });
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 640, height: 360 }, deviceScaleFactor: 1 });
    for (const image of images) {
      const file = safePath(folder, `output/preview/${image.file}`);
      const data = fs.readFileSync(file).toString("base64");
      await page.setContent(`<style>html,body{margin:0;width:640px;height:360px;overflow:hidden}img{width:640px;height:360px;display:block}</style><img src="data:image/png;base64,${data}">`);
      await page.locator("img").evaluate((img) => img.decode());
      await page.screenshot({ path: safePath(out, image.file) });
    }
  } finally { await browser.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [root, jobFile] = process.argv.slice(2);
  inspectPreview(root, JSON.parse(fs.readFileSync(jobFile, "utf8")))
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
