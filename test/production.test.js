import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { normalizePaper, parseArgs, agentCommand, decodeClaude, acquireLock, ProductionRunner, readJob, claudeRouteProblems, describeClaudeAuth, doctor } from "../src/production.js";
import { validateResult, buildPrompt } from "../src/production-prompts.js";
import { safePath, fingerprint, inputFingerprint, protectedFingerprint, previewPageHashes, GateError, validatePreviewRecord, inspectDraft, inspectPreview } from "../src/production-gates.js";
import { runProcess, resolveAgent } from "../src/production-process.js";
import { writeEpisode } from "../src/new-episode.js";

const PAPER = { id: "2610.99999", versionedId: "2610.99999v1", title: "Example Paper", authors: ["Example Author"], published: "2026-10-10", license: "http://creativecommons.org/licenses/by/4.0/" };
const pass = (evidence = {}) => ({ status: "pass", summary: "本阶段通过", findings: [], notes: [], evidence: { source_checked: true, pages: [1, 2], images: [], files: [], ...evidence } });
const changes = (message) => ({ ...pass(), status: "changes_requested", summary: "需要返修", findings: [message] });

function temp(t) {
  // The Windows AppContainer temp volume denies rename. Test atomic state writes on the same
  // writable workspace volume as real jobs, in an ignored, owned fixture folder.
  const base = fileURLToPath(new URL("../.production/tests/", import.meta.url));
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, "dp-production-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const dir of ["src", "docs", "templates", "episodes"]) fs.mkdirSync(path.join(root, dir));
  fs.writeFileSync(path.join(root, "src", "existing.js"), "// protected\n");
  fs.writeFileSync(path.join(root, "WORKLOG.md"), "# WORKLOG\n\n## 当前状态\n\n- 旧状态保留\n\n## 待办交接\n\n| 编号 | 任务 | 交给 | 提出者 | 状态 |\n|---|---|---|---|---|\n| T99 | 原任务 | 用户 | 用户 | 进行中 |\n\n## 记录\n\n### 旧记录\n原样保留\n");
  fs.writeFileSync(path.join(root, "episodes", "published.json"), "[]");
  return root;
}

test("论文链接锁定版本，只接收明确的 arXiv 链接，不接受可执行文本", () => {
  for (const value of ["2610.07967v1", "https://arxiv.org/abs/2610.07967v1", "https://arxiv.org/pdf/2610.07967v1.pdf", "https://arxiv.org/html/2610.07967v1?x=1#s1"]) assert.equal(normalizePaper(value), "2610.07967v1");
  for (const value of ["https://arxiv.org.evil.org/abs/2610.07967v1", "https://user:pass@arxiv.org/abs/2610.07967", "https://arxiv.org:9999/abs/2610.07967", "2610.07967;whoami", "../../x", "2610.07967v0", "https://arxiv.org/list/recent"]) assert.throws(() => normalizePaper(value));
});

test("参数检查：无效预算/重复/缺值拒绝，恢复要显式给参数", () => {
  assert.equal(parseArgs(["2610.07967v1", "--dry-run"]).dryRun, true);
  assert.equal(parseArgs(["resume", "task", "--max-calls", "150", "--feedback", "同意继续"]).options.maxCalls, 150);
  for (const args of [["2610.07967", "--minutes", "NaN"], ["2610.07967", "--max-revisions", "-1"], ["2610.07967", "--minutes"], ["2610.07967", "--minutes", "5", "--minutes", "6"], ["doctor", "--dry-run"], ["2610.07967", "--refresh-inputs"], ["status", "a", "b"]]) assert.throws(() => parseArgs(args));
});

test("CLI参数不拼shell，审稿只读、图片实际作为输入、Claude不绕过权限", () => {
  const args = agentCommand("codex", "visual_review", { schemaFile: "D:/a b/schema.json", resultFile: "D:/a b/result.json", images: ["D:/a b/p01.png", "D:/a b/p02.png"] });
  assert.deepEqual(args.slice(args.indexOf("--sandbox") + 1, args.indexOf("--sandbox") + 2), ["read-only"]);
  assert.equal(args.filter((v) => v === "--image").length, 2);
  assert.ok(args.includes("D:/a b/p01.png")); assert.equal(args.at(-1), "D:/a b/p02.png");
  assert.ok(!args.includes("-")); assert.ok(!args.includes("--json"));
  const withoutImages = agentCommand("codex", "draft", { schemaFile: "schema", resultFile: "result" });
  assert.equal(withoutImages.at(-1), "result"); assert.ok(!withoutImages.includes("-"));
  const claude = agentCommand("claude", "assets", { schemaFile: "", resultFile: "" });
  assert.ok(claude.includes("dontAsk")); assert.ok(claude.includes("Bash(git *)"));
  assert.ok(!claude.join(" ").includes("dangerously"));
});

test("失败的Claude返回和不完整证据不能假报通过", () => {
  assert.deepEqual(decodeClaude(JSON.stringify({ subtype: "success", structured_output: pass() })), pass());
  assert.throws(() => decodeClaude(JSON.stringify({ is_error: true, result: "Login required" })));
  assert.throws(() => decodeClaude(JSON.stringify({ subtype: "success", result: "done" })));
  assert.throws(() => validateResult({ ...pass(), findings: ["仍有问题"] }));
  assert.throws(() => validateResult({ ...pass(), status: "changes_requested", summary: " " }));
  assert.throws(() => validateResult({ ...pass(), evidence: {} }));
});

test("提示词包含独立原文核对、常驻限定语和禁止自动发布", () => {
  const job = { id: "job", folder: "episode", paper: PAPER, options: { minutes: 5, audience: "auto" } };
  assert.match(buildPrompt(job, "source_review"), /与写稿会话独立/);
  assert.match(buildPrompt(job, "assets"), /“\+”与对应内容同时出现/);
  assert.match(buildPrompt(job, "visual_review", { page: 2, images: ["x.png"] }), /640×360/);
  assert.match(buildPrompt(job, "draft"), /不要 commit、push、发布/);
});

test("项目锁拒绝并发任务，释放只作用于自己的锁", (t) => {
  const root = temp(t);
  const lock = acquireLock(root, "one");
  assert.throws(() => acquireLock(root, "two"), /已有制作任务/);
  lock.release();
  const other = acquireLock(root, "two"); other.release();
  assert.ok(!fs.existsSync(path.join(root, ".production", "active.lock")));
});

