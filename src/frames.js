// Fill the templates with each slide's content and take one screenshot per subtitle line.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const TEMPLATES_DIR = fileURLToPath(new URL("../templates/", import.meta.url));
const WIDTH = 1920;
const HEIGHT = 1080;

/**
 * @returns {Promise<{ frames: Array<{ file: string, duration: number }>, warnings: string[] }>}
 */
export async function renderFrames(slides, narration, workDir) {
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
      fs.writeFileSync(htmlFile, fillTemplate(slide));
      await page.goto(pathToFileURL(htmlFile).href);

      const problems = await page.evaluate(prepareSlide, {
        cardCounts: slide.cardCounts,
        hidden: slide.hidden,
        fitGrid: slide.fitGrid,
      });
      problems.forEach((problem) => warnings.push(`第 ${slide.number} 页：${problem}`));

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
      console.log(`  第 ${slide.number} 页画面完成（${timing.lines.length} 帧）`);
    }
  } finally {
    await browser.close();
  }

  return { frames, warnings };
}

function fillTemplate(slide) {
  const template = fs.readFileSync(path.join(TEMPLATES_DIR, `${slide.layout}.html`), "utf8");
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name) => escapeHtml(slide.values[name] ?? ""));
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
      color: "#ffffff",
      textAlign: "center",
      textShadow: "0 2px 8px rgba(0, 0, 0, 0.85)",
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

function showSubtitle(text) {
  const subtitle = document.getElementById("dp-subtitle");
  if (subtitle) subtitle.textContent = text;
}
