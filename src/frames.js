// Fill the templates with each slide's content and take the screenshots for the video: a new one
// whenever the picture changes (a page turn moves, a subtitle line starts), held while it stays
// still. Also renders the Bilibili cover from the same kind of template.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { FPS, pageTurn, planPageFrames } from "./animation.js";

const TEMPLATES_DIR = fileURLToPath(new URL("../templates/", import.meta.url));
const THEMES_DIR = path.join(TEMPLATES_DIR, "themes");
const WIDTH = 1920;
const HEIGHT = 1080;
export const VIEWPORT = { width: WIDTH, height: HEIGHT };

// Every template links the default theme, so it also looks right when opened on its own;
// the filled-in page points that link at the chosen theme (templates/themes/<name>.css).
export const DEFAULT_THEME = "academic";
const THEME_LINK = 'href="themes/academic.css"';

// A figure at least this many times wider than tall looks tiny next to the points, so the page
// switches to the wide variant of its template: figure across the top, points below it.
const WIDE_FIGURE_RATIO = 2.2;
const WIDE_VARIANTS = { figure_text: "figure_text_wide" };

/**
 * With `animate: false` (npm run render -- --static) nothing moves: one screenshot per subtitle line.
 * `schedules` are the cue table's actions per page number (scheduleAll in cues.js).
 * @returns {Promise<{ frames: Array<{ file: string, duration: number }>, warnings: string[], fonts: string[],
 *   environment: { browser: string, fonts: string[] } }>}
 *   fonts: warnings for the theme's fonts missing on this computer; environment: what the
 *   computer renders with (renderEnvironment), which the preview's inputs are compared against
 */
export async function renderFrames(slides, narration, workDir, { theme = DEFAULT_THEME, animate = true, schedules = new Map() } = {}) {
  const pagesDir = path.join(workDir, "pages");
  const framesDir = path.join(workDir, "frames");
  for (const dir of [pagesDir, framesDir]) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
  }

  const frames = [];
  const warnings = [];
  const fonts = []; // warnings for missing fonts
  let environment = null;
  const browser = await launchBrowser();

  try {
    const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });

    for (const [slideIndex, slide] of slides.entries()) {
      // Slides and narration pages come in the same order. Use the position, not the page
      // number, so a numbering mistake can never mix up audio, frames or file names.
      const timing = narration.pages[slideIndex];
      const order = pad(slideIndex + 1);
      const htmlFile = path.join(pagesDir, `page${order}.html`);
      const schedule = schedules.get(slide.number);
      const { template, problems, moves } = await setUpSlide(page, slide, { htmlFile, theme, timing, animate, schedule });
      problems.forEach((problem) => warnings.push(`第 ${slide.number} 页：${problem}`));
      if (slideIndex === 0) {
        fonts.push(...(await fontWarnings(page, theme)));
        environment = await renderEnvironment(page);
      }

      // Before the first sentence no subtitle shows, so text never appears ahead of the voice;
      // the last line stays up through the pause after it.
      const shots = planPageFrames(timing, moves);
      for (const [index, shot] of shots.entries()) {
        await showMoment(page, { time: shot.time, subtitle: timing.lines[shot.line]?.display ?? "" });
        const file = path.join(framesDir, `p${order}-${String(index + 1).padStart(3, "0")}.png`);
        await page.screenshot({ path: file });
        frames.push({ file, duration: shot.count / FPS });
      }
      const moving = animate ? `，其中 ${shots.filter((shot) => shot.moving).length} 张是动画` : "";
      const variant = template === slide.layout ? "" : `，${template}`;
      console.log(`  第 ${slide.number} 页画面完成（${shots.length} 张截图${moving}${variant}）`);
    }
  } finally {
    await browser.close();
  }

  return { frames, warnings, fonts, environment };
}

/**
 * Render the Bilibili cover (templates/bilibili-cover.html) as a 1920×1080 PNG.
 * @returns {Promise<{ file: string, warnings: string[] }>}
 */
