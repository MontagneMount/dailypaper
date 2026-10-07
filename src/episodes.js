// The episodes: folders under episodes/ named <date>-<arXiv number> (e.g. 2026-10-07-2610.05608),
// and episodes/published.json, the record of what has been published. A folder is an episode in
// the making until it is in that record. The number in a title follows the publishing order kept
// there, not the number of folders.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const EPISODES_DIR = fileURLToPath(new URL("../episodes/", import.meta.url));
const EPISODE_FOLDER = /^(\d{4}-\d{2}-\d{2})-(\d{4}\.\d{4,5})$/;
const TITLE_NUMBER = /^【每日论文 #(\d+)】/;

/**
 * The published episodes from episodes/published.json, e.g.
 * [{ "number": 1, "folder": "2026-10-07-2610.05608", "title": "…", "url": "https://www.bilibili.com/video/…", "date": "2026-10-07" }]
 * Claude adds an entry when the user sends the link of a new video.
 */
export function readPublished(dir = EPISODES_DIR) {
  const file = path.join(dir, "published.json");
  if (!fs.existsSync(file)) return [];
  let list;
  try {
    // Notepad and PowerShell may save the file with a byte order mark, which JSON.parse refuses.
    list = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
  } catch (error) {
    throw new Error(`episodes/published.json 不是有效的 JSON：${error.message}`);
  }
  const problem = publishedProblem(list);
  if (problem) throw new Error(`episodes/published.json 的格式不对：${problem}`);
  return list;
}

function publishedProblem(list) {
  if (!Array.isArray(list)) return "要是一个列表";
  for (const [index, item] of list.entries()) {
    if (!Number.isInteger(item?.number) || item.number < 1) return `第 ${index + 1} 项的 number 要是正整数`;
    if (typeof item.folder !== "string" || !EPISODE_FOLDER.test(item.folder)) {
      return `第 ${index + 1} 项的 folder 要写本期文件夹的名字，比如 2026-10-07-2610.05608`;
    }
  }
  const numbers = list.map((item) => item.number);
  if (new Set(numbers).size < numbers.length) return "有两项的 number 一样";
  const folders = list.map((item) => item.folder);
  if (new Set(folders).size < folders.length) return "有两项的 folder 一样";
  return null;
}

/**
 * Every episode as { name, date, arxivId, hasScript, published }, oldest first; `published` is the
 * entry in published.json, or null while the episode is in the making. Only real folders named
 * <date>-<arXiv number> count (not episodes/example, not files), plus published episodes whose
 * folder is gone. A paper started twice shows up twice.
 */
export function listEpisodes(dir = EPISODES_DIR, published = readPublished(dir)) {
  const folders = fs.existsSync(dir)
    ? fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    : [];
  const names = new Set([...folders, ...published.map((item) => item.folder)]);
  return [...names]
    .map((name) => name.match(EPISODE_FOLDER))
    .filter(Boolean)
    .map(([name, date, arxivId]) => ({
      name,
      date,
      arxivId,
      hasScript: fs.existsSync(path.join(dir, name, "script.md")),
      published: published.find((item) => item.folder === name) ?? null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** "已发布 #1（episodes/…）" or "制作中（episodes/…）" for the folders of one paper. */
export function describeEpisodes(episodes) {
  return episodes
    .map((episode) =>
      episode.published
        ? `已发布 #${episode.published.number}（episodes/${episode.name}）`
        : `制作中（episodes/${episode.name}${episode.hasScript ? "" : "，还没有 script.md"}）`,
    )
    .join("；");
}

/** The number the next published episode gets. */
export function nextEpisodeNumber(published) {
  return Math.max(0, ...published.map((item) => item.number)) + 1;
}

/**
 * What is wrong with the number in an episode's title, or null when it fits the publishing order.
 * Episodes in the making all take the next number; whichever is published first keeps it, and the
 * others are told to move up.
 */
export function episodeNumberProblem(folderName, title, published) {
  const titleNumber = Number(title?.match(TITLE_NUMBER)?.[1]);
  if (!EPISODE_FOLDER.test(folderName) || !titleNumber) return null;

  const entry = published.find((item) => item.folder === folderName);
  if (entry) return entry.number === titleNumber ? null : `这一期发布时是 #${entry.number}，标题写的是 #${titleNumber}`;

  const next = nextEpisodeNumber(published);
  if (titleNumber === next) return null;
  const taken = published.find((item) => item.number === titleNumber);
  return taken
    ? `#${titleNumber} 已经发布过了（episodes/${taken.folder}），这一期发布时应该是 #${next}`
    : `标题写的是 #${titleNumber}，按发布记录下一期是 #${next}`;
}

/** Today's local date as YYYY-MM-DD, shifted by a number of days. */
export function localDate(shiftDays = 0) {
  const date = new Date();
  date.setDate(date.getDate() + shiftDays);
  const two = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}
