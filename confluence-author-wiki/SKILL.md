---
name: confluence-author-wiki
description: 按人名(作者)检索其在 Confluence 上的全部 wiki 记录, 抓取每页正文, 并按知识点分类总结成一份带侧边栏的可点击 HTML 报告。触发词: 按人名搜 wiki、某人的 wiki、某人写的文档、作者的 Confluence 记录、整理成分类 html、总结某人的 wiki。
---

# Confluence Author Wiki

## 概述

按**人名(作者)**检索其在 Confluence 上创建或参与的**全部 wiki 记录**，抓取每页正文，并整理成一份**按知识点分类、带侧边栏、可点击跳转原文**的 HTML 报告。

本技能分两步：
1. **脚本负责机械抓取**：`confluence-author-wiki.mjs` 解析用户名、按作者检索、抓取每页正文，输出清单 HTML 与正文 JSONL。
2. **你(Claude)负责分类总结**：读 JSONL → 派并行 agent 精读并结构化摘要 → 用 `render-report.mjs` 渲染成带侧边栏的分类 HTML。

## 环境变量

1. **CONFLUENCE_URL** (必填) - Confluence 基础 URL
2. 认证 (二选一)：
   - 云版：`CONFLUENCE_EMAIL` + `CONFLUENCE_API_TOKEN`
   - 私有化版：`CONFLUENCE_PAT`

## 脚本

### 1. confluence-author-wiki.mjs — 抓取

```bash
# A) 清单模式: 只列表 + 可点击 HTML(默认)
node confluence-author-wiki.mjs "张三" --out ./zhangsan-wiki.html

# B) 正文模式: 抓每页正文, 输出 JSONL(供分类总结)
node confluence-author-wiki.mjs "张三" --content --out ./zhangsan-content.jsonl

# C) 只要 JSON 元数据
node confluence-author-wiki.mjs "张三" --format json
```

参数：`author`(必填)、`--field contributor|creator`(默认 contributor)、`--limit N`(默认 100)、`--format html|json`、`--content`(正文 JSONL)、`--out PATH`。

### 2. render-report.mjs — 渲染带侧边栏 HTML

```bash
node render-report.mjs \
  --knowledge summaries-A.json \
  --knowledge summaries-B.json \
  --logs summaries-C.json \
  --name "张三" \
  --out ./zhangsan-wiki.html
```
- `--knowledge` 可重复，每份形如 `{groups:[{category, pages:[{title,url,summary,keyPoints,codeSnippet}]}]}`。
- `--logs` 形如 `{months:[{month,summary,logsWithContent:[{date,url,text}]}], themes:[], weeklyPlans:[{title,url,summary}], indexPages:[{title,url,note}], stats:{}}`（可省略）。

## 关键难点：私有化版中文姓名解析

**坑**：私有化版 Confluence 的 `contributor`/`creator` CQL **不识别中文显示名**，云版 `search/user` 端点也常 404。直接拿中文名查 CQL 会返回 **0 条**。

**脚本已内置反查**（`resolveUser` 的 siteSearch 回退）：
1. 云版 `search/user?cql=user.fullname ~ "姓名"`；
2. 失败则 `content/search?cql=siteSearch ~ "姓名"`，从命中页的 `_links.webui` 路径 `/display/~<username>/` 与 `version.by.username` 反查用户名；
3. 仍失败回退原始字符串（适配 username/邮箱直接传入）。

验证：跑 `node confluence-author-wiki.mjs "冯之尧" --limit 5 --format json`，stderr 应打印 `[resolve] "冯之尧" -> username="zhiyao.feng" ... (via sitesearch-path)`。若仍 fallback 且 0 条，让用户改用**登录用户名或邮箱**重试。

## 完整工作流（按知识点分类总结）

### Phase 1 — 抓取
```bash
# 1a. 抓正文 JSONL(含全部页面正文, type 区分 page/attachment)
node confluence-author-wiki.mjs "冯之尧" --content --limit 300 --out ./feng-content.jsonl

# 1b. 看分布: 多少页面 vs 附件, 哪些是知识点页 vs 日日志
jq -s '{total:length, pages:map(select(.type=="page"))|length}' feng-content.jsonl
jq -r 'select(.type=="page")|"[\(.id)] \(.title) \(.text|length)字"' feng-content.jsonl
```

### Phase 2 — 并行 agent 精读分类
按知识点把页面**分簇**（如外设接口 / 安全签名验签 / 平台驱动 / 工具规范 / 工作日志与计划），每簇派一个 **general-purpose agent**，让它读 `feng-content.jsonl` 中属于该簇的页面（用 `jq` 按 id 过滤），产出结构化 JSON：

每个 agent 的输出 schema：
```json
{ "groups": [ { "category": "外设接口文档",
  "pages": [ { "id":"...", "title":"...", "url":"...",
    "summary":"3-6 句中文摘要",
    "keyPoints":["要点1","要点2"],
    "codeSnippet":"关键命令/代码(无则空串)" } ] } ] }
```
日志类 agent 返回 `{category, months:[{month,summary,logsWithContent:[{date,url,text}]}], themes:[], weeklyPlans:[{title,url,summary}], indexPages:[{title,url,note}], stats:{}}`。

**把每簇负责的 page id 清单写进 agent prompt**，并要求"只输出一个 json 代码块，不要其它文字"，方便后续提取。

### Phase 3 — 合并并渲染
```bash
# 把各 agent 产出的 summaryA.json / summaryB.json / summaryC.json 收齐后:
node render-report.mjs \
  --knowledge summaryA.json --knowledge summaryB.json \
  --logs summaryC.json --name "冯之尧" --out ./冯之尧-wiki.html
```

## ⚠️ 编排 agent 的注意事项（避免上下文溢出）

- **绝对不要 Read / tail / cat agent 的 `.output` 文件**——它是完整 JSONL transcript，会撑爆上下文。
- agent 在后台跑，**完成时会自动推送通知（task-notification），通知里直接带最终结果文本**，直接用通知里的 JSON 即可。
- 若要查进度，只 `TaskOutput block=false` 取状态快照（仍会返回截断 transcript，谨慎）；**不要用 block=true 长轮询**本地 agent——同样会回灌 transcript。
- 多个 agent 用**一条消息里多个 Agent 调用**并行启动（勿串行）。
- 从通知/transcript 抽取最终 JSON：用 `python3` 解析 JSONL transcript，取最后一个 role=assistant 且含 ```json 代码块 的 text（参考实现见会话内 `save-summaries.py`），**不要手动誊抄整段 JSON**。

## 最佳实践

1. **姓名解析**：私有化版优先用登录用户名/邮箱；只有中文名时依赖脚本 siteSearch 反查。
2. **维度**：看"写过哪些"→ `--field creator`；看"参与/编辑过哪些"→ 默认 `contributor`。
3. **结果过多**：调大 `--limit`；按 `lastmodified desc`，最新在前。
4. **分类总结**：知识点页（标题非日期）逐篇精读产出摘要+要点+代码；日日志（标题为日期）按月归纳 + 提炼工作主线，不必逐篇长摘要。
5. **正文抓取速率**：脚本已对 429 退避重试；145 页约 1-2 分钟。附件(type=attachment)无正文，自动跳过。
6. **无结果时**：核对拼写、确认该用户在当前站点确有内容、换 username/邮箱。
