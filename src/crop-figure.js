// Crop a figure or table out of the paper PDF in the episode folder, keeping it exactly as printed.
//   npm run figure -- <本期文件夹> <页码>                       render the whole page, to locate the figure
//   npm run figure -- <本期文件夹> <页码> <名字> <上,左,下,右>    crop that region into figures/<名字>.png
//   add --gaps to either, to list the blank rows and columns (where a crop or a cue can end cleanly)
// The region is a generous box in fractions of the page (0~1); the white margin inside it is trimmed.
// Figures are cropped at 576 dpi, so the text stays sharp when the video's camera zooms in.
// The PDF is drawn by pdf.js inside Edge; pdf.js is loaded from cdnjs, so this needs the internet.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { launchBrowser } from "./frames.js";

const PDFJS = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174";
const PAGE_SCALE = 1.5; // whole page, just for finding the figure
const CROP_SCALE = 8; // 576 dpi, sharp even when the camera zooms in (visual v2)
// White margin kept around the trimmed figure: 6 pixels at 72 dpi, more at higher resolutions, so a
// figure cropped again at another resolution keeps the same percent positions (cues.md).
const PADDING = 6;

// Names follow the script's naming rule (docs/script-format.md): "Figure 3(b)" -> figure3b.
const FIGURE_NAME = /^[a-z0-9][a-z0-9._-]*$/;
const IMAGE_EXTENSION = /\.(png|jpe?g|svg|webp)$/;
const FRACTION = /^\d*\.?\d+$/;

const USAGE = `用法：
  npm run figure -- <本期文件夹> <页码> [--gaps]
  npm run figure -- <本期文件夹> <页码> <名字> <上,左,下,右> [--gaps]   比如 figure1 0.11,0.12,0.30,0.88
  --gaps 列出图里的空白行、空白列：整页给页面的 0～1（写截图范围用），截出的图给百分比（写镜头表用）`;

async function main() {
  const args = process.argv.slice(2);
  const gaps = args.includes("--gaps");
  const [episodeArg, pageArg, name, regionArg] = args.filter((arg) => arg !== "--gaps");
  const pageNumber = Number(pageArg);
  if (!episodeArg || !Number.isInteger(pageNumber) || (name !== undefined && regionArg === undefined)) {
    console.log(USAGE);
    process.exitCode = 1;
    return;
  }
  // Check everything the user typed before starting the browser.
  const episodeDir = path.resolve(episodeArg);
  const pdfFile = findPdf(episodeDir);
  const crop = name === undefined ? null : { file: figureFile(episodeDir, name), region: parseRegion(regionArg) };

  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ url: `${PDFJS}/pdf.min.js` });
    const pageCount = await page.evaluate(loadPdf, {
      base64: fs.readFileSync(pdfFile).toString("base64"),
      workerSrc: `${PDFJS}/pdf.worker.min.js`,
    });
    if (pageNumber < 1 || pageNumber > pageCount) throw new Error(`PDF 只有 ${pageCount} 页`);

    const scale = crop ? CROP_SCALE : PAGE_SCALE;
    const box = crop ? pixelBox(crop.region, await page.evaluate(pageSize, { pageNumber, scale })) : null;
    const result = await page.evaluate(renderPage, { pageNumber, scale, box, padding: PADDING * scale, gaps });
    if (result.error) throw new Error(result.error);

    const file = crop ? crop.file : path.join(episodeDir, "output", "pdf-pages", `page${pageNumber}.png`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(result.png, "base64"));
    console.log(`${path.relative(process.cwd(), file)}（${result.size}）`);
    // Content touching the edge of the region may have been cut off.
    const touching = Object.entries(result.margins ?? {}).filter(([, gap]) => gap < scale).map(([side]) => side);
    if (touching.length > 0) console.warn(`⚠️  图贴着范围的边（${touching.join("、")}），可能截掉了一部分，看一眼再决定要不要放大范围`);
    if (gaps) {
      const format = crop ? (start, end, length) => `${percent(start, length)}–${percent(end, length)}%` : (start, end, length) => `${(start / length).toFixed(3)}–${(end / length).toFixed(3)}`;
      const list = (flags) => blankRuns(flags, Math.max(2, Math.round(flags.length * 0.004))).map(([start, end]) => format(start, end, flags.length)).join("、") || "没有";
      console.log(`空白行（从上往下${crop ? "，占图高的百分比" : "，页面的 0～1"}）：${list(result.blankRows)}`);
      console.log(`空白列（从左往右${crop ? "，占图宽的百分比" : "，页面的 0～1"}）：${list(result.blankColumns)}`);
      console.log("空白只是参考：两组数据之间没有空白行的表格，边界还要看图逐行核对");
    }
  } finally {
    await browser.close();
  }
}

/** The episode folder holds exactly one paper PDF, named like 2610.05608v1.pdf. */
function findPdf(episodeDir) {
  const pdfs = fs.existsSync(episodeDir) ? fs.readdirSync(episodeDir).filter((file) => file.endsWith(".pdf")) : [];
  if (pdfs.length !== 1) throw new Error(`本期文件夹里应该正好有一个论文 PDF，现在有 ${pdfs.length} 个`);
  return path.join(episodeDir, pdfs[0]);
}

