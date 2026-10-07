// Fill the templates with each slide's content and take one screenshot per subtitle line.
// Also renders the Bilibili cover from the same kind of template.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const TEMPLATES_DIR = fileURLToPath(new URL("../templates/", import.meta.url));
const THEMES_DIR = path.join(TEMPLATES_DIR, "themes");
const WIDTH = 1920;
const HEIGHT = 1080;

// Every template links the default theme, so it also looks right when opened on its own;
// the filled-in page points that link at the chosen theme (templates/themes/<name>.css).
export const DEFAULT_THEME = "academic";
const THEME_LINK = 'href="themes/academic.css"';

// A figure at least this many times wider than tall looks tiny next to the points, so the page
// switches to the wide variant of its template: figure across the top, points below it.
const WIDE_FIGURE_RATIO = 2.2;
const WIDE_VARIANTS = { figure_text: "figure_text_wide" };

/**
 * @returns {Promise<{ frames: Array<{ file: string, duration: number }>, warnings: string[] }>}
 */
export async function renderFrames(slides, narration, workDir, { theme = DEFAULT_THEME } = {}) {
  const pagesDir = path.join(workDir, "pages");
  const framesDir = path.join(workDir, "frames");
  for (const dir of [pagesDir, framesDir]) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
  }

  const frames = [];
  const warnings = [];
  const browser = await launchBrowser();

  try {
    const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });

    for (const [slideIndex, slide] of slides.entries()) {
      // Slides and narration pages come in the same order. Use the position, not the page
      // number, so a numbering mistake can never mix up audio, frames or file names.
      const timing = narration.pages[slideIndex];
      const order = pad(slideIndex + 1);
      const htmlFile = path.join(pagesDir, `page${order}.html`);
      const template = await openSlide(page, slide, htmlFile, theme);
      const diagram = slide.values.diagram_image_path;
      if (diagram?.endsWith(".svg")) await page.evaluate(inlineDiagram, fs.readFileSync(fileURLToPath(diagram), "utf8"));

      const problems = await page.evaluate(prepareSlide, {
        cardCounts: slide.cardCounts,
        hidden: slide.hidden,
        fitGrid: slide.fitGrid,
      });
      problems.forEach((problem) => warnings.push(`第 ${slide.number} 页：${problem}`));
      if (slideIndex === 0) (await page.evaluate(missingFonts)).forEach((font) => warnings.push(missingFontWarning(font, theme)));

      // No subtitle during the pause before the first sentence, so text never shows up before the voice.
      const firstStart = timing.lines[0].start;
      if (firstStart > timing.start) {
        await page.evaluate(showSubtitle, "");
        const file = path.join(framesDir, `p${order}-l00.png`);
        await page.screenshot({ path: file });
        frames.push({ file, duration: firstStart - timing.start });
      }

      for (const [index, line] of timing.lines.entries()) {
        await page.evaluate(showSubtitle, line.display);
        const file = path.join(framesDir, `p${order}-l${pad(index + 1)}.png`);
        await page.screenshot({ path: file });

        // A line stays until the next one starts; the last line also covers the pause after it.
        const end = index === timing.lines.length - 1 ? timing.end : timing.lines[index + 1].start;
        frames.push({ file, duration: end - line.start });
      }
      const variant = template === slide.layout ? "" : `，${template}`;
      console.log(`  第 ${slide.number} 页画面完成（${timing.lines.length} 帧${variant}）`);
    }
  } finally {
    await browser.close();
  }

  return { frames, warnings };
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
    const fonts = (await page.evaluate(missingFonts)).map((font) => missingFontWarning(font, theme));
    await page.screenshot({ path: file });
    return { file, warnings: [...problems.map((problem) => `封面：${problem}`), ...fonts] };
  } finally {
    await browser.close();
  }
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

function missingFontWarning(font, theme) {
  return `风格「${theme}」要用的字体「${font}」这台电脑上没有，画面会退回别的字体`;
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

function showSubtitle(text) {
  const subtitle = document.getElementById("dp-subtitle");
  if (subtitle) subtitle.textContent = text;
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
