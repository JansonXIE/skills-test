---
name: confluence-search
description: 搜索公司 Confluence 知识库。当用户需要查找公司内部文档、技术规范、流程指南或项目文档时使用此技能。
---

# Confluence Search

## 概述

此技能用于搜索公司 Confluence 知识库，帮助用户查找内部文档、技术规范、流程指南和项目文档。

## 使用方法

当用户提供搜索关键词时，执行以下命令搜索 Confluence 知识库：

```bash
node ~/.gemini/skills/confluence-search/confluence-search.mjs "$PROMPT" --format markdown
```

### 环境变量配置

搜索前需要配置以下环境变量：

1. **CONFLUENCE_URL** (必填) - Confluence 基础 URL
2. **认证方式** (二选一)：
   - **云版 Confluence**：
     - `CONFLUENCE_EMAIL` - 用户邮箱
     - `CONFLUENCE_API_TOKEN` - API Token
   - **私有化版 Confluence**：
     - `CONFLUENCE_PAT` - Personal Access Token

### 搜索完成后

1. **汇总搜索结果**：提取最相关的内容进行总结
2. **引用原文链接**：提供 Confluence 页面链接
3. **中文回答**：用中文回答用户的问题
4. **无结果处理**：如果搜索无结果，建议用户尝试不同的关键词

## 脚本说明

### confluence-search.mjs

位于 `~/.gemini/skills/confluence-search/confluence-search.mjs`，主要功能：

- 通过 CQL (Confluence Query Language) 搜索内容
- 支持分页和结果数量限制
- 支持 JSON 和 Markdown 输出格式
- 自动处理认证和 API 调用

#### 参数说明

- `query` - 搜索关键词 (必填)
- `--limit N` - 返回结果数量上限 (默认 25)
- `--format FORMAT` - 输出格式: `json` 或 `markdown` (默认 json)

#### 使用示例

```bash
# 基本搜索
node confluence-search.mjs "API 文档"

# 限制结果数量
node confluence-search.mjs "项目规范" --limit 10

# Markdown 格式输出
node confluence-search.mjs "技术指南" --format markdown
```

## 最佳实践

1. **关键词优化**：
   - 使用具体的关键词而非模糊描述
   - 尝试同义词或相关术语
   - 结合项目名称、文档类型等限定词

2. **结果处理**：
   - 优先展示最近更新的文档
   - 关注文档的浏览量、点赞数等质量指标
   - 检查文档的标签和分类

3. **无结果时的建议**：
   - 尝试更宽泛或更具体的关键词
   - 检查拼写错误
   - 建议用户联系相关团队或创建新文档

## 常见搜索场景

### 技术文档搜索
- API 接口文档
- SDK 使用指南
- 系统架构设计
- 部署配置说明

### 流程规范搜索
- 开发流程
- 代码审查规范
- 发布流程
- 故障处理流程

### 项目文档搜索
- 项目需求文档
- 会议纪要
- 项目计划
- 风险评估

### 团队知识搜索
- 团队规范
- 最佳实践
- 经验总结
- 培训材料