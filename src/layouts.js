// Check a parsed script against docs/script-format.md (v1.2) and map each page onto the
// placeholders of its template (templates/*.html), and the header onto the Bilibili cover.
// Every problem is collected, so the author can fix them all at once.
// Passing these checks does not mean the content is right.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { splitParts } from "./parse-script.js";

export const LAYOUT_NAMES = ["cover", "figure_text", "big_metric", "figure_annotated", "concept_diagram", "comparison"];

const MAX_ITEMS = 3;
const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".svg", ".webp"];
const ITEM_HINT = "标题 | 一句话说明";

// The header fields, in the order of docs/script-format.md「开头」. All are required except
// the optional cover fields.
const HEADER_KEYS = [
  "视频标题", "封面大字", "封面副标题", "封面卖点", "封面指标", "简介", "标签",
  "领域", "论文标题", "作者", "机构", "arXiv", "状态", "会议或期刊", "链接",
];
const OPTIONAL_HEADER_KEYS = ["封面副标题", "封面卖点", "封面指标"];
const ARXIV_ID = /^\d{4}\.\d{4,5}v\d+$/;
const PAPER_STATUSES = ["预印本", "已接收"];

// Suggested maximum length of each cover field. Longer text may not fit, or not be readable
// when the cover is shown small.
const COVER_TEXT_LIMITS = { 封面大字: 12, 封面副标题: 24, 封面卖点: 10, 封面指标: 8 };
export const BRAND_TEXT = "DailyPaper · 每日论文";

// The upload title is "【每日论文 #1】论文简称｜看点", at most 40 characters (docs/script-format.md).
const SERIES_TAG = /^【每日论文 #\d+】\s*/;
const TITLE_LIMIT = 40;

/*
 * The fields of each layout.
 *   text:  a single value
 *   parts: a single value made of exactly `count` parts separated by " | "
 *   items: 1~3 lines, each made of exactly `count` parts
 * Every part must be filled in, except the ones listed in `blankParts`.
 */
const LAYOUT_FIELDS = {
  cover: {
    核心突破: { kind: "text" },
  },
  figure_text: {
    步骤标签: { kind: "text", optional: true },
    主标题: { kind: "text" },
    原图: { kind: "parts", count: 3, hint: "Figure 2 | 第 3 节 | 图注" },
    要点: { kind: "items", count: 2 },
  },
  big_metric: {
    主标题: { kind: "text" },
    数据集: { kind: "text" },
    指标: {
      kind: "items",
      count: 5,
      blankParts: [1, 3],
      hint: "指标名 | 符号 | 数值 | 单位 | 一句话说明（没有符号或单位可以留空，但 | 要保留）",
    },
    对比基线: { kind: "text" },
    测试环境: { kind: "text" },
    原文出处: { kind: "text" },
  },
  figure_annotated: {
    主标题: { kind: "text" },
    聚焦模块: { kind: "text" },
    原图: { kind: "parts", count: 2, hint: "Figure 2 | 第 3 节" },
    标注: { kind: "parts", count: 2, blankParts: [1], hint: "红框标签 | 上, 左, 宽, 高" },
    要点: { kind: "items", count: 2 },
  },
  concept_diagram: {
    主标题: { kind: "text" },
    示意图: { kind: "text" },
    步骤: { kind: "items", count: 2 },
  },
  comparison: {
    主标题: { kind: "text" },
    基线: { kind: "text" },
    本文: { kind: "text" },
    基线要点: { kind: "items", count: 2 },
    本文要点: { kind: "items", count: 2 },
  },
};

/**
 * @returns {{ slides: object[], cover: object, errors: string[], warnings: string[] }}
 * Each slide: { number, topic, layout, values, cardCounts, hidden, fitGrid, narration }
 * The cover:  { layout, values, hidden }, for templates/bilibili-cover.html
 */
export function buildSlides(script, episodeDir) {
  const errors = [];
  const warnings = [];

  const header = checkHeader(script.headerFields, errors, warnings);
  checkPageNumbers(script.pages, errors);
  checkPronunciations(script.pronunciations, errors);
  checkSourceTable(script.sourceRows, header, warnings);

  const slides = script.pages.map((page) => buildSlide(page, script.pages.length, header, episodeDir, errors));
  return { slides, cover: buildCover(header), errors, warnings };
}

// ---- Script-level checks ----