export async function renderCover(cover, workDir, { theme = DEFAULT_THEME } = {}) {
  const htmlFile = path.join(workDir, "cover.html");
  const file = path.join(workDir, "cover.png");
  fs.writeFileSync(htmlFile, fillTemplate(cover, theme));

  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(htmlFile).href);
    const problems = await page.evaluate(prepareCover, cover.hidden);
    const fonts = await fontWarnings(page, theme);
    await page.screenshot({ path: file });
    return { file, warnings: [...problems.map((problem) => `封面：${problem}`), ...fonts] };
  } finally {
    await browser.close();
  }
}

/**
 * Open a slide so that any moment of it can be shown with showMoment: the template filled in, the
 * diagram put into the page, the render rules applied, the page turn and the cue table's actions
 * set up. npm run render and npm run preview both go through here, so they show the same thing.
 * @returns {Promise<{ template: string, problems: string[], moves: Array<[number, number]>,
 *   cameraWindows: object[], turn: object | null }>}
 */
export async function setUpSlide(page, slide, { htmlFile, theme, timing, animate, schedule }) {
  const template = await openSlide(page, slide, htmlFile, theme);
  const diagram = slide.values.diagram_image_path;
  if (diagram?.endsWith(".svg")) await page.evaluate(inlineDiagram, fs.readFileSync(fileURLToPath(diagram), "utf8"));
  const problems = await page.evaluate(prepareSlide, { cardCounts: slide.cardCounts, hidden: slide.hidden, fitGrid: slide.fitGrid });

  const moves = [];
  let cameraWindows = [];
  let turn = null;
  if (animate) {
    turn = pageTurn(timing.end - timing.start);
    await page.evaluate(setUpPageTurn, { ...turn, duration: timing.end - timing.start });
    moves.push(...turn.moves);
    if (schedule) {
      cameraWindows = await page.evaluate(setUpCues, cueSetup(schedule, slide));
      moves.push(...schedule.moves);
    }
  }
  return { template, problems, moves, cameraWindows, turn };
}

/**
 * Show the slide as it is `time` seconds after it starts, with this subtitle line. The preview
 * can show the page turn at another moment (`turnTime`), to see an action at the very start of a
 * page without the page still fading in.
 */
export async function showMoment(page, { time, subtitle, turnTime = time }) {
  await page.evaluate(showFrame, { ms: time * 1000, turnMs: turnTime * 1000, subtitle });
}

/** Fill the slide's template and open it; switch to the wide variant for a very wide figure. */
async function openSlide(page, slide, htmlFile, theme) {
  fs.writeFileSync(htmlFile, fillTemplate(slide, theme));
  await page.goto(pathToFileURL(htmlFile).href);

  const variant = WIDE_VARIANTS[slide.layout];
  if (!variant || (await page.evaluate(figureRatio)) < WIDE_FIGURE_RATIO) return slide.layout;
  fs.writeFileSync(htmlFile, fillTemplate({ ...slide, layout: variant }, theme));
  await page.goto(pathToFileURL(htmlFile).href);
  return variant;
}

/** The theme names there are files for in templates/themes/, e.g. ["academic", "dark"]. */
export function listThemes() {
  return fs
    .readdirSync(THEMES_DIR)
    .filter((file) => file.endsWith(".css"))
    .map((file) => file.slice(0, -".css".length))
    .sort();
}

/** The template with its {{placeholders}} filled in and its theme link pointing at the chosen theme. */
export function fillTemplate({ layout, values }, theme = DEFAULT_THEME) {
  const themeFile = path.join(THEMES_DIR, `${theme}.css`);
  if (!fs.existsSync(themeFile)) throw new Error(`没有「${theme}」这个风格，可选：${listThemes().join("、")}`);
  const template = fs.readFileSync(path.join(TEMPLATES_DIR, `${layout}.html`), "utf8");
  if (!template.includes(THEME_LINK)) throw new Error(`模板 ${layout}.html 没有引用风格文件（${THEME_LINK}）`);
  return template
    .replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name) => escapeHtml(values[name] ?? ""))
    .replace(THEME_LINK, () => `href="${pathToFileURL(themeFile).href}"`);
}

