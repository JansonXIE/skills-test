#!/usr/bin/env node

/**
 * 把"按知识点分类的结构化摘要"渲染成带 sticky 侧边栏的单页 HTML.
 *
 * 输入:
 *   --knowledge PATH   (可重复) 每份形如 { groups:[{category, pages:[{title,url,summary,keyPoints,codeSnippet}]}] }
 *   --logs PATH        (可选)   形如 { months:[{month,summary,logsWithContent:[{date,url,text}]}],
 *                                  themes:[], weeklyPlans:[{title,url,summary}],
 *                                  indexPages:[{title,url,note}], stats:{} }
 *   --name "显示名"     报告标题里的人名
 *   --out PATH         输出 HTML 路径 (默认 ./report.html)
 *
 * 输出: 独立 HTML, 左侧 sticky 导航 + 右侧分类内容, 所有标题可点击跳转原文.
 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opts = { knowledge: [], logs: '', name: '', out: '' };
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--knowledge' && i + 1 < args.length) opts.knowledge.push(args[++i]);
  else if (args[i] === '--logs' && i + 1 < args.length) opts.logs = args[++i];
  else if (args[i] === '--name' && i + 1 < args.length) opts.name = args[++i];
  else if (args[i] === '--out' && i + 1 < args.length) opts.out = args[++i];
}

// 合并所有 knowledge 文件的 groups
const groups = [];
for (const p of opts.knowledge) {
  const obj = JSON.parse(fs.readFileSync(p, 'utf8'));
  for (const g of obj.groups || []) groups.push(g);
}
let logs = null;
if (opts.logs) logs = JSON.parse(fs.readFileSync(opts.logs, 'utf8'));

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const escCode = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const totalPages = groups.reduce((n, g) => n + (g.pages?.length || 0), 0);
const name = opts.name || (groups[0]?.pages?.[0]?.title ? 'Wiki' : 'Wiki');

// ---- 侧边栏导航 ----
function sidebar() {
  const items = [];
  if (logs?.themes?.length) items.push(`<a href="#themes">🎯 工作主线</a>`);
  groups.forEach((g, i) => {
    items.push(`<a href="#grp${i}">${esc(g.category)}<span class="n">${g.pages?.length || 0}</span></a>`);
  });
  if (logs) {
    items.push(`<a href="#logs">📅 工作日志与计划<span class="n">${logs.stats?.totalDailyLogs ?? ''}</span></a>`);
  }
  return `<nav class="nav">${items.join('')}</nav>`;
}

// ---- 知识页面卡片 ----
function pageCard(p) {
  const kps = (p.keyPoints || []).map((k) => `<li>${esc(k)}</li>`).join('');
  const code = p.codeSnippet ? `<pre class="code"><code>${escCode(p.codeSnippet)}</code></pre>` : '';
  return `<article class="page">
  <a class="page-title" href="${esc(p.url)}" target="_blank" rel="noreferrer">${esc(p.title)}</a>
  <p class="summary">${esc(p.summary)}</p>
  ${kps ? `<ul class="kps">${kps}</ul>` : ''}
  ${code}
</article>`;
}

const groupsHtml = groups.map((g, i) => `
<section class="group" id="grp${i}">
  <h2>${esc(g.category)} <span class="count">${g.pages?.length || 0} 篇</span></h2>
  ${(g.pages || []).map(pageCard).join('')}
</section>`).join('');

// ---- 日志区 ----
let logsHtml = '';
if (logs) {
  const themes = (logs.themes || []).map((t) => `<li>${esc(t)}</li>`).join('');
  const months = (logs.months || []).map((m) => `
<div class="month">
  <h3>${esc(m.month)} <span class="count">${m.logsWithContent?.length || 0} 篇</span></h3>
  <p class="summary">${esc(m.summary)}</p>
  <details class="logs"><summary>展开当日工作记录</summary>
    <ul class="loglist">${(m.logsWithContent || []).map((l) => `<li><a href="${esc(l.url)}" target="_blank" rel="noreferrer"><b>${esc(l.date)}</b></a> — ${esc(l.text)}</li>`).join('')}</ul>
  </details>
</div>`).join('');
  const weekly = (logs.weeklyPlans || []).map((w) => `<li class="weekly"><a href="${esc(w.url)}" target="_blank" rel="noreferrer"><b>${esc(w.title)}</b></a>：${esc(w.summary)}</li>`).join('');
  const indexPages = (logs.indexPages || []).map((p) => `<li><a href="${esc(p.url)}" target="_blank" rel="noreferrer">${esc(p.title)}</a> — ${esc(p.note)}</li>`).join('');
  logsHtml = `
<section class="group" id="logs">
  <h2>工作日志与计划 <span class="count">${logs.stats?.totalDailyLogs || ''} 篇日日志</span></h2>
  ${months}
  <h3 class="sub">📅 周工作计划</h3>
  <ul class="weekly-list">${weekly}</ul>
  <h3 class="sub">📑 索引/汇总页</h3>
  <ul class="index-list">${indexPages}</ul>
</section>`;
  if (themes) {
    logsHtml = `<section class="group themes" id="themes"><h2>🎯 工作主线 / 反复出现的主题</h2><ul>${themes}</ul></section>` + logsHtml;
  }
}

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(name)} Wiki 知识汇总</title>
<style>
  :root { color-scheme: light dark; --accent:#0052cc; --accent2:#1e3a8a; --bg:#f4f5f7; --card:#fff; --border:#eef0f2; --muted:#888; }
  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; }
  body { font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; margin: 0; background: var(--bg); color: #1a1a1a; line-height: 1.7; }
  .layout { display: flex; align-items: flex-start; max-width: 1280px; margin: 0 auto; }
  .sidebar { position: sticky; top: 0; width: 248px; min-height: 100vh; background: #fff; border-right: 1px solid var(--border); padding: 22px 16px; overflow-y: auto; }
  .sidebar .hero { margin-bottom: 18px; }
  .sidebar .hero h1 { font-size: 17px; margin: 0 0 4px; color: var(--accent); }
  .sidebar .hero .sub { font-size: 12px; color: var(--muted); }
  .sidebar .stats { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 12px; margin: 12px 0 18px; }
  .sidebar .stat b { font-size: 17px; color: var(--accent2); }
  .sidebar .stat span { display: block; font-size: 11px; color: var(--muted); }
  .nav a { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 6px 10px; border-radius: 6px; color: #444; text-decoration: none; font-size: 13px; }
  .nav a:hover, .nav a.active { background: #eef4ff; color: var(--accent); }
  .nav .n { font-size: 11px; color: var(--muted); background: #f0f1f3; border-radius: 10px; padding: 0 7px; }
  .nav .nav-title { font-size: 11px; color: #aaa; text-transform: uppercase; letter-spacing: .05em; padding: 10px 10px 4px; }
  .main { flex: 1; min-width: 0; padding: 24px 28px 60px; }
  .group { background: var(--card); border-radius: 14px; padding: 24px 26px; margin-bottom: 22px; box-shadow: 0 1px 4px rgba(0,0,0,.06); }
  .group h2 { margin: 0 0 18px; font-size: 21px; color: var(--accent); border-left: 4px solid var(--accent); padding-left: 12px; }
  .group.themes h2 { color: #b45309; border-color: #b45309; }
  .group.themes ul { margin: 0; padding-left: 20px; font-size: 13.5px; }
  .group.themes li { margin: 4px 0; }
  .count { color: var(--muted); font-size: 13px; font-weight: 400; }
  .page { border: 1px solid var(--border); border-radius: 10px; padding: 16px 18px; margin-bottom: 14px; background: #fafbfc; }
  .page-title { color: var(--accent); font-weight: 600; font-size: 16px; text-decoration: none; display: block; margin-bottom: 4px; }
  .page-title:hover { text-decoration: underline; }
  .summary { margin: 4px 0 10px; color: #333; font-size: 14px; }
  .kps { margin: 0; padding-left: 20px; font-size: 13px; color: #444; }
  .kps li { margin: 3px 0; }
  .code { background: #1e293b; color: #e2e8f0; border-radius: 8px; padding: 12px 14px; margin: 10px 0 0; overflow-x: auto; font-size: 12.5px; line-height: 1.55; }
  .code code { font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace; white-space: pre; }
  .month { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 16px 20px; margin-bottom: 12px; }
  .month h3 { margin: 0 0 6px; font-size: 16px; color: var(--accent2); }
  .logs summary { cursor: pointer; color: var(--accent); font-size: 13px; margin-top: 4px; }
  .loglist { margin: 8px 0 0; padding-left: 18px; font-size: 13px; }
  .loglist li { margin: 5px 0; color: #444; }
  .loglist a { color: var(--accent); text-decoration: none; }
  .loglist a:hover { text-decoration: underline; }
  .weekly-list, .index-list { padding-left: 18px; font-size: 13.5px; }
  .weekly-list li, .index-list li { margin: 8px 0; }
  h3.sub { color: var(--accent2); margin-top: 22px; }
  .footer { text-align: center; color: #aaa; font-size: 12px; margin-top: 24px; }
  @media (max-width: 860px) { .layout { flex-direction: column; } .sidebar { position: static; width: auto; min-height: auto; border-right: none; border-bottom: 1px solid var(--border); } }
</style>
</head>
<body>
<div class="layout">
  <aside class="sidebar">
    <div class="hero">
      <h1>📚 ${esc(name)}</h1>
      <div class="sub">Wiki 知识汇总</div>
    </div>
    <div class="stats">
      <div class="stat"><b>${totalPages}</b><span>知识文档</span></div>
      <div class="stat"><b>${groups.length}</b><span>分类</span></div>
      <div class="stat"><b>${logs?.stats?.totalDailyLogs ?? '—'}</b><span>日日志</span></div>
      <div class="stat"><b>${logs?.weeklyPlans?.length ?? '—'}</b><span>周计划</span></div>
    </div>
    <div class="nav-title">目录</div>
    ${sidebar()}
  </aside>
  <main class="main">
    ${logs?.themes?.length ? '' : ''}
    ${groupsHtml}
    ${logsHtml}
    <div class="footer">按知识点分类整理 · 标题均可点击跳转原文 · Generated by confluence-author-wiki skill</div>
  </main>
</div>
</body>
</html>`;

const outPath = path.resolve(opts.out || 'report.html');
fs.writeFileSync(outPath, html, 'utf8');
console.log(`已生成: ${outPath}`);
console.log(`知识文档: ${totalPages} 篇 (跨 ${groups.length} 类)`);
if (logs) console.log(`日日志: ${logs.stats?.totalDailyLogs ?? '?'} 篇, 周计划: ${logs.weeklyPlans?.length ?? '?'} 篇`);