function checkHeader(fields, errors, warnings) {
  const report = (message, lineNo) => errors.push(lineNo ? `开头（第 ${lineNo} 行）：${message}` : `开头：${message}`);
  const header = {};
  const lineOf = {};

  if (fields.length === 0) {
    report("没有找到「## 开头」，或者里面没有字段");
    return header;
  }
  for (const field of fields) {
    if (!HEADER_KEYS.includes(field.key)) {
      report(`「${field.key}」不是开头的字段，可用的字段有：${HEADER_KEYS.join("、")}`, field.lineNo);
    } else if (field.key in header) {
      report(`「${field.key}」写了不止一次`, field.lineNo);
    } else {
      header[field.key] = field.value;
      lineOf[field.key] = field.lineNo;
    }
  }
  for (const key of HEADER_KEYS) {
    if (!header[key] && !OPTIONAL_HEADER_KEYS.includes(key)) report(`缺少「${key}」`);
  }
  checkCoverText(header, lineOf, report, warnings);
  checkVideoTitle(header["视频标题"], lineOf["视频标题"], warnings);

  const id = header["arXiv"];
  const status = header["状态"];
  const venue = header["会议或期刊"];
  const link = header["链接"];
  if (id && !ARXIV_ID.test(id)) {
    report(`「arXiv」要写带版本号的编号，比如 2510.01234v2，现在是「${id}」`);
  }
  if (status && !PAPER_STATUSES.includes(status)) {
    report(`「状态」只能写「预印本」或「已接收」，现在是「${status}」`);
  }
  if (status === "预印本" && venue && venue !== "无") {
    report("状态是「预印本」时，「会议或期刊」要写「无」");
  }
  if (status === "已接收" && venue === "无") {
    report("状态是「已接收」时，「会议或期刊」要写实际的会议或期刊");
  }
  if (id && link && ARXIV_ID.test(id) && !isArxivLink(link, id)) {
    report(`「链接」要和 arXiv 编号是同一个版本，比如 https://arxiv.org/abs/${id}`);
  }
  return header;
}

function isArxivLink(link, id) {
  const escapedId = id.replace(/\./g, "\\.");
  return new RegExp(`^https?://arxiv\\.org/(abs|pdf)/${escapedId}(\\.pdf)?/?$`).test(link);
}

/** The episode is part of a series, so the title starts with the series tag and stays short. */
function checkVideoTitle(title, lineNo, warnings) {
  if (!title) return;
  const where = `开头（第 ${lineNo} 行）`;
  if (!SERIES_TAG.test(title)) {
    warnings.push(`${where}：「视频标题」要以「【每日论文 #期数】」开头，写成「【每日论文 #1】论文简称｜看点」`);
  }
  // npm run new leaves these words in the title for the script writer to replace.
  if (title.includes("论文简称") || title.endsWith("｜看点")) {
    warnings.push(`${where}：「视频标题」里还有没换掉的「论文简称」或「看点」`);
  }
  const length = [...title].length;
  if (length > TITLE_LIMIT) warnings.push(`${where}：「视频标题」有 ${length} 个字，建议不超过 ${TITLE_LIMIT} 个字`);
}

/** The cover fields go straight onto the cover, so notes and placeholders must not slip through. */
function checkCoverText(header, lineOf, report, warnings) {
  for (const [key, limit] of Object.entries(COVER_TEXT_LIMITS)) {
    const value = header[key];
    if (!value) continue;
    const lineNo = lineOf[key];

    if (/[（(]\s*可选\s*[）)]/.test(value)) {
      report(`「${key}」里的「（可选）」只是格式说明，不要写进去`, lineNo);
    } else if (value === "无" || /^[.。…]+$/.test(value)) {
      const fix = OPTIONAL_HEADER_KEYS.includes(key) ? "不用就整行删掉" : "要写实际内容";
      report(`「${key}」${fix}，不要写「${value}」`, lineNo);
    }

    const length = [...value.replace(/\s/g, "")].length;
    if (length > limit) {
      warnings.push(`开头（第 ${lineNo} 行）：「${key}」有 ${length} 个字，建议不超过 ${limit} 个字，不然封面上可能放不下、缩小后看不清`);
    }
  }
}

/** Pages are numbered 1, 2, 3 ... with no gaps and no repeats; the number also names files. */
function checkPageNumbers(pages, errors) {
  if (pages.length === 0) {
    errors.push("没有找到任何一页。每页要以「### 第 X 页 · 主题」开头。");
    return;
  }
  const seen = new Set();
  pages.forEach((page, index) => {
    const expected = index + 1;
    if (seen.has(page.number)) {
      errors.push(`第 ${page.lineNo} 行：「第 ${page.number} 页」重复了，页码不能重复`);
    } else if (page.number !== expected) {
      errors.push(`第 ${page.lineNo} 行：这是第 ${expected} 个页面，页码应该是「第 ${expected} 页」，现在写的是「第 ${page.number} 页」`);
    }
    seen.add(page.number);
  });
}

