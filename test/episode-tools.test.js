// Checks for the topic list (npm run topics) and the new-episode setup (npm run new).
// The network is replaced by stand-ins (fakeFetch below, and a local server for the time limits),
// and episode folders are made in a temporary folder, so these run offline and touch nothing real.
// Run with: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fetchPaper, licenseFromAbsPage, licenseName, paperProblems, parseArxivEntry } from "../src/arxiv.js";
import { assertCanRender, describeEpisodes, episodeNumberProblem, listEpisodes, nextEpisodeNumber, readPublished } from "../src/episodes.js";
import { httpGet } from "../src/http.js";
import { authorsText, createEpisode, scriptSkeleton, shortName, writeEpisode } from "../src/new-episode.js";
import { parseScript } from "../src/parse-script.js";
import { readDailyPapers } from "../src/topics.js";

// ---- Stand-ins ----

const KANDINSKY_TITLE = `Kandinsky 6.0 Video: Foundation Models for
      Synchronized Video &amp; Audio Generation`;

/** An arXiv API answer with one entry, in the same shape as the real one. */
function arxivAnswer({ id = "2610.05608v2", title = KANDINSKY_TITLE, authors = ["Team Kandinsky", "Julia Agafonova"] } = {}) {
  const authorTags = authors.map((name) => `<author>\n      <name>${name}</name>\n    </author>`).join("\n    ");
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>https://arxiv.org/api/query-id</id>
  <entry>
    <id>http://arxiv.org/abs/${id}</id>
    <title>${title}</title>
    <published>2026-10-04T23:19:20Z</published>
    <arxiv:comment>Technical report. GitHub: https://github.com/kandinskylab/kandinsky-6</arxiv:comment>
    ${authorTags}
  </entry>
</feed>`;
}

/** An answer that names a paper but leaves out everything else. */
const ONLY_ID = "<feed><entry><id>http://arxiv.org/abs/2610.04198v1</id></entry></feed>";
const LICENSE_PAGE = '<a href="http://creativecommons.org/licenses/by-nc-sa/4.0/" title="Rights to this article">view license</a>';
const API = "https://export.arxiv.org/api/query";
const ABS = "https://arxiv.org/abs/";
const PDF = "https://arxiv.org/pdf/";

/** A stand-in for fetch: answers by the start of the URL, and remembers what was asked. */
function fakeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const prefix = Object.keys(routes).find((start) => url.startsWith(start));
    if (!prefix) throw new TypeError(`unexpected request: ${url}`);
    return routes[prefix]();
  };
  return { fetchImpl, calls };
}

const timesOut = () => Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError"));

const FIRST = { number: 1, folder: "2026-10-07-2610.05608", url: "https://www.bilibili.com/video/BV1PdpN6SEk7/", date: "2026-10-07" };

/** A temporary episodes/ folder with episode #1 published, removed after the test. */
function tempEpisodes(t, published = [FIRST]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dailypaper-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "published.json"), JSON.stringify(published));
  return dir;
}

function addFolder(dir, name, script = "原稿，不能被改动\n") {
  fs.mkdirSync(path.join(dir, name));
  if (script !== null) fs.writeFileSync(path.join(dir, name, "script.md"), script);
}

/** Every file and folder under `dir` with its content, to compare before and after. */
function snapshot(dir) {
  return fs
    .readdirSync(dir, { recursive: true })
    .sort()
    .map((name) => {
      const file = path.join(dir, name);
      return fs.statSync(file).isDirectory() ? `${name}/` : `${name}: ${fs.readFileSync(file, "utf8")}`;
    });
}

// ---- arXiv ----

test("读出 arXiv 接口返回的论文信息", () => {
  const paper = parseArxivEntry(arxivAnswer());
  assert.equal(paper.id, "2610.05608");
  assert.equal(paper.versionedId, "2610.05608v2");
  assert.equal(paper.title, "Kandinsky 6.0 Video: Foundation Models for Synchronized Video & Audio Generation");
  assert.deepEqual(paper.authors, ["Team Kandinsky", "Julia Agafonova"]);
  assert.equal(paper.published, "2026-10-04");
  assert.equal(paper.journalRef, "");
});

test("arXiv 没有这篇或返回错误时，读不出论文", () => {
  assert.equal(parseArxivEntry("<feed></feed>"), null);
  const error = "<feed><entry><id>http://arxiv.org/api/errors#incorrect_id_format_for_1234</id><title>Error</title></entry></feed>";
  assert.equal(parseArxivEntry(error), null);
});

test("arXiv 返回的必须是要的那篇论文；写了版本号的，版本也要一致", () => {
  const v1 = parseArxivEntry(arxivAnswer({ id: "2610.05608v1" }));
  assert.deepEqual(paperProblems("2610.05608", v1), []);
  assert.deepEqual(paperProblems("2610.05608v1", v1), []);
  assert.deepEqual(paperProblems("2610.05608v2", v1), ["要的是 2610.05608v2，返回的却是 2610.05608v1"]);
  assert.deepEqual(paperProblems("2610.04198", v1), ["要的是 2610.04198，返回的却是 2610.05608v1"]);
  const v10 = parseArxivEntry(arxivAnswer({ id: "2610.05608v10" }));
  assert.deepEqual(paperProblems("2610.05608v1", v10), ["要的是 2610.05608v1，返回的却是 2610.05608v10"]);
});

test("缺标题、作者或发布日期的答复不能用；备注和期刊信息可以没有", () => {
  assert.deepEqual(paperProblems("2610.04198", parseArxivEntry(ONLY_ID)), ["缺少标题、作者、发布日期"]);
  const blankAuthor = parseArxivEntry(arxivAnswer({ authors: ["Team Kandinsky", " "] }));
  assert.deepEqual(paperProblems("2610.05608", blankAuthor), ["缺少作者"]);
  const noJournal = parseArxivEntry(arxivAnswer());
  assert.equal(noJournal.journalRef, "");
  assert.deepEqual(paperProblems("2610.05608", noJournal), []);
});

test("fetchPaper：返回别的论文、信息不全、接口超时或出错时报错", async () => {
  const other = fakeFetch({ [API]: () => new Response(arxivAnswer({ id: "2610.05608v1" })) });
  await assert.rejects(fetchPaper("2610.04198v2", other), /要的是 2610\.04198v2，返回的却是 2610\.05608v1/);
  assert.equal(other.calls.length, 1);

  const incomplete = fakeFetch({ [API]: () => new Response(ONLY_ID) });
  await assert.rejects(fetchPaper("2610.04198", incomplete), /缺少标题、作者、发布日期/);
  await assert.rejects(fetchPaper("2610.04198", fakeFetch({ [API]: timesOut })), /arXiv 接口超过 30 秒没有回应/);
  const busy = fakeFetch({ [API]: () => new Response("busy", { status: 503 }) });
  await assert.rejects(fetchPaper("2610.04198", busy), /arXiv 接口返回 503/);
  const busyPage = fakeFetch({ [API]: () => new Response("<html>Rate exceeded.</html>") });
  await assert.rejects(fetchPaper("2610.04198", busyPage), /arXiv 接口的数据异常：返回的不是论文信息/);
  const none = fakeFetch({ [API]: () => new Response('<feed xmlns="http://www.w3.org/2005/Atom"></feed>') });
  await assert.rejects(fetchPaper("2610.99999", none), /arXiv 上找不到 2610\.99999/);
});

test("fetchPaper：许可证从摘要页查；摘要页超时只是查不到许可证", async () => {
  const found = await fetchPaper("2610.05608", fakeFetch({ [API]: () => new Response(arxivAnswer()), [ABS]: () => new Response(LICENSE_PAGE) }));
  assert.equal(found.license, "http://creativecommons.org/licenses/by-nc-sa/4.0/");
  const slow = await fetchPaper("2610.05608", fakeFetch({ [API]: () => new Response(arxivAnswer()), [ABS]: timesOut }));
  assert.equal(slow.license, null);
  assert.equal(slow.versionedId, "2610.05608v2");
});

test("请求有时间限制：服务器卡住时会放弃；出错和答复不是 JSON 时说清楚", async (t) => {
  const server = http.createServer((request, response) => {
    if (request.url === "/silent") return; // never answers
    if (request.url === "/busy") return response.writeHead(503).end();
    if (request.url === "/html") return response.end("<html>busy</html>");
    response.writeHead(200);
    response.write("part of the body"); // and never the rest
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const options = { what: "测试服务器", seconds: 0.2 };
  await assert.rejects(httpGet(`${base}/silent`, options), /测试服务器超过 0\.2 秒没有回应/);
  await assert.rejects(httpGet(`${base}/stalled`, options), /测试服务器超过 0\.2 秒没有回应/);
  await assert.rejects(httpGet(`${base}/busy`, options), /测试服务器返回 503/);
  await assert.rejects(httpGet(`${base}/html`, { ...options, as: "json" }), /测试服务器的数据异常：返回的不是 JSON/);
});

test("从摘要页找出许可证，并换成好读的名字", () => {
  assert.equal(licenseFromAbsPage(LICENSE_PAGE), "http://creativecommons.org/licenses/by-nc-sa/4.0/");
  assert.equal(licenseName("http://creativecommons.org/licenses/by-nc-sa/4.0/"), "CC BY-NC-SA 4.0");
  assert.equal(licenseName("http://arxiv.org/licenses/nonexclusive-distrib/1.0/"), "arXiv 默认许可（作者没有授权转载）");
  assert.equal(licenseName("http://creativecommons.org/publicdomain/zero/1.0/"), "CC0");
  assert.match(licenseName(null), /没查到/);
});

// ---- Hugging Face daily list ----

test("日榜按点赞数排序，数据不完整的条目跳过并计数", () => {
  const { papers, skipped } = readDailyPapers([
    { paper: { id: "2610.00001", title: "Low", upvotes: 3 } },
    { paper: { id: "2610.00002", title: "High", upvotes: 40 } },
    { title: "No paper" },
    null,
    { paper: { id: "2610.00003", title: "  ", upvotes: 5 } },
    { paper: { id: "not-arxiv", title: "Bad number", upvotes: 5 } },
    { paper: { id: "2610.00004", title: "No upvotes" } },
  ]);
  assert.deepEqual(papers.map((paper) => paper.id), ["2610.00002", "2610.00001"]);
  assert.equal(skipped, 5);
  assert.deepEqual(readDailyPapers([]), { papers: [], skipped: 0 });
});

test("日榜接口返回的不是论文列表，或一条能用的都没有时，报数据异常", () => {
  assert.throws(() => readDailyPapers({ error: "busy" }), /日榜接口的数据异常：返回的不是论文列表（\{"error":"busy"\}）/);
  assert.throws(() => readDailyPapers([null]), /日榜接口的数据异常：1 条都缺 arXiv 编号、标题或点赞数/);
  assert.throws(() => readDailyPapers(undefined), /日榜接口的数据异常/);
});

// ---- Episodes and the publishing record ----

test("只把真实的「日期-arXiv 编号」文件夹算作一期，分清制作中和已发布", (t) => {
  const dir = tempEpisodes(t);
  addFolder(dir, "2026-10-07-2610.05608");
  addFolder(dir, "2026-10-09-2610.04198", null);
  addFolder(dir, "example");
  addFolder(dir, "notes", null);
  fs.writeFileSync(path.join(dir, "2026-10-10-2610.07777"), "a file, not a folder");

  const episodes = listEpisodes(dir);
  assert.deepEqual(episodes.map((episode) => episode.name), ["2026-10-07-2610.05608", "2026-10-09-2610.04198"]);
  assert.equal(episodes[0].published.number, 1);
  assert.equal(episodes[1].published, null);
  assert.equal(describeEpisodes([episodes[0]]), "已发布 #1（episodes/2026-10-07-2610.05608）");
  assert.equal(describeEpisodes([episodes[1]]), "制作中（episodes/2026-10-09-2610.04198，还没有 script.md）");
});

test("同一篇论文有两个文件夹时都列出来；已发布的文件夹不在了也还算已发布", (t) => {
  const dir = tempEpisodes(t);
  addFolder(dir, "2026-10-08-2610.04198");
  addFolder(dir, "2026-10-09-2610.04198");

  const episodes = listEpisodes(dir);
  assert.deepEqual(
    episodes.map((episode) => [episode.arxivId, episode.published?.number ?? null]),
    [["2610.05608", 1], ["2610.04198", null], ["2610.04198", null]],
  );
});

test("发布记录：没有文件时为空，格式不对时报错，带 BOM 也能读", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dailypaper-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "published.json");
  assert.deepEqual(readPublished(dir), []);

  const cases = [
    ["{ not json", /不是有效的 JSON/],
    ['{"number":1}', /要是一个列表/],
    ['[{"number":0,"folder":"2026-10-07-2610.05608"}]', /第 1 项的 number 要是正整数/],
    ['[{"number":1,"folder":"example"}]', /第 1 项的 folder/],
    ['[{"number":1,"folder":"2026-10-07-2610.05608"},{"number":1,"folder":"2026-10-08-2610.04198"}]', /number 一样/],
    ['[{"number":1,"folder":"2026-10-07-2610.05608"},{"number":2,"folder":"2026-10-07-2610.05608"}]', /folder 一样/],
  ];
  for (const [content, message] of cases) {
    fs.writeFileSync(file, content);
    assert.throws(() => readPublished(dir), message, content);
  }
  fs.writeFileSync(file, `﻿${JSON.stringify([FIRST])}`);
  assert.deepEqual(readPublished(dir), [FIRST]);
});

test("期数按发布记录排，不按文件夹数；先发布的那期占号，其他制作中的要改号", () => {
  const published = [FIRST];
  assert.equal(nextEpisodeNumber([]), 1);
  assert.equal(nextEpisodeNumber(published), 2);

  const kandinsky = "【每日论文 #1】Kandinsky 6.0 Video｜画面和声音一起生成";
  assert.equal(episodeNumberProblem("2026-10-07-2610.05608", kandinsky, published), null);
  assert.equal(episodeNumberProblem("2026-10-09-2610.04198", "【每日论文 #2】ALoDLM｜看点", published), null);
  assert.equal(episodeNumberProblem("2026-10-09-2610.04198", "【每日论文 #1】ALoDLM｜看点", published),
    "#1 已经发布过了（episodes/2026-10-07-2610.05608），这一期发布时应该是 #2");
  assert.equal(episodeNumberProblem("2026-10-07-2610.05608", "【每日论文 #2】Kandinsky", published), "这一期发布时是 #1，标题写的是 #2");

  // Another draft went out first as #2, so this one becomes #3.
  const later = [...published, { number: 2, folder: "2026-10-08-2610.00002" }];
  assert.equal(episodeNumberProblem("2026-10-09-2610.04198", "【每日论文 #2】ALoDLM｜看点", later),
    "#2 已经发布过了（episodes/2026-10-08-2610.00002），这一期发布时应该是 #3");
  assert.equal(episodeNumberProblem("2026-10-09-2610.04198", "【每日论文 #7】ALoDLM｜看点", later), "标题写的是 #7，按发布记录下一期是 #3");
  assert.equal(episodeNumberProblem("example", "【每日论文 #9】示例", published), null);
});

test("T63 已发布的期默认不让重新生成，加 --force 才行", () => {
  const published = [FIRST];
  assert.throws(() => assertCanRender(FIRST.folder, published), /第 1 期已经发布.*加上 --force/);
  assert.doesNotThrow(() => assertCanRender(FIRST.folder, published, { force: true }));
  assert.doesNotThrow(() => assertCanRender("2026-10-09-2610.04198", published));
  assert.doesNotThrow(() => assertCanRender("example", published));
});

// ---- npm run new ----

const ALODLM = { id: "2610.04198v1", title: "ALoDLM: Something Long Enough", authors: ["A", "B", "C", "D"] };

test("开工：建好文件夹、稿件和 PDF，期数接着发布记录排", async (t) => {
  const dir = tempEpisodes(t);
  addFolder(dir, "2026-10-07-2610.05608");
  addFolder(dir, "2026-10-08-2610.00002");
  const pdf = Buffer.from("%PDF-1.7 a small stand-in");
  const network = fakeFetch({
    [API]: () => new Response(arxivAnswer(ALODLM)),
    [ABS]: () => new Response(LICENSE_PAGE),
    [PDF]: () => new Response(pdf),
  });

  const result = await createEpisode("2610.04198", { dir, date: "2026-10-09", fetchImpl: network.fetchImpl });
  const folder = path.join(dir, "2026-10-09-2610.04198");
  assert.equal(result.folder, folder);
  assert.equal(result.episodeNumber, 2);
  assert.deepEqual(result.drafts.map((episode) => episode.name), ["2026-10-08-2610.00002"]);
  assert.deepEqual(fs.readdirSync(folder).sort(), ["2610.04198v1.pdf", "diagrams", "figures", "script.md"]);
  assert.deepEqual(fs.readFileSync(path.join(folder, "2610.04198v1.pdf")), pdf);
  const script = fs.readFileSync(path.join(folder, "script.md"), "utf8");
  assert.match(script, /- 视频标题：【每日论文 #2】ALoDLM｜看点/);
  assert.match(script, /许可证：CC BY-NC-SA 4\.0/);
});

test("arXiv 返回别的论文时，不下载、不建文件夹，已有的稿件原样保留", async (t) => {
  // T50 R1: asking for 2610.04198v2 and getting episode #1's paper must not touch episode #1.
  const dir = tempEpisodes(t);
  addFolder(dir, "2026-10-07-2610.05608");
  const before = snapshot(dir);
  const network = fakeFetch({ [API]: () => new Response(arxivAnswer({ id: "2610.05608v1" })), [ABS]: () => new Response(LICENSE_PAGE) });

  await assert.rejects(
    createEpisode("2610.04198v2", { dir, date: "2026-10-07", fetchImpl: network.fetchImpl }),
    /要的是 2610\.04198v2，返回的却是 2610\.05608v1/,
  );
  assert.deepEqual(snapshot(dir), before);
  assert.equal(network.calls.length, 1);
});

test("论文信息不全、PDF 下载失败或超时时，不建文件夹", async (t) => {
  const dir = tempEpisodes(t);
  addFolder(dir, "2026-10-07-2610.05608");
  const before = snapshot(dir);
  const options = { dir, date: "2026-10-09" };

  const incomplete = fakeFetch({ [API]: () => new Response(ONLY_ID) });
  await assert.rejects(createEpisode("2610.04198", { ...options, fetchImpl: incomplete.fetchImpl }), /缺少标题、作者、发布日期/);
  assert.equal(incomplete.calls.length, 1);

  const answers = { [API]: () => new Response(arxivAnswer(ALODLM)), [ABS]: () => new Response(LICENSE_PAGE) };
  const slowPdf = fakeFetch({ ...answers, [PDF]: timesOut });
  await assert.rejects(createEpisode("2610.04198", { ...options, fetchImpl: slowPdf.fetchImpl }), /arXiv 的 PDF 文件超过 300 秒没有回应/);
  const notPdf = fakeFetch({ ...answers, [PDF]: () => new Response("<html>Just a moment...</html>") });
  await assert.rejects(createEpisode("2610.04198", { ...options, fetchImpl: notPdf.fetchImpl }), /不是 PDF/);
  assert.deepEqual(snapshot(dir), before);
});

test("已发布或已开工的论文，联网之前就拒绝，并说清楚是哪种", async (t) => {
  const dir = tempEpisodes(t);
  addFolder(dir, "2026-10-07-2610.05608");
  addFolder(dir, "2026-10-08-2610.04198");
  const network = fakeFetch({});
  const options = { dir, date: "2026-10-09", fetchImpl: network.fetchImpl };

  await assert.rejects(createEpisode("2610.05608v1", options), /这篇已经发布过了：已发布 #1（episodes\/2026-10-07-2610\.05608）/);
  await assert.rejects(createEpisode("2610.04198", options), /这篇已经开工了：制作中（episodes\/2026-10-08-2610\.04198）/);
  addFolder(dir, "2026-10-09-2610.04198");
  await assert.rejects(createEpisode("2610.04198", options), /这篇有 2 个文件夹/);
  assert.equal(network.calls.length, 0);
});

test("要建的文件夹已经存在时不写入（比如另一个窗口刚建好），里面的文件原样保留", async (t) => {
  const dir = tempEpisodes(t);
  const folder = path.join(dir, "2026-10-09-2610.04198");
  const network = fakeFetch({
    [API]: () => {
      addFolder(dir, "2026-10-09-2610.04198", "另一个窗口刚写的稿\n"); // made while arXiv was answering
      return new Response(arxivAnswer(ALODLM));
    },
    [ABS]: () => new Response(LICENSE_PAGE),
  });
  await assert.rejects(
    createEpisode("2610.04198", { dir, date: "2026-10-09", pdf: false, fetchImpl: network.fetchImpl }),
    /episodes\/2026-10-09-2610\.04198 已经存在，没有改动它/,
  );
  assert.deepEqual(fs.readdirSync(folder), ["script.md"]);
  assert.equal(fs.readFileSync(path.join(folder, "script.md"), "utf8"), "另一个窗口刚写的稿\n");
});

test("写到一半出错时，把这次刚建的文件夹收回，不留半成品", (t) => {
  const dir = tempEpisodes(t);
  const folder = path.join(dir, "2026-10-09-2610.04198");
  assert.throws(() => writeEpisode(folder, { "script.md": "骨架", "no-such-folder/x.pdf": "%PDF-" }), /ENOENT/);
  assert.equal(fs.existsSync(folder), false);
});

test("论文简称取冒号前面的部分", () => {
  assert.equal(shortName("Kandinsky 6.0 Video: Foundation Models for Synchronized Video and Audio Generation"), "Kandinsky 6.0 Video");
  assert.equal(shortName("Attention Is All You Need"), "");
  assert.equal(shortName("A Very Long Name That Goes On And On Forever: Subtitle"), "");
});

test("作者多的时候写成「第一作者 等 N 人」", () => {
  assert.equal(authorsText(["A", "B"]), "A、B");
  assert.equal(authorsText(["A", "B", "C", "D"]), "A 等 4 人");
});

test("新一期稿件的开头填好了论文信息，标题按系列格式", () => {
  const paper = { ...parseArxivEntry(arxivAnswer()), license: "http://creativecommons.org/licenses/by/4.0/" };
  const script = parseScript(scriptSkeleton({ paper, episodeNumber: 2, date: "2026-10-08" }));
  const header = Object.fromEntries(script.headerFields.map((field) => [field.key, field.value]));
  assert.equal(header["视频标题"], "【每日论文 #2】Kandinsky 6.0 Video｜看点");
  assert.equal(header["arXiv"], "2610.05608v2");
  assert.equal(header["链接"], "https://arxiv.org/abs/2610.05608v2");
  assert.equal(header["作者"], "Team Kandinsky、Julia Agafonova");
  assert.equal(header["状态"], "预印本");
});