test("路径越界及符号链接不能用于文件指纹/读写", (t) => {
  const root = temp(t);
  assert.throws(() => safePath(root, "../outside"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "dp-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  try { fs.symlinkSync(outside, path.join(root, "alias"), process.platform === "win32" ? "junction" : "dir"); }
  catch (error) { if (["EPERM", "EACCES"].includes(error.code)) { t.skip("本机沙箱不允许创建链接"); return; } throw error; }
  assert.throws(() => fingerprint(root, ["alias/file"]), /符号链接/);
});

test("预览全页覆盖：无动画页、缺图和路径异常也会阻断", (t) => {
  const root = temp(t);
  fs.writeFileSync(path.join(root, "p01-01.png"), "eightbytesPNG");
  const slides = [{ number: 1 }, { number: 2 }];
  const record = { pages: { 1: { moments: [{ file: "p01-01.png" }] } } };
  assert.throws(() => validatePreviewRecord(record, slides, root), /第 2 页/);
  record.pages[2] = { moments: [{ file: "p02-01.png" }] };
  assert.throws(() => validatePreviewRecord(record, slides, root), /缺少预览图片/);
  record.pages[2].moments[0].file = "../p01-01.png";
  assert.throws(() => validatePreviewRecord(record, slides, root), /文件名/);
});

test("输入指纹覆盖素材清单、原图、PDF、静态页预览和时间轴", (t) => {
  const root = temp(t), folder = "2026-10-10-2610.99999";
  const dir = path.join(root, "episodes", folder);
  fs.mkdirSync(path.join(dir, "output", "preview"), { recursive: true });
  fs.mkdirSync(path.join(dir, "figures"));
  const names = ["script.md", "materials.md", "2610.99999v1.pdf", "figures/table1.png", "output/narration.json", "output/preview/p01-01.png"];
  for (const name of names) fs.writeFileSync(path.join(dir, name), name);
  const hash = inputFingerprint(root, folder, { preview: true });
  for (const name of names) {
    fs.appendFileSync(path.join(dir, name), "changed");
    assert.notEqual(inputFingerprint(root, folder, { preview: true }), hash, name);
    fs.writeFileSync(path.join(dir, name), name);
  }
});

test("真实子进程：标准输入中文字和特殊字符不执行，非零退出保留", async (t) => {
  const root = temp(t);
  const result = await runProcess(process.execPath, ["-e", "process.stdin.on('data', d => process.stdout.write(d)); process.stdin.on('end', () => process.exitCode=7)"], { cwd: root, input: "中文 `whoami` $(whoami)\n", timeoutMs: 5000 });
  assert.equal(result.code, 7); assert.equal(result.stdout, "中文 `whoami` $(whoami)\n");
});

test("真实子进程超时和取消可退出，不留运行中的调用", async (t) => {
  const root = temp(t);
  await assert.rejects(runProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], { cwd: root, timeoutMs: 100 }), /超时/);
  const controller = new AbortController();
  const pending = runProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], { cwd: root, signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(pending, /停止/);
});

test("Windows npm安装使用package bin，不执行cmd/ps1字符串", (t) => {
  const root = temp(t);
  const dir = path.join(root, "node_modules", "@anthropic-ai", "claude-code");
  fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ bin: { claude: "bin/claude.exe" } }));
  fs.writeFileSync(path.join(dir, "bin", "claude.exe"), "fake binary");
  assert.equal(resolveAgent("claude", { env: { PATH: root }, platform: "win32" }).command, path.join(dir, "bin", "claude.exe"));
  fs.writeFileSync(path.join(root, "claude.cmd"), "don't execute");
  assert.throws(() => resolveAgent("claude", { env: { DAILYPAPER_CLAUDE_BIN: path.join(root, "claude.cmd") }, platform: "win32" }), /包装脚本/);
});

