# 视频模板

Gemini 设计（T15），2026-10-07 起由 Claude 维护。合成脚本把讲解稿的内容填进这些模板，再截图生成视频画面。

## 通用规格

- 画面 1920×1080，底部 162px（15%）留给字幕
- 纯 HTML/CSS，不依赖外部网络资源；字体用系统字体（Windows 上是微软雅黑）
- 要填的内容用 `{{字段名}}` 占位符标出
- 除 `cover` 外，每个模板都有 `{{page_topic}}`、`{{page_number}}`、`{{total_pages}}`

## 6 个版式

| 版式 | 用途 | 专有占位符 |
|---|---|---|
| `cover` | 封面 / 导读 | field_tag、paper_status、arxiv_id、conference_or_journal、video_title、paper_original_title、authors_team、affiliations、core_highlight |
| `figure_text` | 左图右文：论文原图 + 1~3 条要点 | module_step、figure_label、figure_source_location、figure_image_path、figure_caption、heading_title、point_1~3_title / desc |
| `big_metric` | 全屏大字：核心实验指标 | benchmark_dataset、metric_headline、metric_1~3_name / sign / val / unit / desc、baseline_model、hardware_condition、paper_table_ref |
| `figure_annotated` | 原图聚焦标注：原图不动，红框单独一层 | figure_label、figure_source_location、figure_image_path、box_top / left / width / height、highlight_label、target_module_name、annotation_headline、detail_1~3_title / content |
| `concept_diagram` | 自制概念示意图，自带「示意图」标识 | diagram_title、diagram_image_path、step_1~3_title / desc |
| `comparison` | 方案对比：基线 vs 本文 | comparison_headline、baseline_name、ours_name、base_point_1~3_title / desc、ours_point_1~3_title / desc |

**宽图版** `figure_text_wide`（Claude 照 figure_text 的样式做，2026-10-07）：原图在上面占满宽度，标题和要点卡片在下面排成一行，占位符和 `figure_text` 完全一样。讲解稿里不用写它：`figure_text` 页的原图宽度是高度的 2.2 倍以上时，脚本自动换用（结构图、流程图大多这么宽，放在左边会很小）。

## 渲染时脚本要处理的事（模板本身不改）

- **字幕区**：隐藏提示文字「[底部 15% 字幕保留区 …]」和上方的虚线，换成真正的字幕。每页开头的停顿不显示字幕；字幕去掉行末的逗号、句号和冒号。
- **百分号**：`big_metric` 的单位是 % 时，贴紧数字显示（40%，不是 40 %）。
- **数量不固定的卡片**：要点、指标、步骤、对比项都预留了 3 个位置；内容少于 3 条时，删掉空着的卡片（排成一行的卡片会重新均分宽度）。
- **红框对齐**：`figure_annotated` 的标注层铺满整个图片区域，但原图按比例缩放、四周会留白，红框百分比会对不准。脚本要把标注层对齐到原图实际显示的范围，让百分比相对原图计算。
- **红框必填**：没给红框位置时，不能用模板里的默认值（25%、45%、35%、40%），要报错提醒。
- **空值**：`conference_or_journal` 这类可能为空的字段，空着或写「无」时隐藏对应标签。`cover` 页的机构和作者相同时，不再重复显示机构。
- **标题**：`cover` 页的 `video_title` 去掉开头的「【每日论文 #期数】」，顶栏已经有栏目名。
- **转义**：填进去的文字要做 HTML 转义。

## B 站封面模板（T22）

`templates/bilibili-cover.html`，Gemini 设计（2026-10-06）。Gemini 交付的文件里 SVG 的 xmlns 被写坏成了 Markdown 链接的样子，保存时 Claude 改回了 `http://www.w3.org/2000/svg`，其余内容没动。

`npm run render` 生成视频时，会顺带用这个模板生成 `output/cover.png`（1920×1080）。

| 占位符 | 含义 | 来源（讲解稿「开头」，见 docs/script-format.md v1.2） |
|---|---|---|
| `brand_text` | 左上角栏目名 | 代码统一设置为「DailyPaper · 每日论文」 |
| `field_tag` | 领域标签 | 「领域」 |
| `paper_status` | 论文状态标签 | 「状态」 |
| `impact_highlight` | 大字上方的高亮卖点 | 「封面卖点」（可选） |
| `cover_title` | 封面大字 | 「封面大字」（必填） |
| `cover_subtitle` | 大字下面的一行 | 「封面副标题」（可选） |
| `metric_summary` | 右侧卡片里的核心指标 | 「封面指标」（可选） |

渲染时脚本要处理的事：

- **可选字段不写**：隐藏整个容器，连装饰一起去掉：副标题 `.cover-sub`（含竖条）、卖点 `.highlight-pill`（含星号）、指标 `.hero-graphic`（含固定标签和图形）
- **文字太长**：封面大字排成 2 行以上、封面指标换行、或者内容超出版面时，给出提醒

还要注意：

- 模板注释写的推荐尺寸是 1920×1080（16:9），但没给出处链接；第一次投稿时在 B 站投稿页核对封面比例
- 左上角的「DP」图标写死在模板里；以后栏目改名，要一起改
- 三个可选字段都不写时，右边会空出一大块；至少写上「封面指标」更好看

设计要求（Gemini 设计时依据的原始要求）：

- **文件**：`templates/bilibili-cover.html`
- **尺寸**：按 B 站投稿页当前推荐的封面尺寸；设计前先确认，并写在模板开头的注释里
- **技术要求**：和视频模板一样，纯 HTML/CSS，不依赖外部网络资源，用系统字体
- **占位符**：至少要有 `{{cover_title}}`（封面大字，建议不超过 12 字）；可以再加领域、论文状态等字段，但每个占位符都要写明含义
- **好认**：字大、字少、对比强，在手机上缩小后也能看清
- **避开遮挡**：B 站会在封面底部叠加播放量、时长等信息，重要内容不要放在底部两角
- **不放论文原图**：封面上没地方注明出处，只用文字和自己画的图形
