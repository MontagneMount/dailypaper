// Start a new episode from an arXiv number (README step ②).
//   npm run new -- 2610.05608            the latest version
//   npm run new -- 2610.05608v1          a given version
//   npm run new -- 2610.05608 --no-pdf   without downloading the PDF
// Creates episodes/<today>-<number>/ with the paper PDF and a script.md whose header already holds
// the paper's information from arXiv. ChatGPT writes the rest (docs/script-format.md).

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ARXIV_ID, fetchPaper, fetchPdf, licenseName } from "./arxiv.js";
import { describeEpisodes, EPISODES_DIR, listEpisodes, localDate, nextEpisodeNumber, readPublished } from "./episodes.js";

const USAGE = `用法：
  npm run new -- <arXiv 编号>          比如 2610.05608，不写版本号就用最新版
  npm run new -- <arXiv 编号> --no-pdf  不下载 PDF`;

async function main() {
  const args = process.argv.slice(2);
  const id = args.find((arg) => !arg.startsWith("--"));
  const unknown = args.filter((arg) => arg.startsWith("--") && arg !== "--no-pdf");
  if (!id || !ARXIV_ID.test(id) || unknown.length > 0) {
    console.log(USAGE);
    process.exitCode = 1;
    return;
  }

  const withPdf = !args.includes("--no-pdf");
  const { folder, paper, pdf, episodeNumber, drafts } = await createEpisode(id, { pdf: withPdf, log: console.log });

  console.log(`\n已建好：episodes/${path.basename(folder)}`);
  console.log(`  论文：${paper.title}（${paper.versionedId}）`);
  console.log(`  许可证：${licenseName(paper.license)}`);
  console.log(`  PDF：${pdf ? `${paper.versionedId}.pdf（${(pdf.length / 1024 / 1024).toFixed(1)} MB）` : "没有下载"}`);
  console.log("  稿件：script.md，「开头」里的论文信息已经填好");
  console.log(`  期数：${numberNote(episodeNumber, drafts)}`);
  if (paper.journalRef || /accepted|conference|journal/i.test(paper.comment)) {
    console.log(`⚠️  arXiv 上写着「${paper.journalRef || paper.comment}」，可能已被接收，写稿时核对「状态」`);
  }
  console.log("\n下一步：交给 ChatGPT 按 docs/script-format.md 写完 script.md");
}

/**
 * Creates episodes/<date>-<number>/ for an arXiv paper and returns what was made. Nothing is written
 * until arXiv has answered with the paper asked for (and the PDF is in), and a folder that already
 * exists is never written into. `log` gets progress messages.
 */
export async function createEpisode(id, { pdf = true, dir = EPISODES_DIR, date = localDate(), fetchImpl, log = () => {} } = {}) {
  const number = id.match(ARXIV_ID)?.[1];
  if (!number) throw new Error(`「${id}」不是 arXiv 编号，要写成 2610.05608 或 2610.05608v1`);
  const published = readPublished(dir);
  const episodes = listEpisodes(dir, published);
  const started = episodes.filter((episode) => episode.arxivId === number);
  if (started.length > 0) throw new Error(alreadyStarted(started));

  log(`查询 arXiv：${id}`);
  const paper = await fetchPaper(id, { fetchImpl });
  if (pdf) log(`下载 PDF：${paper.versionedId}`);
  const pdfBytes = pdf ? await fetchPdf(paper.versionedId, { fetchImpl }) : null;

  const episodeNumber = nextEpisodeNumber(published);
  const folder = path.join(dir, `${date}-${paper.id}`);
  const files = { "script.md": scriptSkeleton({ paper, episodeNumber, date }) };
  if (pdfBytes) files[`${paper.versionedId}.pdf`] = pdfBytes;
  writeEpisode(folder, files);
  return { folder, paper, pdf: pdfBytes, episodeNumber, drafts: episodes.filter((episode) => !episode.published) };
}

