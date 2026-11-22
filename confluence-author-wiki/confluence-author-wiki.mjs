#!/usr/bin/env node

/**
 * Confluence Author Wiki Skill - 独立脚本
 *
 * 模式:
 *   (A) 清单模式 (默认): 按作者检索 wiki 记录, 生成可点击 HTML 表格
 *   (B) 正文模式 (--content): 在清单基础上抓取每页 body.storage 正文并清洗为纯文本,
 *       输出 JSONL, 供后续"按知识点分类总结"使用
 *
 * 人名解析策略 (私有化版 Confluence 的 contributor/creator CQL 不识别中文显示名,
 * 需先把姓名反查为 username):
 *   1. 云版用户搜索 user.fullname ~ "姓名"
 *   2. siteSearch 全文搜姓名 -> 从命中页的 _links.webui(/display/~<user>/)
 *      或 version.by.username 反查用户名
 *   3. 回退: 直接用原始字符串当 username/邮箱
 *
 * 环境变量:
 *   CONFLUENCE_URL          - Confluence 基础 URL (必填)
 *   CONFLUENCE_EMAIL        - 用户邮箱 (云版, 与 API_TOKEN 配合)
 *   CONFLUENCE_API_TOKEN    - API Token (云版)
 *   CONFLUENCE_PAT          - Personal Access Token (私有化版)
 *
 * 用法:
 *   node confluence-author-wiki.mjs "张三"
 *   node confluence-author-wiki.mjs "张三" --limit 100
 *   node confluence-author-wiki.mjs "张三" --field creator
 *   node confluence-author-wiki.mjs "张三" --out ./zhangsan-wiki.html
 *   node confluence-author-wiki.mjs "张三" --format json
 *   node confluence-author-wiki.mjs "张三" --content --out ./zhangsan-content.jsonl
 */

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);

function parseArgs(argv) {
  const result = {
    author: '',
    limit: 100,
    field: 'contributor', // contributor | creator
    format: 'html', // html | json | content
    out: '',
    content: false,
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--limit' && i + 1 < argv.length) {
      result.limit = parseInt(argv[++i], 10);
    } else if (argv[i] === '--field' && i + 1 < argv.length) {
      result.field = argv[++i];
    } else if (argv[i] === '--format' && i + 1 < argv.length) {
      result.format = argv[++i];
    } else if (argv[i] === '--out' && i + 1 < argv.length) {
      result.out = argv[++i];
    } else if (argv[i] === '--content') {
      result.content = true;
      result.format = 'content';
    } else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log(`用法: node confluence-author-wiki.mjs <author> [选项]

参数:
  author          作者姓名/用户名/邮箱 (必填)

选项:
  --limit N       返回结果数量上限 (默认 100)
  --field FIELD   搜索字段: contributor(参与者) 或 creator(创建者) (默认 contributor)
  --format FMT    输出格式: html 或 json (默认 html)
  --content       正文模式: 抓取每页 body.storage 正文, 清洗为纯文本, 输出 JSONL
                  (覆盖 --format; 用于后续按知识点分类总结)
  --out PATH      输出文件路径 (默认 ./<author>-wiki.html 或 ./<author>-content.jsonl)
  --help, -h      显示帮助信息

环境变量:
  CONFLUENCE_URL          Confluence 基础 URL (必填)
  CONFLUENCE_EMAIL        用户邮箱 (云版 Basic Auth)
  CONFLUENCE_API_TOKEN    API Token (云版 Basic Auth)
  CONFLUENCE_PAT          Personal Access Token (私有化版 Bearer Auth)
`);
      process.exit(0);
    } else {
      positional.push(argv[i]);
    }
  }
  result.author = positional.join(' ').trim();
  return result;
}

function buildHeaders() {
  const headers = { Accept: 'application/json' };
  if (process.env.CONFLUENCE_API_TOKEN && process.env.CONFLUENCE_EMAIL) {
    const credentials = Buffer.from(
      `${process.env.CONFLUENCE_EMAIL}:${process.env.CONFLUENCE_API_TOKEN}`,
    ).toString('base64');
    headers.Authorization = `Basic ${credentials}`;
  } else if (process.env.CONFLUENCE_PAT) {
    headers.Authorization = `Bearer ${process.env.CONFLUENCE_PAT}`;
  } else {
    console.error('错误: Confluence 认证信息未配置 (需要 EMAIL+API_TOKEN 或 PAT)');
    process.exit(1);
  }
  return headers;
}