function checkPronunciations(table, errors) {
  const seen = new Set();
  for (const { original, lineNo } of table) {
    if (seen.has(original)) errors.push(`发音替换表（第 ${lineNo} 行）：「${original}」写了不止一次`);
    seen.add(original);
  }
}

/** The source table is for reviewers, not for the video, so problems here are warnings. */
function checkSourceTable(rows, header, warnings) {
  if (rows.length === 0) {
    warnings.push("没有找到原文核对表（审稿要用，配音不用）");
    return;
  }
  const version = header["arXiv"]?.match(/v\d+$/)?.[0];
  if (!version) return;
  for (const { cells, lineNo } of rows) {
    const usedVersion = cells[2] ?? "";
    // Compare whole version tags, so "v10" never counts as "v1". A date instead of a tag is not compared.
    const tags = usedVersion.match(/v\d+/g) ?? [];
    if (!usedVersion) {
      warnings.push(`原文核对表（第 ${lineNo} 行）：没写论文版本`);
    } else if (tags.length > 0 && !tags.includes(version)) {
      warnings.push(`原文核对表（第 ${lineNo} 行）：论文版本写的是「${usedVersion}」，和开头的 ${version} 不一致`);
    }
  }
}

// ---- Bilibili cover ----

function buildCover(header) {
  const values = {
    brand_text: BRAND_TEXT,
    field_tag: header["领域"] ?? "",
    paper_status: header["状态"] ?? "",
    cover_title: header["封面大字"] ?? "",
    cover_subtitle: header["封面副标题"] ?? "",
    impact_highlight: header["封面卖点"] ?? "",
    metric_summary: header["封面指标"] ?? "",
  };
  return {
    layout: "bilibili-cover",
    values,
    // An optional field that is left out hides its whole box, decorations included.
    hidden: emptySelectors({
      ".cover-sub": values.cover_subtitle,
      ".highlight-pill": values.impact_highlight,
      ".hero-graphic": values.metric_summary,
    }),
  };
}

// ---- Page checks and template values ----

function buildSlide(page, totalPages, header, episodeDir, errors) {
  const report = (message, lineNo = page.lineNo) => errors.push(`第 ${page.number} 页（第 ${lineNo} 行）：${message}`);
  const layout = readLayout(page, report);
  if (page.narration.length === 0) report("「旁白」是空的");

  const spec = LAYOUT_FIELDS[layout];
  const data = spec ? readFields(page, layout, spec, report) : null;
  const context = {
    header,
    report,
    figureUrl: (label) => findImageUrl(path.join(episodeDir, "figures"), figureFileName(label), `「${label}」`, report),
    diagramUrl: () => findImageUrl(path.join(episodeDir, "diagrams"), `page${page.number}`, "示意图", report),
  };
  const result = data ? builders[layout](data, context) : { values: {} };

  return {
    number: page.number,
    topic: page.topic,
    layout,
    values: {
      page_topic: page.topic,
      page_number: String(page.number),
      total_pages: String(totalPages),
      ...result.values,
    },
    cardCounts: result.cardCounts ?? {},
    hidden: emptySelectors(result.hideWhenEmpty ?? {}),
    fitGrid: result.fitGrid ?? null,
    narration: page.narration,
  };
}

function readLayout(page, report) {
  const fields = page.fields.filter((field) => field.key === "版式");
  if (fields.length === 0) {
    report("缺少「版式」");
    return "";
  }
  if (fields.length > 1) report("「版式」写了不止一次", fields[1].lineNo);
  const layout = fields[0].value;
  if (!LAYOUT_NAMES.includes(layout)) {
    report(`版式「${layout}」不存在，只能用：${LAYOUT_NAMES.join("、")}`, fields[0].lineNo);
  }
  return layout;
}