function alreadyStarted(episodes) {
  const where = describeEpisodes(episodes);
  if (episodes.length > 1) return `这篇有 ${episodes.length} 个文件夹：${where}。先确认留哪一个，把多的移走`;
  if (episodes[0].published) return `这篇已经发布过了：${where}`;
  return `这篇已经开工了：${where}。接着在这个文件夹里做；要从头再来，先把它移走`;
}

/** Makes the episode folder with figures/, diagrams/ and the given files. Refuses a folder that already exists. */
export function writeEpisode(folder, files) {
  try {
    fs.mkdirSync(folder);
  } catch (error) {
    if (error.code === "EEXIST") throw new Error(`episodes/${path.basename(folder)} 已经存在，没有改动它`);
    throw error;
  }
  try {
    fs.mkdirSync(path.join(folder, "figures"));
    fs.mkdirSync(path.join(folder, "diagrams"));
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(folder, name), content, { flag: "wx" });
    }
  } catch (error) {
    // This run made the folder a moment ago, so removing it again leaves nothing half-made.
    fs.rmSync(folder, { recursive: true, force: true });
    throw error;
  }
}

/** The number goes by episodes/published.json; with other episodes in the making it is provisional. */
function numberNote(episodeNumber, drafts) {
  if (drafts.length === 0) return `#${episodeNumber}（按发布记录 episodes/published.json 往下排）`;
  const others = drafts.map((episode) => `episodes/${episode.name}`).join("、");
  return `#${episodeNumber} 是暂定的：还有 ${drafts.length} 期在制作中（${others}），哪一期先发布哪一期用 #${episodeNumber}，另一期 npm run check 时会提醒改号`;
}

/** The script's header filled in from arXiv; the parts that need the paper read are left empty. */
export function scriptSkeleton({ paper, episodeNumber, date }) {
  const short = shortName(paper.title);
  const notes = [`许可证：${licenseName(paper.license)}`];
  if (paper.comment) notes.push(`arXiv 备注：${paper.comment}`);
  if (paper.journalRef) notes.push(`arXiv 期刊信息：${paper.journalRef}`);
  return [
    `# ${short || paper.title}`,
    "",
    `> 由 \`npm run new\` 在 ${date} 生成。「开头」里的论文信息取自 arXiv（${paper.versionedId}，${paper.published} 发布），其余部分由 ChatGPT 按 docs/script-format.md 写完。`,
    `> ${notes.join("；")}`,
    "",
    "## 开头",
    "",
    `- 视频标题：【每日论文 #${episodeNumber}】${short || "论文简称"}｜看点`,
    "- 封面大字：",
    "- 简介：",
    "- 标签：",
    "- 领域：",
    `- 论文标题：${paper.title}`,
    `- 作者：${authorsText(paper.authors)}`,
    "- 机构：",
    `- arXiv：${paper.versionedId}`,
    "- 状态：预印本",
    "- 会议或期刊：无",
    `- 链接：https://arxiv.org/abs/${paper.versionedId}`,
    "",
    "## 正文",
    "",
    "## 原文核对表",
    "",
    "| 稿件位置 | 关键数字或结论 | 论文版本 | 原文位置（章节、页码或图表） | 实验条件 | 局限 / 待确认事项 |",
    "|---|---|---|---|---|---|",
    "",
    "## 发音替换表",
    "",
    "| 原文 | 读法 |",
    "|---|---|",
    "",
  ].join("\n");
}

/** The short name before the colon, as the title format wants it: "Kandinsky 6.0 Video: ..." -> "Kandinsky 6.0 Video". */
export function shortName(title) {
  const head = title.split(/:\s|：/)[0].trim();
  return head !== title && [...head].length <= 30 ? head : "";
}

/** A few authors in full, many as "first author 等 N 人". */
export function authorsText(authors) {
  return authors.length <= 3 ? authors.join("、") : `${authors[0]} 等 ${authors.length} 人`;
}

// Run only when started from the command line, so the tests can import the helpers above.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`出错了：${error.message}`);
    process.exitCode = 1;
  });
}
