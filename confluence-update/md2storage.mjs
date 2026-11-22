/**
 * 轻量 Markdown -> Confluence storage(XHTML 片段) 转换器
 * 覆盖常见语法：标题、段落、加粗/斜体/行内代码、围栏代码块、
 * 引用块、有序/无序列表(单层)、表格、水平线、链接。
 * 纯本地、不联网、无第三方依赖。
 *
 * 局限(已知，需人工复核)：
 *   - 不支持嵌套列表的多级缩进(会拍平为单层)。
 *   - 图片 ![alt](path)：本地图转 <ac:image><ri:attachment>(按 basename 引用，需另行上传附件)，
 *     外链(http/https)转 <ac:image><ri:url>。上传由 confluence-update.mjs 的 create/setbody 负责。
 *   - Mermaid/DOT 等图不转换，按普通代码块处理。
 *   - 复杂/自定义 Confluence 宏不生成。
 */

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// 取路径 basename（兼容 / 和 \），并去掉可能的 #anchor / ?query
function baseName(src) {
  const clean = src.trim().replace(/[?#].*$/, '');
  return clean.split('/').pop().split('\\').pop();
}

// Markdown 图片 -> Confluence storage 图片宏
// 本地路径 -> <ri:attachment ri:filename="basename">（附件需另行上传到该页）
// http(s) 外链 -> <ri:url ri:value="...">
function imageMacro(alt, src) {
  const altAttr = alt ? ` ac:alt="${escapeAttr(alt)}"` : '';
  if (/^https?:\/\//i.test(src.trim())) {
    return `<ac:image${altAttr}><ri:url ri:value="${escapeAttr(src.trim())}" /></ac:image>`;
  }
  return `<ac:image${altAttr}><ri:attachment ri:filename="${escapeAttr(baseName(src))}" /></ac:image>`;
}

// 从 Markdown 提取本地图片引用（供 create/setbody 上传附件用）。
// 只收本地路径，跳过 http(s) 外链；按 basename 去重。
export function extractImages(md) {
  const re = /!\[([^\]]*)\]\(([^)]+)\)/g;
  const text = md.replace(/\r\n/g, '\n');
  const seen = new Set();
  const out = [];
  let m;
  while ((m = re.exec(text))) {
    const src = m[2].trim();
    if (/^https?:\/\//i.test(src)) continue;
    const filename = baseName(src);
    if (seen.has(filename)) continue;
    seen.add(filename);
    out.push({ alt: m[1], src, filename });
  }
  return out;
}

// 行内元素：先保护行内代码/图片，再处理粗/斜/链接，最后转义
function inline(text) {
  const codes = [];
  let s = text.replace(/`([^`]+)`/g, (_, c) => {
    codes.push(c);
    return ` CODE${codes.length - 1} `;
  });
  // 图片 ![alt](src)：必须在链接之前处理(否则被链接规则吃掉)。
  // 生成的宏含 < 标签，先占位保护，避免被 escapeHtml 破坏。
  const imgs = [];
  s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, src) => {
    imgs.push(imageMacro(alt, src));
    return ` IMG${imgs.length - 1} `;
  });
  s = escapeHtml(s);
  // 链接 [text](url)
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, u) => {
    return `<a href="${u.replace(/"/g, '&quot;')}">${t}</a>`;
  });
  // 加粗 **x** / __x__
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  // 斜体 *x* / _x_
  s = s.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  // 还原行内代码
  s = s.replace(/ CODE(\d+) /g, (_, i) => `<code>${escapeHtml(codes[+i])}</code>`);
  // 还原图片宏
  s = s.replace(/ IMG(\d+) /g, (_, i) => imgs[+i]);
  return s;
}

