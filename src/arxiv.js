// Paper information from arXiv: the API gives the title, authors and version, and the abstract
// page gives the license. An answer is checked before a new episode uses it: it must be the paper
// asked for, with a title, authors and a date.

import { httpGet } from "./http.js";

export const ARXIV_ID = /^(\d{4}\.\d{4,5})(v\d+)?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * What a new episode needs to know. `id` may carry a version ("2610.05608v1"); without one, the latest.
 * Throws when arXiv answers with another paper, or leaves out something the episode needs.
 */
export async function fetchPaper(id, { fetchImpl } = {}) {
  const xml = await httpGet(`https://export.arxiv.org/api/query?id_list=${id}`, { what: "arXiv 接口", seconds: 30, fetchImpl });
  // A busy page instead of the usual feed would otherwise read as "no such paper".
  if (!/<feed[\s>]/.test(xml)) throw new Error("arXiv 接口的数据异常：返回的不是论文信息，过一会儿再试");
  const paper = parseArxivEntry(xml);
  if (!paper) throw new Error(`arXiv 上找不到 ${id}`);
  const problems = paperProblems(id, paper);
  if (problems.length > 0) throw new Error(`arXiv 返回的论文信息不能用：${problems.join("；")}`);
  // The license is shown for reference only, so a slow or broken abstract page does not stop anything.
  paper.license = await httpGet(`https://arxiv.org/abs/${paper.versionedId}`, { what: "arXiv 摘要页", seconds: 15, fetchImpl })
    .then(licenseFromAbsPage)
    .catch(() => null);
  return paper;
}

/** The PDF as bytes; checked to really be a PDF. */
export async function fetchPdf(versionedId, { fetchImpl } = {}) {
  const bytes = await httpGet(`https://arxiv.org/pdf/${versionedId}`, { what: "arXiv 的 PDF 文件", seconds: 300, as: "bytes", fetchImpl });
  if (bytes.subarray(0, 5).toString("latin1") !== "%PDF-") throw new Error("下载到的文件不是 PDF");
  return bytes;
}

/** The first <entry> of an arXiv API response, or null when there is none (or it is an error). */
export function parseArxivEntry(xml) {
  const entry = xml.match(/<entry>([\s\S]*?)<\/entry>/)?.[1];
  if (!entry) return null;
  const text = (tag) => decodeXml(entry.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`))?.[1] ?? "");
  const versioned = text("id").match(/(\d{4}\.\d{4,5})(v\d+)$/);
  if (!versioned) return null;
  return {
    id: versioned[1],
    versionedId: versioned[1] + versioned[2],
    title: text("title"),
    authors: [...entry.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/g)].map((match) => decodeXml(match[1])),
    published: text("published").slice(0, 10),
    comment: text("arxiv:comment"),
    journalRef: text("arxiv:journal_ref"),
  };
}

/**
 * What makes a parsed answer unusable for `requestedId`, as a list (empty when it is fine):
 * another paper or version than the one asked for, or no title, authors or date.
 * The comment, journal reference and license may be missing.
 */
export function paperProblems(requestedId, paper) {
  const [, number, version] = requestedId.match(ARXIV_ID) ?? [];
  const problems = [];
  if (paper.id !== number || (version && paper.versionedId !== number + version)) {
    problems.push(`要的是 ${requestedId}，返回的却是 ${paper.versionedId}`);
  }
  const missing = [];
  if (!paper.title) missing.push("标题");
  if (paper.authors.length === 0 || paper.authors.some((name) => !name)) missing.push("作者");
  if (!DATE.test(paper.published)) missing.push("发布日期");
  if (missing.length > 0) problems.push(`缺少${missing.join("、")}`);
  return problems;
}

/** The license link on an arXiv abstract page, e.g. http://creativecommons.org/licenses/by/4.0/ */
export function licenseFromAbsPage(html) {
  const link = html.match(/href="((?:https?:)?\/\/(?:creativecommons\.org\/(?:licenses|publicdomain)|(?:www\.)?arxiv\.org\/licenses)\/[^"]+)"/);
  return link?.[1] ?? null;
}

/** "http://creativecommons.org/licenses/by-nc-sa/4.0/" -> "CC BY-NC-SA 4.0" */
export function licenseName(url) {
  if (!url) return "没查到，请到 arXiv 页面确认";
  const cc = url.match(/creativecommons\.org\/licenses\/([a-z-]+)\/([\d.]+)/);
  if (cc) return `CC ${cc[1].toUpperCase()} ${cc[2]}`;
  if (/publicdomain\/zero/.test(url)) return "CC0";
  if (/arxiv\.org\/licenses\/nonexclusive-distrib/.test(url)) return "arXiv 默认许可（作者没有授权转载）";
  return url;
}

function decodeXml(text) {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}
