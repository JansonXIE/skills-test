#!/usr/bin/env node

/**
 * Confluence Search Skill - 独立脚本
 * 通过 CQL 搜索 Confluence 内容并提取摘要
 *
 * 环境变量:
 *   CONFLUENCE_URL          - Confluence 基础 URL (必填)
 *   CONFLUENCE_EMAIL        - 用户邮箱 (云版, 与 API_TOKEN 配合)
 *   CONFLUENCE_API_TOKEN    - API Token (云版)
 *   CONFLUENCE_PAT          - Personal Access Token (私有化版)
 *
 * 用法:
 *   node confluence-search.mjs "搜索关键词"
 *   node confluence-search.mjs "搜索关键词" --limit 10
 *   node confluence-search.mjs "搜索关键词" --format markdown
 */

const args = process.argv.slice(2);

function parseArgs(args) {
  const result = { query: '', limit: 25, format: 'json' };
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit' && i + 1 < args.length) {
      result.limit = parseInt(args[++i], 10);
    } else if (args[i] === '--format' && i + 1 < args.length) {
      result.format = args[++i];
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`用法: node confluence-search.mjs <query> [--limit N] [--format json|markdown]

参数:
  query           搜索关键词 (必填)
  --limit N       返回结果数量上限 (默认 25)
  --format FORMAT 输出格式: json 或 markdown (默认 json)
  --help, -h      显示帮助信息

环境变量:
  CONFLUENCE_URL          Confluence 基础 URL (必填)
  CONFLUENCE_EMAIL        用户邮箱 (云版 Basic Auth)
  CONFLUENCE_API_TOKEN    API Token (云版 Basic Auth)
  CONFLUENCE_PAT          Personal Access Token (私有化版 Bearer Auth)
`);
      process.exit(0);
    } else {
      positional.push(args[i]);
    }
  }
  result.query = positional.join(' ');
  return result;
}

async function searchConfluence(query, limit) {
  const baseUrl = process.env.CONFLUENCE_URL;
  if (!baseUrl) {
    console.error('错误: 环境变量 CONFLUENCE_URL 未配置');
    process.exit(1);
  }

  const headers = { 'Accept': 'application/json' };

  if (process.env.CONFLUENCE_API_TOKEN && process.env.CONFLUENCE_EMAIL) {
    const credentials = Buffer.from(
      `${process.env.CONFLUENCE_EMAIL}:${process.env.CONFLUENCE_API_TOKEN}`
    ).toString('base64');
    headers['Authorization'] = `Basic ${credentials}`;
  } else if (process.env.CONFLUENCE_PAT) {
    headers['Authorization'] = `Bearer ${process.env.CONFLUENCE_PAT}`;
  } else {
    console.error('错误: Confluence 认证信息未配置 (需要 EMAIL+API_TOKEN 或 PAT)');
    process.exit(1);
  }

  const cql = `text ~ "${query}"`;
  const url = `${baseUrl}/rest/api/search?cql=${encodeURIComponent(cql)}&limit=${limit}`;

  const res = await fetch(url, { method: 'GET', headers });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`Confluence API 错误: ${res.status} ${res.statusText}`);
    if (body) console.error(body);
    process.exit(1);
  }

  const data = await res.json();

  return (data.results || []).map((item) => ({
    id: item.content?.id || item.id,
    title: item.title || item.content?.title,
    url: `${baseUrl}${item.url}`,
    content: item.excerpt
      ? item.excerpt.replace(/<[^>]*>?/gm, '')
      : 'No content available',
    source: 'confluence',
  }));
}

async function main() {
  const { query, limit, format } = parseArgs(args);

  if (!query) {
    console.error('错误: 请提供搜索关键词');
    console.error('用法: node confluence-search.mjs <query> [--limit N] [--format json|markdown]');
    process.exit(1);
  }

  const results = await searchConfluence(query, limit);

  if (format === 'markdown') {
    if (results.length === 0) {
      console.log('未找到相关 Confluence 内容。');
      return;
    }
    console.log(`## Confluence 搜索结果 (共 ${results.length} 条)\n`);
    console.log(`**搜索关键词**: ${query}\n`);
    results.forEach((r, i) => {
      console.log(`### ${i + 1}. ${r.title}`);
      console.log(`- **ID**: ${r.id}`);
      console.log(`- **链接**: ${r.url}`);
      console.log(`- **摘要**: ${r.content}`);
      console.log('');
    });
  } else {
    console.log(JSON.stringify(results, null, 2));
  }
}

main().catch((err) => {
  console.error('执行失败:', err.message);
  process.exit(1);
});
