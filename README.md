# dailypaper

每天挑选一篇热门的前沿论文，生成中文讲解稿，做成视频发布到 B 站（栏目名「DailyPaper 每日论文」）。先做 AI，之后扩展到经济、材料、化学、数学、物理。

> **状态：✅ M1 完成**：已发布 2 期：[【每日论文 #1】Kandinsky 6.0 Video](https://www.bilibili.com/video/BV1PdpN6SEk7/)、[【每日论文 #2】Memadapter](https://www.bilibili.com/video/BV1PFpM6REtz/)（都在 2026-10-07），发布记录见 [episodes/published.json](episodes/published.json)。M2 的选题和开工脚本已做好，正在做 M3 的连续发布。

## 快速开始

需要 Node.js 20 以上。截图用的是 Windows 自带的 Microsoft Edge，不用另外装浏览器。

```bash
npm install
npm run render -- episodes/example
```

生成的视频在 `episodes/example/output/video.mp4`，同一个文件夹里还有 SRT 字幕 `subtitles.srt` 和 B 站封面 `cover.png`。

**做新的一期**：

```bash
npm run topics
npm run new -- <arXiv 编号>
```

`npm run topics` 列出 Hugging Face 日榜的候选论文，按点赞数排序，已发布和制作中的会标出来（`-- --date 2026-10-06` 看某一天）。选好后运行 `npm run new`，它会查 arXiv（核对返回的确实是这篇、这个版本，标题、作者、日期齐全），下载论文 PDF，再建好 `episodes/<日期>-<arXiv 编号>/`，生成填好论文信息的 `script.md` 开头，同时显示论文的许可证。中途出错不会留下半成品，已经有的文件夹也不会被改动。本期文件夹里有这些文件：

- `<arXiv 编号>v<版本>.pdf`：论文 PDF，如 `2610.05608v1.pdf`（不提交到仓库）
- `script.md`：讲解稿，格式见 [docs/script-format.md](docs/script-format.md)
- `figures/`：论文原图，如 `figure2.png`（有版权，不提交到仓库）。由 Claude 用 `npm run figure` 从 PDF 原样截取：先 `npm run figure -- <本期文件夹> <页码>` 渲染整页找到图，再 `npm run figure -- <本期文件夹> <页码> <名字> <上,左,下,右>` 截出来（范围是 0～1 的小数，白边会自动裁掉）
- `diagrams/`：示意图，如 `page5.svg`（Claude 按稿子画，优先写成 SVG；颜色用类名，跟着风格走，画法见 [templates/README.md](templates/README.md)「示意图怎么画」）

**期数和发布记录**：已发布的视频记在 [episodes/published.json](episodes/published.json)（期数、文件夹、标题、B 站链接、发布日期）。用户发布后把链接发给 Claude，由 Claude 记上。新一期的期数按这个记录往下排，不按文件夹数；同时有几期在做时，哪一期先发布就用这个号，`npm run check` 会提醒其他期改号。

生成之前，可以先只检查稿子：

```bash
npm run check -- episodes/<本期文件夹>
```

可选参数：`--theme dark` 换成深色风格（默认是浅色学术，见 [templates/README.md](templates/README.md)「风格」）；`--voice zh-CN-YunxiNeural` 换成男声（默认是女声「晓晓」）；`--rate +0%` 换回正常语速（默认是 `+25%`，也就是 1.25 倍）。

改了代码之后，运行 `npm test`，确认稿子的检查规则没有被改坏。

**头像和头图**：源文件在 `assets/`（Gemini 设计）。要用时运行 `npm run assets`，导出 `assets/avatar.png`（800×800）和 `assets/channel-banner.png`（2560×400）。导出的图片不提交，改了源文件之后重新导出。

## 定位

- **AI 辅助 + 人工把关**：写稿、做视频交给 AI；内容准不准，先由 ChatGPT 审核，再由用户最终确认。
- **先手动，再自动**：现阶段由用户手动操作 ChatGPT，视频由 Claude 写的合成脚本生成；流程成熟后，再把稳定的步骤改成程序调用 API。
- **先验证，再加量**：先每周 3 更，看看有没有人看，再考虑日更。

## 工作流

| 步骤 | 负责 | 做什么 |
|---|---|---|
| ① 选题 | 用户 | 用 `npm run topics` 看 Hugging Face 日榜的候选，或按「选题与受众」里的其他来源挑一篇论文，定好目标时长 |
| ② 准备材料 | Claude 或 ChatGPT | 运行 `npm run new -- <arXiv 编号>`：建好本期文件夹、下载论文 PDF、填好稿件开头的论文信息；整理论文信息和正文，生成给 ChatGPT 的写稿材料包（M2 之后由 Claude 的脚本做） |
| ③ 写稿 | ChatGPT | 先判断这篇适合科普向还是专业向，再按[讲解稿格式](docs/script-format.md)写稿，附标题、简介、标签 |
| ④ 审稿 | ChatGPT → 用户 | ChatGPT 开一个新对话，逐条核对数字和结论是否出自原文；用户最终确认 |
| ⑤ 画面素材 | Claude | 按稿子从 PDF 截取论文原图（`npm run figure`）、画示意图（优先写成 SVG，中文不会写错）；用到红框的页，看原图给出红框位置，用户确认。视频模板和封面模板（HTML/CSS）也由 Claude 维护 |
| ⑥ 合成视频 | Claude 的脚本 | 按定稿生成每页画面、TTS 配音和字幕，用 FFmpeg 合成 MP4；B 站封面也由脚本按模板生成 |
| ⑦ 审核成片 | Claude → 用户 | Claude 先检查画面和时间轴（逐页截图、字幕和配音的时间、超出版面的提醒），列出带时间点的问题；用户听声音（读错的词、停顿是否自然）并最终确认 |
| ⑧ 发布 | 用户 | 上传 B 站，声明含 AI 生成内容，注明论文出处；把视频链接发给 Claude，记进 `episodes/published.json` |
| ⑨ 归档 | Claude 的脚本 | 保存讲解稿、审稿记录和发布信息，避免重复选题 |

M1 阶段先只写⑥的合成脚本，②和⑨先手动完成。

## 技术栈

| 用途 | 现阶段 | 成熟后（自动） |
|---|---|---|
| 写稿、审稿 | ChatGPT（网页 / App） | OpenAI API |
| 画面素材 | Claude：视频模板和封面模板（HTML/CSS）、示意图（SVG）；论文原图用 pdf.js 在 Edge 里从 PDF 截取 | 同左 |
| 成片预审 | Claude 检查画面和时间轴，用户听声音 | 同左 |
| 视频合成 | Node.js 脚本：Playwright 控制 Edge 截图，FFmpeg（ffmpeg-static）合成 | 同左，再加定时运行 |
| 配音 | Edge TTS（msedge-tts，免费，非官方接口） | 开始定期发布前换成官方服务（Azure、火山引擎、阿里云等） |
| 辅助脚本 | Node.js：选题候选、材料整理、归档 | 再加定时运行（Windows 任务计划程序） |
| 论文来源 | Hugging Face Daily Papers、arXiv | 同左 |

**没选的方案**：NotebookLM 的视频概览能直接生成讲解视频，但很难保证按审过的稿子讲、用论文原图、带中文字幕（见 WORKLOG.md 的 T10）。

## 里程碑

- [x] **M1 跑通第一条视频**（2026-10-07 发布第一期）：Claude 写最小版合成脚本（讲解稿 → 画面 → 配音 → 字幕 → MP4），Gemini 设计视频模板；从 Hugging Face 日榜选一篇 AI 论文 → ChatGPT 写稿 → ChatGPT 审稿 → 用户确认 → 脚本合成视频 → 用户审核成片 → 发布。记下每一步遇到的问题
- [ ] **M2 辅助脚本**：Claude 开发选题候选（先接 Hugging Face 日榜）、材料整理和归档脚本（`npm run topics`、`npm run new` 已完成，T52 复审通过；归档待做），把 M1 里最费时的手工步骤自动化；ChatGPT 审核代码
- [ ] **M3 连续发布 10 条**：固定流程和模板，看播放量、完播率、评论（已发布 2 条）
- [ ] **M4 逐步自动化**：把成熟的步骤改成程序调用 API，最后加定时运行
- [ ] **M5 扩展方向**：流程稳定后，逐步加入经济、材料、化学、数学、物理

## 注意事项

- **AI 内容标识**：《人工智能生成合成内容标识办法》2025 年 9 月 1 日起施行，投稿时要按平台要求声明含 AI 生成内容。
- **注明出处**：引用论文原图和结论要注明标题、作者、链接，不大段照搬原文。
- **说明论文状态**：讲清楚是预印本（未经同行评审），还是已被某个会议接收。
- **版权**：论文全文和原图只在本地使用，不提交到仓库。
- **配音**：用通用的 AI 音色，不克隆真人声音。
- **账号安全**：前期手动上传。用 Cookie 自动上传有封号风险；Cookie 和 API key 都放在 `.env`，绝不提交到仓库。

## 选题与受众

- **方向**：先只做 AI，跟着 Hugging Face 日榜选题；流程稳定后，再逐步加入经济、材料、化学、数学、物理。
- **选题原则**：有榜单的方向，跟着榜单选；没有日榜的方向，用每周精选或关注度来补。
- **受众**：按论文决定。适合可视化、能讲得通俗的，做**科普向**；专业性强、很难通俗化的，做**专业向**。在 B 站用合集或标题标签区分，让观众知道是哪一类。
- **配音**：不用本人声音，由合成脚本调用 Edge TTS 生成。默认女声「晓晓」，也可以换男声「云希」。
- **审核**：每个视频都必须审核后才能发布；审核时间不固定。

### 选题来源

| 方向 | 来源 |
|---|---|
| AI | Hugging Face Daily Papers：有日榜、周榜、月榜，按社区点赞排序；alphaXiv：arXiv 论文的浏览量和点赞 |
| 物理、数学 | arXiv 新论文 + alphaXiv 热度；APS Physics、Quanta Magazine 的精选报道 |
| 化学、材料 | Nature、Science 每周新刊；相关期刊的「最多阅读」榜 |
| 经济 | NBER 工作论文、SSRN 下载排行 |
| 跨学科 | Nature、Science 每周新刊；Altmetric 关注度评分 |

只有 AI 有现成的日榜。Hugging Face 和 alphaXiv 已确认可用；其他方向的来源，等扩展方向（M5）时再逐个核实。

## 协作方式

本项目由用户和多个 AI agent 协作开发：Claude 写代码，并负责画面素材和成片的画面检查；ChatGPT 写稿，并审核代码和讲解稿。Gemini 设计过最初的模板、头像和头图，2026-10-07 起暂时退出。协作规则和进度见：

- [AGENTS.md](AGENTS.md)：协作共识，所有 agent 开始工作前必读
- [WORKLOG.md](WORKLOG.md)：工作记录和待办交接