/** What setUpCues needs in the page: the timed actions without their table rows, the readable regions and the cards. */
export function cueSetup(schedule, slide) {
  return {
    tracks: schedule.tracks.map(({ action, ...track }) => track),
    readable: schedule.readable.map((region) => region.box),
    // The same selectors that keep the right number of cards, in the order the cue table counts them.
    cardSelectors: Object.keys(slide.cardCounts),
  };
}

/**
 * What this computer renders with (T66 R2): the browser version and, for each of the theme's font
 * stacks, the fonts Chrome really draws text with, fallbacks included (CSS.getPlatformFontsForNode).
 * A font installed, removed or renamed, or a browser update, changes it. Measured in the open page.
 * @returns {Promise<{ browser: string, fonts: string[] }>}
 */
export async function renderEnvironment(page) {
  const probes = await page.evaluate(placeFontProbes);
  const client = await page.context().newCDPSession(page);
  try {
    await client.send("DOM.enable");
    await client.send("CSS.enable");
    const { root } = await client.send("DOM.getDocument");
    const fonts = [];
    for (const probe of probes) {
      const { nodeId } = await client.send("DOM.querySelector", { nodeId: root.nodeId, selector: `#${probe}` });
      // Chrome answers with nothing until the text has been laid out; never record that as "no font".
      let used = [];
      for (let attempt = 0; attempt < 20 && used.length === 0; attempt++) {
        if (attempt > 0) await page.waitForTimeout(50);
        ({ fonts: used } = await client.send("CSS.getPlatformFontsForNode", { nodeId }));
      }
      if (used.length === 0) throw new Error(`读不出风格字体（${probe}）实际用的是哪个字体，再运行一次试试`);
      fonts.push(`${probe}: ${used.map((font) => font.postScriptName || font.familyName).sort().join(", ")}`);
    }
    return { browser: page.context().browser().version(), fonts };
  } finally {
    await client.detach().catch(() => {});
    await page.evaluate(() => document.querySelectorAll(".dp-font-probe").forEach((probe) => probe.remove()));
  }
}

