---
name: confluence-update
description: 在公司 Confluence 新建页面或把指定内容追加更新到已有页面（如个人主页/工作记录页）。支持从 Markdown 文件直接转换写入、指定父页面建子页。当用户说"把内容更新到我的 Confluence 主页 / 新建 wiki 页面 / 在某页下建子页 / 把这个 md 发到 confluence"时使用。写入前自动备份原页面。
---

# Confluence Update

## 概述

此技能可在 Confluence 上**新建页面**或把内容**追加到已有页面**末尾，并内置一个
**Markdown → Confluence storage(XHTML)** 的轻量转换器（纯本地，无需 pandoc/联网）。

Confluence 的更新是**覆盖式**的（必须携带正确的版本号整体提交），本技能封装了
"查版本 → 备份 → 读原文 → 拼接新内容 → 提交 version+1"的完整流程，降低误操作风险。

与只读的 `confluence-search` 技能共用同一套认证环境变量。

### 脚本组成

- `confluence-update.mjs` — 主入口，子命令 `find` / `create` / `append` / `setbody` / `mermaid`
- `md2storage.mjs` — Markdown → storage 转换器（可被 create 复用，也可单独 CLI 运行）

## 环境变量（与 confluence-search 相同）

- **CONFLUENCE_URL**（必填）Confluence 基础 URL，例如 `https://wiki.sophgo.com`
- 认证二选一：
  - 私有化版：`CONFLUENCE_PAT`（Bearer）
  - 云版：`CONFLUENCE_EMAIL` + `CONFLUENCE_API_TOKEN`（Basic）

> 建议在 `~/.claude/settings.json` 的 `env` 中配置，无需每次手动设置。
> ⚠️ PAT 是敏感凭证，不要写入任何文件或粘贴到对话；如疑似泄露请在 wiki 后台吊销重建。

## ⚠️ 安全限制：只允许写入个人空间

**本脚本禁止对部门/团队空间（如硬件系统部、BSP 等）做任何写操作**，防止 AI 误操作改动团队共享文档。

- Confluence 个人空间的 key 以 `~` 开头（如 `~ge.gao`），部门空间以字母开头（如 `HW`、`BSP`）。
- `find`（只读搜索）不受此限制。
- `create` / `append` / `setbody` / `mermaid` 在写入前强制检查空间类型：
  - ✅ 个人空间（`~xxx`）→ 允许写入
  - ❌ 部门/团队空间 → **拒绝写入，脚本直接报错退出**
- 如需修改部门空间页面，请通过 Confluence 网页端手动操作。

## 使用流程（两步，先确认再写入）

### 第 1 步：按标题找到目标页面（只读，安全）

```bash
node confluence-update.mjs find "页面标题"
```

输出候选页面列表及其 **pageId** 和当前版本。若命中多个同名页面，
**必须让用户确认唯一的 pageId**，不要自行猜测。

### 第 2 步（A）：新建页面 `create`

新建页面，可指定父页面（建子页）或直接指定 space；内容来源三选一：
`--md-file`（Markdown，自动转 storage）/ `--content-file`（现成 storage 片段）/ `--content`（直传）。

```bash
# 在某父页下建子页，并把 Markdown 文件转换写入
node confluence-update.mjs create \
  --title "页面标题" --parent <父pageId> --md-file /path/to/doc.md

# 建空的父/容器页（只给 space 或 parent）
node confluence-update.mjs create \
  --title "Mars3" --parent <主页pageId> --content "<p>索引页</p>"
```

- 指定 `--parent` 时会自动继承父页的 space，无需再写 `--space`。
- 同一 space 内**标题不能重名**，否则 API 报错。
- 建页成功后末行打印新 `pageId`，便于串联（先建父页拿 id，再建子页挂上去）。

### 第 2 步（B）：追加到已有页面 `append`

推荐把要追加的内容写成一个 storage 片段文件，再追加：

```bash
node confluence-update.mjs append \
  --id <pageId> --content-file /path/to/new.html --message "本次变更说明"
```

也支持直接传一小段内容：

```bash
node confluence-update.mjs append \
  --id <pageId> --content "<p>今天完成了 XXX</p>"
```

### 第 2 步（C）：整页替换正文 `setbody`

用 Markdown 或 storage 片段**整体替换**已有页面正文（自动备份 + version+1）。

```bash
node confluence-update.mjs setbody \
  --id <pageId> --md-file /path/to/doc.md --message "整页更新"
```

> `setbody` **强制备份**（`--no-backup` 也照备），安全性高于 `append`。

### 第 2 步（D）：把 Markdown 里的 Mermaid 图渲染成图片并嵌入 `mermaid`

本 wiki 未安装 Mermaid 插件（原生 `mermaid` 宏渲染不出图），因此本命令走
"提取 ```mermaid 源码 → 经 mermaid.ink 在线渲染 → 上传为页面附件 → 正文嵌入 `<ac:image>`"这条链路。

