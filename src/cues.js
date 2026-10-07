// The cue table (cues.md in the episode folder, visual v2): which narration line starts which
// animation on which page. Claude writes it, ChatGPT reviews it with the preview
// (docs/proposals/visual-v2.md, sections 3-5). Without a cue table every page shows all its
// content from the start, with page turns only.
//
// Checking happens in two steps: checkCues() needs only the script and the files (npm run check);
// scheduleCues() also needs the page's real narration times, so it runs after the voice-over.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pageTurn } from "./animation.js";

export const CUES_FILE = "cues.md";

// How long each action takes, in seconds (visual-v2.md section 4.2).
export const CUE_TIMING = {
  appear: 0.5,
  stagger: 0.3, // between the targets of 「、」
  emphasizeDelay: 0.3,
  emphasize: 1.1,
  box: [0.35, 0.3], // in, out
  spotlight: [0.4, 0.4],
  camera: [0.9, 0.9],
  cameraClear: 1.0, // the camera is back on the whole figure this long before the page ends
};
const MAX_BOXES = 3;

const ACTIONS = { 出现: "appear", 强调: "emphasize", 框: "box", 聚光: "spotlight", 镜头: "camera" };
const HEADER = ["从哪句", "到哪句", "动作", "目标", "位置", "说明"];
const POSITION_EXAMPLE = "比如 25%, 45%, 35%, 40%";

/**
 * Read and check the episode's cues.md against its slides. A missing file is fine: no cues.
 * @returns {{ pages: Map<number, object>, errors: string[], warnings: string[] }}
 */
export function checkCues(episodeDir, slides) {
  const file = path.join(episodeDir, CUES_FILE);
  if (!fs.existsSync(file)) return { pages: new Map(), errors: [], warnings: [] };

  const { pages, errors } = parseCues(fs.readFileSync(file, "utf8"));
  const warnings = [];
  for (const page of pages.values()) {
    const slide = slides.find((item) => item.number === page.number);
    const report = (message, lineNo = page.lineNo) => errors.push(`镜头表第 ${page.number} 页（第 ${lineNo} 行）：${message}`);
    if (!slide) {
      report("讲稿里没有这一页");
      continue;
    }
    checkPage(page, slide, episodeDir, report);
  }
  return { pages, errors, warnings };
}

