// Local, serial Claude Code <-> Codex orchestration. Publishing and Git are always manual.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ARXIV_ID } from "./arxiv.js";
import { createEpisode } from "./new-episode.js";
import { localDate, readPublished } from "./episodes.js";
import { safePath, filesUnder, fingerprint, protectedFingerprint, inputFingerprint, inspectDraft, inspectPreview, makePhoneImages, GateError } from "./production-gates.js";
import { resolveAgent, runProcess } from "./production-process.js";
import { buildPrompt, RESULT_SCHEMA, STAGE_LABELS, validateResult } from "./production-prompts.js";

export const ROOT = fileURLToPath(new URL("../", import.meta.url));
const JOB_ID = /^\d{8}T\d{6}-\d{4}\.\d{4,5}(?:v\d+)?-[a-f0-9]{8}$/;
const STATE_STATUSES = ["running", "paused", "needs_user", "ready"];
const AGENT_STAGES = ["draft", "source_review", "source_fix", "assets", "visual_review", "assets_fix", "video_review"];
const SOURCE_STAGES = new Set(["paper", "draft", "source_review", "source_fix"]);

export function normalizePaper(input) {
  let id = input?.trim();
  if (!id) throw new Error("请输入论文链接或 arXiv 编号");
  if (/^https?:\/\//i.test(id)) {
    const url = new URL(id);
    if (!["arxiv.org", "www.arxiv.org", "export.arxiv.org"].includes(url.hostname) || url.username || url.password || url.port) throw new Error("首版只接收 arXiv 的 abs/pdf/html 论文链接");
    const match = url.pathname.match(/^\/(?:abs|pdf|html)\/(\d{4}\.\d{4,5}(?:v\d+)?)(?:\.pdf)?\/?$/);
    if (!match) throw new Error("不是可识别的 arXiv 论文链接");
    id = match[1];
  }
  if (!ARXIV_ID.test(id) || /v0+$/.test(id)) throw new Error("arXiv 编号应写成 2610.07967 或 2610.07967v1");
  return id;
}

export function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
  try { fs.renameSync(temporary, file); } finally { if (fs.existsSync(temporary)) fs.rmSync(temporary); }
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
}

/** One project-wide lock, including WORKLOG updates. Never reclaim a lock with a live child. */
export function acquireLock(root, jobId) {
  const dir = safePath(root, ".production");
  fs.mkdirSync(dir, { recursive: true });
  const file = safePath(root, ".production/active.lock");
  const value = { pid: process.pid, childPid: null, jobId, token: crypto.randomBytes(12).toString("hex") };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, JSON.stringify(value), { flag: "wx" });
      const write = (childPid) => {
        value.childPid = childPid;
        fs.writeFileSync(file, JSON.stringify(value));
      };
      return {
        child: write,
        release() {
          if (fs.existsSync(file) && JSON.parse(fs.readFileSync(file, "utf8")).token === value.token) fs.rmSync(file);
        },
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let old;
      try { old = JSON.parse(fs.readFileSync(file, "utf8")); } catch { throw new Error("制作锁损坏，请确认没有制作进程后再移走 .production/active.lock"); }
      if (alive(old.pid) || alive(old.childPid)) throw new Error(`已有制作任务 ${old.jobId} 在运行，先等待或使用 stop；若程序意外退出，先结束遗留子进程`);
      fs.rmSync(file); // Confirmed dead owner AND child; no arbitrary process is killed.
    }
  }
  throw new Error("无法取得制作锁，请稍后再试");
}

export function jobDirectory(root, id) {
  if (!JOB_ID.test(id ?? "")) throw new Error("任务编号无效，用 npm run produce -- list 查看");
  return safePath(root, `.production/jobs/${id}`);
}

export function readJob(root, id) {
  const dir = jobDirectory(root, id);
  const job = JSON.parse(fs.readFileSync(safePath(dir, "state.json"), "utf8"));
  if (job.id !== id || !STATE_STATUSES.includes(job.status) || (!STAGE_LABELS[job.stage] && job.stage !== "init")
    || typeof job.folder !== "string" || !/^\d{4}-\d{2}-\d{2}-\d{4}\.\d{4,5}$/.test(job.folder)
    || !ARXIV_ID.test(job.requestedId) || !Array.isArray(job.history)) throw new Error("任务状态无效，不能恢复");
  checkOptions(job.options);
  if (job.stage !== "init" && !/^\d{4}\.\d{4,5}v[1-9]\d*$/.test(job.paper?.versionedId ?? "")) throw new Error("任务论文版本不完整");
  return job;
}

function checkOptions(options) {
  if (!Number.isFinite(options?.minutes) || options.minutes < 1 || options.minutes > 20
    || !Number.isInteger(options.maxRevisions) || options.maxRevisions < 0 || options.maxRevisions > 10
    || !Number.isFinite(options.timeoutMs) || options.timeoutMs < 1000 || options.timeoutMs > 24 * 60 * 60_000
    || !Number.isInteger(options.maxCalls) || options.maxCalls < 1 || options.maxCalls > 500
    || !["auto", "科普向", "专业向"].includes(options.audience)) throw new Error("目标时长/返修次数/超时/调用上限/定位参数无效");
}