/** figures/<name>.png of the episode. The name is a figure label, never a path. */
export function figureFile(episodeDir, name) {
  if (!FIGURE_NAME.test(name) || IMAGE_EXTENSION.test(name)) {
    throw new Error(`名字「${name}」不对：按图号写，全部小写、不带扩展名和路径，比如 figure1、figure3b、table11`);
  }
  const figuresDir = path.resolve(episodeDir, "figures");
  const file = path.resolve(figuresDir, `${name}.png`);
  // The pattern already rules out folders; make sure the file really lands in figures/.
  if (path.dirname(file) !== figuresDir) throw new Error(`名字「${name}」会存到 figures 文件夹外面`);
  return file;
}

/** "上,左,下,右" -> { top, left, bottom, right }: exactly four fractions of the page. */
export function parseRegion(text) {
  const parts = String(text).split(",").map((part) => part.trim());
  const numbers = parts.length === 4 && parts.every((part) => FRACTION.test(part)) ? parts.map(Number) : [];
  const [top, left, bottom, right] = numbers;
  const valid = numbers.length === 4 && numbers.every((n) => n <= 1) && top < bottom && left < right;
  if (!valid) {
    throw new Error(`范围「${text}」不对：要写 4 个 0～1 之间的小数「上,左,下,右」，用逗号隔开，上比下小、左比右小`);
  }
  return { top, left, bottom, right };
}

/**
 * The stretches of at least minLength blank rows (or columns), as [start, end) indexes.
 * @param {Array<0|1>} flags  1 for a blank row
 */
export function blankRuns(flags, minLength) {
  const runs = [];
  let start = -1;
  flags.forEach((blank, index) => {
    if (blank && start < 0) start = index;
    const last = index === flags.length - 1;
    if (start >= 0 && (!blank || last)) {
      const end = blank && last ? index + 1 : index;
      if (end - start >= minLength) runs.push([start, end]);
      start = -1;
    }
  });
  return runs;
}

function percent(pixels, length) {
  return ((pixels / length) * 100).toFixed(1);
}

/** The region in pixels of the rendered page; a region that rounds to nothing is refused. */
export function pixelBox(region, { width, height }) {
  const box = {
    x: Math.round(region.left * width),
    y: Math.round(region.top * height),
    width: Math.round((region.right - region.left) * width),
    height: Math.round((region.bottom - region.top) * height),
  };
  if (box.width < 1 || box.height < 1) throw new Error("范围太小，换算成像素后宽或高是 0，放大一点再截");
  return box;
}

// ---- The functions below run inside the browser page, not in Node.js ----

async function loadPdf({ base64, workerSrc }) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  window.pdfDoc = await pdfjsLib.getDocument({ data: bytes }).promise;
  return window.pdfDoc.numPages;
}

/** The size in pixels the page will be drawn at, the same as renderPage's canvas. */
async function pageSize({ pageNumber, scale }) {
  const viewport = (await window.pdfDoc.getPage(pageNumber)).getViewport({ scale });
  return { width: Math.ceil(viewport.width), height: Math.ceil(viewport.height) };
}

/** Draw a page on a white canvas, then return it whole or trimmed to the content inside a box. */
async function renderPage({ pageNumber, scale, box, padding, gaps }) {
  const pdfPage = await window.pdfDoc.getPage(pageNumber);
  const viewport = pdfPage.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  await pdfPage.render({ canvasContext: context, viewport }).promise;
  if (!box) return { png: canvas.toDataURL("image/png").split(",")[1], size: `${canvas.width}×${canvas.height}`, ...(gaps ? blankLines(canvas) : {}) };

  const { data } = context.getImageData(box.x, box.y, box.width, box.height);

  // The bounding box of everything that is not (almost) white.
  let minX = box.width, minY = box.height, maxX = -1, maxY = -1;
  for (let y = 0; y < box.height; y++) {
    for (let x = 0; x < box.width; x++) {
      const i = (y * box.width + x) * 4;
      if (data[i] < 245 || data[i + 1] < 245 || data[i + 2] < 245) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
  }
  if (maxX < 0) return { error: "这个范围里是空白，没有图" };

  const contentWidth = maxX - minX + 1;
  const contentHeight = maxY - minY + 1;
  const out = document.createElement("canvas");
  out.width = contentWidth + padding * 2;
  out.height = contentHeight + padding * 2;
  const outContext = out.getContext("2d");
  outContext.fillStyle = "#ffffff";
  outContext.fillRect(0, 0, out.width, out.height);
  outContext.drawImage(canvas, box.x + minX, box.y + minY, contentWidth, contentHeight, padding, padding, contentWidth, contentHeight);
  return {
    png: out.toDataURL("image/png").split(",")[1],
    size: `${out.width}×${out.height}`,
    margins: { 上: minY, 左: minX, 下: box.height - 1 - maxY, 右: box.width - 1 - maxX },
    ...(gaps ? blankLines(out) : {}),
  };

  /** For each row and each column of the canvas: 1 when it is (almost) white all the way. */
  function blankLines(target) {
    const pixels = target.getContext("2d").getImageData(0, 0, target.width, target.height).data;
    const blankRows = new Array(target.height).fill(1);
    const blankColumns = new Array(target.width).fill(1);
    for (let y = 0; y < target.height; y++) {
      for (let x = 0; x < target.width; x++) {
        const i = (y * target.width + x) * 4;
        if (pixels[i] < 245 || pixels[i + 1] < 245 || pixels[i + 2] < 245) {
          blankRows[y] = 0;
          blankColumns[x] = 0;
        }
      }
    }
    return { blankRows, blankColumns };
  }
}

// Run only when started from the command line, so the tests can import the checks above.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`出错了：${error.message}`);
    process.exitCode = 1;
  });
}
