// List candidate papers from the Hugging Face daily papers, most upvoted first (README step ①).
//   npm run topics                        today's list; while it is still empty, the days before
//   npm run topics -- --date 2026-10-06   a given day
//   npm run topics -- --limit 20          how many to show (default 15)

import { pathToFileURL } from "node:url";
import { describeEpisodes, listEpisodes, localDate } from "./episodes.js";
import { httpGet } from "./http.js";

const DEFAULT_LIMIT = 15;
const LOOK_BACK_DAYS = 3;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ARXIV_NUMBER = /^\d{4}\.\d{4,5}$/;

const USAGE = `用法：
  npm run topics
  npm run topics -- --date 2026-10-06 --limit 20`;

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options) {
    console.log(USAGE);
    process.exitCode = 1;
    return;
  }

  // Today's list fills up during the day, so look back a few days while it is empty.
  let date = options.date ?? localDate();
  let list = await fetchDailyPapers(date);
  for (let days = 1; !options.date && list.papers.length === 0 && days <= LOOK_BACK_DAYS; days++) {
    date = localDate(-days);
    list = await fetchDailyPapers(date);
  }
  if (list.papers.length === 0) {
    console.log(`Hugging Face 日榜 ${date} 还没有论文`);
    return;
  }

  const episodes = listEpisodes();
  const ranked = list.papers.slice(0, options.limit);
  console.log(`Hugging Face 日榜 ${date}：共 ${list.papers.length} 篇，按点赞数排序，前 ${ranked.length} 篇\n`);
  ranked.forEach((paper, index) => {
    const started = episodes.filter((episode) => episode.arxivId === paper.id);
    const mark = started.length > 0 ? `  ← ${describeEpisodes(started)}` : "";
    console.log(`${String(index + 1).padStart(2)}. ${String(paper.upvotes).padStart(4)} 赞  ${paper.id}  ${shorten(paper.title, 70)}${mark}`);
  });
  if (list.skipped > 0) console.log(`\n⚠️  另有 ${list.skipped} 条数据不完整（缺 arXiv 编号、标题或点赞数），没有列出`);
  console.log(`\n看详情：https://huggingface.co/papers/date/${date}`);
  console.log("选好了就运行：npm run new -- <arXiv 编号>");
}

function parseArgs(args) {
  const options = { date: null, limit: DEFAULT_LIMIT };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--date") options.date = args[++i];
    else if (args[i] === "--limit") options.limit = Number(args[++i]);
    else return null;
  }
  const valid = (options.date === null || DATE.test(options.date)) && Number.isInteger(options.limit) && options.limit > 0;
  return valid ? options : null;
}

async function fetchDailyPapers(date) {
  const url = `https://huggingface.co/api/daily_papers?date=${date}`;
  return readDailyPapers(await httpGet(url, { what: "Hugging Face 日榜接口", seconds: 30, as: "json" }));
}

/**
 * The usable papers of a daily list as { id, title, upvotes }, most upvoted first, and how many
 * entries were skipped for lacking an arXiv number, a title or the upvotes. Throws when the answer
 * is not a list, or when none of its entries can be used.
 */
export function readDailyPapers(data) {
  if (!Array.isArray(data)) {
    const answer = String(JSON.stringify(data)).slice(0, 80);
    throw new Error(`Hugging Face 日榜接口的数据异常：返回的不是论文列表（${answer}），过一会儿再试`);
  }
  const papers = data.map(toCandidate).filter(Boolean).sort((a, b) => b.upvotes - a.upvotes);
  if (data.length > 0 && papers.length === 0) {
    throw new Error(`Hugging Face 日榜接口的数据异常：${data.length} 条都缺 arXiv 编号、标题或点赞数，过一会儿再试`);
  }
  return { papers, skipped: data.length - papers.length };
}

function toCandidate(item) {
  const paper = item?.paper;
  const title = typeof paper?.title === "string" ? paper.title.replace(/\s+/g, " ").trim() : "";
  const usable =
    typeof paper?.id === "string" && ARXIV_NUMBER.test(paper.id) && title !== "" && Number.isInteger(paper.upvotes) && paper.upvotes >= 0;
  return usable ? { id: paper.id, title, upvotes: paper.upvotes } : null;
}

function shorten(text, length) {
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

// Run only when started from the command line, so the tests can import the helpers above.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`出错了：${error.message}`);
    process.exitCode = 1;
  });
}