/** Read and check every field of a page against its layout's rules. */
function readFields(page, layout, spec, report) {
  for (const field of page.fields) {
    if (field.key !== "版式" && !(field.key in spec)) {
      report(`「${field.key}」不是 ${layout} 版式的字段，可用的字段有：${Object.keys(spec).join("、")}`, field.lineNo);
    }
  }

  const data = { lineOf: (key) => page.fields.find((field) => field.key === key)?.lineNo ?? page.lineNo };
  for (const [key, rule] of Object.entries(spec)) {
    const fields = page.fields.filter((field) => field.key === key);

    if (rule.kind === "items") {
      if (fields.length === 0) report(`至少要写 1 条「${key}」`);
      if (fields.length > MAX_ITEMS) {
        report(`「${key}」最多 ${MAX_ITEMS} 条，现在有 ${fields.length} 条`, fields[MAX_ITEMS].lineNo);
      }
      data[key] = fields.slice(0, MAX_ITEMS).map((field) => readParts(key, field, rule, report));
      continue;
    }

    if (fields.length > 1) report(`「${key}」写了不止一次`, fields[1].lineNo);
    const field = fields[0];
    if (!field || !field.value) {
      if (!rule.optional) report(`缺少「${key}」`, field?.lineNo);
      data[key] = rule.kind === "parts" ? Array(rule.count).fill("") : "";
    } else {
      data[key] = rule.kind === "parts" ? readParts(key, field, rule, report) : field.value;
    }
  }
  return data;
}

/** Split "a | b | c" and check that it has exactly the right number of filled-in parts. */
function readParts(key, field, rule, report) {
  const parts = splitParts(field.value);
  const hint = rule.hint ?? ITEM_HINT;
  if (parts.length !== rule.count) {
    report(`「${key}：${field.value}」应该正好分成 ${rule.count} 部分（用 | 分隔），写成：${hint}`, field.lineNo);
  } else {
    const blankIndex = parts.findIndex((part, i) => !part && !(rule.blankParts ?? []).includes(i));
    if (blankIndex !== -1) {
      report(`「${key}：${field.value}」的第 ${blankIndex + 1} 部分是空的，应该写成：${hint}`, field.lineNo);
    }
  }
  return Array.from({ length: rule.count }, (_, i) => parts[i] ?? "");
}

// One builder per layout: turn the checked fields into template values.
const builders = {
  cover(data, { header }) {
    return {
      values: {
        field_tag: header["领域"] ?? "",
        paper_status: header["状态"] ?? "",
        arxiv_id: header["arXiv"] ?? "",
        conference_or_journal: header["会议或期刊"] ?? "",
        // The top bar already shows the series name, so the series tag is left out here.
        video_title: (header["视频标题"] ?? "").replace(SERIES_TAG, ""),
        paper_original_title: header["论文标题"] ?? "",
        authors_team: header["作者"] ?? "",
        affiliations: header["机构"] ?? "",
        core_highlight: data["核心突破"],
      },
      hideWhenEmpty: {
        ".badge-bar .source-badge:nth-of-type(2)": header["会议或期刊"],
        // "Kandinsky Lab (Kandinsky Lab)" says the same name twice.
        ".affiliations": header["机构"] === header["作者"] ? "" : header["机构"],
      },
    };
  },

  figure_text(data, { figureUrl }) {
    const [label, location, caption] = data["原图"];
    const points = data["要点"];
    return {
      values: {
        module_step: data["步骤标签"],
        heading_title: data["主标题"],
        figure_label: label,
        figure_source_location: location,
        figure_caption: caption,
        figure_image_path: label ? figureUrl(label) : "",
        ...numbered("point", points, ["title", "desc"]),
      },
      cardCounts: { ".points-list .point-card": points.length },
      hideWhenEmpty: { ".step-pill": data["步骤标签"] },
      // Only matters in the wide variant, where the points sit in one row.
      fitGrid: ".points-list",
    };
  },

  big_metric(data) {
    const metrics = data["指标"];
    return {
      values: {
        metric_headline: data["主标题"],
        benchmark_dataset: data["数据集"],
        baseline_model: data["对比基线"],
        hardware_condition: data["测试环境"],
        paper_table_ref: data["原文出处"],
        ...numbered("metric", metrics, ["name", "sign", "val", "unit", "desc"]),
      },
      cardCounts: { ".metric-grid .metric-card": metrics.length },
      hideWhenEmpty: { ".benchmark-footer span:nth-of-type(2)": data["测试环境"] },
    };
  },

  figure_annotated(data, { figureUrl, report }) {
    const [label, location] = data["原图"];
    const [boxLabel, boxText] = data["标注"];
    const box = parseBox(boxText, (message) => report(message, data.lineOf("标注")));
    const details = data["要点"];
    return {
      values: {
        annotation_headline: data["主标题"],
        target_module_name: data["聚焦模块"],
        figure_label: label,
        figure_source_location: location,
        figure_image_path: label ? figureUrl(label) : "",
        highlight_label: boxLabel,
        box_top: box.top,
        box_left: box.left,
        box_width: box.width,
        box_height: box.height,
        ...numbered("detail", details, ["title", "content"]),
      },
      cardCounts: { ".detail-cards .detail-card": details.length },
    };
  },

  concept_diagram(data, { diagramUrl }) {
    const steps = data["步骤"];
    return {
      values: {
        diagram_title: data["主标题"],
        diagram_image_path: diagramUrl(),
        ...numbered("step", steps, ["title", "desc"]),
      },
      cardCounts: { ".takeaway-grid .takeaway-card": steps.length },
      fitGrid: ".takeaway-grid",
    };
  },

  comparison(data) {
    const basePoints = data["基线要点"];
    const oursPoints = data["本文要点"];
    return {
      values: {
        comparison_headline: data["主标题"],
        baseline_name: data["基线"],
        ours_name: data["本文"],
        ...numbered("base_point", basePoints, ["title", "desc"]),
        ...numbered("ours_point", oursPoints, ["title", "desc"]),
      },
      cardCounts: {
        ".compare-col.traditional .feature-item": basePoints.length,
        ".compare-col.ours .feature-item": oursPoints.length,
      },
    };
  },
};