/** cues.md -> pages keyed by page number; only the format is checked here. */
export function parseCues(markdown) {
  const pages = new Map();
  const errors = [];
  let page = null;
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const cellsOf = (line) => line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
  const isSeparator = (line) => line?.trim().startsWith("|") && cellsOf(line).every((cell) => /^:?-{3,}:?$/.test(cell));

  lines.forEach((raw, index) => {
    const lineNo = index + 1;
    const line = raw.trim();
    const where = page ? `镜头表第 ${page.number} 页（第 ${lineNo} 行）` : `镜头表（第 ${lineNo} 行）`;

    const heading = line.match(/^##\s*第\s*(\d+)\s*页/);
    if (heading) {
      const number = Number(heading[1]);
      if (pages.has(number)) errors.push(`镜头表（第 ${lineNo} 行）：「第 ${number} 页」写了两次`);
      page = { number, lineNo, figure: null, diagram: null, readable: [], actions: [] };
      pages.set(number, page);
      return;
    }
    if (!page) return; // a title or notes before the first page

    if (line.startsWith("|")) {
      if (isSeparator(line)) return;
      const cells = cellsOf(line);
      // The row above the |---| line is the header.
      if (isSeparator(lines[index + 1])) {
        if (cells.join("|") !== HEADER.join("|")) errors.push(`${where}：表头要写成「${HEADER.join(" | ")}」`);
        return;
      }
      if (cells.length !== HEADER.length) {
        errors.push(`${where}：这一行有 ${cells.length} 格，要写 ${HEADER.length} 格：${HEADER.join(" | ")}（空着的格子也要留着）`);
        return;
      }
      const [from, to, action, target, position, note] = cells;
      page.actions.push({ lineNo, from, to, action, target, position, note });
      return;
    }

    const item = line.match(/^[-*]\s*(原图|示意图|始终可读)\s*[:：]\s*(.*)$/);
    if (item) {
      const [, key, value] = item;
      const problem = (message) => errors.push(`${where}：${message}`);
      if (key === "原图") page.figure = { lineNo, ...parseFigureLine(value, problem) };
      if (key === "示意图") page.diagram = { lineNo, ...parseDiagramLine(value, problem) };
      if (key === "始终可读") page.readable.push(...parseReadable(value, problem).map((region) => ({ ...region, lineNo })));
      return;
    }
    if (/^[-*]\s/.test(line)) errors.push(`${where}：不认识这一行；每页只写「原图」「示意图」「始终可读」和动作表`);
  });
  return { pages, errors };
}

// "figures/table1.png（3254×684，校验 5d41402a）"
function parseFigureLine(value, problem) {
  const match = value.match(/^(\S+?)\s*[（(]\s*(\d+)\s*[×xX*]\s*(\d+)\s*[,，]\s*校验\s*(.*?)\s*[）)]$/);
  if (!match) {
    problem(`「原图」要写成「figures/文件名.png（宽×高，校验 8 位校验码）」，尺寸和校验码由 npm run check 给出`);
    return { file: value.split(/[（(]/)[0].trim(), width: 0, height: 0, checksum: "" };
  }
  const [, file, width, height, checksum] = match;
  return { file, width: Number(width), height: Number(height), checksum };
}

// "diagrams/page5.svg（部件：memory、pill、note）"
function parseDiagramLine(value, problem) {
  const match = value.match(/^(\S+?)\s*(?:[（(]\s*部件\s*[:：]\s*(.*?)\s*[）)])?$/);
  if (!match) {
    problem("「示意图」要写成「diagrams/page<页码>.svg（部件：id1、id2）」");
    return { file: value.trim(), parts: [] };
  }
  return { file: match[1], parts: match[2] ? match[2].split(/\s*、\s*/).filter(Boolean) : [] };
}

// "纵轴和刻度 | 15%, 2%, 14%, 65%；图例 | 3%, 18%, 70%, 7.5%"
function parseReadable(value, problem) {
  return value
    .split(/\s*[；;]\s*/)
    .filter(Boolean)
    .flatMap((entry) => {
      const [name, position, extra] = entry.split("|").map((part) => part.trim());
      if (!name || !position || extra !== undefined) {
        problem(`「始终可读」的每一项写成「名字 | 上, 左, 宽, 高」，几项之间用「；」隔开（这一项是「${entry}」）`);
        return [];
      }
      const box = parsePosition(position, (message) => problem(`「始终可读」的「${name}」${message}`));
      return box ? [{ name, box }] : [];
    });
}

/**
 * "25%, 45%, 35%, 40%" -> { top, left, width, height } in percent of the image file (white margins
 * included); null after reporting what is wrong.
 */
export function parsePosition(text, report) {
  const values = text.split(/\s*[,，]\s*/);
  const numbers = values.map((value) => {
    const match = value.match(/^(\d+(?:\.\d+)?)%$/);
    return match ? Number(match[1]) : Number.NaN;
  });
  if (values.length !== 4 || numbers.some((number) => !Number.isFinite(number))) {
    report(`位置「${text}」格式不对，要写 4 个带 % 的数字：上, 左, 宽, 高，${POSITION_EXAMPLE}`);
    return null;
  }
  const [top, left, width, height] = numbers;
  if (width <= 0 || height <= 0) {
    report(`位置「${text}」的宽和高都要大于 0`);
    return null;
  }
  if (top + height > 100 || left + width > 100) {
    report(`位置「${text}」超出了原图（上 + 高、左 + 宽都不能超过 100%）`);
    return null;
  }
  return { top, left, width, height };
}

// ---- Checks against the script and the files ----

function checkPage(page, slide, episodeDir, report) {
  const figureFile = slide.values.figure_image_path ? fileURLToPath(slide.values.figure_image_path) : null;
  const diagramFile = slide.values.diagram_image_path ? fileURLToPath(slide.values.diagram_image_path) : null;
  const diagramIds = page.diagram || page.actions.some((row) => row.target.includes("#")) ? readSvgIds(diagramFile) : null;

  if (page.figure) checkFigure(page.figure, figureFile, episodeDir, report);
  if (page.diagram) {
    const named = path.resolve(episodeDir, page.diagram.file);
    if (!diagramFile) report("这一页没有示意图", page.diagram.lineNo);
    else if (named !== diagramFile) report(`「示意图」写的是 ${page.diagram.file}，这一页用的是 ${relative(episodeDir, diagramFile)}`, page.diagram.lineNo);
    for (const id of diagramIds?.duplicates ?? []) report(`示意图里有两个部件都叫「${id}」，id 不能重复`, page.diagram.lineNo);
    for (const part of page.diagram.parts) {
      if (diagramIds && !diagramIds.ids.has(part)) report(`示意图里没有「${part}」这个部件`, page.diagram.lineNo);
    }
  }
  if (page.readable.length > 0 && !page.figure) report("写了「始终可读」，但没写「原图」", page.readable[0].lineNo);

  const lines = slide.narration;
  const cards = slide.cards ?? [];
  const appeared = new Map(); // target key -> lineNo of its 出现
  page.actions = page.actions.flatMap((row) => {
    const problem = (message) => report(message, row.lineNo);
    const action = checkRow(row, { lines, cards, figureFile, page, diagramIds, problem });
    if (!action) return [];
    for (const target of action.kind === "appear" ? action.groups.flat() : []) {
      const key = targetKey(target);
      if (appeared.has(key)) problem(`${targetName(target)} 已经在第 ${appeared.get(key)} 行出现过了，同一个目标只能出现一次`);
      appeared.set(key, row.lineNo);
    }
    return [action];
  });
}

function checkFigure(figure, figureFile, episodeDir, report) {
  const where = figure.lineNo;
  if (!figureFile) {
    report("这一页没有论文原图", where);
    return;
  }
  const named = path.resolve(episodeDir, figure.file);
  if (named !== figureFile) {
    report(`「原图」写的是 ${figure.file}，这一页用的是 ${relative(episodeDir, figureFile)}`, where);
    return;
  }
  if (!fs.existsSync(figureFile)) return; // the script check already reports the missing image
  const actual = describeFigure(figureFile);
  if (!actual) {
    report(`读不出 ${figure.file} 的尺寸；用到框、聚光、镜头的原图要用 PNG（npm run figure 截的就是）或写了宽高的 SVG`, where);
    return;
  }
  const written = `${figure.width}×${figure.height}，校验 ${figure.checksum}`;
  const real = `${actual.width}×${actual.height}，校验 ${actual.checksum}`;
  if (!/^[0-9a-f]{8}$/.test(figure.checksum)) {
    report(`「原图」还没写校验码：照现在的文件写成「${figure.file}（${real}）」；写之前先用 npm run preview 核对这一页的位置`, where);
  } else if (written !== real) {
    report(
      `原图和镜头表记的不一样：表里是「${written}」，现在的文件是「${real}」。` +
        "原图重截过的话，先用 npm run preview 重新核对这一页的位置，再更新尺寸和校验码",
      where,
    );
  }
}

/**
 * Width, height and an 8-digit checksum of a figure: a PNG, or an SVG with width and height
 * (the demo episode's placeholder). Null when the size cannot be read.
 */
export function describeFigure(file) {
  const bytes = fs.readFileSync(file);
  const checksum = crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 8);
  if (bytes.length > 24 && bytes.toString("latin1", 1, 4) === "PNG" && bytes.toString("latin1", 12, 16) === "IHDR") {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), checksum };
  }
  const svg = file.endsWith(".svg") ? bytes.toString("utf8").match(/<svg\b[^>]*>/)?.[0] : null;
  const size = (name) => Number(svg?.match(new RegExp(`\\s${name}\\s*=\\s*["'](\\d+(?:\\.\\d+)?)(?:px)?["']`))?.[1]);
  if (size("width") > 0 && size("height") > 0) return { width: size("width"), height: size("height"), checksum };
  return null;
}