function defaultOptions(options = {}) {
  return { minutes: 5, audience: "auto", maxRevisions: 3, timeoutMs: 20 * 60_000, maxCalls: 100, ...options };
}

function agentFor(stage) {
  return ["assets", "assets_fix", "video_review"].includes(stage) ? "claude" : "codex";
}

export function agentCommand(agent, stage, { schemaFile, resultFile, images = [] }) {
  const review = ["source_review", "visual_review", "video_review"].includes(stage);
  if (agent === "codex") {
    const args = ["exec", "--sandbox", review ? "read-only" : "workspace-write", "--output-schema", schemaFile, "--output-last-message", resultFile];
    for (const image of images) args.push("--image", image);
    // No positional prompt: Codex reads stdin. A trailing '-' can be consumed by --image.
    return args;
  }
  const tools = review
    ? "Read,Glob,Grep,Bash(node *),Bash(python *),Bash(pdftotext *),Bash(pdftoppm *)"
    : "Read,Write,Edit,Glob,Grep,Bash(node *),Bash(python *),Bash(pdftotext *),Bash(pdftoppm *),Bash(npm run figure *),Bash(npm run check *)";
  return ["-p", "--output-format", "json", "--json-schema", JSON.stringify(RESULT_SCHEMA), "--permission-mode", "dontAsk", "--allowedTools", tools, "--disallowedTools", "Bash(git *)"];
}

export function decodeClaude(stdout) {
  const response = JSON.parse(stdout);
  if (response.is_error || response.subtype && response.subtype !== "success") throw new Error(`Claude 未完成任务：${response.subtype ?? "调用失败"}`);
  if (!response.structured_output) throw new Error("Claude 没有返回结构化结果");
  return validateResult(response.structured_output);
}

function handoffResult(result) {
  return `# 本轮结果\n\n状态：${result.status}\n\n${result.summary}\n\n## 问题 / 下一步\n` +
    (result.findings.length ? result.findings.map((item) => `- ${item}`).join("\n") : "- 本阶段通过，程序继续下一阶段") +
    `\n\n## 不阻断的建议\n${(result.notes ?? []).map((item) => `- ${item}`).join("\n") || "- 无"}` +
    `\n\n## 核对依据\n\n\`\`\`json\n${JSON.stringify(result.evidence, null, 2)}\n\`\`\`\n`;
}

export function evidencePath(root, name) {
  return (path.isAbsolute(name) ? path.relative(root, name) : name).replaceAll("\\", "/");
}

/** Dependencies are injectable to test real state transitions without spending model usage. */
export class ProductionRunner {
  constructor(root = ROOT, dependencies = {}) {
    this.root = path.resolve(root);
    this.deps = {
      run: runProcess, resolve: resolveAgent, create: createEpisode, draft: inspectDraft, preview: inspectPreview,
      phones: makePhoneImages, log: console.log, ...dependencies,
    };
    this.abort = new AbortController();
  }

  save(job) { atomicJson(path.join(jobDirectory(this.root, job.id), "state.json"), job); }

  async start(input, options) {
    const requestedId = normalizePaper(input);
    options = defaultOptions(options);
    checkOptions(options);
    // Resolve both executables before downloading or creating a paper folder.
    this.deps.resolve("codex"); this.deps.resolve("claude");
    const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
    const job = {
      id: `${stamp}-${requestedId}-${crypto.randomBytes(4).toString("hex")}`,
      requestedId, folder: `${localDate()}-${requestedId.match(ARXIV_ID)[1]}`,
      options, stage: "init", status: "running", history: [], calls: 0, revisions: 0, feedback: [],
      created: new Date().toISOString(),
    };
    fs.mkdirSync(jobDirectory(this.root, job.id), { recursive: true });
    this.save(job);
    return this.execute(job);
  }

  async resume(id, { feedback, refreshInputs = false, options = {} } = {}) {
    const job = readJob(this.root, id);
    if (job.status === "needs_user" && !feedback?.trim()) throw new Error("这项任务需要你的决定；恢复时加 --feedback 说明处理办法，不能直接忽略问题");
    if ((refreshInputs || Object.keys(options).length) && !feedback?.trim()) throw new Error("变更输入基准或调用上限时必须用 --feedback 写明你的决定");
    job.options = { ...job.options, ...options }; checkOptions(job.options);
    if (feedback) job.feedback.push(`用户补充：${feedback}`);
    if (refreshInputs && job.stage !== "init") {
      job.protected = protectedFingerprint(this.root, job.folder);
      job.stage = "paper"; job.afterSource = "preview";
      job.paperFingerprint = null;
      job.sourceApproved = null; job.visualApproved = null; job.visualIndex = 0;
      job.visualPages = {}; job.visualRound = null;
    }
    this.deps.resolve("codex"); this.deps.resolve("claude");
    return this.execute(job);
  }

