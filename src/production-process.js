// Start CLI processes without interpolating prompts, URLs or paths into a shell command.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

export function resolveAgent(name, { env = process.env, platform = process.platform } = {}) {
  const override = env[`DAILYPAPER_${name.toUpperCase()}_BIN`];
  const directories = (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean);
  const candidates = override ? [override] : [];
  if (!override) {
    for (const directory of directories) {
      candidates.push(path.join(directory, platform === "win32" ? `${name}.exe` : name));
      // npm's Windows .cmd/.ps1 shims cannot be spawned directly. Use the package's real bin.
      const packageDir = path.join(directory, "node_modules", name === "claude" ? "@anthropic-ai/claude-code" : "@openai/codex");
      const manifest = path.join(packageDir, "package.json");
      if (fs.existsSync(manifest)) {
        const bin = JSON.parse(fs.readFileSync(manifest, "utf8")).bin;
        const entry = typeof bin === "string" ? bin : bin?.[name];
        if (entry) candidates.push(path.resolve(packageDir, entry));
      }
    }
    if (platform === "win32" && name === "claude") {
      candidates.push(path.join(env.USERPROFILE ?? "", ".local", "bin", "claude.exe"));
    }
    if (platform === "win32" && name === "codex" && env.LOCALAPPDATA) {
      const dir = path.join(env.LOCALAPPDATA, "OpenAI", "Codex", "bin");
      if (fs.existsSync(dir)) {
        const bins = fs.readdirSync(dir).map((item) => path.join(dir, item, "codex.exe"))
          .filter((file) => fs.existsSync(file)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
        candidates.push(...bins);
      }
    }
  }
  const file = candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  if (!file) throw new Error(`找不到 ${name}，请安装并登录，或设置 DAILYPAPER_${name.toUpperCase()}_BIN 为可执行文件的绝对路径`);
  if (/\.(cmd|bat|ps1)$/i.test(file)) throw new Error(`${name} 请使用实际的 .exe 或 .js 文件路径，不能使用命令行包装脚本`);
  return /\.[cm]?js$/i.test(file)
    ? { command: process.execPath, prefix: [path.resolve(file)] }
    : { command: path.resolve(file), prefix: [] };
}

export function killTree(child) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    // AppContainer can delay or refuse taskkill even for an owned process. Do not hang forever
    // waiting for that helper; terminate the direct child as a fallback as well.
    const fallback = setTimeout(() => child.kill("SIGKILL"), 1000);
    child.once("close", () => clearTimeout(fallback));
    const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    killer.on("error", () => child.kill("SIGKILL"));
    killer.on("close", (code) => { if (code !== 0) child.kill("SIGKILL"); });
  } else {
    try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  }
}

/** A timeout/cancellation kills the entire tree and waits for it to exit before releasing locks. */
export function runProcess(command, args, { cwd, input = "", timeoutMs = 20 * 60_000, signal, logFile, maxBytes = 16 * 1024 * 1024, onSpawn = () => {} } = {}) {
  if (signal?.aborted) return Promise.reject(new Error("任务已停止"));
  return new Promise((resolve, reject) => {
    const output = { stdout: [], stderr: [] };
    let bytes = 0, failure = null;
    const log = logFile ? fs.openSync(logFile, "wx") : null;
    const child = spawn(command, args, { cwd, windowsHide: true, shell: false, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    child.on("spawn", () => { onSpawn(child.pid); if (failure) killTree(child); });
    const stop = (message) => {
      if (!failure) { failure = new Error(message); killTree(child); }
    };
    const timer = setTimeout(() => stop("这一步超时，子进程已停止；可以查看交接记录后恢复"), timeoutMs);
    const cancel = () => stop("任务已停止，可以恢复");
    signal?.addEventListener("abort", cancel, { once: true });
    const collect = (stream, chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) { stop("进程输出超过上限，已停止"); return; }
      if (log !== null) fs.writeSync(log, chunk);
      output[stream].push(chunk);
    };
    child.stdout.on("data", (chunk) => collect("stdout", chunk));
    child.stderr.on("data", (chunk) => collect("stderr", chunk));
    child.stdin.on("error", () => {}); // A failed startup can close stdin before the prompt is written.
    child.on("error", (error) => { failure ??= error; });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      if (log !== null) fs.closeSync(log);
      if (failure) reject(failure);
      else resolve({ code, stdout: Buffer.concat(output.stdout).toString("utf8"), stderr: Buffer.concat(output.stderr).toString("utf8") });
    });
    child.stdin.end(input);
  });
}