async function fetchJson(baseUrl, headers, url, label) {
  const res = await fetch(url, { method: 'GET', headers });
  if (!res.ok) {
    if (label) console.error(`[${label}] HTTP ${res.status} ${res.statusText}`);
    return null;
  }
  return res.json().catch(() => null);
}

/**
 * 解析作者输入, 返回可用于 CQL 的用户标识.
 * 私有化版 contributor/creator CQL 不识别中文显示名, 必须先反查 username.
 * 步骤:
 *   1. 云版用户搜索 user.fullname ~ "姓名"
 *   2. siteSearch 全文搜姓名, 从 /display/~<user>/ 路径反查用户名
 *   3. 再取一篇命中页的 version.by.username 确认
 *   4. 全失败则回退用原始字符串
 */
async function resolveUser(baseUrl, headers, author) {
  // 1. 云版用户搜索
  {
    const url = `${baseUrl}/rest/api/search/user?cql=${encodeURIComponent(`user.fullname ~ "${author}"`)}&limit=5`;
    const data = await fetchJson(baseUrl, headers, url, 'user-search');
    const first = data?.results?.[0]?.user;
    if (first) {
      return {
        accountId: first.accountId || null,
        username: first.username || first.name || null,
        displayName: first.displayName || author,
        source: 'cloud-user-search',
      };
    }
  }

  // 2. siteSearch 全文搜姓名 -> 从个人空间路径 /display/~<user>/ 反查用户名
  {
    const url = `${baseUrl}/rest/api/content/search?cql=${encodeURIComponent(`siteSearch ~ "${author}"`)}&limit=25&expand=version`;
    const data = await fetchJson(baseUrl, headers, url, 'sitesearch');
    const results = data?.results || [];
    const seen = new Map(); // username -> count
    for (const item of results) {
      const webui = item._links?.webui || '';
      // /display/~zhiyao.feng/Page  或  /pages/viewpage.action?pageId=...
      let uname = null;
      const m = webui.match(/\/display\/~([^/?#]+)/);
      if (m) uname = decodeURIComponent(m[1]);
      if (!uname) {
        // 兜底: 用最后修改人 username
        uname = item.version?.by?.username || item.version?.by?.userKey || null;
      }
      if (uname) seen.set(uname, (seen.get(uname) || 0) + 1);
    }
    if (seen.size > 0) {
      // 取出现次数最多的 username (个人空间名)
      let best = null, bestN = 0;
      for (const [u, n] of seen) if (n > bestN) { best = u; bestN = n; }
      // 用命中页的 version.by 确认 displayName
      const conf = results.find((r) => (r.version?.by?.username || '') === best);
      return {
        accountId: null,
        username: best,
        displayName: conf?.version?.by?.displayName || author,
        source: 'sitesearch-path',
      };
    }
  }

  // 3. 回退: 原始字符串
  return { accountId: null, username: null, displayName: author, source: 'fallback' };
}

function buildCql(field, author, user) {
  const key = field === 'creator' ? 'creator' : 'contributor';
  if (user.accountId) {
    return `${key} = "${user.accountId}" order by lastmodified desc`;
  }
  if (user.username) {
    return `${key} = "${user.username}" order by lastmodified desc`;
  }
  return `${key} = "${author}" order by lastmodified desc`;
}

async function searchByAuthor(baseUrl, headers, cql, limit) {
  const collected = [];
  let start = 0;
  const pageSize = Math.min(limit, 50);
  while (collected.length < limit) {
    const url =
      `${baseUrl}/rest/api/content/search?cql=${encodeURIComponent(cql)}` +
      `&limit=${pageSize}&start=${start}` +
      `&expand=history,version,space,metadata.labels`;
    const res = await fetch(url, { method: 'GET', headers });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`Confluence API 错误: ${res.status} ${res.statusText}`);
      if (body) console.error(body);
      process.exit(1);
    }
    const data = await res.json();
    const results = data.results || [];
    for (const item of results) {
      collected.push({
        id: item.id,
        type: item.type,
        title: item.title,
        space: item.space?.name || item.space?.key || '',
        url: item._links?.webui ? `${baseUrl}${item._links.webui}` : `${baseUrl}/pages/viewpage.action?pageId=${item.id}`,
        creator: item.history?.createdBy?.displayName || '',
        created: item.history?.createdDate || '',
        lastModifier: item.version?.by?.displayName || '',
        lastModified: item.version?.when || '',
        version: item.version?.number || '',
        labels: (item.metadata?.labels?.results || []).map((l) => l.name),
      });
      if (collected.length >= limit) break;
    }
    if (results.length < pageSize) break;
    start += pageSize;
  }
  return collected;
}

/**
 * 抓取单页正文 (body.storage), 清洗为纯文本.
 * 重试 429; 权限受限/已删除记空串.
 */
async function fetchPageText(baseUrl, headers, pageId, maxRetries = 3) {
  const url = `${baseUrl}/rest/api/content/${pageId}?expand=body.storage`;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const res = await fetch(url, { method: 'GET', headers });
      if (res.ok) {
        const data = await res.json();
        return stripHtml(data.body?.storage?.value || '');
      }
      if (res.status === 429) {
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      return ''; // 403/404 等 -> 空内容
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
      if (attempt === maxRetries - 1) return '';
    }
  }
  return '';
}