// A process stand-in exercises the real state machine, saved handoffs, files, locks and logs.
function harness(t, { responseFor, onCall, previewError, commandResult, draftErrors = [], pages = [1, 2], momentsPerPage = 1 } = {}) {
  const root = temp(t), calls = [], counts = {}, prompts = [];
  let dir;
  const write = (relative, content) => { const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };
  const dependencies = {
    resolve: (name) => ({ command: `fake-${name}`, prefix: [] }), log: () => {}, env: {},
    create: async (id, { dir: episodes, date }) => {
      dir = path.join(episodes, `${date}-${PAPER.id}`);
      if (fs.existsSync(dir)) throw new Error("已经存在");
      writeEpisode(dir, { "script.md": "skeleton", [`${PAPER.versionedId}.pdf`]: "%PDF-test" });
      return { folder: dir, paper: PAPER };
    },
    draft: () => ({ errors: draftErrors, warnings: [] }),
    preview: async () => {
      if (previewError) throw typeof previewError === "string" ? new Error(previewError) : previewError;
      const images = pages.flatMap((page) => Array.from({ length: momentsPerPage }, (_, i) => ({ page, file: `p${String(page).padStart(2, "0")}-${String(i + 1).padStart(2, "0")}.png`, time: i, turnTime: i, labels: [i ? "镜头：稳定" : "翻页：淡入中"] })));
      const pageHashes = Object.fromEntries(pages.map((page) => [page, fingerprint(root, [`episodes/${path.basename(dir)}/script.md`, `episodes/${path.basename(dir)}/materials.md`, `episodes/${path.basename(dir)}/diagrams/page${page}.svg`])]));
      return { pages, pageHashes, images, duration: 300, warnings: [] };
    },
    phones: async (base, job, images) => { for (const image of images) write(`episodes/${job.folder}/output/production-phone/${image.file}`, "phone image"); },
    run: async (command, args, options) => {
      if (command === process.execPath) {
        const file = path.basename(args[0]);
        const outcome = commandResult?.(file, args);
        if (outcome) return outcome;
        if (file === "preview.js") {
          for (const page of pages) for (let i = 1; i <= momentsPerPage; i++) fs.writeFileSync(path.join(dir, "output", "preview", `p${String(page).padStart(2, "0")}-${String(i).padStart(2, "0")}.png`), "preview image");
          fs.writeFileSync(path.join(dir, "output", "preview", "preview.json"), "{}");
          fs.writeFileSync(path.join(dir, "output", "preview", "index.html"), "preview index");
          fs.writeFileSync(path.join(dir, "output", "narration.json"), "{}");
        }
        if (file === "render.js" && !args.includes("--check")) {
          for (const name of ["video.mp4", "cover.png", "subtitles.srt", "chapters.txt"]) fs.writeFileSync(path.join(dir, "output", name), "final artifact");
        }
        return { code: 0, stdout: "ok", stderr: "" };
      }
      const resultFile = args[args.indexOf("--output-last-message") + 1];
      const stage = Object.keys(STAGE_LABEL).find((name) => options.input.includes(`阶段：${STAGE_LABEL[name]}\n`));
      calls.push(stage); counts[stage] = (counts[stage] ?? 0) + 1;
      prompts.push({ stage, text: options.input });
      fs.mkdirSync(path.join(dir, "output", "preview"), { recursive: true });
      if (["draft", "source_fix"].includes(stage)) {
        fs.writeFileSync(path.join(dir, "script.md"), "written draft");
        fs.writeFileSync(path.join(dir, "materials.md"), "written materials");
      }
      if (["assets", "assets_fix"].includes(stage)) {
        fs.writeFileSync(path.join(dir, "cues.md"), "written cues");
        fs.writeFileSync(path.join(dir, "diagrams", "page2.svg"), "<svg/>");
      }
      const attached = args.flatMap((arg, i) => arg === "--image" ? [path.relative(root, args[i + 1]).replaceAll("\\", "/")] : []);
      const page = Number(options.input.match(/本轮审核第 (\d+) 页/)?.[1]);
      let result = pass({ pages: page ? [page] : [1, 2], images: attached });
      if (stage === "video_review") result.evidence.images = [path.relative(root, path.join(dir, "output", "cover.png")).replaceAll("\\", "/")];
      result = responseFor?.(stage, counts[stage], result) ?? result;
      await onCall?.({ stage, counts, root, dir, result });
      if (command === "fake-codex") fs.writeFileSync(resultFile, JSON.stringify(result));
      return { code: 0, stdout: command === "fake-claude" ? JSON.stringify({ subtype: "success", structured_output: result }) : "", stderr: "" };
    },
  };
  const runner = new ProductionRunner(root, dependencies);
  return { root, runner, calls, counts, prompts, dir: () => dir };
}
const STAGE_LABEL = {
  draft: "写讲解稿和素材清单", source_review: "独立核对论文原文", source_fix: "修订稿件", assets: "制作原图、示意图和镜头表",
  visual_review: "对照图片联合审核", assets_fix: "按审核意见返修", video_review: "检查成片画面和时间轴",
};

test("端到端离线制作：独立原文审核、全页逐图审核后才能合成；留下交接和用户审核待办", async (t) => {
  const h = harness(t);
  const job = await h.runner.start(PAPER.versionedId);
  assert.equal(job.status, "ready");
  assert.deepEqual(h.calls, ["draft", "source_review", "assets", "visual_review", "visual_review", "video_review"]);
  assert.ok(fs.existsSync(path.join(h.dir(), "output", "video.mp4")));
  const saved = readJob(h.root, job.id); assert.equal(saved.stage, "ready");
  const files = fs.readdirSync(path.join(h.root, ".production", "jobs", job.id));
  assert.equal(files.filter((file) => file.endsWith("-handoff.md")).length, 6);
  const log = fs.readFileSync(path.join(h.root, "WORKLOG.md"), "utf8");
  assert.ok(log.endsWith("### 旧记录\n原样保留\n"));
  assert.match(log, /最终审核自动制作的/); assert.match(log, /未 commit、push 或发布/);
  assert.ok(!fs.existsSync(path.join(h.root, ".production", "active.lock")));
});

test("原文不通过先修稿再独立复审，素材不提前制作", async (t) => {
  const h = harness(t, { responseFor: (stage, n, result) => stage === "source_review" && n === 1 ? changes("百分点写错") : result });
  const job = await h.runner.start(PAPER.versionedId);
  assert.equal(job.status, "ready");
  assert.deepEqual(h.calls.slice(0, 5), ["draft", "source_review", "source_fix", "source_review", "assets"]);
});

test("T99 R2：整轮收集问题后返修，只复审未通过或变动的页", async (t) => {
  const h = harness(t, { responseFor: (stage, n, result) => stage === "visual_review" && n === 2 ? changes("第2页取景切字") : result });
  const job = await h.runner.start(PAPER.versionedId);
  assert.equal(job.status, "ready"); assert.equal(h.counts.visual_review, 3); assert.equal(h.counts.assets_fix, 1);
});

test("返修改了稿件/素材清单就重新查原文", async (t) => {
  const h = harness(t, {
    responseFor: (stage, n, result) => stage === "visual_review" && n === 1 ? changes("卡片说明不清") : result,
    onCall: ({ stage, dir }) => { if (stage === "assets_fix") fs.appendFileSync(path.join(dir, "materials.md"), "updated explanation"); },
  });
  const job = await h.runner.start(PAPER.versionedId);
  assert.equal(job.status, "ready"); assert.equal(h.counts.source_review, 2);
});

test("没有逐图证据时停止，不能合成或跳过用户决定", async (t) => {
  const h = harness(t, { responseFor: (stage, n, result) => stage === "visual_review" ? pass() : result });
  const job = await h.runner.start(PAPER.versionedId);
  assert.equal(job.status, "needs_user"); assert.match(job.message, /没有覆盖/);
  assert.ok(!fs.existsSync(path.join(h.dir(), "output", "video.mp4")));
  await assert.rejects(h.runner.resume(job.id), /需要你的决定/);
});

test("返修和调用上限都能终止循环，并保存失败计数", async (t) => {
  const h = harness(t, { responseFor: (stage, n, result) => stage === "source_review" ? changes("原文仍不一致") : result });
  const job = await h.runner.start(PAPER.versionedId, { maxRevisions: 1 });
  assert.equal(job.status, "needs_user"); assert.equal(job.revisions, 2); assert.equal(job.stage, "source_fix");
  const second = harness(t);
  const capped = await second.runner.start(PAPER.versionedId, { maxCalls: 2 });
  assert.equal(capped.status, "needs_user"); assert.equal(capped.calls, 2); assert.match(capped.message, /调用上限/);
});