/** The ids in a diagram SVG, and those used twice. */
function readSvgIds(file) {
  if (!file || !file.endsWith(".svg") || !fs.existsSync(file)) return null;
  const svg = fs.readFileSync(file, "utf8").replace(/<!--[\s\S]*?-->/g, "");
  const all = [...svg.matchAll(/\sid\s*=\s*["']([^"']+)["']/g)].map((match) => match[1]);
  const duplicates = [...new Set(all.filter((id, index) => all.indexOf(id) !== index))];
  return { ids: new Set(all), duplicates };
}

/** One row of the action table -> an action, or null when anything about it is wrong. */
function checkRow(row, { lines, cards, figureFile, page, diagramIds, problem }) {
  let failed = false;
  const fail = (message) => {
    failed = true;
    problem(message);
  };
  const kind = ACTIONS[row.action];
  if (!kind) {
    fail(`不认识动作「${row.action}」，只能写：${Object.keys(ACTIONS).join("、")}`);
    return null;
  }
  const fromLine = findLine(row.from, lines, "从哪句", fail);
  let toLine = fromLine;
  if (row.to) {
    if (kind === "appear" || kind === "emphasize") fail(`「${row.action}」不写「到哪句」：${kind === "appear" ? "出现后一直保留到本页结束" : "强调是一次性的提示"}`);
    else toLine = findLine(row.to, lines, "到哪句", fail);
    if (fromLine !== null && toLine !== null && toLine < fromLine) fail(`「到哪句」（第 ${toLine + 1} 句）在「从哪句」（第 ${fromLine + 1} 句）前面`);
  }
  const action = { lineNo: row.lineNo, kind, label: row.action, fromLine, toLine, note: row.note };

  if (kind === "appear") {
    if (row.position) fail("「出现」不写位置");
    action.groups = row.target
      .split(/\s*、\s*/)
      .map((group) => group.split(/\s*\+\s*/).map((text) => parseTarget(text, { cards, diagramIds, problem: fail })));
  } else if (kind === "emphasize") {
    if (row.position) fail("「强调」不写位置");
    const match = row.target.match(/^卡片\s*(\d+)\s*「(.+)」$/);
    if (!match) {
      fail(`「强调」的目标写成「卡片N「文字」」，比如 卡片2「77.3%」（现在是「${row.target}」）`);
    } else if (checkCard(Number(match[1]), cards, fail)) {
      const card = Number(match[1]);
      const text = match[2];
      const found = cards[card - 1].reduce((sum, part) => sum + countText(part, text), 0);
      if (found === 0) fail(`卡片${card} 里找不到「${text}」（要和卡片上的写法一样、在同一段里，也不能是更长数字的一部分，比如 80 不算 80.0 里的）`);
      if (found > 1) fail(`「${text}」在卡片${card} 里出现了 ${found} 次，多写几个字，让它只出现一次`);
      Object.assign(action, { card, text });
    }
  } else {
    if (row.target !== "原图") fail(`「${row.action}」的目标只能是「原图」`);
    if (!figureFile) fail(`这一页没有论文原图，不能「${row.action}」`);
    else if (!page.figure) fail(`用到「${row.action}」的页，要先写「- 原图：」这一行（文件、尺寸和校验码）`);
    if (!row.position) fail(`「${row.action}」要写位置：上, 左, 宽, 高，${POSITION_EXAMPLE}`);
    else action.box = parsePosition(row.position, fail);
  }
  return failed ? null : action;
}

