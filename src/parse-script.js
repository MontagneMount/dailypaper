// Parse an explainer script written in the format of docs/script-format.md (v1.1) into plain data.
// This file only reads the text; all checks happen in layouts.js.

const PAGE_HEADING = /^###\s*第\s*(\d+)\s*页\s*[·・]\s*(.+?)\s*(?:[（(]\s*预估时长\s*[：:]\s*(\d+)\s*秒\s*[）)])?\s*$/;
const BLOCK_MARKER = /^\*\*\s*(画面|旁白)\s*\*\*\s*[：:]?\s*$/;
const FIELD_LINE = /^[-*]\s*([^：:]+?)\s*[：:]\s*(.*)$/;
const TABLE_ROW = /^\|(.+)\|\s*$/;

/**
 * @returns {{
 *   headerFields: Array<{ key: string, value: string, lineNo: number }>,
 *   pages: Array<{ number: number, topic: string, estimatedSeconds: number | null, lineNo: number,
 *                  fields: Array<{ key: string, value: string, lineNo: number }>, narration: string[] }>,
 *   pronunciations: Array<{ original: string, reading: string, lineNo: number }>,
 *   sourceRows: Array<{ cells: string[], lineNo: number }>
 * }}
 */
export function parseScript(markdown) {
  const headerFields = [];
  const pages = [];
  const pronunciations = [];
  const sourceRows = [];

  let section = null; // "header" | "pronunciation" | "sources" | "other"
  let page = null;
  let block = null; // "visual" | "narration"

  markdown.split(/\r?\n/).forEach((rawLine, index) => {
    const line = rawLine.trim();
    const lineNo = index + 1;

    const pageMatch = line.match(PAGE_HEADING);
    if (pageMatch) {
      page = {
        number: Number(pageMatch[1]),
        topic: pageMatch[2].trim(),
        estimatedSeconds: pageMatch[3] ? Number(pageMatch[3]) : null,
        lineNo,
        fields: [],
        narration: [],
      };
      pages.push(page);
      section = null;
      block = null;
      return;
    }

    // Any other heading ends the current page.
    if (/^#{1,6}\s/.test(line)) {
      const title = line.replace(/^#{1,6}\s*/, "");
      if (title.startsWith("开头")) section = "header";
      else if (title.startsWith("发音替换表")) section = "pronunciation";
      else if (title.startsWith("原文核对表")) section = "sources";
      else section = "other";
      page = null;
      block = null;
      return;
    }

    if (page) {
      const marker = line.match(BLOCK_MARKER);
      if (marker) {
        block = marker[1] === "画面" ? "visual" : "narration";
        return;
      }
      if (block === "visual") {
        const field = line.match(FIELD_LINE);
        if (field) page.fields.push({ key: field[1].trim(), value: field[2].trim(), lineNo });
      } else if (block === "narration" && line) {
        page.narration.push(line.replace(/^([-*>]\s+)/, ""));
      }
      return;
    }

    if (section === "header") {
      const field = line.match(FIELD_LINE);
      if (field) headerFields.push({ key: field[1].trim(), value: field[2].trim(), lineNo });
    } else if (section === "pronunciation" || section === "sources") {
      const cells = readTableRow(line);
      if (!cells) return;
      if (section === "pronunciation" && cells[0] !== "原文" && cells[0] && cells[1]) {
        pronunciations.push({ original: cells[0], reading: cells[1], lineNo });
      }
      if (section === "sources" && cells[0] !== "稿件位置") {
        sourceRows.push({ cells, lineNo });
      }
    }
  });

  return { headerFields, pages, pronunciations, sourceRows };
}

/** "| a | b |" -> ["a", "b"]; returns null for non-table lines and divider rows like "|---|---|". */
function readTableRow(line) {
  const row = line.match(TABLE_ROW);
  if (!row) return null;
  const cells = row[1].split("|").map((cell) => cell.trim());
  const isDivider = cells.every((cell) => /^:?-+:?$/.test(cell));
  return isDivider ? null : cells;
}

/** Split a field value like "标题 | 说明" into its parts. */
export function splitParts(value) {
  return value.split(/\s*[|｜]\s*/).map((part) => part.trim());
}