test("共享文件或WORKLOG被agent修改时停止且保留现场", async (t) => {
  for (const name of ["src/existing.js", "WORKLOG.md"]) {
    const h = harness(t, { onCall: ({ stage, root }) => { if (stage === "draft") fs.appendFileSync(path.join(root, name), "unexpected edit"); } });
    const job = await h.runner.start(PAPER.versionedId);
    assert.equal(job.status, "paused"); assert.match(job.message, /变化|WORKLOG/);
    assert.match(fs.readFileSync(path.join(h.root, name), "utf8"), /unexpected edit/);
    assert.deepEqual(h.calls, ["draft"]);
  }
});

test("agent不能修改已经准备好的论文阅读输入", async (t) => {
  const h = harness(t, { onCall: ({ stage, dir }) => { if (stage === "draft") fs.appendFileSync(path.join(dir, `${PAPER.versionedId}.pdf`), "changed paper"); } });
  const job = await h.runner.start(PAPER.versionedId);
  assert.equal(job.status, "paused"); assert.match(job.message, /原文阅读材料被改动/);
  assert.deepEqual(h.calls, ["draft"]);
});

test("独立审核改了稿件不能用通过结果，恢复后重新审核", async (t) => {
  let once = true;
  const h = harness(t, { onCall: ({ stage, dir }) => { if (stage === "source_review" && once) { once = false; fs.appendFileSync(path.join(dir, "script.md"), "illegal edit"); } } });
  const job = await h.runner.start(PAPER.versionedId);
  assert.equal(job.status, "paused"); assert.match(job.message, /只读审核/);
  assert.equal((await h.runner.resume(job.id)).status, "ready");
});

test("完成后稿件被改动，再恢复不能沿用旧原文/视觉通过结果", async (t) => {
  const h = harness(t);
  const job = await h.runner.start(PAPER.versionedId);
  fs.appendFileSync(path.join(h.dir(), "script.md"), "changed conclusion");
  const resumed = await h.runner.resume(job.id);
  assert.equal(resumed.status, "ready"); assert.equal(h.counts.source_review, 2); assert.equal(h.counts.visual_review, 4);
});

test("交付文件被改动或丢失时不能复用成片通过结果", async (t) => {
  const h = harness(t);
  const job = await h.runner.start(PAPER.versionedId);
  fs.rmSync(path.join(h.dir(), "output", "video.mp4"));
  const resumed = await h.runner.resume(job.id);
  assert.equal(resumed.status, "ready"); assert.equal(h.counts.video_review, 2);
  assert.ok(fs.existsSync(path.join(h.dir(), "output", "video.mp4")));
});

test("成片审核擅改封面不能标记通过", async (t) => {
  const h = harness(t, { onCall: ({ stage, dir }) => { if (stage === "video_review") fs.appendFileSync(path.join(dir, "output", "cover.png"), "edited"); } });
  const job = await h.runner.start(PAPER.versionedId);
  assert.equal(job.status, "paused"); assert.match(job.message, /修改了交付文件/);
});

test("已有稿件和已发布成片都不会被接管或覆盖", async (t) => {
  const h = harness(t);
  const job = await h.runner.start(PAPER.versionedId);
  const old = fs.readFileSync(path.join(h.dir(), "script.md"), "utf8");
  const second = await h.runner.start(PAPER.versionedId);
  assert.equal(second.status, "paused"); assert.match(second.message, /已存在/);
  assert.equal(fs.readFileSync(path.join(h.dir(), "script.md"), "utf8"), old);
  fs.writeFileSync(path.join(h.root, "episodes", "published.json"), JSON.stringify([{ number: 1, folder: job.folder }]));
  const resumed = await h.runner.resume(job.id);
  assert.equal(resumed.status, "paused"); assert.match(resumed.message, /已经发布/);
});

test("T99 R4：环境故障暂停，不消费返修次数或调用素材返修", async (t) => {
  const h = harness(t, { previewError: "静态页预览过期" });
  const job = await h.runner.start(PAPER.versionedId, { maxRevisions: 0 });
  assert.equal(job.status, "paused"); assert.match(job.message, /静态页预览过期/); assert.equal(job.revisions, 0);
  assert.equal(h.counts.visual_review ?? 0, 0); assert.equal(h.counts.video_review ?? 0, 0);
});

test("恢复变更共享输入必须显式说明决定并重新审稿", async (t) => {
  const h = harness(t);
  const job = await h.runner.start(PAPER.versionedId);
  fs.appendFileSync(path.join(h.root, "src", "existing.js"), "new approved code");
  assert.equal((await h.runner.resume(job.id)).status, "paused");
  await assert.rejects(h.runner.resume(job.id, { refreshInputs: true }), /必须用 --feedback/);
  assert.equal((await h.runner.resume(job.id, { refreshInputs: true, feedback: "确认代码修改" })).status, "ready");
  assert.equal(h.counts.source_review, 2);
});

test("真实稿件门禁：缺图可交接，缺必要字段/核对表或错版本不放行", (t) => {
  const root = temp(t), folder = "2026-10-10-2610.99999";
  const dir = path.join(root, "episodes", folder);
  fs.mkdirSync(dir);
  let source = fs.readFileSync(new URL("../episodes/example/script.md", import.meta.url), "utf8");
  const id = source.match(/- arXiv：([^\r\n]+)/)[1];
  source = source.replaceAll(id, PAPER.versionedId);
  fs.writeFileSync(path.join(dir, "script.md"), source);
  fs.writeFileSync(path.join(dir, "materials.md"), "素材清单：需要论文图表和示意图，每个数字核对原文，限定语常驻显示。".repeat(2));
  fs.writeFileSync(path.join(dir, `${PAPER.versionedId}.pdf`), "%PDF-test");
  const job = { folder, paper: PAPER };
  const permissive = inspectDraft(root, job, { allowMissing: true });
  assert.equal(permissive.errors.length, 0, permissive.errors.join(";"));
  assert.ok(inspectDraft(root, job).errors.some((e) => /找不到/.test(e)));
  fs.writeFileSync(path.join(dir, "script.md"), source.replace(PAPER.versionedId, "2610.99998v1").replace(/- 机构：[^\r\n]+/, "- 机构："));
  const broken = inspectDraft(root, job, { allowMissing: true });
  assert.ok(broken.errors.some((e) => /版本必须/.test(e))); assert.ok(broken.errors.some((e) => /缺少「机构」/.test(e)));
});