// Confluence 代码块宏
// Confluence code 宏只接受固定的语言白名单，传白名单外的值(如 mermaid)
// 会抛 com.atlassian.confluence.ext.code.render.InvalidValueException。
// 常见别名做归一化，白名单外一律不写 language 参数(退化为无高亮纯文本，永远合法)。
const CODE_LANG_WHITELIST = new Set([
  'actionscript3', 'bash', 'csharp', 'coldfusion', 'cpp', 'css', 'delphi',
  'diff', 'erlang', 'groovy', 'html', 'java', 'javafx', 'javascript',
  'perl', 'php', 'powershell', 'python', 'ruby', 'scala', 'sql', 'vb',
  'xml', 'text', 'go', 'yaml', 'json',
]);
const CODE_LANG_ALIAS = {
  sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash',
  'c++': 'cpp', c: 'cpp', h: 'cpp', hpp: 'cpp',
  js: 'javascript', ts: 'javascript', py: 'python',
  yml: 'yaml', htm: 'html', md: 'text', makefile: 'text', make: 'text',
  dts: 'text', dtsi: 'text', kconfig: 'text', mk: 'text',
};

function codeMacro(lang, code) {
  let norm = (lang || '').toLowerCase();
  norm = CODE_LANG_ALIAS[norm] || norm;
  const langAttr = CODE_LANG_WHITELIST.has(norm)
    ? `<ac:parameter ac:name="language">${escapeHtml(norm)}</ac:parameter>`
    : '';
  return (
    `<ac:structured-macro ac:name="code">${langAttr}` +
    `<ac:plain-text-body><![CDATA[${code.replace(/]]>/g, ']]]]><![CDATA[>')}]]></ac:plain-text-body>` +
    `</ac:structured-macro>`
  );
}

export function mdToStorage(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;

  // 列表缓冲
  let listType = null; // 'ul' | 'ol'
  let listItems = [];
  const flushList = () => {
    if (listType) {
      out.push(`<${listType}>` + listItems.map((x) => `<li>${x}</li>`).join('') + `</${listType}>`);
      listType = null;
      listItems = [];
    }
  };

  // 段落缓冲
  let para = [];
  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${inline(para.join(' '))}</p>`);
      para = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    // 围栏代码块
    const fence = line.match(/^```\s*([\w+-]*)\s*$/);
    if (fence) {
      flushPara();
      flushList();
      const lang = fence[1] || '';
      const buf = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++; // 跳过结尾 ```
      out.push(codeMacro(lang, buf.join('\n')));
      continue;
    }

    // 水平线
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      flushPara();
      flushList();
      out.push('<hr/>');
      i++;
      continue;
    }

    // 标题
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushPara();
      flushList();
      const level = h[1].length;
      out.push(`<h${level}>${inline(h[2].trim())}</h${level}>`);
      i++;
      continue;
    }

    // 表格：当前行含 | 且下一行是分隔行
    if (/\|/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1]) && /-/.test(lines[i + 1])) {
      flushPara();
      flushList();
      const splitRow = (r) =>
        r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
      const header = splitRow(line);
      i += 2; // 跳过表头和分隔行
      const rows = [];
      while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim() !== '') {
        rows.push(splitRow(lines[i]));
        i++;
      }
      let t = '<table><tbody>';
      t += '<tr>' + header.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr>';
      for (const r of rows) {
        t += '<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>';
      }
      t += '</tbody></table>';
      out.push(t);
      continue;
    }

    // 引用块
    if (/^\s*>\s?/.test(line)) {
      flushPara();
      flushList();
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      out.push(`<blockquote><p>${inline(buf.join(' '))}</p></blockquote>`);
      continue;
    }

    // 无序列表
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    if (ul) {
      flushPara();
      if (listType && listType !== 'ul') flushList();
      listType = 'ul';
      listItems.push(inline(ul[1]));
      i++;
      continue;
    }

    // 有序列表
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ol) {
      flushPara();
      if (listType && listType !== 'ol') flushList();
      listType = 'ol';
      listItems.push(inline(ol[1]));
      i++;
      continue;
    }

    // 空行 -> 段落/列表结束
    if (line.trim() === '') {
      flushPara();
      flushList();
      i++;
      continue;
    }

    // 普通段落文本
    flushList();
    para.push(line.trim());
    i++;
  }

  flushPara();
  flushList();
  return out.join('\n');
}

// 允许作为 CLI 使用：node md2storage.mjs input.md > out.xhtml
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const f = process.argv[2];
  if (!f) {
    console.error('用法: node md2storage.mjs <markdown 文件>');
    process.exit(1);
  }
  process.stdout.write(mdToStorage(fs.readFileSync(f, 'utf8')));
}