function parseTarget(text, { cards, diagramIds, problem }) {
  const card = text.match(/^卡片\s*(\d+)$/);
  if (card) return checkCard(Number(card[1]), cards, problem) ? { type: "card", index: Number(card[1]) } : null;
  const part = text.match(/^#([\w-]+)$/);
  if (part) {
    if (!diagramIds) {
      problem(`这一页没有 SVG 示意图，不能出现「${text}」`);
      return null;
    }
    if (!diagramIds.ids.has(part[1])) {
      problem(`示意图里没有「${text}」这个部件`);
      return null;
    }
    return { type: "part", id: part[1] };
  }
  problem(`「出现」的目标写成「卡片N」或「#部件id」（现在是「${text}」）；同时出现用「+」连，依次出现用「、」隔开`);
  return null;
}

function checkCard(number, cards, problem) {
  if (cards.length === 0) problem("这一页没有卡片");
  else if (number < 1 || number > cards.length) problem(`这一页只有 ${cards.length} 张卡片，没有卡片${number}`);
  else return true;
  return false;
}

/** How many times `text` stands on its own in `part`: "80" inside "80.0" or "180" does not count. */
export function countText(part, text) {
  let count = 0;
  for (let at = part.indexOf(text); at !== -1; at = part.indexOf(text, at + 1)) {
    const before = part[at - 1] ?? "";
    const after = part.slice(at + text.length, at + text.length + 2);
    if (/^\d/.test(text) && /[\d.]/.test(before)) continue;
    if (/\d$/.test(text) && /^(\d|\.\d)/.test(after)) continue;
    count += 1;
  }
  return count;
}

/**
 * The narration line a cue starts on: the one line whose text begins with these words. Spaces
 * do not count, nor punctuation at the end of the cue; the text before pronunciation replacement
 * is compared. Returns its index, or null after reporting.
 */
export function findLine(words, lines, column, problem) {
  const compact = (text) => text.replace(/\s+/g, "");
  const key = compact(words).replace(/\p{P}+$/u, "");
  if (!key) {
    problem(`「${column}」是空的`);
    return null;
  }
  const matches = lines.flatMap((line, index) => (compact(line).startsWith(key) ? [index] : []));
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) problem(`「${column}」：本页找不到以「${words}」开头的旁白`);
  else problem(`「${column}」：本页有 ${matches.length} 句旁白都以「${words}」开头（第 ${matches.map((index) => index + 1).join("、")} 句），多写几个字`);
  return null;
}