test("T99 R2/R3：多页多批问题只返修一次，每轮仅一条工作记录", async (t) => {
  const h = harness(t, { momentsPerPage: 7, responseFor: (stage, n, result) => stage === "visual_review" && [1, 3].includes(n) ? changes(`问题${n}`) : result });
  const job = await h.runner.start(PAPER.versionedId);
  assert.equal(job.status, "ready"); assert.equal(job.revisions, 1);
  assert.deepEqual(h.calls.slice(3, 8), ["visual_review", "visual_review", "visual_review", "visual_review", "assets_fix"]);
  assert.equal(h.counts.visual_review, 8);
  const repair = h.prompts.find((p) => p.stage === "assets_fix").text;
  assert.match(repair, /第 1 页：问题1/); assert.match(repair, /第 2 页：问题3/);
  const records = fs.readFileSync(path.join(h.root, "WORKLOG.md"), "utf8");
  assert.equal((records.match(/\*\*任务\*\*：[^\n]*对照图片联合审核/g) ?? []).length, 2);
});

test("T99 R2：返修改变已通过页时也要复审；未变页继续复用", async (t) => {
  for (const editPassed of [false, true]) {
    const h = harness(t, {
      responseFor: (stage, n, result) => stage === "visual_review" && n === 2 ? changes("第2页框线") : result,
      onCall: ({ stage, dir }) => { if (stage === "assets_fix" && editPassed) fs.writeFileSync(path.join(dir, "diagrams/page1.svg"), "changed first page"); },
    });
    const job = await h.runner.start(PAPER.versionedId);
    assert.equal(job.status, "ready"); assert.equal(h.counts.visual_review, editPassed ? 4 : 3);
  }
});

test("T99 R2：按整轮批次数估算额度，不足时不启动半轮审核", async (t) => {
  const h = harness(t, { momentsPerPage: 7 });
  const job = await h.runner.start(PAPER.versionedId, { maxCalls: 6 });
  assert.equal(job.status, "needs_user"); assert.equal(h.counts.visual_review ?? 0, 0);
  assert.match(job.message, /本轮 4 批/); assert.ok(job.callEstimate.recommendedTotal > 6);
});

test("T99 R2/R3：审核中断后恢复剩余批次，汇总记录不重复", async (t) => {
  let once = true;
  const h = harness(t, { onCall: ({ stage, counts }) => { if (stage === "visual_review" && counts.visual_review === 2 && once) { once = false; throw new Error("服务连接中断"); } } });
  const stopped = await h.runner.start(PAPER.versionedId);
  assert.equal(stopped.status, "paused"); assert.equal(stopped.visualRound.index, 1);
  assert.equal((await h.runner.resume(stopped.id)).status, "ready");
  assert.equal(h.counts.visual_review, 3);
  const records = fs.readFileSync(path.join(h.root, "WORKLOG.md"), "utf8");
  assert.equal((records.match(/\*\*任务\*\*：[^\n]*对照图片联合审核/g) ?? []).length, 1);
});

test("T99 R4：网络/配音/浏览器/超时及未知故障暂停，格式与镜头错误才返修", async (t) => {
  for (const message of ["TTS network ECONNRESET", "pdf.js 下载失败", "浏览器启动失败", "字体探测异常", "这一步超时", "未知制作错误"]) {
    const h = harness(t, { commandResult: (file) => file === "preview.js" ? { code: 1, stdout: "", stderr: message } : null });
    const job = await h.runner.start(PAPER.versionedId);
    assert.equal(job.status, "paused", message); assert.equal(job.revisions, 0); assert.equal(h.counts.assets_fix ?? 0, 0);
  }
  const content = harness(t, { previewError: new GateError("第2页镜头表句子不唯一", "content") });
  const job = await content.runner.start(PAPER.versionedId, { maxRevisions: 0 });
  assert.equal(job.status, "needs_user"); assert.equal(job.revisions, 1);
  const cliContent = harness(t, { commandResult: (file) => file === "preview.js" ? { code: 1, stdout: "", stderr: "镜头表有 1 个问题（按这次配音的时间算），改好之后再预览：" } : null });
  assert.equal((await cliContent.runner.start(PAPER.versionedId, { maxRevisions: 0 })).status, "needs_user");
});

test("T99 R5：保护所有外部已跟踪/未忽略文件以及忽略的CLI设置和远端引用", (t) => {
  const root = temp(t), folder = "2026-10-10-2610.99999";
  execFileSync("git", ["init", "--quiet", root], { windowsHide: true });
  fs.writeFileSync(path.join(root, ".gitignore"), ".production/\n.claude/\n.codex/\nignored.bin\ntracked.bin\nepisodes/*/figures/\n");
  fs.writeFileSync(path.join(root, "tracked.bin"), "tracked");
  execFileSync("git", ["-C", root, "add", "--force", "tracked.bin"], { windowsHide: true });
  const write = (name, text) => { fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), text); };
  const base = protectedFingerprint(root, folder);
  for (const name of ["assets/custom.svg", "new-top.txt", "episodes/other/notes.txt", "episodes/other/figures/table1.png", ".claude/settings.json", ".codex/config.toml", ".git/refs/remotes/origin/main"]) {
    write(name, "created"); assert.notEqual(protectedFingerprint(root, folder), base, name);
    const created = protectedFingerprint(root, folder);
    write(name, "updated"); assert.notEqual(protectedFingerprint(root, folder), created, name);
    fs.rmSync(path.join(root, name)); assert.equal(protectedFingerprint(root, folder), base);
  }
  fs.rmSync(path.join(root, "tracked.bin")); assert.notEqual(protectedFingerprint(root, folder), base);
  write("tracked.bin", "tracked"); assert.equal(protectedFingerprint(root, folder), base);
  for (const name of ["WORKLOG.md", "ignored.bin", ".production/test.log", `episodes/${folder}/script.md`, `episodes/${folder}/figures/table1.png`]) write(name, "permitted local change");
  assert.equal(protectedFingerprint(root, folder), base);
});