/** A warning for each font the theme asks for that this computer does not have (checked in the open page). */
export async function fontWarnings(page, theme) {
  const missing = await page.evaluate(missingFonts);
  return missing.map((font) => `风格「${theme}」要用的字体「${font}」这台电脑上没有，画面会退回别的字体`);
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function pad(number) {
  return String(number).padStart(2, "0");
}

export async function launchBrowser() {
  try {
    return await chromium.launch({ channel: "msedge" });
  } catch {
    try {
      return await chromium.launch();
    } catch {
      throw new Error("打不开浏览器。请确认电脑装了 Microsoft Edge，或者运行 npx playwright install chromium");
    }
  }
}

// ---- The functions below run inside the browser page, not in Node.js ----

/** Apply the render rules from templates/README.md and report anything that looks wrong. */
async function prepareSlide({ cardCounts, hidden, fitGrid }) {
  const problems = [];

  // Keep only as many cards as the script has items.
  for (const [selector, count] of Object.entries(cardCounts)) {
    [...document.querySelectorAll(selector)].slice(count).forEach((card) => card.remove());
  }
  if (fitGrid) {
    const grid = document.querySelector(fitGrid);
    if (grid && grid.children.length > 0) grid.style.gridTemplateColumns = `repeat(${grid.children.length}, 1fr)`;
  }

  // Remove labels whose content is empty or「无」.
  hidden.flatMap((selector) => [...document.querySelectorAll(selector)]).forEach((element) => element.remove());

  // big_metric: write "40%", not "40 %".
  for (const unit of document.querySelectorAll(".metric-unit")) {
    if (unit.textContent.trim() === "%") {
      const gap = Number.parseFloat(getComputedStyle(unit.parentElement).columnGap) || 0;
      unit.style.marginLeft = `${-gap}px`;
    }
  }

  // Replace the design hint in the subtitle area with a real subtitle line.
  const area = document.querySelector(".subtitle-safe-area");
  if (area) {
    area.innerHTML = "";
    area.style.borderTop = "none";
    const subtitle = document.createElement("div");
    subtitle.id = "dp-subtitle";
    Object.assign(subtitle.style, {
      maxWidth: "1600px",
      fontSize: "46px",
      fontWeight: "600",
      lineHeight: "1.35",
      letterSpacing: "1px",
      fontFamily: "var(--font-subtitle)",
      color: "var(--subtitle-color)",
      textAlign: "center",
      textShadow: "var(--subtitle-shadow)",
    });
    area.appendChild(subtitle);
  } else {
    problems.push("模板里没有字幕区（.subtitle-safe-area）");
  }

  // Wait for fonts and images, and report images that failed to load.
  await document.fonts.ready;
  const images = [...document.images];
  await Promise.all(
    images.map((image) => {
      if (image.complete) return null;
      return new Promise((resolve) => {
        image.addEventListener("load", resolve);
        image.addEventListener("error", resolve);
      });
    }),
  );
  images
    .filter((image) => image.naturalWidth === 0)
    .forEach((image) => problems.push(`图片加载失败：${decodeURI(image.src)}`));

  // figure_annotated: make the red-box layer cover exactly the figure as displayed,
  // so the box percentages are relative to the figure, not to the blank space around it.
  const viewport = document.querySelector(".image-viewport");
  const figure = document.querySelector(".base-figure");
  const layer = document.querySelector(".annotation-layer");
  if (viewport && figure && layer) {
    const outer = viewport.getBoundingClientRect();
    const inner = figure.getBoundingClientRect();
    Object.assign(layer.style, {
      top: `${inner.top - outer.top}px`,
      left: `${inner.left - outer.left}px`,
      width: `${inner.width}px`,
      height: `${inner.height}px`,
      right: "auto",
      bottom: "auto",
    });
  }

  // Warn when text does not fit in the content area.
  for (const element of document.querySelectorAll(".main-area, .metric-stage, .main-content")) {
    if (element.scrollHeight > element.clientHeight + 2) problems.push("内容超出了画面，可能要精简文字");
  }

  return problems;
}

/**
 * Put the diagram's SVG into the page itself, at the size the <img> had, so the diagram can use
 * the theme's colours and fonts (classes in templates/README.md) and its parts can be animated.
 * A diagram that failed to load stays an <img>, so prepareSlide reports it.
 */
async function inlineDiagram(markup) {
  const image = document.querySelector(".diagram-graphic img");
  if (!image) return;
  await image.decode().catch(() => {});
  if (image.naturalWidth === 0) return;

  const holder = document.createElement("div");
  holder.className = "diagram-svg";
  holder.innerHTML = markup;
  const svg = holder.querySelector("svg");
  if (!svg) return;
  const { width, height } = image.getBoundingClientRect();
  Object.assign(holder.style, { width: `${width}px`, height: `${height}px` });
  if (!svg.hasAttribute("viewBox")) svg.setAttribute("viewBox", `0 0 ${image.naturalWidth} ${image.naturalHeight}`);
  svg.setAttribute("width", "100%");
  svg.setAttribute("height", "100%");
  image.replaceWith(holder);
}

/** Width ÷ height of the paper figure on the page, or 0 when there is none or it failed to load. */
async function figureRatio() {
  const image = document.querySelector(".image-wrapper img");
  if (!image) return 0;
  await image.decode().catch(() => {});
  return image.naturalHeight > 0 ? image.naturalWidth / image.naturalHeight : 0;
}

/** One line of sample text, out of sight, per theme font stack and weight, laid out; returns their ids. */
async function placeFontProbes() {
  const probes = [];
  for (const stack of ["--font-body", "--font-heading", "--font-subtitle", "--font-mono"]) {
    for (const weight of [400, 700]) {
      const probe = document.createElement("span");
      probe.id = `dp-font${stack.slice("--font".length)}-${weight}`;
      probe.className = "dp-font-probe";
      probe.textContent = "DailyPaper 每日论文 0123456789 ↑↓% FastAttn";
      Object.assign(probe.style, { position: "absolute", left: "-10000px", top: "0", whiteSpace: "nowrap", fontFamily: `var(${stack})`, fontWeight: String(weight) });
      document.body.appendChild(probe);
      probes.push(probe.id);
    }
  }
  // Lay the text out and let two frames pass, so the fonts have been chosen when Chrome is asked.
  for (const id of probes) document.getElementById(id).getBoundingClientRect();
  await document.fonts.ready;
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  return probes;
}

/**
 * The fonts the theme names first (body, headings, subtitles) that this computer does not have.
 * A missing font shows up as text measuring the same as in the plain fallback font.
 */
function missingFonts() {
  const style = getComputedStyle(document.documentElement);
  const firstFamilies = ["--font-body", "--font-heading", "--font-subtitle"]
    .map((name) => style.getPropertyValue(name).split(",")[0].trim().replace(/^["']|["']$/g, ""))
    .filter((family) => family && !family.startsWith("-") && !family.startsWith("var(") && !/^(serif|sans-serif|monospace)$/.test(family));
  const probe = document.createElement("span");
  probe.textContent = "mmmmmmmmmmwwwwwlliI1 字体";
  Object.assign(probe.style, { position: "absolute", visibility: "hidden", fontSize: "48px", whiteSpace: "nowrap" });
  document.body.appendChild(probe);
  const widthIn = (family) => {
    probe.style.fontFamily = family;
    return probe.getBoundingClientRect().width;
  };
  const missing = [...new Set(firstFamilies)].filter((family) => widthIn(`"${family}", monospace`) === widthIn("monospace"));
  probe.remove();
  return missing;
}

/** Fade the page in and out (all but the subtitles), as paused animations that showFrame moves. */
function setUpPageTurn({ fadeIn, fadeOut, duration }) {
  const parts = [...document.body.children].filter((element) => !element.classList.contains("subtitle-safe-area"));
  for (const part of parts) {
    const fades = [
      { opacity: 0, offset: 0, easing: "ease-out" },
      { opacity: 1, offset: fadeIn / duration },
      { opacity: 1, offset: 1 - fadeOut / duration, easing: "ease-in" },
      { opacity: 0, offset: 1 },
    ];
    part.animate(fades, { duration: duration * 1000, fill: "both" }).pause();
  }
}

/** Show the page as it is `ms` milliseconds after it starts (the page turn at `turnMs`), with this subtitle line. */
function showFrame({ ms, turnMs = ms, subtitle }) {
  for (const animation of document.getAnimations()) animation.currentTime = turnMs;
  window.dpRender?.(ms / 1000);
  const element = document.getElementById("dp-subtitle");
  if (element) element.textContent = subtitle;
}

/**
 * Set up the cue table's actions (visual-v2.md section 4) and define window.dpRender(t), which
 * shows each of them as it is t seconds after the page starts. Positions are percent of the figure
 * file. The camera zooms the figure (and figure_annotated's red-box layer) inside its frame; boxes
 * and the spotlight are drawn over it in the frame's own pixels, so their lines keep their width.
 * @returns {Array<{ start: number, top: number, left: number, width: number, height: number }>}
 *   what each camera shows of the figure when fully zoomed in, in percent, for the preview index
 */
function setUpCues({ tracks, readable, cardSelectors }) {
  const cards = cardSelectors.flatMap((selector) => [...document.querySelectorAll(selector)]);
  const of = (kind) => tracks.filter((track) => track.kind === kind);
  const clamp = (x) => Math.min(1, Math.max(0, x));
  const ease = (x) => (x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2);
  const ramp = (t, from, to) => (to > from ? ease(clamp((t - from) / (to - from))) : Number(t >= from));
  // Box, spotlight, camera: 0 before, rising to 1, held, falling back to 0 (or leaving with the page).
  const level = (track, t) => (t < track.leave ? ramp(t, track.start, track.shown) : 1 - ramp(t, track.leave, track.end));

  // ---- The figure in its frame, and the camera ----
  const figure = document.querySelector(".image-wrapper img, .base-figure");
  const frame = figure?.parentElement;
  const usesFigure = tracks.some((track) => track.box);
  let image = null;
  let frameSize = null;
  let zoomed = [];
  if (figure && frame && usesFigure) {
    if (getComputedStyle(frame).position === "static") frame.style.position = "relative";
    const frameBox = frame.getBoundingClientRect();
    const offset = (element) => {
      const box = element.getBoundingClientRect();
      return { x: box.left - frameBox.left - frame.clientLeft, y: box.top - frameBox.top - frame.clientTop, w: box.width, h: box.height };
    };
    image = offset(figure);
    frameSize = { w: frame.clientWidth, h: frame.clientHeight };
    zoomed = [figure, frame.querySelector(".annotation-layer")].filter(Boolean).map((element) => {
      element.style.transformOrigin = "0 0";
      return { element, ...offset(element) };
    });
  }
  const area = (box) => ({
    x: image.x + (box.left / 100) * image.w,
    y: image.y + (box.top / 100) * image.h,
    w: (box.width / 100) * image.w,
    h: (box.height / 100) * image.h,
  });

  // Fit the area into the frame and center it, but keep the zoomed figure covering the frame,
  // so no blank shows beyond the figure's edges.
  const cameraView = (target) => {
    const scale = Math.max(1, Math.min(4, (frameSize.w * 0.96) / target.w, (frameSize.h * 0.96) / target.h));
    const shift = (frameLength, imageStart, imageLength, center) => {
      if (scale * imageLength <= frameLength) return (frameLength - scale * imageLength) / 2 - scale * imageStart;
      const centered = frameLength / 2 - scale * center;
      return Math.min(-scale * imageStart, Math.max(frameLength - scale * (imageStart + imageLength), centered));
    };
    return { scale, x: shift(frameSize.w, image.x, image.w, target.x + target.w / 2), y: shift(frameSize.h, image.y, image.h, target.y + target.h / 2) };
  };
  const cameras = image ? of("camera").map((track) => ({ ...track, view: cameraView(area(track.box)) })) : [];
  const cameraAt = (t) => {
    const camera = cameras.find((track) => t >= track.start && t < track.end);
    if (!camera) return { scale: 1, x: 0, y: 0 };
    const p = level(camera, t);
    return { scale: 1 + (camera.view.scale - 1) * p, x: camera.view.x * p, y: camera.view.y * p };
  };
  const place = (box, camera) => {
    const target = area(box);
    return { x: camera.scale * target.x + camera.x, y: camera.scale * target.y + camera.y, w: camera.scale * target.w, h: camera.scale * target.h };
  };

  // ---- Boxes and the spotlight, over the figure ----
  const overlay = image ? document.createElement("div") : null;
  if (overlay) {
    Object.assign(overlay.style, { position: "absolute", left: "0", top: "0", width: `${frameSize.w}px`, height: `${frameSize.h}px`, pointerEvents: "none", zIndex: "5" });
    frame.appendChild(overlay);
  }
  const svgNode = (name, attributes) => {
    const node = document.createElementNS("http://www.w3.org/2000/svg", name);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
    return node;
  };
  const spotlights = image ? of("spotlight") : [];
  let veil = null;
  if (spotlights.length > 0) {
    // Everything but the spotlight and the always-readable regions is covered by a veil.
    const size = { width: frameSize.w, height: frameSize.h };
    const svg = svgNode("svg", { ...size, style: "position: absolute; left: 0; top: 0" });
    // A mask region starts at -10% unless told otherwise, which would leave a strip uncovered.
    const mask = svgNode("mask", { id: "dp-spotlight", maskUnits: "userSpaceOnUse", x: "0", y: "0", ...size });
    mask.appendChild(svgNode("rect", { ...size, fill: "white" }));
    const holes = [null, ...readable].map(() => mask.appendChild(svgNode("rect", { fill: "black", rx: "6" })));
    const shade = svgNode("rect", { ...size, mask: "url(#dp-spotlight)", style: "fill: var(--spotlight-veil); opacity: 0" });
    const defs = svgNode("defs", {});
    defs.appendChild(mask);
    svg.append(defs, shade);
    overlay.appendChild(svg);
    veil = { holes, shade };
  }
  const boxes = image
    ? of("box").map((track) => {
        const element = document.createElement("div");
        Object.assign(element.style, {
          position: "absolute",
          boxSizing: "border-box",
          border: "4px solid var(--negative)",
          borderRadius: "6px",
          boxShadow: "0 0 0 2px color-mix(in srgb, var(--figure-bg) 80%, transparent)",
          opacity: "0",
        });
        overlay.appendChild(element);
        return { ...track, element };
      })
    : [];

  // ---- Cards and diagram parts that appear; lines are drawn like a pen stroke ----
  const appearing = of("appear").map((track) => {
    const element = track.target.type === "card" ? cards[track.target.index - 1] : document.getElementById(track.target.id);
    const parts = element instanceof SVGElement ? [element, ...element.querySelectorAll("*")] : [];
    // A line with its own dash pattern (a dashed arrow) keeps it: it fades in with its part instead of being drawn.
    const lines = parts
      .filter((part) => part.classList.contains("line") && typeof part.getTotalLength === "function")
      .filter((part) => getComputedStyle(part).strokeDasharray === "none")
      .map((part) => ({ part, length: part.getTotalLength(), marker: getComputedStyle(part).markerEnd !== "none" }));
    const shapes = parts.filter((part) => part instanceof SVGGeometryElement || part instanceof SVGTextElement);
    const drawOnly = shapes.length > 0 && shapes.every((part) => lines.some((line) => line.part === part));
    return { ...track, element, lines, drawOnly };
  });

  // ---- Emphasis: the words grow and change colour, then go back ----
  const emphasis = of("emphasize").map((track) => {
    const span = wrapWords(cards[track.card - 1], track.text);
    return { ...track, span, base: span ? baseColour(span) : null };
  });

  window.dpRender = (t) => {
    const camera = image ? cameraAt(t) : null;
    for (const item of camera ? zoomed : []) {
      const still = camera.scale === 1 && camera.x === 0 && camera.y === 0;
      const dx = camera.scale * item.x + camera.x - item.x;
      const dy = camera.scale * item.y + camera.y - item.y;
      item.element.style.transform = still ? "" : `translate(${dx}px, ${dy}px) scale(${camera.scale})`;
    }
    for (const box of boxes) {
      const shown = t >= box.start && t < box.end ? level(box, t) : 0;
      box.element.style.opacity = String(shown);
      if (shown > 0) {
        const at = place(box.box, camera);
        const pad = 6;
        Object.assign(box.element.style, { left: `${at.x - pad}px`, top: `${at.y - pad}px`, width: `${at.w + 2 * pad}px`, height: `${at.h + 2 * pad}px` });
      }
    }
    if (veil) {
      const spotlight = spotlights.find((track) => t >= track.start && t < track.end);
      veil.shade.style.opacity = spotlight ? String(level(spotlight, t)) : "0";
      if (spotlight) {
        [spotlight.box, ...readable].forEach((box, index) => {
          const at = place(box, camera);
          const pad = 4;
          for (const [key, value] of Object.entries({ x: at.x - pad, y: at.y - pad, width: at.w + 2 * pad, height: at.h + 2 * pad })) {
            veil.holes[index].setAttribute(key, String(value));
          }
        });
      }
    }
    for (const item of appearing) {
      const p = ramp(t, item.start, item.end);
      if (item.target.type === "card") {
        item.element.style.opacity = String(p);
        item.element.style.transform = p < 1 ? `translateY(${(1 - p) * 16}px)` : "";
        continue;
      }
      item.element.style.opacity = item.drawOnly ? (t >= item.start ? "1" : "0") : String(p);
      for (const line of item.lines) {
        line.part.style.strokeDasharray = `${line.length} ${line.length}`;
        line.part.style.strokeDashoffset = String(line.length * (1 - p));
        if (line.marker) line.part.style.markerEnd = p < 0.98 ? "none" : "";
      }
    }
    for (const item of emphasis.filter((entry) => entry.span)) {
      const k = Math.min(ramp(t, item.start, item.start + 0.25), 1 - ramp(t, item.end - 0.25, item.end));
      if (k <= 0) {
        item.span.removeAttribute("style");
        continue;
      }
      const colour = `color-mix(in srgb, var(--highlight-text) ${Math.round(k * 100)}%, ${item.base})`;
      Object.assign(item.span.style, { display: "inline-block", transform: `scale(${1 + 0.15 * k})`, transformOrigin: "50% 60%", color: colour });
      item.span.style.setProperty("-webkit-text-fill-color", colour);
    }
  };

  // What each camera shows of the figure when fully zoomed in, in percent of the figure.
  return cameras.map((camera) => {
    const { scale, x, y } = camera.view;
    const left = clamp(((-x / scale - image.x) / image.w)) * 100;
    const top = clamp(((-y / scale - image.y) / image.h)) * 100;
    const right = clamp((((frameSize.w - x) / scale - image.x) / image.w)) * 100;
    const bottom = clamp((((frameSize.h - y) / scale - image.y) / image.h)) * 100;
    return { start: camera.start, top, left, width: right - left, height: bottom - top };
  });

  /** Put the words (standing on their own, as in cues.js countText) into a span of their own. */
  function wrapWords(card, text) {
    const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      for (let at = node.data.indexOf(text); at !== -1; at = node.data.indexOf(text, at + 1)) {
        const before = node.data[at - 1] ?? "";
        const after = node.data.slice(at + text.length, at + text.length + 2);
        if (/^\d/.test(text) && /[\d.]/.test(before)) continue;
        if (/\d$/.test(text) && /^(\d|\.\d)/.test(after)) continue;
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + text.length);
        const span = document.createElement("span");
        range.surroundContents(span);
        return span;
      }
    }
    return null;
  }

  /** The colour the words show in now; for gradient text (background-clip: text), its first colour. */
  function baseColour(span) {
    const fill = getComputedStyle(span).webkitTextFillColor;
    if (fill && fill !== "rgba(0, 0, 0, 0)" && fill !== "transparent") return fill;
    for (let element = span.parentElement; element; element = element.parentElement) {
      const stop = getComputedStyle(element).backgroundImage.match(/(?:rgba?|color)\([^)]*\)/);
      if (stop) return stop[0];
    }
    return getComputedStyle(span).color;
  }
}

/** Remove the cover's empty optional boxes and report text that does not fit. */
async function prepareCover(hidden) {
  hidden.flatMap((selector) => [...document.querySelectorAll(selector)]).forEach((element) => element.remove());
  await document.fonts.ready;

  const problems = [];
  const lineLimits = [
    { selector: ".cover-headline", name: "封面大字", max: 2 },
    { selector: ".hero-metric-val", name: "封面指标", max: 1 },
  ];
  for (const { selector, name, max } of lineLimits) {
    const element = document.querySelector(selector);
    const lines = element ? countLines(element) : 0;
    if (lines > max) problems.push(`「${name}」排成了 ${lines} 行（最多 ${max} 行），缩小后不好认，建议精简`);
  }
  for (const element of document.querySelectorAll(".content-stage, .hero-graphic")) {
    if (element.scrollHeight > element.clientHeight + 2 || element.scrollWidth > element.clientWidth + 2) {
      problems.push("有文字超出了版面，建议精简");
    }
  }
  return problems;

  // The number of lines the text was laid out in: one distinct top edge per line.
  function countLines(element) {
    const range = document.createRange();
    range.selectNodeContents(element);
    return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
  }
}