  async command(job, file, extra = []) {
    const dir = jobDirectory(this.root, job.id);
    const logFile = safePath(dir, `${String(job.history.length + 1).padStart(3, "0")}-${file.replaceAll("/", "-")}-${crypto.randomBytes(3).toString("hex")}.log`);
    const result = await this.deps.run(process.execPath, [safePath(this.root, `src/${file}`), ...extra], {
      cwd: this.root, signal: this.abort.signal, timeoutMs: job.options.timeoutMs, logFile,
      onSpawn: (pid) => this.lock.child(pid),
    });
    this.lock.child(null);
    if (result.code !== 0) {
      const output = `${result.stderr}\n${result.stdout}`;
      const content = /(?:讲解稿(?:或镜头表)?|镜头表(?:的时间)?)有 \d+ 个问题/.test(output);
      throw new GateError(`检查或制作失败：${output.trim().slice(-1500)}；详见 ${path.relative(this.root, logFile)}`, content ? "content" : "environment");
    }
    return result;
  }

  sourceHash(job) {
    const dir = `episodes/${job.folder}`;
    return fingerprint(this.root, [`${dir}/script.md`, `${dir}/materials.md`, `${dir}/${job.paper.versionedId}.pdf`, ...filesUnder(this.root, `${dir}/related`), ...filesUnder(this.root, `${dir}/output/paper`)]);
  }

  deliveryHash(job) {
    return fingerprint(this.root, ["video.mp4", "cover.png", "subtitles.srt", "chapters.txt"].map((name) => `episodes/${job.folder}/output/${name}`));
  }

  assertManaged(job) {
    const dir = safePath(this.root, `episodes/${job.folder}`);
    const marker = JSON.parse(fs.readFileSync(safePath(dir, ".production-owner.json"), "utf8"));
    if (marker.jobId !== job.id) throw new Error("本期文件夹不是这个自动任务创建的，不能覆盖");
    if (readPublished(path.join(this.root, "episodes")).some((entry) => entry.folder === job.folder)) throw new Error("本期已经发布，自动流程不能重新生成或改稿");
  }

  assertScope(job) {
    if (protectedFingerprint(this.root, job.folder) !== job.protected) throw new Error("共享代码/文档/其他期文件有变化，任务已停止；请确认改动来源后重新安排，程序没有覆盖它们");
    const pdfNames = [`episodes/${job.folder}/${job.paper.versionedId}.pdf`, ...filesUnder(this.root, `episodes/${job.folder}/output/paper`)];
    if (job.paperFingerprint && fingerprint(this.root, pdfNames) !== job.paperFingerprint) throw new Error("论文PDF或原文阅读材料被改动，必须确认来源后重新准备和审核");
  }

  async call(job, stage, context = {}) {
    if (job.calls >= job.options.maxCalls) return { status: "needs_user", summary: "已达到本任务的调用上限", findings: ["已达到本任务的调用上限；请检查任务和返修记录，另行安排剩余工作"], evidence: { source_checked: false, pages: [], images: [], files: [] } };
    this.assertScope(job);
    const dir = jobDirectory(this.root, job.id);
    const order = `${String(job.history.length + 1).padStart(3, "0")}-${stage}${context.page ? `-p${context.page}` : ""}-${crypto.randomBytes(3).toString("hex")}`;
    const schemaFile = safePath(dir, `${order}-schema.json`);
    const resultFile = safePath(dir, `${order}-result.json`);
    const prompt = buildPrompt(job, stage, { ...context, feedback: job.feedback });
    fs.writeFileSync(safePath(dir, `${order}-to-${agentFor(stage)}.md`), prompt, { flag: "wx" });
    fs.writeFileSync(schemaFile, JSON.stringify(RESULT_SCHEMA), { flag: "wx" });
    const executable = this.deps.resolve(agentFor(stage));
    const images = (context.images ?? []).map((name) => safePath(this.root, name));
    const args = agentCommand(agentFor(stage), stage, { schemaFile, resultFile, images });
    const immutable = ["source_review", "visual_review", "video_review"].includes(stage);
    const before = inputFingerprint(this.root, job.folder, { preview: stage !== "source_review" });
    const beforeDelivery = stage === "video_review" ? this.deliveryHash(job) : null;
    const beforeWorklog = fingerprint(this.root, ["WORKLOG.md"]);
    job.calls++; // A failed/incomplete call still consumes the budget and must not be lost on resume.
    this.save(job);
    this.deps.log(`  ${agentFor(stage)}：${STAGE_LABELS[stage]}${context.page ? ` · 第${context.page}页` : ""}`);
    const response = await this.deps.run(executable.command, [...executable.prefix, ...args], {
      cwd: this.root, input: prompt, signal: this.abort.signal, timeoutMs: job.options.timeoutMs,
      logFile: safePath(dir, `${order}.log`), onSpawn: (pid) => this.lock.child(pid),
    });
    this.lock.child(null);
    this.assertScope(job);
    if (fingerprint(this.root, ["WORKLOG.md"]) !== beforeWorklog) throw new Error("agent 或外部进程改了 WORKLOG，已停止；请先核对记录，程序没有覆盖它们");
    if (immutable && inputFingerprint(this.root, job.folder, { preview: stage !== "source_review" }) !== before) throw new Error("只读审核修改了制作输入，已停止，不能使用本轮通过结果");
    if (stage === "video_review" && this.deliveryHash(job) !== beforeDelivery) throw new Error("成片审核修改了交付文件，不能使用本轮通过结果");
    if (response.code !== 0) throw new Error(`agent 调用失败（退出码 ${response.code}），看 .production/jobs/${job.id}/${order}.log`);
    const result = agentFor(stage) === "codex"
      ? validateResult(JSON.parse(fs.readFileSync(resultFile, "utf8"))) : decodeClaude(response.stdout);
    if (agentFor(stage) === "claude") atomicJson(resultFile, result);
    fs.writeFileSync(safePath(dir, `${order}-handoff.md`), handoffResult(result), { flag: "wx" });
    job.history.push({ stage, page: context.page ?? null, status: result.status, summary: result.summary, resultFile: path.basename(resultFile), time: new Date().toISOString() });
    this.save(job);
    return result;
  }