test("T99 R2：逐页指纹忽略生成时间/全稿哈希/绝对偏移，保留实际图像与共享输入", (t) => {
  const root = temp(t), job = { folder: "2026-10-10-2610.99999" };
  const dir = path.join(root, "episodes", job.folder, "output", "preview"); fs.mkdirSync(dir, { recursive: true });
  const record = { pages: {} }, narration = { pages: [] }, contents = {};
  for (const n of [1, 2]) {
    const file = `p0${n}-01.png`; fs.writeFileSync(path.join(dir, file), "pixels");
    record.pages[n] = { made: "then", inputs: { page: `page${n}`, script: "whole script", cues: "whole cues", timing: "absolute hash", browser: "1", fonts: "font" }, moments: [{ file, time: 1, labels: ["稳定"] }], actions: [] };
    narration.pages.push({ number: n, start: n * 10, end: n * 10 + 5, lines: [{ text: "旁白", start: n * 10, end: n * 10 + 5 }] });
    contents[n] = { slide: { number: n, narration: ["旁白"] }, cues: null };
  }
  const hashes = () => previewPageHashes(root, job, record, narration, {}, contents);
  const before = hashes();
  for (const entry of Object.values(record.pages)) { entry.made = "now"; entry.inputs.script = "changed whole hash"; entry.inputs.cues = "changed"; entry.inputs.timing = "changed offset"; }
  for (const p of narration.pages) { p.start += 10; p.end += 10; for (const l of p.lines) { l.start += 10; l.end += 10; } }
  assert.deepEqual(hashes(), before);
  fs.writeFileSync(path.join(dir, "p02-01.png"), "changed pixels");
  const after = hashes();
  assert.equal(after[1], before[1]); assert.notEqual(after[2], before[2]);
  record.pages[1].inputs.browser = "2"; record.pages[2].inputs.browser = "2";
  const shared = hashes();
  assert.notEqual(shared[1], after[1]); assert.notEqual(shared[2], after[2]);
});

// Mirrors preview.json's real fields (including absolute videoTime and source-row labels),
// while using authored fixture text and placeholder bytes instead of ignored paper assets.
function realShapePreview(t) {
  const root = temp(t), job = { folder: "2026-10-12-2610.99999" };
  const dir = path.join(root, "episodes", job.folder, "output", "preview"); fs.mkdirSync(dir, { recursive: true });
  const content = {
    slide: { number: 5, topic: "本页实验", layout: "figure_text", values: { figure_caption: "受控条件", card1_title: "本页数字", card1_body: "29 个百分点" }, cards: ["本页数字"], narration: ["先说明条件。", "再看结果。"] },
    cues: { number: 5, lineNo: 32, figure: { lineNo: 33, file: "figures/table1.png", width: 1000, height: 600, hash: "figure-hash" }, diagram: null,
      readable: [{ lineNo: 34, name: "受控条件", box: { top: 1, left: 1, width: 50, height: 5 } }],
      actions: [
        { lineNo: 41, from: "先说明条件", to: "", action: "出现", target: "卡片1", position: "", note: "限定说明同时出现" },
        { lineNo: 42, from: "再看结果", to: "", action: "框", target: "", position: "10%, 10%, 20%, 20%", note: "框定本行数值" },
      ] },
  };
  const entry = {
    topic: "本页实验", layout: "figure_text", duration: 10, made: "2026-10-10T00:00:00Z",
    inputs: { code: "code", templates: "templates", script: "script", cues: "cues", page: "opaque-page-hash-containing-lineNo", figure: "figure", diagram: "diagram", theme: "academic", voice: "voice", rate: "+25%", timing: "absolute-timing-hash", fonts: "fonts", browser: "154" },
    environment: { fonts: ["font"], browser: "154" }, missingFonts: [],
    actions: [
      { name: "第 41 行 出现 卡片1", box: "", note: "限定说明同时出现", start: 0.3, end: 0.7, window: "", outside: [] },
      { name: "第 42 行 框", box: "10%, 10%, 20%, 20%", note: "框定本行数值", start: 2, end: 9.7, window: "", outside: [] },
    ],
    moments: [
      { time: 0, turnTime: 0.6, labels: ["页首：本页开始时的样子"], file: "p05-01.png", line: -1, videoTime: 60 },
      { time: 0.5, turnTime: 0.6, labels: ["第 41 行 出现 卡片1：出现中"], file: "p05-02.png", line: 0, videoTime: 60.5 },
      { time: 2.3, turnTime: 2.3, labels: ["第 42 行 框：稳定", "重叠：第 41 行 出现 卡片1 + 第 42 行 框"], file: "p05-03.png", line: 1, videoTime: 62.3 },
    ],
  };
  for (const m of entry.moments) fs.writeFileSync(path.join(dir, m.file), "fixture-pixels");
  const record = { pages: { 5: entry } }, contents = { 5: content };
  const narration = { pages: [{ number: 5, start: 60, end: 70, lines: [{ text: "先说明条件。", display: "先说明条件", start: 60.3, end: 62 }, { text: "再看结果。", display: "再看结果", start: 62, end: 69 }] }] };
  const common = { header: [{ key: "作者", value: "作者", lineNo: 5 }], sourceRows: [{ cells: ["受控条件", "2610.99999v1"], lineNo: 300 }], materials: "unchanged", paper: "2610.99999v1" };
  return { root, job, dir, record, contents, narration, common, hash: () => previewPageHashes(root, job, record, narration, common, contents)[5] };
}

test("T101 R13：真实预览结构中前页时长和镜头行增减不影响后页审核指纹", (t) => {
  const f = realShapePreview(t), before = f.hash();
  const shiftLines = (value, delta) => {
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      if (key === "lineNo") value[key] += delta;
      else shiftLines(item, delta);
    }
  };
  const original = JSON.stringify(f.record);
  for (const delta of [1, -1]) {
    const p = f.narration.pages[0]; p.start += delta; p.end += delta;
    for (const line of p.lines) { line.start += delta; line.end += delta; }
    for (const m of f.record.pages[5].moments) m.videoTime += delta;
    assert.equal(f.hash(), before, "仅前页时长变化");
  }
  assert.equal(JSON.stringify(f.record), original, "计算指纹不改写原始预览定位信息");
  for (const delta of [3, -3]) {
    shiftLines(f.contents, delta); shiftLines(f.common, delta);
    for (const a of f.record.pages[5].actions) a.name = a.name.replace(/第 (\d+) 行/g, (_, n) => `第 ${Number(n) + delta} 行`);
    for (const m of f.record.pages[5].moments) m.labels = m.labels.map((s) => s.replace(/第 (\d+) 行/g, (_, n) => `第 ${Number(n) + delta} 行`));
    f.record.pages[5].inputs.page = `different-opaque-page-hash-${delta}`;
    assert.equal(f.hash(), before, "前面加减镜头表行，动作和重叠标签一致复用");
  }
  // Also tolerate arithmetic roundoff from rebuilding timing with an earlier page shifted.
  f.record.pages[5].actions[1].start += 1e-14; f.record.pages[5].moments[2].time += 1e-14;
  assert.equal(f.hash(), before);
  assert.throws(() => previewPageHashes(f.root, f.job, f.record, f.narration, f.common), /缺少逐页画面和镜头输入/);
});