function targetKey(target) {
  return target.type === "card" ? `card:${target.index}` : `part:${target.id}`;
}

export function targetName(target) {
  return target.type === "card" ? `卡片${target.index}` : `#${target.id}`;
}

function relative(episodeDir, file) {
  return path.relative(episodeDir, file).replace(/\\/g, "/");
}

// ---- Timing, from the real narration ----

/**
 * Schedule every page of the cue table against the narration (output/narration.json).
 * @returns {{ schedules: Map<number, { tracks, moves, readable }>, errors: string[], warnings: string[] }}
 */
export function scheduleAll(cues, narration) {
  const schedules = new Map();
  const errors = [];
  const warnings = [];
  for (const timing of narration.pages) {
    const page = cues.get(timing.number);
    if (!page || page.actions.length === 0) continue;
    const result = scheduleCues(page, timing, pageTurn(timing.end - timing.start).fadeOut);
    errors.push(...result.errors);
    warnings.push(...result.warnings);
    schedules.set(timing.number, { tracks: result.tracks, moves: result.moves, readable: page.readable });
  }
  return { schedules, errors, warnings };
}

/**
 * When every action of a page runs, in seconds from the page start, from the page's narration
 * times (narration.json): a line lasts from its start until the next line starts; the last one
 * until the page ends. Actions that do not fit, or clash, are errors: nothing is stretched,
 * cut short or carried over to the next page.
 * @param {object} page  a checked cue page (checkCues)
 * @param {{ start: number, end: number, lines: Array<{ start: number }> }} timing
 * @param {number} fadeOut  the page turn's fade-out, which actions must finish before
 * @returns {{ tracks: object[], moves: Array<[number, number]>, errors: string[], warnings: string[] }}
 */