function stripHtml(s) {
  if (!s) return '';
  let t = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, c) => c);
  t = t.replace(/<\/?(p|li|tr|h[1-6]|div|td|th|br|table|section|pre|code)[^>]*>/gi, '\n');
  t = t.replace(/<br\s*\/?>/gi, '\n');
  t = t.replace(/<li>/gi, '• ');
  t = t.replace(/<[^>]+>/g, '');
  t = t.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&[a-z]+;/g, ' ');
  t = t.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+/g, ' ').trim();
  return t;
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return escapeHtml(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function renderHtml(author, field, results) {
  const genTime = fmtDate(new Date().toISOString());
  const rows = results
    .map((r, i) => {
      const labels = r.labels.length
        ? r.labels.map((l) => `<span class="label">${escapeHtml(l)}</span>`).join(' ')
        : '<span class="muted">-</span>';
      return `        <tr>
          <td class="idx">${i + 1}</td>
          <td class="title"><a href="${escapeHtml(r.url)}" target="_blank" rel="noreferrer">${escapeHtml(r.title)}</a>
            <div class="type">${escapeHtml(r.type)}</div></td>
          <td>${escapeHtml(r.space)}</td>
          <td>${escapeHtml(r.creator)}</td>
          <td>${fmtDate(r.created)}</td>
          <td>${escapeHtml(r.lastModifier)}</td>
          <td>${fmtDate(r.lastModified)}</td>
          <td class="ver">v${escapeHtml(r.version)}</td>
          <td class="labels">${labels}</td>
        </tr>`;
    })
    .join('\n');

  const fieldLabel = field === 'creator' ? '创建者' : '参与者';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(author)} 的 Confluence Wiki 记录</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
    margin: 0; padding: 24px; background: #f5f6f8; color: #1a1a1a; }
  .header { background: #fff; border-radius: 12px; padding: 20px 24px; margin-bottom: 20px;
    box-shadow: 0 1px 4px rgba(0,0,0,.08); }
  .header h1 { margin: 0 0 8px; font-size: 22px; }
  .meta { color: #666; font-size: 13px; }
  .meta b { color: #0052cc; }
  .card { background: #fff; border-radius: 12px; padding: 8px; box-shadow: 0 1px 4px rgba(0,0,0,.08);
    overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  thead th { text-align: left; padding: 12px 10px; border-bottom: 2px solid #e3e6ea;
    color: #444; font-weight: 600; white-space: nowrap; position: sticky; top: 0; background: #fff; }
  tbody td { padding: 12px 10px; border-bottom: 1px solid #eef0f2; vertical-align: top; }
  tbody tr:hover { background: #f7faff; }
  .idx { color: #999; width: 36px; }
  .title a { color: #0052cc; text-decoration: none; font-weight: 600; }
  .title a:hover { text-decoration: underline; }
  .type { color: #999; font-size: 11px; text-transform: uppercase; margin-top: 2px; }
  .ver { color: #666; white-space: nowrap; }
  .label { display: inline-block; background: #e6f0ff; color: #0052cc; border-radius: 4px;
    padding: 1px 6px; font-size: 11px; margin: 1px 0; }
  .muted { color: #bbb; }
  .empty { text-align: center; padding: 48px; color: #999; }
  .footer { text-align: center; color: #aaa; font-size: 12px; margin-top: 16px; }
</style>
</head>
<body>
  <div class="header">
    <h1>📚 ${escapeHtml(author)} 的 Confluence Wiki 记录</h1>
    <div class="meta">搜索维度: <b>${fieldLabel}</b> &nbsp;|&nbsp; 共 <b>${results.length}</b> 条记录 &nbsp;|&nbsp; 生成时间: ${genTime}</div>
  </div>
  <div class="card">
${
  results.length === 0
    ? '    <div class="empty">未找到该用户的 Wiki 记录，请尝试更换姓名/用户名或搜索维度。</div>'
    : `    <table>
      <thead>
        <tr>
          <th>#</th><th>标题</th><th>空间</th><th>创建者</th><th>创建时间</th>
          <th>最后修改人</th><th>最后修改</th><th>版本</th><th>标签</th>
        </tr>
      </thead>
      <tbody>
${rows}
      </tbody>
    </table>`
}
  </div>
  <div class="footer">Generated by confluence-author-wiki skill</div>
</body>
</html>
`;
}

async function main() {
  const opts = parseArgs(args);
  if (!opts.author) {
    console.error('错误: 请提供作者姓名');
    console.error('用法: node confluence-author-wiki.mjs <author> [--field contributor|creator] [--limit N] [--content] [--out PATH]');
    process.exit(1);
  }

  const baseUrl = process.env.CONFLUENCE_URL;
  if (!baseUrl) {
    console.error('错误: 环境变量 CONFLUENCE_URL 未配置');
    process.exit(1);
  }
  const headers = buildHeaders();

  // 解析用户名 (私有化版中文显示名需反查)
  const user = await resolveUser(baseUrl, headers, opts.author);
  if (user.source !== 'fallback') {
    console.error(`[resolve] "${opts.author}" -> username="${user.username}" displayName="${user.displayName}" (via ${user.source})`);
  } else {
    console.error(`[resolve] "${opts.author}" 未能反查用户名, 回退为原始字符串`);
  }
  const cql = buildCql(opts.field, opts.author, user);
  const results = await searchByAuthor(baseUrl, headers, cql, opts.limit);
  console.error(`[search] CQL: ${cql}`);
  console.error(`[search] 命中 ${results.length} 条`);

  // 正文模式: 抓取每页正文, 输出 JSONL
  if (opts.content) {
    const outPath = path.resolve(opts.out || `${opts.author.replace(/[\\/:*?"<>|\s]+/g, '_')}-content.jsonl`);
    const out = fs.createWriteStream(outPath, { flags: 'w' });
    let n = 0;
    for (const r of results) {
      const text = r.type === 'page' ? await fetchPageText(baseUrl, headers, r.id) : '';
      out.write(JSON.stringify({
        id: r.id, type: r.type, title: r.title, url: r.url, space: r.space,
        created: r.created, lastModified: r.lastModified, lastModifier: r.lastModifier, text,
      }) + '\n');
      n++;
      if (n % 20 === 0) console.error(`[content] 已抓 ${n}/${results.length}`);
    }
    out.end();
    const pages = results.filter((r) => r.type === 'page').length;
    console.log(`已输出正文 JSONL: ${outPath}`);
    console.log(`共 ${results.length} 条 (${pages} 页面 + ${results.length - pages} 附件)`);
    return;
  }

  if (opts.format === 'json') {
    console.log(JSON.stringify({ author: opts.author, resolved: user, field: opts.field, cql, total: results.length, results }, null, 2));
    return;
  }

  const html = renderHtml(user.displayName || opts.author, opts.field, results);
  const outPath = opts.out
    ? path.resolve(opts.out)
    : path.resolve(process.cwd(), `${opts.author.replace(/[\\/:*?"<>|\s]+/g, '_')}-wiki.html`);
  fs.writeFileSync(outPath, html, 'utf8');
  console.log(`已生成 HTML 报告: ${outPath}`);
  console.log(`共找到 ${results.length} 条记录 (CQL: ${cql})`);
}

main().catch((err) => {
  console.error('执行失败:', err.message);
  process.exit(1);
});