/** numbered("point", [["A", "a"]], ["title", "desc"]) -> { point_1_title: "A", point_1_desc: "a" } */
function numbered(prefix, rows, names) {
  const values = {};
  rows.forEach((row, rowIndex) => {
    names.forEach((name, i) => {
      values[`${prefix}_${rowIndex + 1}_${name}`] = row[i] ?? "";
    });
  });
  return values;
}

/** "25%, 45%, 35%, 40%" -> { top, left, width, height }, all relative to the figure. */
function parseBox(text, report) {
  const empty = { top: "", left: "", width: "", height: "" };
  const example = "比如 25%, 45%, 35%, 40%";
  if (!text) {
    report(`「标注」缺少红框位置。请看着原图写成「上, 左, 宽, 高」的百分比，${example}`);
    return empty;
  }
  if (text.includes("待定")) {
    report(`红框位置还是「待定」。生成视频前，请看着原图改成「上, 左, 宽, 高」的百分比，${example}`);
    return empty;
  }
  const values = text.split(/\s*[,，]\s*/);
  const numbers = values.map((value) => {
    const match = value.match(/^(\d+(?:\.\d+)?)%$/);
    return match ? Number(match[1]) : Number.NaN;
  });
  if (values.length !== 4 || numbers.some((number) => Number.isNaN(number))) {
    report(`红框位置「${text}」格式不对，要写 4 个带 % 的数字：上, 左, 宽, 高，${example}`);
    return empty;
  }
  const [top, left, width, height] = numbers;
  if (width <= 0 || height <= 0) report(`红框「${text}」的宽和高都要大于 0`);
  if (top + height > 100 || left + width > 100) report(`红框「${text}」超出了原图范围（上 + 高、左 + 宽都不能超过 100%）`);
  return { top: `${top}%`, left: `${left}%`, width: `${width}%`, height: `${height}%` };
}

/** "Figure 3(b)" -> "figure3b" */
export function figureFileName(label) {
  return label.toLowerCase().replace(/[\s()（）]/g, "");
}

/** Find the single image file for a figure or diagram, whatever its extension. */
function findImageUrl(dir, baseName, description, report) {
  const found = IMAGE_EXTENSIONS.map((extension) => path.join(dir, baseName + extension)).filter((file) => fs.existsSync(file));
  const folder = path.basename(dir);
  if (found.length === 0) {
    report(`找不到${description}的图片文件 ${folder}/${baseName}.png（也支持 .jpg、.jpeg、.svg、.webp）`);
    return "";
  }
  if (found.length > 1) {
    const names = found.map((file) => path.basename(file)).join("、");
    report(`${description}有 ${found.length} 个图片文件（${names}），只能保留一个`);
  }
  return pathToFileURL(found[0]).href;
}

/** { selector: value } -> the selectors whose value is empty, so their elements get removed. */
function emptySelectors(hideWhenEmpty) {
  return Object.entries(hideWhenEmpty)
    .filter(([, value]) => isEmpty(value))
    .map(([selector]) => selector);
}

function isEmpty(value) {
  return value === undefined || value === null || value.trim() === "" || value.trim() === "无";
}