test("T101 R13：真实本页内容、动作/常驻说明、局部时间、图片和环境变化仍失效", (t) => {
  const f = realShapePreview(t), before = f.hash();
  const mutations = [
    () => { f.contents[5].slide.values.card1_body = "30 个百分点"; },
    () => { f.contents[5].cues.readable[0].box.width = 51; },
    () => { f.contents[5].cues.actions[1].position = "11%, 10%, 20%, 20%"; },
    () => { f.record.pages[5].actions[1].box = "11%, 10%, 20%, 20%"; },
    () => { f.record.pages[5].moments[2].time += 0.1; },
    () => { f.record.pages[5].moments[1].turnTime += 0.1; },
    () => { f.narration.pages[0].lines[1].start += 0.1; },
    () => { f.record.pages[5].inputs.fonts = "other-font"; },
    () => { f.record.pages[5].inputs.browser = "155"; },
    () => { f.common.sourceRows[0].cells[0] = "不同条件"; },
    () => { fs.writeFileSync(path.join(f.dir, "p05-01.png"), "different pixels"); },
  ];
  const snapshot = JSON.stringify({ record: f.record, contents: f.contents, narration: f.narration, common: f.common });
  for (const mutate of mutations) {
    mutate(); assert.notEqual(f.hash(), before);
    const saved = JSON.parse(snapshot);
    for (const name of ["record", "contents", "narration", "common"]) { for (const key of Object.keys(f[name])) delete f[name][key]; Object.assign(f[name], saved[name]); }
    fs.writeFileSync(path.join(f.dir, "p05-01.png"), "fixture-pixels");
    assert.equal(f.hash(), before);
  }
});

test("T99 R6/R7/R8：可选建议不返修、过渡帧注明时刻、反斜杠不误判漏审", async (t) => {
  assert.doesNotThrow(() => validateResult({ ...pass(), notes: ["可选缩短标题"] }));
  assert.throws(() => validateResult({ ...pass(), notes: [7] }), /建议格式/);
  const h = harness(t, { responseFor: (stage, n, result) => stage === "visual_review" ? { ...result, notes: ["可选排版建议"], evidence: { ...result.evidence, images: result.evidence.images.map((name) => name.replaceAll("/", "\\")) } } : result });
  const job = await h.runner.start(PAPER.versionedId);
  assert.equal(job.status, "ready"); assert.equal(job.revisions, 0);
  const prompt = h.prompts.find((p) => p.stage === "visual_review").text;
  assert.match(prompt, /翻页：淡入中/); assert.match(prompt, /过渡状态/); assert.match(prompt, /0 秒/);
});

test("T99 R12：合成前浏览器/字体变化回到预览并复审，不滞留合成阶段", async (t) => {
  const h = harness(t);
  const original = h.runner.deps.preview;
  let checks = 0, version = "old";
  h.runner.deps.preview = async (...args) => {
    checks++;
    if (checks === 2) { version = "new"; throw new GateError("预览未全部更新：浏览器版本变化", "stale"); }
    const result = await original(...args);
    for (const p of result.pages) result.pageHashes[p] += version;
    return result;
  };
  const job = await h.runner.start(PAPER.versionedId);
  assert.equal(job.status, "ready"); assert.equal(job.revisions, 0); assert.equal(h.counts.assets_fix ?? 0, 0);
  assert.equal(h.counts.visual_review, 4);
});

test("T104 ②：未通过但问题清单为空时，用摘要当原因，照常返修或交用户", async (t) => {
  const refusal = { ...pass(), status: "needs_user", summary: "读不了图片，需要你决定", findings: [] };
  assert.deepEqual(validateResult(refusal).findings, ["读不了图片，需要你决定"]);
  assert.deepEqual(refusal.findings, []);
  assert.deepEqual(validateResult({ ...refusal, status: "changes_requested", summary: " 数字被框切到 " }).findings, ["数字被框切到"]);
  assert.throws(() => validateResult({ ...pass(), findings: ["仍有问题"] }), /不能标记通过/);
  const prompt = buildPrompt({ id: "job", folder: "episode", paper: PAPER, options: { minutes: 5, audience: "auto" } }, "assets");
  assert.match(prompt, /不是pass时，findings至少写一条具体原因/);

  const stuck = harness(t, { responseFor: (stage, n, result) => stage === "assets" ? { ...result, status: "needs_user", summary: "读不了图片，需要你决定", findings: [] } : result });
  const paused = await stuck.runner.start(PAPER.versionedId);
  assert.equal(paused.status, "needs_user"); assert.equal(paused.message, "读不了图片，需要你决定");

  const fix = harness(t, { responseFor: (stage, n, result) => stage === "visual_review" && n === 1 ? { ...result, status: "changes_requested", summary: "数字被框切到", findings: [] } : result });
  const done = await fix.runner.start(PAPER.versionedId);
  assert.equal(done.status, "ready"); assert.equal(done.revisions, 1);
  assert.match(fix.prompts.find((p) => p.stage === "assets_fix").text, /数字被框切到/);
});