```bash
# 渲染 md 中所有 mermaid 图为 SVG，追加到页面末尾
node confluence-update.mjs mermaid \
  --id <pageId> --md-file /path/to/doc.md

# 只处理第 1 张图，用 PNG，插到含"顶层编译流程图"的标题下方
node confluence-update.mjs mermaid \
  --id <pageId> --md-file /path/to/doc.md \
  --format png --index 1 --anchor "顶层编译流程图"
```

参数：

| 参数 | 说明 |
|------|------|
| `--md-file <md>` | 包含 ```mermaid 代码块的 Markdown 源文件（必填） |
| `--format svg\|png` | 输出格式，默认 `svg`。SVG 可无损放大、体积小；PNG 兼容性最好，某些 wiki 会过滤 SVG |
| `--index N` | 只处理第 N 张图（1-based）；不给则处理全部 |
| `--anchor "标题词"` | 把图插到**第一个**标题文本含该关键词的标题后；找不到则追加到末尾 |
| `--no-backup` | 关闭写入前备份（不建议） |

- 附件名为 `mermaid-<序号>.<ext>`；**同名附件会更新而非重复上传**（可重复执行刷新图）。
- 图是**源码快照**：md 里的 mermaid 改了要重跑本命令才更新。
- ⚠️ **外网渲染**：mermaid 源码会发送到 mermaid.ink 公共服务。涉及公司内部结构/命名时，先确认外发是否合规；需内网化则改用本地 mermaid CLI（另需安装）。

## 重要说明与限制

1. **内容格式是 Confluence storage 格式（XHTML 片段），不是纯 Markdown。**
   - `--md-file` 会用内置 `md2storage.mjs` 自动转换（标题/段落/粗斜/行内码/代码块/引用/列表/表格/链接/水平线）。
   - `--content-file` / `--content`：含 `<...>` 标签按 storage 原样处理；纯文本自动 `<p>` 包裹并转义。
   - md2storage 已知局限（需人工复核）：**多级嵌套列表会被拍平为单层**（被子项打断的有序列表会重新从 1 编号）；不处理图片；Mermaid/DOT 图按普通代码块处理，不渲染成图。
2. **`create` 支持整页写入；`append` 仅追加到末尾；`setbody` 整页替换正文**（`setbody` 强制备份，适合给已有页面补图/换内容）。
3. **每次写入前自动备份**原页面正文到 `backups/page-<id>-v<版本>-<时间>.html`，
   万一结果不对可据此人工还原。（`--no-backup` 可关闭，不建议新人使用；`setbody` 强制备份不受此开关影响。）
4. 更新采用乐观锁：提交时用"读到的版本号 + 1"。若期间他人也改了该页导致版本冲突，
   API 会报错且**原页面不会被改动**，此时重新执行即可。

## 宏与图表的坑（实测记录，本环境 wiki.sophgo.com）

1. **code 宏的 `language` 参数有白名单。** 传白名单外的值（如 `mermaid`、`makefile`、`dts`）
   会让整段抛 `com.atlassian.confluence.ext.code.render.InvalidValueException`。
   `md2storage.mjs` 已内置白名单 + 别名归一化：白名单外语言**一律不写 `language`**，
   退化为无高亮纯文本代码宏（永远合法）。新增语言别名时改 `CODE_LANG_ALIAS`。
2. **本 wiki 未安装 Mermaid 插件。** 写 `<ac:structured-macro ac:name="mermaid">` 会渲染成
   "unknown-macro"占位图，不出图。`markdown` 宏虽装了，但只做代码高亮、**不渲染 mermaid 成图**。
   能画图的原生宏只有 `drawio`（手画，不吃 mermaid 源码）。
   → 处理 mermaid 流程图的现实选项：**降级为代码块**（最稳）／ 用本技能的 `mermaid` 子命令
   经 mermaid.ink 在线渲染 SVG/PNG 后**作附件内嵌**（有图、需联网，见上文第 2 步 D）。
3. **安全探测宏是否可用**：用不落库的 convert 端点，不会建页/改页：
   ```bash
   # 返回含 unknown-macro 即该宏未安装
   curl -s -X POST "$CONFLUENCE_URL/rest/api/contentbody/convert/view" \
     -H "Authorization: Bearer $CONFLUENCE_PAT" -H "Content-Type: application/json" \
     -d '{"value":"<ac:structured-macro ac:name=\"mermaid\"><ac:plain-text-body><![CDATA[graph TD;A-->B;]]></ac:plain-text-body></ac:structured-macro>","representation":"storage"}'
   ```

## 写入后要做的事

1. 打印新版本号与页面链接，供用户核对。
2. 提醒用户在浏览器打开页面确认展示效果（尤其含 HTML/宏时）。
3. 如结果不符合预期，用 `backups/` 里的备份文件人工还原。