  async logWork(job, task, result, next) {
    const file = safePath(this.root, "WORKLOG.md");
    if (!fs.existsSync(file)) throw new Error("缺少 WORKLOG.md");
    const text = fs.readFileSync(file, "utf8");
    if (!text.includes("## 记录")) throw new Error("WORKLOG.md 缺少记录部分");
    const role = agentFor(task) === "codex" ? "ChatGPT（Codex CLI，自动交接）" : "Claude（Claude Code，自动交接）";
    const row = `### ${localDate()} · ${role}\n\n**任务**：自动制作 ${job.paper.versionedId}：${STAGE_LABELS[task]}（${job.id}）\n\n**完成**\n- ${result.summary.replaceAll("\n", " ")}\n- 状态：${result.status}；详细交接和结果见本地 .production/jobs/${job.id}/\n\n**改动文件**\n- \`episodes/${job.folder}/\`：本阶段制作文件或审核结果，详见交接记录\n- \`WORKLOG.md\`：由调度程序串行追加记录\n\n**交接**\n- → ${next}：${result.findings.length ? result.findings.join("；").replaceAll("\n", " ") : "按自动任务状态继续；成片仍需用户试听、最终确认与手动发布"}\n\n**待确认 / 风险**\n- ${result.status === "pass" ? "本阶段无未解决问题；最终声音和发布由用户确认" : "未通过，不得发布；原因见上面的问题清单"}\n- 未 commit、push 或发布\n\n`;
    // Only the records section changes; historical records remain byte-for-byte unchanged.
    fs.writeFileSync(file, text.replace(/(## 记录\r?\n\r?\n)/, `$1${row.replaceAll("$", "$$$$")}`));
  }

  needUser(job, findings) {
    job.status = "needs_user";
    job.feedback = findings;
    job.message = findings.join("；");
    this.save(job);
  }

  updateTask(job) {
    const file = safePath(this.root, "WORKLOG.md");
    if (!fs.existsSync(file)) return;
    let text = fs.readFileSync(file, "utf8");
    const allocate = () => Math.max(0, ...[...text.matchAll(/^\| T(\d+) \|/gm)].map((m) => Number(m[1]))) + 1;
    const add = (row) => {
      const marker = text.match(/\r?\n## 记录/);
      if (!marker) throw new Error("WORKLOG 缺少记录部分");
      const before = text.slice(0, marker.index).trimEnd();
      text = `${before}\n${row}\n\n${text.slice(marker.index).trimStart()}`;
    };
    const state = job.status === "ready" ? "已完成" : job.status === "running" ? "进行中" : "待处理";
    if (!job.worklogTask) {
      job.worklogTask = allocate();
      add(`| T${job.worklogTask} | 自动制作 ${job.paper.versionedId}（${job.id}）：稿件、素材、独立审核、预览、返修及本地成片；最终确认/发布由用户负责 | Claude、ChatGPT | 用户 | ${state} |`);
    } else {
      const pattern = new RegExp(`^(\\| T${job.worklogTask} \\|[^\\r\\n]*\\| )(?:待处理|进行中|已完成|暂缓|已取消)( \\|)$`, "m");
      const row = text.match(pattern)?.[0];
      if (!row || !row.includes(job.id)) throw new Error("自动任务交接行被修改，请先核对工作记录");
      text = text.replace(pattern, `$1${state}$2`);
    }
    if (job.status === "ready" && !job.confirmationTask) {
      job.confirmationTask = allocate();
      add(`| T${job.confirmationTask} | 最终审核自动制作的 ${job.paper.versionedId}：看成片、听声音、确认内容后手动上传；发布后交 Claude 维护 published.json（${job.id}） | 用户 | 自动调度程序 | 待处理 |`);
    }
    const current = `- **自动制作任务**：${job.paper.versionedId}（${job.id}），${STAGE_LABELS[job.stage]}；${job.status === "ready" ? "等待用户试听、最终确认和手动发布" : job.status === "running" ? "自动进行中" : job.message ?? "等待恢复"}`;
    if (/^- \*\*自动制作任务\*\*：.*$/m.test(text)) text = text.replace(/^- \*\*自动制作任务\*\*：.*$/m, () => current);
    else text = text.replace(/(## 当前状态\r?\n)/, (_, heading) => `${heading}\n${current}\n`);
    fs.writeFileSync(file, text);
    this.save(job);
  }

  revise(job, stage, findings) {
    job.revisions++;
    job.stage = stage;
    if (job.revisions > job.options.maxRevisions) { this.needUser(job, ["已达到返修轮数上限", ...findings]); return false; }
    job.feedback = findings;
    job.visualIndex = 0;
    job.visualApproved = null;
    job.visualRound = null;
    this.save(job);
    return true;
  }

  visualBatches(job) {
    const batches = [];
    for (const page of job.pages) {
      if (job.visualPages?.[page] === job.pageHashes[page]) continue;
      const frames = job.previewImages.filter((image) => image.page === page);
      for (let i = 0; i < frames.length; i += 6) {
        const moments = frames.slice(i, i + 6);
        const images = moments.flatMap((image) => [
          `episodes/${job.folder}/output/production-phone/${image.file}`,
          `episodes/${job.folder}/output/preview/${image.file}`,
        ]);
        batches.push({ page, images, moments });
      }
    }
    return batches;
  }

  async reviewVisualRound(job) {
    const batches = this.visualBatches(job);
    job.visualRound ??= { fingerprint: job.previewFingerprint, index: 0, results: [] };
    const round = job.visualRound;
    if (round.fingerprint !== job.previewFingerprint) throw new Error("审核轮次与预览不一致，必须重做预览");
    const remaining = batches.length - round.index;
    job.callEstimate = { batches: batches.length, remaining, recommendedTotal: job.calls + remaining * (job.options.maxRevisions - job.revisions + 1) + 4 };
    if (job.options.maxCalls - job.calls < remaining) {
      this.needUser(job, [`剩余调用额度不足以完成本轮 ${remaining} 批图片审核；至少需要总上限 ${job.calls + remaining}，含后续返修建议 ${job.callEstimate.recommendedTotal}`]);
      return;
    }
    while (round.index < batches.length) {
      if (this.abort.signal.aborted) throw new Error("任务已停止，可以恢复");
      if (inputFingerprint(this.root, job.folder, { preview: true }) !== job.previewFingerprint) {
        job.stage = "preview"; job.visualRound = null; this.save(job); return;
      }
      const phoneHash = () => fingerprint(this.root, job.previewImages.map((image) => `episodes/${job.folder}/output/production-phone/${image.file}`));
      if (phoneHash() !== job.phoneFingerprint) throw new Error("手机预览图片被改动，不能继续使用之前的审核");
      const batch = batches[round.index];
      let result = await this.call(job, "visual_review", batch);
      if (phoneHash() !== job.phoneFingerprint) throw new Error("手机预览图片被改动，不能使用本批审核结果");
      const seen = result.evidence.images.map((name) => evidencePath(this.root, name));
      if (result.status === "pass" && (!result.evidence.pages.includes(batch.page) || batch.images.some((name) => !seen.includes(name)))) {
        result = { ...result, status: "needs_user", summary: "程序拒绝未覆盖全部图片的通过结果", findings: ["图片审核没有覆盖本批全部手机图和原尺寸图，不能标记通过"] };
      }
      round.results.push({ page: batch.page, result });
      round.index++;
      this.save(job); // Individual reports remain local; one WORKLOG summary per complete round.
    }
    job.visualPages ??= {};
    for (const page of job.pages) {
      const results = round.results.filter((item) => item.page === page);
      if (results.length && results.every((item) => item.result.status === "pass")) job.visualPages[page] = job.pageHashes[page];
    }
    const failures = round.results.filter((item) => item.result.status !== "pass");
    const status = failures.some((item) => item.result.status === "needs_user") ? "needs_user" : failures.length ? "changes_requested" : "pass";
    const result = {
      status, summary: `本轮图片审核完成 ${batches.length} 批，${new Set(batches.map((b) => b.page)).size} 页；${failures.length} 批未通过，未变且已通过的页保留审核`,
      findings: [...new Set(failures.flatMap(({ page, result }) => result.findings.map((finding) => `第 ${page} 页：${finding}`)))],
      notes: round.results.flatMap((item) => item.result.notes ?? []),
      evidence: { source_checked: false, pages: [...new Set(batches.map((b) => b.page))], images: batches.flatMap((b) => b.images), files: [] },
    };
    job.visualRound = null;
    if (status === "needs_user") this.needUser(job, result.findings);
    else if (status === "changes_requested") this.revise(job, "assets_fix", result.findings);
    else { job.visualApproved = job.previewFingerprint; job.stage = "render"; this.save(job); }
    await this.logWork(job, "visual_review", result, status === "needs_user" ? "用户" : "自动调度程序 / Claude");
  }

  async execute(job) {
    try { this.lock = acquireLock(this.root, job.id); }
    catch (error) { job.status = "paused"; job.message = error.message; this.save(job); throw error; }
    const stoppedFile = safePath(jobDirectory(this.root, job.id), "stop");
    if (fs.existsSync(stoppedFile)) fs.rmSync(stoppedFile);
    this.abort = new AbortController();
    const timer = setInterval(() => { if (fs.existsSync(stoppedFile)) this.abort.abort(); }, 500);
    const interrupt = () => this.abort.abort();
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", interrupt);
    try {
      job.status = "running";
      this.save(job);
      if (job.stage === "init") {
        const folder = safePath(this.root, `episodes/${job.folder}`);
        if (fs.existsSync(folder)) throw new Error("本期文件夹已存在；没有接管或覆盖它。请先确认已有稿件归属");
        const created = await this.deps.create(job.requestedId, {
          dir: safePath(this.root, "episodes"), date: job.folder.slice(0, 10), log: this.deps.log,
          fetchImpl: (url, options) => fetch(url, { ...options, signal: AbortSignal.any([options.signal, this.abort.signal].filter(Boolean)) }),
        });
        if (path.resolve(created.folder) !== folder) throw new Error("创建的论文目录与请求不一致，任务停止");
        job.paper = { ...created.paper };
        job.stage = "paper";
        fs.writeFileSync(safePath(folder, ".production-owner.json"), JSON.stringify({ jobId: job.id }), { flag: "wx" });
        job.protected = protectedFingerprint(this.root, job.folder);
        this.save(job);
      }
      this.assertManaged(job);
      this.assertScope(job);
      this.updateTask(job);
      // Reusing a review after edits or interrupted render is forbidden.
      if (!SOURCE_STAGES.has(job.stage) && this.sourceHash(job) !== job.sourceApproved) {
        job.afterSource = ["assets", "assets_fix"].includes(job.stage) ? job.stage : "preview";
        job.stage = "source_review";
      }
      if (["visual_review", "render", "video_review", "ready"].includes(job.stage) && job.previewFingerprint
        && inputFingerprint(this.root, job.folder, { preview: true }) !== job.previewFingerprint) {
        job.stage = "preview"; job.visualIndex = 0; job.visualApproved = null;
      }
      if (["video_review", "ready"].includes(job.stage) && this.deliveryHash(job) !== job.deliveryFingerprint) job.stage = "render";
      if (job.stage === "ready") { job.status = "ready"; this.save(job); return job; }
      while (job.status === "running") {
        if (this.abort.signal.aborted) throw new Error("任务已停止，可以恢复");
        this.assertManaged(job); this.assertScope(job);
        this.save(job);
        this.deps.log(`\n${STAGE_LABELS[job.stage]} · ${job.id}`);
        const stage = job.stage;
        if (stage === "paper") {
          await this.command(job, "paper-text.js", [`episodes/${job.folder}`, job.paper.versionedId]);
          job.paperFingerprint = fingerprint(this.root, [`episodes/${job.folder}/${job.paper.versionedId}.pdf`, ...filesUnder(this.root, `episodes/${job.folder}/output/paper`)]);
          job.stage = fs.existsSync(safePath(this.root, `episodes/${job.folder}/materials.md`)) ? "source_review" : "draft";
          continue;
        }
        if (stage === "preview") {
          try {
            await this.command(job, "render.js", ["--check", `episodes/${job.folder}`]);
            await this.command(job, "preview.js", [`episodes/${job.folder}`]);
            const checked = await this.deps.preview(this.root, job);
            await this.deps.phones(this.root, job, checked.images);
            job.pages = checked.pages; job.previewImages = checked.images; job.duration = checked.duration;
            if (!checked.pageHashes || checked.pages.some((page) => typeof checked.pageHashes[page] !== "string")) throw new Error("缺少逐页预览指纹，不能复用审核");
            job.pageHashes = checked.pageHashes;
            job.previewFingerprint = inputFingerprint(this.root, job.folder, { preview: true });
            job.phoneFingerprint = fingerprint(this.root, checked.images.map((image) => `episodes/${job.folder}/output/production-phone/${image.file}`));
            job.visualRound = null; job.visualIndex = 0; job.stage = "visual_review";
          } catch (error) {
            if (this.abort.signal.aborted) throw error;
            if (error.kind !== "content") throw error; // Network/TTS/browser/unknown faults pause without a repair.
            this.revise(job, "assets_fix", [error.message]);
            await this.logWork(job, stage, { status: "changes_requested", summary: "稿件或镜头表检查未通过", findings: [error.message] }, "Claude");
          }
          continue;
        }
        if (stage === "render") {
          let checked;
          try { checked = await this.deps.preview(this.root, job); }
          catch (error) {
            if (error.kind !== "stale") throw error;
            job.stage = "preview"; job.visualRound = null; continue;
          }
          if (inputFingerprint(this.root, job.folder, { preview: true }) !== job.visualApproved) {
            job.stage = "preview"; job.visualIndex = 0; continue;
          }
          await this.command(job, "render.js", [`episodes/${job.folder}`]);
          if (inputFingerprint(this.root, job.folder, { preview: true }) !== job.visualApproved) {
            job.stage = "preview"; job.visualIndex = 0; continue;
          }
          for (const name of ["video.mp4", "cover.png", "subtitles.srt", "chapters.txt"]) {
            const file = safePath(this.root, `episodes/${job.folder}/output/${name}`);
            if (!fs.existsSync(file) || fs.statSync(file).size === 0) throw new Error(`成片缺少 ${name}`);
          }
          job.pages = checked.pages; job.stage = "video_review";
          job.deliveryFingerprint = this.deliveryHash(job);
          continue;
        }
        if (stage === "visual_review") {
          if (inputFingerprint(this.root, job.folder, { preview: true }) !== job.previewFingerprint) {
            job.stage = "preview"; continue;
          }
          if (fingerprint(this.root, job.previewImages.map((image) => `episodes/${job.folder}/output/production-phone/${image.file}`)) !== job.phoneFingerprint) throw new Error("手机预览图片被改动，不能继续使用之前的审核");
          await this.reviewVisualRound(job);
          continue;
        }
        if (!AGENT_STAGES.includes(stage)) throw new Error("未识别的制作阶段");
        let result = await this.call(job, stage);
        if (result.status === "needs_user") this.needUser(job, result.findings);
        else if (result.status === "changes_requested") this.revise(job, SOURCE_STAGES.has(stage) ? "source_fix" : "assets_fix", result.findings);
        else if (stage === "draft" || stage === "source_fix") {
          const draft = this.deps.draft(this.root, job, { allowMissing: true });
          if (draft.errors.length || draft.warnings.length) {
            const findings = [...draft.errors, ...draft.warnings];
            this.revise(job, "source_fix", findings);
            result = { ...result, status: "changes_requested", summary: "写稿报告完成，但程序检查未通过", findings };
          }
          else { job.stage = "source_review"; job.feedback = []; }
        } else if (stage === "source_review") {
          const draft = this.deps.draft(this.root, job, { allowMissing: true });
          if (!result.evidence.source_checked || draft.errors.length || draft.warnings.length) {
            const findings = ["原文审核必须确认读过原文并处理所有检查问题", ...draft.errors, ...draft.warnings];
            this.revise(job, "source_fix", findings);
            result = { ...result, status: "changes_requested", summary: "原文审核证据或检查结果不完整，不能放行", findings };
          } else {
            job.sourceApproved = this.sourceHash(job);
            job.stage = job.afterSource ?? "assets"; job.afterSource = null; job.feedback = [];
          }
        } else if (stage === "assets" || stage === "assets_fix") {
          if (this.sourceHash(job) !== job.sourceApproved) { job.afterSource = "preview"; job.stage = "source_review"; }
          else job.stage = "preview";
          job.feedback = [];
        } else if (stage === "video_review") {
          if (job.pages.some((page) => !result.evidence.pages.includes(page)) || result.evidence.images.length === 0) {
            const findings = ["成片检查没有覆盖全部页码或实际抽帧，不能交付为已检查"];
            this.needUser(job, findings);
            result = { ...result, status: "needs_user", summary: "成片检查缺少覆盖依据，不能放行", findings };
          } else {
            for (const rawImage of result.evidence.images) {
              const image = evidencePath(this.root, rawImage);
              if (!image.startsWith(`episodes/${job.folder}/output/`) || !fs.existsSync(safePath(this.root, image))) throw new Error("成片检查引用的图片不存在或不属于本期");
            }
            job.stage = "ready"; job.status = "ready"; job.message = "成片已完成，请看画面、听声音，最终确认后手动上传";
          }
        }
        this.save(job);
        await this.logWork(job, stage, result, job.status === "ready" || job.status === "needs_user" ? "用户" : agentFor(job.stage));
      }
      return job;
    } catch (error) {
      job.status = "paused";
      job.message = error.message;
      this.save(job);
      return job;
    } finally {
      clearInterval(timer);
      process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
      if (job.paper) {
        try { this.updateTask(job); } catch (error) { this.deps.log(`工作记录交接未更新：${error.message}`); }
      }
      this.lock.release();
    }
  }
}

const USAGE = `DailyPaper 自动制作（本地运行，最后由你确认、上传）

  npm run produce -- <arXiv链接或编号> [--minutes 5] [--audience 科普向]
  npm run produce -- list
  npm run produce -- status <任务编号>
  npm run produce -- resume <任务编号> [--feedback "你的补充或决定"]
  npm run produce -- stop <任务编号>
  npm run produce -- doctor
  npm run produce -- <链接或编号> --dry-run

  可选：--max-revisions 3（整项任务返修上限） --max-calls 100（总模型调用上限）
        --timeout-minutes 20（每次调用/制作步骤的超时）
  Ctrl+C 会停止并保留进度。任务及每轮交接在 .production/jobs/，不会提交到Git。
  沿用本机CLI登录和模型配置；限额或认证失败时暂停，不自动切换API。`;

export function parseArgs(args) {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") return { action: "help" };
  const commands = new Set(["list", "status", "resume", "stop", "doctor"]);
  const action = commands.has(args[0]) ? args[0] : "start";
  const positional = [], values = {};
  let dryRun = false, refreshInputs = false;
  const flags = { "--minutes": "minutes", "--audience": "audience", "--max-revisions": "maxRevisions", "--max-calls": "maxCalls", "--timeout-minutes": "timeoutMs", "--feedback": "feedback" };
  const tail = args.slice(action === "start" ? 0 : 1);
  for (let i = 0; i < tail.length; i++) {
    const arg = tail[i];
    if (arg === "--dry-run") { dryRun = true; continue; }
    if (arg === "--refresh-inputs") { refreshInputs = true; continue; }
    if (arg.startsWith("--")) {
      const key = flags[arg];
      if (!key || !tail[i + 1] || tail[i + 1].startsWith("--") || key in values) throw new Error(`参数无效：${arg}`);
      const value = tail[++i];
      values[key] = ["audience", "feedback"].includes(key) ? value : Number(value) * (key === "timeoutMs" ? 60_000 : 1);
    } else positional.push(arg);
  }
  if (action === "start") {
    if (positional.length !== 1 || values.feedback || refreshInputs) throw new Error(USAGE);
    const options = defaultOptions(values); checkOptions(options);
    return { action, input: normalizePaper(positional[0]), options, dryRun };
  }
  if (dryRun || (refreshInputs || Object.keys(values).length) && action !== "resume") throw new Error("这些参数只能用于启动或恢复任务");
  if (["status", "resume", "stop"].includes(action) ? positional.length !== 1 : positional.length !== 0) throw new Error(USAGE);
  const { feedback, ...changes } = values;
  if (Object.keys(changes).length) checkOptions(defaultOptions(changes));
  return { action, id: positional[0], feedback, refreshInputs, options: changes };
}

function printJob(job) {
  console.log(`${job.id}\n  ${job.requestedId} · ${STAGE_LABELS[job.stage] ?? "准备论文"} · ${job.status}\n  ${job.message ?? ""}\n  交接：.production/jobs/${job.id}/\n  本期：episodes/${job.folder}/`);
  if (job.status === "ready") console.log(`  成片：episodes/${job.folder}/output/video.mp4\n  封面：episodes/${job.folder}/output/cover.png`);
}

export async function main(args = process.argv.slice(2), root = ROOT) {
  const options = parseArgs(args);
  if (options.action === "help") { console.log(USAGE); return; }
  if (options.action === "doctor") {
    for (const name of ["codex", "claude"]) {
      const { command, prefix } = resolveAgent(name);
      const result = await runProcess(command, [...prefix, "--version"], { cwd: root, timeoutMs: 30_000 });
      if (result.code !== 0) throw new Error(`${name} 无法启动`);
      console.log(`${name}：${result.stdout.trim()}`);
    }
    console.log("工具可启动。请确保已分别登录；这项检查没有请求模型，也不验证剩余额度。\n使用 --dry-run 可查看流程，提交论文链接后才开始模型调用。");
    return;
  }
  if (options.action === "list") {
    const dir = safePath(root, ".production/jobs");
    if (!fs.existsSync(dir)) { console.log("还没有自动制作任务。"); return; }
    for (const id of fs.readdirSync(dir).filter((name) => JOB_ID.test(name))) printJob(readJob(root, id));
    return;
  }
  if (options.action === "status") { printJob(readJob(root, options.id)); return; }
  if (options.action === "stop") {
    const job = readJob(root, options.id);
    fs.writeFileSync(safePath(jobDirectory(root, job.id), "stop"), "停止请求\n");
    console.log("已请求停止；运行中的程序会终止当前子进程并保留进度。");
    return;
  }
  if (options.dryRun) {
    console.log(`论文：${options.input} · ${options.options.minutes}分钟 · ${options.options.audience}\n` +
      "下载指定版本PDF → Codex写稿 → Codex独立核对原文 → Claude做素材/镜头表 → 完整预览 → Codex逐图审核 → 返修/复审 → 合成 → Claude查画面/时间轴 → 你试听、确认、上传\n" +
      `最多${options.options.maxRevisions}轮返修、${options.options.maxCalls}次模型调用，每步最多${options.options.timeoutMs / 60_000}分钟。\n本次没有创建文件、联网、调用模型或启动制作。`);
    return;
  }
  const runner = new ProductionRunner(root);
  const job = options.action === "resume" ? await runner.resume(options.id, options) : await runner.start(options.input, options.options);
  printJob(job);
  if (job.status !== "ready") process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(`自动制作暂停：${error.message}`); process.exitCode = 1; });
}