test("T110：只认 Anthropic 官方 https 接口和完整的 Claude 模型名，任何变量值都不输出", () => {
  assert.deepEqual(claudeRouteProblems({}), []);
  for (const url of ["https://api.anthropic.com", "https://api.anthropic.com/", "https://api.anthropic.com:443"]) assert.deepEqual(claudeRouteProblems({ ANTHROPIC_BASE_URL: url }), [], url);
  assert.match(claudeRouteProblems({ ANTHROPIC_BASE_URL: "http://api.anthropic.com" }).join(), /没有用 https/);
  assert.match(claudeRouteProblems({ ANTHROPIC_BASE_URL: "https://api.anthropic.com:8443" }).join(), /指向 api\.anthropic\.com:8443，不是 Anthropic 官方/);
  assert.match(claudeRouteProblems({ ANTHROPIC_BASE_URL: "https://api.anthropic.com.evil.example" }).join(), /指向 api\.anthropic\.com\.evil\.example，/);
  const proxy = claudeRouteProblems({ ANTHROPIC_BASE_URL: "https://someone:hunter2@proxy.example.invalid/anthropic?token=abc123" }).join("\n");
  assert.match(proxy, /指向 proxy\.example\.invalid，不是 Anthropic 官方/);
  for (const secret of ["someone", "hunter2", "/anthropic", "token=abc123"]) assert.ok(!proxy.includes(secret), secret);
  assert.match(claudeRouteProblems({ ANTHROPIC_BASE_URL: "not a url" }).join(), /不是有效网址/);
  assert.match(claudeRouteProblems({ CLAUDE_CODE_USE_BEDROCK: "1" }).join(), /CLAUDE_CODE_USE_BEDROCK：Claude Code 会走云服务商/);
  assert.deepEqual(claudeRouteProblems({ CLAUDE_CODE_USE_VERTEX: "0" }), []);
  const credentials = claudeRouteProblems({ ANTHROPIC_AUTH_TOKEN: "sk-secret-value", ANTHROPIC_API_KEY: "sk-ant-secret" }).join("\n");
  assert.match(credentials, /ANTHROPIC_AUTH_TOKEN（不显示内容）/); assert.match(credentials, /ANTHROPIC_API_KEY（不显示内容）/);
  assert.ok(!credentials.includes("sk-secret-value") && !credentials.includes("sk-ant-secret"));

  const names = ["ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_SMALL_FAST_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL"];
  const claude = ["claude-opus-5-5", "claude-sonnet-4-5-20250929", "claude-haiku-5-5", "claude-fable-5-1", "claude-opus-4-6[1m]", "claude-3-5-haiku-20241022", "opus", "sonnet[1m]", "haiku", "opusplan", "default"];
  const other = ["deepseek-v4-pro[1m]", "deepseek-claude-wrapper", "claude-proxy", "gpt-5.6-sol", "review@example.invalid", "sk-ant-api03-FAKE0000000000000000000000", "eyJhbGciOiJIUzI1NiJ9.e30.FAKE"];
  for (const name of names) {
    for (const value of claude) assert.deepEqual(claudeRouteProblems({ [name]: value }), [], `${name}=${value}`);
    for (const value of other) {
      const problems = claudeRouteProblems({ [name]: value });
      assert.equal(problems.length, 1, `${name}=${value}`);
      assert.match(problems[0], new RegExp(`${name} 指定的不是 Claude 官方模型名（不显示内容）`));
      assert.ok(!problems[0].includes(value), `${name} 的原值不能出现在提醒里`);
    }
  }
});

test("T110：doctor 读不到状态、未登录、设置被改时如实提示，不泄露账号和密钥", async () => {
  const check = async (auth, env = {}) => {
    const lines = [];
    const run = async (command, args) => args.includes("--version") ? { code: 0, stdout: `${command} 1.0\n`, stderr: "" } : auth();
    await doctor("D:/repo", { resolve: (name) => ({ command: name, prefix: [] }), run, env, log: (line) => lines.push(line) });
    return lines.join("\n");
  };
  const old = await check(async () => ({ code: 1, stdout: "", stderr: "error: unknown option '--json'" }));
  assert.match(old, /Claude 登录：读不到状态/); assert.match(old, /提醒：读不到 Claude Code 的登录状态/);
  assert.match(await check(async () => { throw new Error("spawn failed"); }), /Claude 登录：读不到状态/);
  const loggedOut = await check(async () => ({ code: 1, stdout: JSON.stringify({ loggedIn: false, authMethod: "none", apiProvider: "firstParty" }), stderr: "" }));
  assert.match(loggedOut, /Claude 登录：未登录/); assert.match(loggedOut, /claude auth login --claudeai/);
  const ok = await check(async () => ({ code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", email: "someone@example.invalid", orgId: "org-fake", orgName: "Someone's Organization", subscriptionType: "pro" }), stderr: "" }));
  assert.match(ok, /Claude 登录：已登录 · claude\.ai · pro · firstParty/);
  for (const hidden of ["提醒", "someone@", "org-fake", "Someone's"]) assert.ok(!ok.includes(hidden), hidden);
  const rerouted = await check(async () => ({ code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "oauth_token", apiProvider: "firstParty" }), stderr: "" }),
    { ANTHROPIC_BASE_URL: "https://user:pw@api.deepseek.invalid/anthropic", ANTHROPIC_AUTH_TOKEN: "sk-fake-secret", ANTHROPIC_MODEL: "review@example.invalid" });
  assert.match(rerouted, /指向 api\.deepseek\.invalid，不是 Anthropic 官方/); assert.match(rerouted, /oauth_token 认证，不是 Claude 订阅登录/);
  assert.match(rerouted, /开始和恢复自动任务会先停下/);
  for (const secret of ["user:pw", "/anthropic", "sk-fake-secret", "review@example.invalid"]) assert.ok(!rerouted.includes(secret), secret);
  assert.match(describeClaudeAuth({ loggedIn: true, authMethod: "claude.ai", apiProvider: "bedrock" }).warnings[0], /走 bedrock/);
});

test("T111：Claude 被改到别的服务时，开始和恢复前就停下，不建目录、不调用模型", async (t) => {
  const h = harness(t);
  h.runner.deps.env = { ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic", ANTHROPIC_AUTH_TOKEN: "sk-fake-secret" };
  await assert.rejects(h.runner.start(PAPER.versionedId), (error) => /已停下：没有创建论文目录，也没有调用模型/.test(error.message)
    && /api\.deepseek\.com/.test(error.message) && !error.message.includes("sk-fake-secret"));
  assert.equal(h.calls.length, 0); assert.equal(h.dir(), undefined);
  assert.ok(!fs.existsSync(path.join(h.root, ".production", "jobs")));

  h.runner.deps.env = {};
  const job = await h.runner.start(PAPER.versionedId);
  assert.equal(job.status, "ready");
  const calls = h.calls.length;
  h.runner.deps.env = { ANTHROPIC_MODEL: "deepseek-v4-pro[1m]" };
  await assert.rejects(h.runner.resume(job.id), /已停下：任务没有继续，也没有调用模型/);
  assert.equal(h.calls.length, calls); assert.equal(readJob(h.root, job.id).status, "ready");
});
