# WORKLOG — dailypaper 工作记录

> 每个 agent 开始工作前先读这里，结束时按 [AGENTS.md](AGENTS.md) 第 4 节的格式记录。
> 最新的记录写在最上面；只追加，不删改别人的记录。

## 当前状态

- **阶段**：想法 / 规划阶段，还没开始制作
- **分工**：Claude 写代码；ChatGPT 写稿，并审核代码和讲解稿；Gemini 制作视频（见 AGENTS.md）
- **方式**：先手动（用户操作 ChatGPT 和 Gemini），流程成熟后再自动化
- **方向**：先只做 AI（跟着 Hugging Face 日榜选题），流程稳定后再加其他方向
- **Git**：已推到 GitHub（https://github.com/MontagneMount/dailypaper），分支 main
- **下一步**：M1 手动跑通第一条视频（T7），等用户决定何时开始
- **最近更新**：2026-10-06 · Claude

## 待办交接

| 编号 | 任务 | 交给 | 提出者 | 状态 |
|---|---|---|---|---|
| T1 | 确认 AGENTS.md 的协作规则，指定 Claude 和 ChatGPT 的分工 | 用户 | Claude | 已完成 |
| T2 | 决定 README「待决定」里的 4 个问题 | 用户 | Claude | 已完成 |
| T3 | 决定首次 commit 的时机 | 用户 | Claude | 已完成 |
| T4 | M1：输入一个 arXiv ID，输出讲解稿（旧 M1，已被新里程碑取代） | 待分配 | Claude | 已取消 |
| T5 | 确认分工细节：① ChatGPT「审核」的范围（代码、讲解稿还是视频）；② ChatGPT 写稿、Gemini 做视频是手动操作，还是由程序调用 API | 用户 | Claude | 已完成 |
| T6 | T5 确认后，按新分工更新 README 的工作流、技术栈和里程碑 | Claude | Claude | 已完成 |
| T7 | M1 手动跑通第一条视频：选论文 → ChatGPT 写稿 → ChatGPT 审稿 → 用户确认 → Gemini 制作视频 → 发布；记下提示词、耗时和问题，确定 Gemini 做视频的方式 | 用户 | Claude | 待处理 |
| T8 | 决定选题起步方式：一开始就覆盖六个方向，还是先只做 AI（有现成日榜），流程稳定后再加其他方向 | 用户 | Claude | 已完成 |

## 记录

### 2026-10-06 · Claude（Claude Code）

**任务**：记录选题起步方式（T8）和 GitHub 推送

**完成**
- 用户决定：先只做 AI，流程稳定后再加其他方向
- 用户已把仓库推到 GitHub：https://github.com/MontagneMount/dailypaper（已确认本地 main 和 origin/main 一致）
- README：
  - 项目简介和「选题与受众」按「先做 AI」更新
  - M1 改成从 Hugging Face 日榜选一篇 AI 论文；M2 的选题脚本先接 Hugging Face
  - 新增 M5「扩展方向」；删除已解决的「待决定」
- AGENTS.md：项目简介同步更新，加上 GitHub 仓库地址

**改动文件**
- `README.md`：项目简介、「选题与受众」、里程碑；删除「待决定」
- `AGENTS.md`：项目简介、GitHub 仓库地址
- `WORKLOG.md`：T8 已完成；更新当前状态

**交接**
- → 用户：有空时按 M1 手动跑通第一条视频（T7）

**待确认 / 风险**
- 无

### 2026-10-06 · Claude（Claude Code）

**任务**：按用户要求做首次 commit（T3）

**完成**
- 把现有的 5 个文件（README.md、AGENTS.md、WORKLOG.md、CLAUDE.md、.gitignore）作为仓库的第一个 commit 提交；本条记录也包含在这次 commit 里

**改动文件**
- `WORKLOG.md`：T3 标为已完成，更新当前状态，新增本条记录

**交接**
- 无

**待确认 / 风险**
- 还没推到 GitHub，push 需要用户同意

### 2026-10-06 · Claude（Claude Code）

**任务**：记录用户对 T2 的决定，调研各方向有没有论文榜单

**完成**
- 用户决定：
  - 受众按论文决定：能通俗讲的做科普向，专业性强的做专业向
  - 方向：AI、经济、材料、化学、数学、物理；有榜单就跟榜单选，没有就自己拓展
  - 不用本人声音，由 Gemini 配音
  - 每个视频都必须审核，审核时间不固定