export function scheduleCues(page, timing, fadeOut) {
  const duration = timing.end - timing.start;
  const lineStart = (index) => timing.lines[index].start - timing.start;
  const lineEnd = (index) => (index + 1 < timing.lines.length ? lineStart(index + 1) : duration);
  const errors = [];
  const warnings = [];
  const tracks = [];
  const latest = duration - fadeOut; // everything is in place before the page fades out
  const report = (action, message) => errors.push(`镜头表第 ${page.number} 页（第 ${action.lineNo} 行）：${message}`);
  const late = (action, what, end) =>
    report(action, `${what}要到第 ${end.toFixed(2)} 秒才做完，可本页在第 ${latest.toFixed(2)} 秒就开始翻页了；换早一点的句子开始，或者拆开写`);

  for (const action of page.actions) {
    const start = lineStart(action.fromLine);
    if (action.kind === "appear") {
      action.groups.forEach((group, order) => {
        for (const target of group) {
          const from = start + order * CUE_TIMING.stagger;
          const track = { kind: "appear", action, target, start: from, end: from + CUE_TIMING.appear };
          if (track.end > latest + 1e-9) late(action, `「出现」${targetName(target)}`, track.end);
          tracks.push(track);
        }
      });
    } else if (action.kind === "emphasize") {
      const from = start + CUE_TIMING.emphasizeDelay;
      const track = { kind: "emphasize", action, card: action.card, text: action.text, start: from, end: from + CUE_TIMING.emphasize };
      if (track.end > latest + 1e-9) late(action, `强调卡片${action.card}「${action.text}」`, track.end);
      tracks.push(track);
    } else {
      const [enter, leave] = CUE_TIMING[action.kind];
      const holdEnd = lineEnd(action.toLine);
      // A box or spotlight held to the last line leaves with the page turn instead.
      const leavesWithPage = action.kind !== "camera" && holdEnd >= duration - 1e-9;
      const track = {
        kind: action.kind,
        action,
        box: action.box,
        start,
        shown: start + enter,
        leave: leavesWithPage ? duration : holdEnd,
        end: leavesWithPage ? duration : holdEnd + leave,
      };
      if (track.shown > holdEnd + 1e-9) report(action, `「${action.label}」进场要 ${enter} 秒，这几句只有 ${(holdEnd - start).toFixed(2)} 秒；多写几句（到哪句）`);
      if (action.kind === "camera" && track.end > duration - CUE_TIMING.cameraClear + 1e-9) {
        report(action, `镜头要在本页最后 ${CUE_TIMING.cameraClear} 秒之前拉回全图（拉回要 ${leave} 秒），现在要到第 ${track.end.toFixed(2)} 秒，本页共 ${duration.toFixed(2)} 秒；提前结束镜头`);
      } else if (!leavesWithPage && track.end > latest + 1e-9) {
        late(action, `「${action.label}」的退场`, track.end);
      }
      tracks.push(track);
    }
  }

  for (const kind of ["camera", "spotlight"]) {
    const same = tracks.filter((track) => track.kind === kind);
    same.forEach((a, index) => {
      for (const b of same.slice(index + 1)) {
        if (a.start < b.end - 1e-9 && b.start < a.end - 1e-9) {
          report(b.action, `和第 ${a.action.lineNo} 行的${a.action.label}时间重叠（进场、停留、退场都算），同一时间只能有一个${a.action.label}`);
        }
      }
    });
  }
  for (const track of tracks.filter((item) => item.kind === "emphasize")) {
    const shown = tracks.find((item) => item.kind === "appear" && item.target.type === "card" && item.target.index === track.card);
    if (shown && shown.start > track.start + 1e-9) report(track.action, `卡片${track.card} 要到第 ${shown.action.lineNo} 行才出现，不能先强调它`);
  }
  const boxes = tracks.filter((track) => track.kind === "box");
  for (const box of boxes) {
    const together = boxes.filter((other) => other.start < box.end && box.start < other.end);
    if (together.length > MAX_BOXES && together[0] === box) {
      warnings.push(`镜头表第 ${page.number} 页（第 ${box.action.lineNo} 行）：同一时间有 ${together.length} 个框，画面可能太乱`);
    }
  }

  const moves = tracks.flatMap((track) =>
    track.kind === "appear" || track.kind === "emphasize"
      ? [[track.start, track.end]]
      : [[track.start, track.shown], ...(track.leave < duration ? [[track.leave, track.end]] : [])],
  );
  return { tracks, moves, errors, warnings };
}
