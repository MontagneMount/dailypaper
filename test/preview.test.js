// Checks that a preview goes out of date when anything it shows changes (visual v2; T66 R2):
// the layout mapping, the diagram, the theme, a figure cropped again at the same size, the cue
// table, the voice, the rate, the narration times, the fonts really used and the browser.
// Each test works on a temporary copy of the demo episode with a made-up preview record.
// Run with: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSlides } from "../src/layouts.js";
import { parseScript } from "../src/parse-script.js";
import { previewInputs, previewStatus } from "../src/preview.js";

const EXAMPLE_DIR = fileURLToPath(new URL("../episodes/example/", import.meta.url));
const CUE_PAGES = [2, 3, 4, 5, 6];
const ENVIRONMENT = { browser: "154.0.4258.48", fonts: ["dp-font-body-400: Noto-Sans-SC", "dp-font-heading-700: Noto-Serif-SC-Bold"] };

/** A copy of the demo episode whose preview was just made, with made-up narration times. */
function freshCopy(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dailypaper-preview-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.cpSync(EXAMPLE_DIR, dir, { recursive: true, filter: (source) => path.basename(source) !== "output" });
  const { slides, cues, errors } = buildSlides(parseScript(fs.readFileSync(path.join(dir, "script.md"), "utf8")), dir);
  assert.deepEqual(errors, []);
  const narration = {
    pages: slides.map((slide, index) => ({
      number: slide.number,
      start: index * 10,
      end: index * 10 + 8,
      lines: slide.narration.map((_, line) => ({ start: index * 10 + 0.3 + line * 2 })),
    })),
  };
  const timed = { voice: "zh-CN-XiaoxiaoNeural", rate: "+25%", narration, environment: ENVIRONMENT };
  const pages = {};
  for (const [index, slide] of slides.entries()) {
    const pageTimed = { ...timed, timing: narration.pages[index] };
    pages[slide.number] = { inputs: previewInputs(dir, slide, cues.get(slide.number), "academic", pageTimed) };
  }
  fs.mkdirSync(path.join(dir, "output", "preview"), { recursive: true });
  fs.writeFileSync(path.join(dir, "output", "preview", "preview.json"), JSON.stringify({ pages }));
  return { dir, slides, cues, timed };
}

/** The out-of-date pages and what changed for each, as { page: "reasons" }. */
function staleOf(status) {
  return Object.fromEntries([...status.stale].map(([page, reasons]) => [page, reasons.join("、")]));
}

test("刚做的预览是最新的：check 只比能看到的，render 再比配音、字体和浏览器", (t) => {
  const { dir, slides, cues, timed } = freshCopy(t);
  const live = previewStatus(dir, slides, cues, "academic", timed);
  assert.deepEqual(live.problems, []);
  assert.deepEqual(live.fresh, CUE_PAGES);
  assert.deepEqual(previewStatus(dir, slides, cues, "academic").fresh, CUE_PAGES);
});

test("布局映射或文字变了，讲稿和模板都没变，也算过期", (t) => {
  const { dir, slides, cues, timed } = freshCopy(t);
  const changed = structuredClone(slides);
  changed[1].values.point_1_title = "别的标题";
  changed[3].cardCounts = { ".metric-grid .metric-card": 1 };
  assert.deepEqual(staleOf(previewStatus(dir, changed, cues, "academic", timed)), {
    2: "页面内容（版式、文字、卡片或镜头动作）",
    4: "页面内容（版式、文字、卡片或镜头动作）",
  });
});

test("示意图、原图（同尺寸重截）、镜头表变了，用到它们的页过期", (t) => {
  const { dir, slides, cues, timed } = freshCopy(t);
  const diagram = path.join(dir, "diagrams", "page6.svg");
  fs.appendFileSync(diagram, "<!-- changed -->\n");
  assert.deepEqual(staleOf(previewStatus(dir, slides, cues, "academic", timed)), { 6: "示意图" });

  // Same width and height, another colour: what a figure cropped again at the same size looks like.
  const figure = path.join(dir, "figures", "figure1.svg");
  fs.writeFileSync(figure, fs.readFileSync(figure, "utf8").replace("#dbeafe", "#dbeaff"));
  const stale = staleOf(previewStatus(dir, slides, cues, "academic", timed));
  assert.equal(stale[2], "原图");
  assert.equal(stale[3], "原图");

  fs.appendFileSync(path.join(dir, "cues.md"), "\n");
  assert.match(staleOf(previewStatus(dir, slides, cues, "academic", timed))[4], /镜头表/);
});

test("风格、声音、语速、配音时间、实际字体或浏览器变了，都算过期", (t) => {
  const { dir, slides, cues, timed } = freshCopy(t);
  const reasons = (theme, changes) => new Set([...previewStatus(dir, slides, cues, theme, { ...timed, ...changes }).stale.values()].flat());
  assert.ok(reasons("dark", {}).has("所选风格"));
  assert.ok(reasons("academic", { voice: "zh-CN-YunxiNeural" }).has("配音声音"));
  assert.ok(reasons("academic", { rate: "+0%" }).has("语速"));
  const later = structuredClone(timed.narration);
  later.pages[2].lines[1].start += 0.2;
  assert.deepEqual(staleOf(previewStatus(dir, slides, cues, "academic", { ...timed, narration: later })), { 3: "配音时间" });
  const otherFont = { ...ENVIRONMENT, fonts: ["dp-font-body-400: MicrosoftYaHei", ENVIRONMENT.fonts[1]] };
  assert.ok(reasons("academic", { environment: otherFont }).has("实际用到的字体"));
  assert.ok(reasons("academic", { environment: { ...ENVIRONMENT, browser: "155.0.0.0" } }).has("浏览器版本"));
});

test("没做过预览的页会提醒，同样原因过期的页合成一条", (t) => {
  const { dir, slides, cues, timed } = freshCopy(t);
  const status = previewStatus(dir, slides, cues, "dark", timed);
  assert.equal(status.problems.length, 1);
  assert.match(status.problems[0], /^第 2、3、4、5、6 页的预览过期了（变了：所选风格）/);
  fs.rmSync(path.join(dir, "output", "preview", "preview.json"));
  assert.match(previewStatus(dir, slides, cues, "academic").problems[0], /第 2、3、4、5、6 页有镜头表，但还没有预览/);
});