- 调研榜单：Hugging Face Daily Papers 有日榜、周榜、月榜（已在浏览器里确认），alphaXiv 能看 arXiv 论文的浏览量和点赞；其他方向没有统一的日榜，只能用每周精选或关注度代替
- README：项目简介扩展到六个方向；新增「选题与受众」和选题来源表；写稿步骤加上「先判断科普向还是专业向」；「待决定」只剩选题起步方式
- AGENTS.md：项目简介同步更新；新增「发布前审核」规则

**改动文件**
- `README.md`：项目简介、工作流①③⑤、「选题与受众」、「待决定」
- `AGENTS.md`：项目简介、「发布前审核」规则
- `WORKLOG.md`：T2 已完成，新增 T8；当前状态加上方向

**交接**
- → 用户：决定选题起步方式（T8）

**待确认 / 风险**
- 选题来源表里除了 Hugging Face 和 alphaXiv，其他来源都还没核实，M2 写选题脚本前要逐个确认

### 2026-10-06 · Claude（Claude Code）

**任务**：记录分工细节（T5），按新分工更新 README（T6）

**完成**
- 用户确认：ChatGPT 审核 Claude 写的代码和讲解稿内容（视频制作之前的所有内容）；ChatGPT 和 Gemini 先手动操作，成熟后再自动化
- 重写 README 的定位、工作流、技术栈和里程碑：
  - 写稿、审稿改由 ChatGPT 完成，视频改由 Gemini 制作；DeepSeek 不再用于写稿
  - 新的 M1 不写代码，先手动跑通一条视频；原来用代码合成视频的方案保留为备选
- 旧 M1（T4）被新里程碑取代，标为已取消
- AGENTS.md 补充 ChatGPT 的审核范围、「先手动」原则和版权规则；用户角色改为「最终确认内容」；交接状态增加「已取消」

**改动文件**
- `README.md`：更新定位、工作流、技术栈、里程碑、注意事项和协作方式；删除顶部「待更新」提示
- `AGENTS.md`：更新参与者表、交接状态说明、合规规则
- `WORKLOG.md`：T4 已取消，T5、T6 已完成，新增 T7；更新当前状态

**交接**
- → 用户：有空时按 M1 手动跑通第一条视频（T7）

**待确认 / 风险**
- Gemini 能否做出合适的论文讲解视频还不确定，M1 会验证；做不到就启用代码合成视频的备选方案

### 2026-10-06 · Claude（Claude Code）

**任务**：按用户确定的分工更新协作共识（T1）

**完成**
- 用户确定分工：Claude 写代码；ChatGPT 审核、写稿；Gemini 制作视频
- 把分工写进 AGENTS.md 的参与者表
- 发现 README 的工作流和技术栈还是旧方案（DeepSeek 写稿、代码合成视频），和新分工不一致：已在 README 顶部加提示，等 T5 确认后再改

**改动文件**
- `AGENTS.md`：参与者表写入分工
- `README.md`：顶部加「待按新分工更新」的提示；「协作方式」写入分工
- `WORKLOG.md`：T1 标为已完成，新增 T5、T6，更新当前状态

**交接**
- → 用户：确认分工细节（T5）
- → Claude：T5 确认后更新 README 的工作流、技术栈和里程碑（T6）

**待确认 / 风险**
- M1「输入一个 arXiv ID，输出讲解稿」可能要随新分工调整
- ChatGPT 审核代码时需要能看到代码：用 Codex 打开本地仓库，或推到 GitHub 后让 ChatGPT 连接仓库

### 2026-10-06 · Claude（Claude Code）

**任务**：建立多 agent 协作机制

**完成**
- 新建协作共识和工作记录：每个 agent 开始工作前先读，结束后记录
- 让 Claude Code 每次自动读取协作共识
- README 加上「协作方式」一节

**改动文件**
- `AGENTS.md`：新建，协作共识（最高优先级）
- `WORKLOG.md`：新建，工作记录（本文件）
- `CLAUDE.md`：新建，引入 AGENTS.md
- `README.md`：新增「协作方式」一节

**交接**
- → 用户：确认协作规则，指定分工（T1）
- → 用户：决定首次 commit 的时机（T3）

**待确认 / 风险**
- 各 agent 的具体分工还没定
- 所有文件都还没 commit

### 2026-10-05 · Claude（Claude Code）

**任务**：确定项目想法，建立仓库

**完成**
- 和用户讨论项目想法，确定定位、工作流、技术栈和里程碑
- 决定建独立仓库 `D:\Vibecoding\dailypaper`，不放在 EX 下，方便以后单独推到 GitHub
- 用 `git init -b main` 初始化仓库

**改动文件**
- `README.md`：新建，项目规划
- `.gitignore`：新建，排除 node_modules、.env、output/ 和日志

**交接**
- → 用户：决定 README「待决定」里的 4 个问题

**待确认 / 风险**
- 无
