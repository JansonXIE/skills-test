#!/usr/bin/env node

/**
 * Confluence Update Skill - 独立脚本
 * 在 Confluence 上新建页面 / 追加内容到已有页面 / 整页替换正文 / 渲染 Mermaid 图。
 * 更新前自动备份原页面内容到本地 backups/ 目录。
 *
 * 环境变量:
 *   CONFLUENCE_URL          - Confluence 基础 URL (必填)
 *   CONFLUENCE_EMAIL        - 用户邮箱 (云版, 与 API_TOKEN 配合 Basic Auth)
 *   CONFLUENCE_API_TOKEN    - API Token (云版)
 *   CONFLUENCE_PAT          - Personal Access Token (私有化版 Bearer Auth)
 *
 * 用法:
 *   # 1) 按标题查找页面，确认 pageId（不写入，安全）
 *   node confluence-update.mjs find "页面标题"
 *
 *   # 2a) 新建页面
 *   node confluence-update.mjs create --title "标题" [--parent <父pageId> | --space <key>] \
 *       [--md-file <md> | --content-file <html> | --content "<p>..</p>"]
 *
 *   # 2b) 追加内容到指定页面（自动备份 + version+1）
 *   node confluence-update.mjs append --id 12345 --content-file ./new.html
 *   node confluence-update.mjs append --id 12345 --content "<p>一行内容</p>"
 *
 *   # 2c) 整页替换正文（强制备份）
 *   node confluence-update.mjs setbody --id <pageId> --md-file /path/to/doc.md
 *
 *   # 2d) Mermaid 图渲染为图片嵌入页面
 *   node confluence-update.mjs mermaid --id <pageId> --md-file <md> [--format svg|png]
 *
 * 安全限制:
 *   - 只允许写入个人空间（space key 以 ~ 开头）。部门/团队空间（如 "HW"、"BSP"）禁止通过本脚本修改，
 *     防止 AI 误操作改动团队共享文档。如需修改部门空间页面，请通过 Confluence 网页端手动操作。
 *
 * 说明:
 *   - content 按 Confluence storage 格式(XHTML 片段)处理；若不含标签会自动用 <p> 包裹。
 *   - 备份默认写到本脚本所在目录的 backups/ 下。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mdToStorage, extractImages } from './md2storage.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKUPS_DIR = path.join(__dirname, 'backups');

const RAW = process.argv.slice(2);

function fail(msg) {
  console.error('错误: ' + msg);
  process.exit(1);
}

function getAuthHeaders(extra = {}) {
  const headers = { Accept: 'application/json', ...extra };
  if (process.env.CONFLUENCE_API_TOKEN && process.env.CONFLUENCE_EMAIL) {
    const cred = Buffer.from(
      `${process.env.CONFLUENCE_EMAIL}:${process.env.CONFLUENCE_API_TOKEN}`
    ).toString('base64');
    headers['Authorization'] = `Basic ${cred}`;
  } else if (process.env.CONFLUENCE_PAT) {
    headers['Authorization'] = `Bearer ${process.env.CONFLUENCE_PAT}`;
  } else {
    fail('Confluence 认证信息未配置 (需要 EMAIL+API_TOKEN 或 PAT)');
  }
  return headers;
}

function getBaseUrl() {
  const b = process.env.CONFLUENCE_URL;
  if (!b) fail('环境变量 CONFLUENCE_URL 未配置');
  return b.replace(/\/+$/, '');
}

function parseFlags(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--id') out.id = args[++i];
    else if (a === '--content') out.content = args[++i];
    else if (a === '--content-file') out.contentFile = args[++i];
    else if (a === '--limit') out.limit = parseInt(args[++i], 10);
    else if (a === '--no-backup') out.noBackup = true;
    else if (a === '--message') out.message = args[++i];
    else if (a === '--title') out.title = args[++i];
    else if (a === '--parent') out.parent = args[++i];
    else if (a === '--space') out.space = args[++i];
    else if (a === '--md-file') out.mdFile = args[++i];
    else if (a === '--index') out.index = parseInt(args[++i], 10);
    else if (a === '--all') out.all = true;
    else if (a === '--anchor') out.anchor = args[++i];
    else if (a === '--format') out.format = args[++i];
    else out._positional = (out._positional || []).concat(a);
  }
  return out;
}

// ---- 子命令: find ----
async function cmdFind(flags) {
  const title = (flags._positional || []).join(' ').trim();
  if (!title) fail('请提供要查找的页面标题: find "标题"');
  const base = getBaseUrl();
  const limit = flags.limit || 10;
  const cql = `title ~ "${title}"`;
  const url = `${base}/rest/api/content/search?cql=${encodeURIComponent(cql)}&limit=${limit}&expand=version`;
  const res = await fetch(url, { headers: getAuthHeaders() });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    fail(`查找失败: ${res.status} ${res.statusText}\n${body}`);
  }
  const data = await res.json();
  const results = data.results || [];
  if (results.length === 0) {
    console.log(`未找到标题匹配 "${title}" 的页面。可换关键词，或用云页面链接里的 pageId 直接指定。`);
    return;
  }
  console.log(`## 找到 ${results.length} 个候选页面（标题 ~ "${title}"）\n`);
  results.forEach((p, i) => {
    console.log(`### ${i + 1}. ${p.title}`);
    console.log(`- pageId: ${p.id}`);
    console.log(`- 类型: ${p.type}  当前版本: ${p.version?.number ?? '未知'}`);
    console.log(`- 链接: ${base}${p._links?.webui || ''}`);
    console.log('');
  });
  console.log('> 确认唯一目标后，用: append --id <pageId> --content-file <文件>');
}

// ---- 读取页面正文 + 版本 ----
async function getPage(base, id) {
  const url = `${base}/rest/api/content/${id}?expand=body.storage,version,space`;
  const res = await fetch(url, { headers: getAuthHeaders() });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    fail(`读取页面 ${id} 失败: ${res.status} ${res.statusText}\n${body}`);
  }
  return res.json();
}

function normalizeFragment(s) {
  const t = s.trim();
  // 简单判断：不含任何 < 标签就当纯文本，用 <p> 包裹并转义
  if (!/[<]/.test(t)) {
    const esc = t
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    return `<p>${esc}</p>`;
  }
  return t;
}

// ---- 备份辅助 ----
function backupPage(id, version, oldBody, suffix = '') {
  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFile = path.join(BACKUPS_DIR, `page-${id}-v${version}-${stamp}${suffix}.html`);
  fs.writeFileSync(backupFile, oldBody, 'utf8');
  console.log(`已备份原页面(v${version})到: ${backupFile}`);
  return backupFile;
}

// ---- 空间安全检查 ----
// Confluence 个人空间的 key 以 ~ 开头（如 ~ge.gao），部门空间则以字母开头（如 HW、BSP）。
// 为防止 AI 误操作改动团队共享文档，所有写操作只允许在个人空间进行。
function checkPersonalSpace(spaceKey, operation) {
  if (!spaceKey) fail('无法确定目标空间，已中止');
  if (!spaceKey.startsWith('~')) {
    fail(
      `❌ 安全限制：禁止通过 AI 修改部门/团队空间（当前空间: "${spaceKey}"）。\n` +
      `   本脚本只允许写入个人空间（space key 以 ~ 开头，如 ~ge.gao）。\n` +
      `   如需修改 "${spaceKey}" 空间的页面，请通过 Confluence 网页端手动操作。`
    );
  }
  console.log(`✅ 空间检查通过: ${spaceKey} (个人空间)`);
}

// ---- 子命令: append ----
async function cmdAppend(flags) {
  const base = getBaseUrl();
  const id = flags.id;
  if (!id) fail('请用 --id <pageId> 指定目标页面 (先用 find 子命令确认)');

  let content = flags.content;
  if (flags.contentFile) {
    if (!fs.existsSync(flags.contentFile)) fail(`内容文件不存在: ${flags.contentFile}`);
    content = fs.readFileSync(flags.contentFile, 'utf8');
  }
  if (!content || !content.trim()) fail('请用 --content 或 --content-file 提供要追加的内容');

  const page = await getPage(base, id);
  checkPersonalSpace(page.space?.key, 'append');
  const oldBody = page.body?.storage?.value || '';
  const version = page.version?.number;
  if (typeof version !== 'number') fail('无法读取页面当前版本号，已中止');

  // 备份
  if (!flags.noBackup) {
    backupPage(id, version, oldBody);
  }

  const fragment = normalizeFragment(content);
  const newBody = oldBody + '\n' + fragment;

  const payload = {
    id: page.id,
    type: page.type,
    title: page.title,
    space: { key: page.space?.key },
    body: { storage: { value: newBody, representation: 'storage' } },
    version: {
      number: version + 1,
      message: flags.message || 'Append content via confluence-update skill',
    },
  };

  const url = `${base}/rest/api/content/${id}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    fail(`更新失败: ${res.status} ${res.statusText}\n${body}\n(原页面未改动，可用备份核对)`);
  }
  const updated = await res.json();
  console.log(`更新成功: "${updated.title}"  版本 ${version} -> ${updated.version?.number}`);
  console.log(`链接: ${base}${updated._links?.webui || ''}`);
}

// ---- 子命令: create (新建页面, 可指定父页/space, 内容来自 md/html/直传) ----
async function cmdCreate(flags) {
  const base = getBaseUrl();
  const title = flags.title;
  if (!title) fail('请用 --title "页面标题" 指定新页面标题');

  // 解析内容来源，统一转为 storage 片段
  let body = '';
  if (flags.mdFile) {
    if (!fs.existsSync(flags.mdFile)) fail(`Markdown 文件不存在: ${flags.mdFile}`);
    body = mdToStorage(fs.readFileSync(flags.mdFile, 'utf8'));
  } else if (flags.contentFile) {
    if (!fs.existsSync(flags.contentFile)) fail(`内容文件不存在: ${flags.contentFile}`);
    body = fs.readFileSync(flags.contentFile, 'utf8');
  } else if (flags.content) {
    body = normalizeFragment(flags.content);
  } else {
    body = '<p></p>'; // 允许创建空页(比如只做父容器)
  }

  // 确定 space key 与父页面
  let spaceKey = flags.space;
  const payload = {
    type: 'page',
    title,
    body: { storage: { value: body, representation: 'storage' } },
  };

  if (flags.parent) {
    // 用父页面反查 space，保证同空间
    const parent = await getPage(base, flags.parent);
    spaceKey = spaceKey || parent.space?.key;
    payload.ancestors = [{ id: String(flags.parent) }];
  }
  if (!spaceKey) fail('无法确定 space：请用 --space <key> 或 --parent <pageId> 指定');
  checkPersonalSpace(spaceKey, 'create');
  payload.space = { key: spaceKey };

  const url = `${base}/rest/api/content`;
  const res = await fetch(url, {
    method: 'POST',
    headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    fail(`创建页面失败: ${res.status} ${res.statusText}\n${t}`);
  }
  const created = await res.json();
  console.log(`创建成功: "${created.title}"  pageId=${created.id}  space=${spaceKey}`);
  console.log(`链接: ${base}${created._links?.webui || ''}`);

  // 若内容来自 md 且含本地图片引用，建页后上传附件（正文已含 <ri:attachment> 引用）
  if (flags.mdFile) {
    const r = await uploadLocalImages(base, created.id, flags.mdFile, fs.readFileSync(flags.mdFile, 'utf8'));
    if (r.missing.length) {
      console.log(`⚠️ ${r.missing.length} 张图未找到本地文件，页面中这些图会显示为缺失附件，需手动补传。`);
    }
  }
  // 输出 pageId 到 stdout 末行，便于脚本串联
  return created.id;
}

// ---- 子命令: setbody (整页替换正文, 来自 md/html; 自动备份 + 上传本地图) ----
async function cmdSetBody(flags) {
  const base = getBaseUrl();
  const id = flags.id;
  if (!id) fail('请用 --id <pageId> 指定目标页面');

  let body = '';
  if (flags.mdFile) {
    if (!fs.existsSync(flags.mdFile)) fail(`Markdown 文件不存在: ${flags.mdFile}`);
    body = mdToStorage(fs.readFileSync(flags.mdFile, 'utf8'));
  } else if (flags.contentFile) {
    if (!fs.existsSync(flags.contentFile)) fail(`内容文件不存在: ${flags.contentFile}`);
    body = fs.readFileSync(flags.contentFile, 'utf8');
  } else if (flags.content) {
    body = normalizeFragment(flags.content);
  } else {
    fail('请用 --md-file / --content-file / --content 提供整页新正文');
  }

  const page = await getPage(base, id);
  checkPersonalSpace(page.space?.key, 'setbody');
  const oldBody = page.body?.storage?.value || '';
  const version = page.version?.number;
  if (typeof version !== 'number') fail('无法读取页面当前版本号，已中止');

  // 整页替换风险高，强制备份（--no-backup 也照备）
  backupPage(id, version, oldBody, '-presetbody');

  // 先上传本地图（正文引用的是 basename 附件）
  if (flags.mdFile) {
    const r = await uploadLocalImages(base, id, flags.mdFile, fs.readFileSync(flags.mdFile, 'utf8'));
    if (r.missing.length) {
      console.log(`⚠️ ${r.missing.length} 张图未找到本地文件，页面中这些图会显示为缺失附件。`);
    }
  }

  const payload = {
    id: page.id,
    type: page.type,
    title: page.title,
    space: { key: page.space?.key },
    body: { storage: { value: body, representation: 'storage' } },
    version: {
      number: version + 1,
      message: flags.message || 'Replace body via confluence-update skill',
    },
  };
  const res = await fetch(`${base}/rest/api/content/${id}`, {
    method: 'PUT',
    headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    fail(`整页替换失败: ${res.status} ${res.statusText}\n${t}\n(原页面未改动，可用备份核对)`);
  }
  const u = await res.json();
  console.log(`整页替换成功: "${u.title}"  版本 ${version} -> ${u.version?.number}`);
  console.log(`链接: ${base}${u._links?.webui || ''}`);
}

// ---- 从 Markdown 文本提取所有 ```mermaid 代码块 ----
function extractMermaid(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    if (/^```mermaid\s*$/.test(lines[i])) {
      const buf = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) buf.push(lines[i++]);
      blocks.push(buf.join('\n'));
    }
    i++;
  }
  return blocks;
}

// ---- 经 mermaid.ink 渲染为图片 (Buffer)，format: 'svg' | 'png' ----
const IMG_META = {
  svg: { path: 'svg', ext: 'svg', mime: 'image/svg+xml' },
  png: { path: 'img', ext: 'png', mime: 'image/png' }, // /img/<b64>?type=png
};
async function renderMermaid(src, format) {
  const meta = IMG_META[format];
  if (!meta) throw new Error(`不支持的 --format: ${format} (仅 svg | png)`);
  const b64 = Buffer.from(src, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const url =
    format === 'png'
      ? `https://mermaid.ink/img/${b64}?type=png`
      : `https://mermaid.ink/svg/${b64}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`mermaid.ink 渲染失败: ${res.status} ${t.slice(0, 120)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

// ---- 上传附件到页面 (存在同名则更新) ----
async function uploadAttachment(base, pageId, filename, buf, mime) {
  // multipart/form-data 手工拼装 (Node 原生 FormData + Blob)
  const form = new FormData();
  form.append('file', new Blob([buf], { type: mime }), filename);
  form.append('minorEdit', 'true');
  const headers = getAuthHeaders({ 'X-Atlassian-Token': 'no-check' });
  delete headers['Content-Type']; // 交给 fetch 自动带 boundary
  // 先查是否已有同名附件
  const listUrl = `${base}/rest/api/content/${pageId}/child/attachment?filename=${encodeURIComponent(filename)}`;
  const list = await fetch(listUrl, { headers: getAuthHeaders() }).then((r) => r.json()).catch(() => ({}));
  const existing = (list.results || [])[0];
  const url = existing
    ? `${base}/rest/api/content/${pageId}/child/attachment/${existing.id}/data`
    : `${base}/rest/api/content/${pageId}/child/attachment`;
  const res = await fetch(url, { method: 'POST', headers, body: form });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`上传附件失败: ${res.status} ${t.slice(0, 200)}`);
  }
  return res.json();
}

// ---- 按扩展名推断图片 mime ----
function guessImageMime(filename) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  const map = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    svg: 'image/svg+xml', webp: 'image/webp', bmp: 'image/bmp',
  };
  return map[ext] || 'application/octet-stream';
}

// ---- 把 md 中引用的本地图片上传为该页附件 ----
// mdPath 用来解析图片相对路径。返回 {uploaded:[], missing:[]}。
async function uploadLocalImages(base, pageId, mdPath, mdText) {
  const imgs = extractImages(mdText);
  const result = { uploaded: [], missing: [] };
  if (imgs.length === 0) return result;
  const mdDir = path.dirname(path.resolve(mdPath));
  console.log(`发现 ${imgs.length} 张本地图片引用，开始上传附件...`);
  for (const { src, filename } of imgs) {
    // 相对 md 文件解析图片路径
    const imgPath = path.isAbsolute(src) ? src : path.resolve(mdDir, src);
    if (!fs.existsSync(imgPath)) {
      console.log(`  ⚠️ 缺失，跳过: ${src} (解析为 ${imgPath})`);
      result.missing.push(src);
      continue;
    }
    const buf = fs.readFileSync(imgPath);
    await uploadAttachment(base, pageId, filename, buf, guessImageMime(filename));
    console.log(`  ✓ 上传 ${filename} (${buf.length} 字节)`);
    result.uploaded.push(filename);
  }
  return result;
}

// ---- 子命令: mermaid (提取 -> 渲染 SVG -> 上传附件 -> 正文嵌入) ----
async function cmdMermaid(flags) {
  const base = getBaseUrl();
  const id = flags.id;
  if (!id) fail('请用 --id <pageId> 指定目标页面');
  if (!flags.mdFile) fail('请用 --md-file <md> 指定包含 ```mermaid 的 Markdown 源文件');
  if (!fs.existsSync(flags.mdFile)) fail(`Markdown 文件不存在: ${flags.mdFile}`);

  const format = (flags.format || 'svg').toLowerCase();
  if (!IMG_META[format]) fail(`--format 仅支持 svg | png，收到: ${format}`);
  const meta = IMG_META[format];

  const blocks = extractMermaid(fs.readFileSync(flags.mdFile, 'utf8'));
  if (blocks.length === 0) fail('未在该 Markdown 中找到 ```mermaid 代码块');
  console.log(`找到 ${blocks.length} 个 mermaid 图，输出格式: ${format}`);

  // 选择要处理的图：默认全部；--index N 只处理第 N 个(1-based)
  let chosen = blocks.map((src, i) => ({ src, i }));
  if (typeof flags.index === 'number') {
    if (flags.index < 1 || flags.index > blocks.length) fail(`--index 超范围 (1..${blocks.length})`);
    chosen = [{ src: blocks[flags.index - 1], i: flags.index - 1 }];
  }

  // 渲染 + 上传所有选中的图
  const uploaded = [];
  for (const { src, i } of chosen) {
    const filename = `mermaid-${i + 1}.${meta.ext}`;
    console.log(`  [${i + 1}] 渲染中 (${format})...`);
    const img = await renderMermaid(src, format);
    console.log(`  [${i + 1}] 已渲染 ${img.length} 字节，上传为附件 ${filename} ...`);
    await uploadAttachment(base, id, filename, img, meta.mime);
    uploaded.push(filename);
  }

  // 读取页面，插入图片宏
  const page = await getPage(base, id);
  checkPersonalSpace(page.space?.key, 'mermaid');
  const oldBody = page.body?.storage?.value || '';
  const version = page.version?.number;
  if (typeof version !== 'number') fail('无法读取页面版本号');

  // 备份
  if (!flags.noBackup) {
    backupPage(id, version, oldBody, '-premermaid');
  }

  // 图片宏 storage 语法
  const imgMacro = (fn) =>
    `<ac:image ac:align="center"><ri:attachment ri:filename="${fn}" /></ac:image>`;

  let newBody = oldBody;
  if (flags.anchor) {
    // 在包含 anchor 文本的标题后插入(第一处)
    const imgs = uploaded.map(imgMacro).join('\n');
    const re = new RegExp(`(<h[1-6][^>]*>[^<]*${flags.anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^<]*</h[1-6]>)`);
    if (re.test(oldBody)) {
      newBody = oldBody.replace(re, `$1\n${imgs}`);
      console.log(`已在含"${flags.anchor}"的标题后插入 ${uploaded.length} 张图`);
    } else {
      console.log(`⚠️ 未找到含"${flags.anchor}"的标题，改为追加到页面末尾`);
      newBody = oldBody + '\n' + imgs;
    }
  } else {
    // 默认追加到末尾
    newBody = oldBody + '\n' + uploaded.map(imgMacro).join('\n');
    console.log(`已把 ${uploaded.length} 张图追加到页面末尾`);
  }

  const payload = {
    id: page.id,
    type: page.type,
    title: page.title,
    space: { key: page.space?.key },
    body: { storage: { value: newBody, representation: 'storage' } },
    version: { number: version + 1, message: flags.message || 'Embed mermaid SVG via skill' },
  };
  const res = await fetch(`${base}/rest/api/content/${id}`, {
    method: 'PUT',
    headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    fail(`更新正文失败: ${res.status} ${t}\n(附件已上传，正文未改，可重试)`);
  }
  const u = await res.json();
  console.log(`更新成功: v${version} -> v${u.version?.number}`);
  console.log(`链接: ${base}${u._links?.webui || ''}`);
}

async function main() {
  const sub = RAW[0];
  const flags = parseFlags(RAW.slice(1));
  if (sub === 'find') return cmdFind(flags);
  if (sub === 'append') return cmdAppend(flags);
  if (sub === 'create') return cmdCreate(flags);
  if (sub === 'setbody') return cmdSetBody(flags);
  if (sub === 'mermaid') return cmdMermaid(flags);
  console.log(`用法:
  node confluence-update.mjs find "页面标题"
  node confluence-update.mjs create --title "标题" [--parent <父pageId> | --space <key>] [--md-file <md> | --content-file <html> | --content "<p>..</p>"]
      (--md-file 含本地图 ![](img/x.png) 时，建页后自动上传为附件)
  node confluence-update.mjs setbody --id <pageId> [--md-file <md> | --content-file <html> | --content "<p>..</p>"] [--message "变更说明"]
      整页替换正文(强制备份)；--md-file 含本地图时自动上传附件。用于给已存在页面补图/换内容。
  node confluence-update.mjs append --id <pageId> --content-file <文件> [--message "变更说明"] [--no-backup]
  node confluence-update.mjs mermaid --id <pageId> --md-file <md> [--format svg|png] [--index N] [--anchor "标题关键词"] [--no-backup]
      提取 md 中的 mermaid 图 -> mermaid.ink 渲染(默认 svg) -> 上传为页面附件 -> 正文嵌入`);
  process.exit(sub ? 1 : 0);
}

main().catch((e) => fail(e.message));
