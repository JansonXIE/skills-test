#!/usr/bin/env node
// update-flash-matrix driver
//
// Keeps "CVITEK_SDK_Flash支持列表汇总.html" in sync with the flash
// support-list sources of the three SDKs.
//
// Sources (all verified to exist at the SDKs' remote refs):
//   NOR  u-boot: <sdk>/u-boot-2021.10/drivers/mtd/spi/spi-nor-ids.c
//   NOR  linux:  <sdk>/linux_5.10/drivers/mtd/spi-nor/cvitek_support_list.c
//   NAND u-boot: <sdk>/u-boot-2021.10/drivers/mtd/nand/raw/cvitek/cvsnfc_spi_ids.c
//   NAND linux:  <sdk>/linux_5.10/drivers/mtd/nand/raw/cvitek/cvsnfc_spi_ids.c
//   eMMC: none — no support_list source exists. The list is hand-maintained in
//         emmc.json next to this driver and is rendered verbatim. All three SDKs
//         share one eMMC IP block, so every entry is compatible with all three
//         by construction (see the section's 适配 column).
//
// Commands:
//   fetch   [--update-checkout] [--keep-local]
//       git fetch each of the 6 repos at its tracked branch.
//       Default: updates only remote-tracking refs (origin/<branch>) —
//       your working trees are never touched.
//       --update-checkout also resets each clean tree to origin/<branch>.
//       --keep-local rebases local-only commits on top instead of resetting.
//
//   report
//       Read the four source files from origin/<branch> (run `fetch` first)
//       and print per-SDK counts, plus every flash whose presence changed
//       since the last `build` (stored in state.json).
//
//   build [--out <file>]
//       Regenerate the HTML from the sources. Default output is the document
//       at $DEVICE_ROOT/CVITEK_SDK_Flash支持列表汇总.html.
//       Writes state.json recording the current flash set.
//
//   render [<html> [out.png] [w] [h]]
//       Screenshot the document (delegates to generate-styled-html/render.sh).
//
// No deps, Node >= 18.

import { execFileSync, execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE = join(HERE, 'state.json');
const EMMC_JSON = join(HERE, 'emmc.json');
const DEVICE_ROOT = process.env.DEVICE_ROOT || '/media/cvitek/jianxing.xie/device';
const DOC = join(DEVICE_ROOT, 'CVITEK_SDK_Flash支持列表汇总.html');
const RENDER_SH = join(HERE, '..', 'generate-styled-html', 'render.sh');

// sdk key -> where its two repos live, and which branch we track
const SDKS = [
  { key: '410', dir: '410', branch: 'v4.1.0', label: 'CV181x (410)', badge: '410' },
  { key: '420_2', dir: '420_2', branch: 'v4.2.0', label: 'CV180x (420)', badge: '420' },
  { key: 'mars3_repo', dir: 'mars3_repo', branch: 'master', label: 'Mars3', badge: 'Mars3' },
];

const F = {
  norUboot: 'drivers/mtd/spi/spi-nor-ids.c',
  norLinux: 'drivers/mtd/spi-nor/cvitek_support_list.c',
  nand: 'drivers/mtd/nand/raw/cvitek/cvsnfc_spi_ids.c',
};

// ---------------------------------------------------------------- helpers
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[k] = true;
      else { out[k] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

function git(repoDir, args) {
  return execFileSync('git', ['-C', repoDir, ...args], {
    encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
}
function gitq(repoDir, args) {
  try { return { ok: true, out: git(repoDir, args) }; }
  catch (e) { return { ok: false, out: `${e.stdout || ''}${e.stderr || ''}` }; }
}

// A flash entry name is only "supported" if its declaration is NOT commented
// out. Several entries in these tables sit behind a `//` — counting those was
// a real bug the first time this document was built (KH25L12833FM2I).
function stripComments(text) {
  return text.split('\n')
    .map((l) => (/^\s*\/\//.test(l) ? '' : l.replace(/\/\/.*$/, '')))
    .join('\n');
}

// ---------------------------------------------------------------- parsers
function parseNorUboot(text) {
  const out = new Map();
  const t = stripComments(text);
  const re = /INFO6?\("([^"]+)",\s*(0x[0-9a-fA-F]+),\s*(0x[0-9a-fA-F]+),\s*([0-9]+\s*\*\s*[0-9]+|[0-9]+),\s*([0-9]+)/g;
  let m;
  while ((m = re.exec(t))) {
    const sector = Number(eval(m[4]));           // "64 * 1024" -> 65536
    out.set(m[1], { jedec: parseInt(m[2], 16), size: sector * parseInt(m[5], 10) });
  }
  return out;
}

function parseNorLinux(text) {
  const out = new Map();
  const t = stripComments(text);
  const re = /\{\s*"([^"]+)",\s*(?:CVI_)?INFO6?\((0x[0-9a-fA-F]+),\s*(0x[0-9a-fA-F]+|0),\s*([0-9]+\s*\*\s*[0-9]+|[0-9]+),\s*([0-9]+)/g;
  let m;
  while ((m = re.exec(t))) {
    const sector = Number(eval(m[4]));
    out.set(m[1], { jedec: parseInt(m[2], 16), size: sector * parseInt(m[5], 10) });
  }
  return out;
}

function parseNandUboot(text) {
  const out = new Map();
  const t = stripComments(text);
  const re = /\.name\s*=\s*"([^"]+)"[\s\S]*?\.chipsize\s*=\s*_([0-9]+)([MG])/g;
  let m;
  while ((m = re.exec(t))) {
    const mb = parseInt(m[2], 10) * (m[3] === 'G' ? 1024 : 1);
    out.set(m[1], { size: mb * 1024 * 1024 });
  }
  return out;
}

function parseNandLinux(text) {
  const out = new Map();
  const t = stripComments(text);
  const re = /\.name\s*=\s*"([^"]+)"[\s\S]*?\.chipsize\s*=\s*SZ_([0-9]+)/g;
  let m;
  while ((m = re.exec(t))) out.set(m[1], { size: parseInt(m[2], 10) * 1024 * 1024 });
  return out;
}

// ------------------------------------------------------- vendor inference
const NOR_VENDORS = [
  ['XTD25', 'XTX'], ['XT25', 'XTX'], ['W25', 'Winbond'], ['GD25', 'GigaDevice'],
  ['GM25', 'GigaDevice'], ['MX25', 'Macronix'], ['KH25', 'Macronix'], ['EN25', 'EON'],
  ['IS25', 'ISSI'], ['XM25', 'Wuhan Xinxin/XMC'], ['ZB25', 'Zbit'], ['S25', 'Cypress/Infineon'],
  ['FM25', 'Fudan'], ['BY25', 'Boya'], ['PY25', 'Puya'], ['P25', 'Puya'], ['N25', 'Micron'],
  ['MT25', 'Micron'], ['JY25', 'Juyang'], ['TH25', 'Tsingteng'], ['UC25', 'Paragon/UC'],
  ['ZB25VQ', 'Zbit'],
];
const NAND_VENDORS = [
  ['GD5F', 'GigaDevice'], ['W25M', 'Winbond'], ['W25', 'Winbond'], ['MX35', 'Macronix'],
  ['MT29', 'Micron'], ['F50', 'ESMT'], ['F35', 'FORESEE'], ['TC58', 'Toshiba/Kioxia'],
  ['XT26', 'XTX'], ['DS35', 'DOSILICON'], ['HYF', 'Hyfun'], ['GSS', 'GSS'],
  ['EM73', 'Etron'], ['ZB35', 'Zbit'], ['UM19C', 'Unim'], ['UM19', 'Unim'],
  ['XCSP', 'XinCun'], ['FM25', 'Fudan'],
];
function vendorOf(name, table) {
  const n = name.toUpperCase();
  let best = ['', '其他'];
  for (const [p, v] of table) if (n.startsWith(p) && p.length > best[0].length) best = [p, v];
  return best[1];
}

// ------------------------------------------------------------------ model
function collect(ref = 'remote') {
  const data = {};
  for (const s of SDKS) {
    const ub = join(DEVICE_ROOT, s.dir, 'u-boot-2021.10');
    const lx = join(DEVICE_ROOT, s.dir, 'linux_5.10');
    const spec = ref === 'remote'
      ? (d, p) => git(d, ['show', `origin/${s.branch}:${p}`])
      : (d, p) => readFileSync(join(d, p), 'utf8');
    for (const [name, d] of [['u-boot', ub], ['linux', lx]]) {
      if (!existsSync(d)) throw new Error(`missing repo: ${d}`);
    }
    data[s.key] = {
      nor_u: parseNorUboot(spec(ub, F.norUboot)),
      nor_l: parseNorLinux(spec(lx, F.norLinux)),
      nand_u: parseNandUboot(spec(ub, F.nand)),
      nand_l: parseNandLinux(spec(lx, F.nand)),
    };
  }
  return data;
}

function fmtNorSize(b) {
  const mb = b / (1024 * 1024);
  if (mb >= 1024) return `${mb / 1024}GB`.replace('.0GB', 'GB');
  return `${mb}MB`;
}
function fmtNandSize(b) {
  const mb = b / (1024 * 1024);
  const gb = (mb * 8) / 1024;
  const bits = gb >= 1 ? `${Number(gb.toFixed(2))}Gb` : `${mb * 8}Mb`;
  return `${bits} / ${fmtNorSize(b)}`;
}

// rows: [vendor, name, detail, [cell per sdk]]
function buildRows(data, kind) {
  const uk = `${kind}_u`, lk = `${kind}_l`;
  const names = new Set();
  for (const s of SDKS) for (const src of [uk, lk]) for (const n of data[s.key][src].keys()) names.add(n);

  const vtab = kind === 'nor' ? NOR_VENDORS : NAND_VENDORS;
  const rows = [];
  for (const name of names) {
    let vendor = vendorOf(name, vtab);
    let detail = '';
    if (kind === 'nor') {
      let jedec = null, size = null;
      for (const s of SDKS) for (const src of [uk, lk]) {
        const v = data[s.key][src].get(name);
        if (v) { jedec = v.jedec; size = v.size; }
      }
      detail = `0x${jedec.toString(16).toUpperCase().padStart(6, '0')}||${fmtNorSize(size)}`;
    } else {
      let size = null;
      for (const s of SDKS) for (const src of [uk, lk]) {
        const v = data[s.key][src].get(name);
        if (v) size = v.size;
      }
      detail = fmtNandSize(size);
    }
    const cells = SDKS.map((s) => {
      const u = data[s.key][uk].has(name), l = data[s.key][lk].has(name);
      return u && l ? 'U/L' : u ? 'U' : l ? 'L' : '';
    });
    rows.push({ vendor, name, detail, cells });
  }
  rows.sort((a, b) => (a.vendor === b.vendor ? a.name.localeCompare(b.name) : a.vendor.localeCompare(b.vendor)));
  return rows;
}

function counts(data, kind) {
  const uk = `${kind}_u`, lk = `${kind}_l`, out = {};
  for (const s of SDKS) {
    const u = new Set(data[s.key][uk].keys()), l = new Set(data[s.key][lk].keys());
    out[s.key] = { union: new Set([...u, ...l]).size, u: u.size, l: l.size };
  }
  return out;
}

function flashSet(data) {
  const set = {};
  for (const kind of ['nor', 'nand']) {
    const uk = `${kind}_u`, lk = `${kind}_l`;
    for (const s of SDKS) {
      set[`${s.key}:${kind}:uboot`] = [...data[s.key][uk].keys()].sort();
      set[`${s.key}:${kind}:linux`] = [...data[s.key][lk].keys()].sort();
    }
  }
  return set;
}

// Structural invariants that MUST hold after a regeneration. These exist
// because an earlier version silently emitted an unclosed <div class="caps-row">,
// which turned every following callout into a flex column and wrecked the page —
// the byte-count check happily passed it.
function validate(html) {
  const problems = [];
  const count = (re) => (html.match(re) || []).length;

  // 1. The three coverage cards must live inside exactly one caps-row, closed
  //    directly before the next heading.
  if (count(/<div class="caps-row">/g) !== 1) {
    problems.push(`expected 1 caps-row, found ${count(/<div class="caps-row">/g)}`);
  }
  if (count(/<\/div>\s*<h3 id="ch1-1">/g) !== 1) {
    problems.push('caps-row is not closed directly before #ch1-1');
  }

  // 2. Every nav href resolves, and every heading is reachable from the nav.
  const hrefs = [...html.matchAll(/<a href="#([^"]+)"/g)].map((m) => m[1]);
  const ids = new Set([...html.matchAll(/<h[23] id="([^"]+)"/g)].map((m) => m[1]));
  for (const h of hrefs) if (!ids.has(h)) problems.push(`nav points at missing id #${h}`);
  for (const id of ids) if (!hrefs.includes(id)) problems.push(`heading #${id} is not in the nav`);

  // 3. No leftover template placeholders.
  if (html.includes('{{')) problems.push('unreplaced {{placeholder}} remains');

  // 4. All three data tables present: NOR, NAND, and the hand-maintained eMMC.
  if (count(/<table>/g) !== 3) problems.push(`expected 3 tables, found ${count(/<table>/g)}`);

  // 4b. The eMMC section is written by hand in emmc.json and must survive as a
  //     chapter in its own right. If a future section regex runs over it — the
  //     same failure mode that ate the footer once — the count above would
  //     still pass, so check the anchors too.
  for (const [what, re] of [
    ['§4 eMMC heading', /<h2 id="ch4">四、eMMC 支持列表/],
    ['§5 differences heading', /<h2 id="ch5">五、SDK 间差异要点/],
  ]) {
    if (count(re) !== 1) problems.push(`expected exactly 1 ${what}, found ${count(re)}`);
  }

  // 5. Document chrome that lives *after* the last regenerated section. These
  //    rode along inside a section regex'ed to the end of the body once and were
  //    silently deleted; nothing else in this file would have noticed.
  for (const [what, re] of [
    ['footer div', /<div class="footer">/g],
    ['§1.1 legend note', /款数”按 U-Boot 与 Linux 的/g],
    ['date span #gen-date-2', /id="gen-date-2"/g],
    ['main-content close', /<\/div><!-- \/main-content -->/g],
  ]) {
    if (count(re) !== 1) problems.push(`expected exactly 1 ${what}, found ${count(re)}`);
  }

  return problems;
}

// ------------------------------------------------------------------- html
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function cellHtml(v) {
  if (v === 'U/L') return '<td style="background:#e6f4ea;color:#137333;font-weight:600;text-align:center">U / L</td>';
  if (v === 'U') return '<td style="background:#fef7e0;color:#b06000;font-weight:600;text-align:center">U</td>';
  if (v === 'L') return '<td style="background:#e8f0fe;color:#1a56c4;font-weight:600;text-align:center">L</td>';
  return '<td style="color:#ccc;text-align:center">—</td>';
}

function norTableHtml(rows) {
  const out = ['<table>', '<tr><th>厂商</th><th>型号</th><th>JEDEC ID</th><th>容量</th>' +
    SDKS.map((s) => `<th>${s.badge}</th>`).join('') + '</tr>'];
  let last = null;
  for (const r of rows) {
    const [jid, sz] = r.detail.split('||');
    out.push(`<tr><td>${esc(r.vendor === last ? '' : r.vendor)}</td><td><strong>${esc(r.name)}</strong></td>` +
      `<td>${jid}</td><td>${sz}</td>${r.cells.map(cellHtml).join('')}</tr>`);
    last = r.vendor;
  }
  out.push('</table>');
  return out.join('\n');
}

function nandTableHtml(rows) {
  const out = ['<table>', '<tr><th>厂商</th><th>型号</th><th>容量</th>' +
    SDKS.map((s) => `<th>${s.badge}</th>`).join('') + '</tr>'];
  let last = null;
  for (const r of rows) {
    out.push(`<tr><td>${esc(r.vendor === last ? '' : r.vendor)}</td><td><strong>${esc(r.name)}</strong></td>` +
      `<td>${r.detail}</td>${r.cells.map(cellHtml).join('')}</tr>`);
    last = r.vendor;
  }
  out.push('</table>');
  return out.join('\n');
}

// ------------------------------------------------------------------- emmc
// eMMC has no bringup support_list in either repo, so unlike NOR/NAND there is
// nothing to parse — the list is maintained by hand in emmc.json. What the
// driver *can* do is render it and keep it structurally honest, which is why
// this goes through the same validate() path as the generated tables.
function loadEmmc() {
  if (!existsSync(EMMC_JSON)) throw new Error(`emmc.json not found at ${EMMC_JSON}`);
  const rows = JSON.parse(readFileSync(EMMC_JSON, 'utf8'));
  if (!Array.isArray(rows) || !rows.length) throw new Error('emmc.json must be a non-empty array');

  const seen = new Set();
  for (const [i, r] of rows.entries()) {
    for (const k of ['name', 'size', 'package']) {
      if (typeof r[k] !== 'string' || !r[k].trim()) {
        throw new Error(`emmc.json[${i}]: missing/blank "${k}"`);
      }
    }
    // A duplicate part number would silently render as two rows and inflate the
    // headline count, so it fails the build instead.
    if (seen.has(r.name)) throw new Error(`emmc.json: duplicate part number ${r.name}`);
    seen.add(r.name);
  }
  // Sort by capacity, then name — stable regardless of the file's own order, so
  // reordering emmc.json never churns the document.
  const gb = (s) => parseFloat(s) * (/(TB|T)$/i.test(s) ? 1024 : 1);
  return rows.slice().sort((a, b) => (gb(a.size) - gb(b.size)) || a.name.localeCompare(b.name));
}

function emmcTableHtml(rows) {
  // eMMC IP is shared by all three SDKs, so every part is compatible with each
  // by construction; the three columns say exactly that rather than claiming a
  // per-SDK u-boot/linux split the way the NOR/NAND tables do.
  const out = ['<table>', '<tr><th>型号</th><th>容量</th><th>电压</th><th>封装</th>' +
    SDKS.map((s) => `<th>${s.badge}</th>`).join('') + '</tr>'];
  for (const r of rows) {
    out.push(`<tr><td><strong>${esc(r.name)}</strong></td><td>${esc(r.size)}</td>` +
      `<td>1.8V</td><td>${esc(r.package)}</td>` +
      SDKS.map(() => '<td style="background:#e6f4ea;color:#137333;font-weight:600;text-align:center">✔</td>').join('') +
      '</tr>');
  }
  out.push('</table>');
  return out.join('\n');
}
// A model name that only ever shows up on one side of the u-boot/linux split
// in a single SDK is a real coverage gap worth naming in §4.
function exclusiveNames(data, kind, sdkKey, side) {
  const other = side === 'u' ? 'l' : 'u';
  const mine = data[sdkKey][`${kind}_${side}`];
  const names = [];
  for (const n of mine.keys()) {
    let seenElsewhere = false;
    for (const s of SDKS) {
      if (s.key !== sdkKey && (data[s.key][`${kind}_u`].has(n) || data[s.key][`${kind}_l`].has(n))) seenElsewhere = true;
    }
    if (!seenElsewhere) names.push(n);
  }
  return names.sort();
}

// Names of flashes landed in the last N bringup commits, read from git log on
// the four support_list files. This is the honest source for "最近新增": a
// state.json diff only knows what changed since *this driver* last ran, so on a
// fresh checkout it would report every flash in the tree as new.
function recentlyAdded(limit = 6) {
  const seen = new Map(); // name -> commit date, newest wins
  // The paths span both repos of each SDK, so walk (sdk, repo, path) triples.
  const targets = [
    ['u-boot-2021.10', F.norUboot],
    ['u-boot-2021.10', F.nand],
    ['linux_5.10', F.norLinux],
    ['linux_5.10', F.nand],
  ];
  for (const s of SDKS) {
    for (const [repo, rel] of targets) {
      const dir = join(DEVICE_ROOT, s.dir, repo);
      let log;
      try {
        log = git(dir, ['log', '--date=short', '--format=%ad\t%s',
          '-20', `refs/remotes/origin/${s.branch}`, '--', rel]);
      } catch { continue; }
      for (const line of log.split('\n')) {
        const [date, ...rest] = line.split('\t');
        const subject = rest.join('\t');
        if (!date || !subject) continue;
        // Datasheet-style part numbers: 2-4 letters, a digit, then the rest,
        // with an optional dash suffix (DS35Q4GB-IB, XCSP1AXPK-IT). The leading
        // letters+digit requirement is what keeps SPI/SOPHGO/CVITEK out.
        for (const m of subject.matchAll(/\b([A-Z]{2,4}[0-9][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*)\b/g)) {
          const name = m[1];
          if (!seen.has(name) || seen.get(name).date < date) seen.set(name, { date, name });
        }
      }
    }
  }
  return [...seen.values()].sort((a, b) => b.date.localeCompare(a.date));
}

// Replace an element's whole contents by scanning div depth. A plain
// /<div class="caps-row">[\s\S]*?<\/div>/ is WRONG here: the first `</div>` is
// the one closing the first nested .caps-node, so the rest of the old cards
// survive as orphans and blow the layout apart.
function replaceCapsRow(html, openTag, inner) {
  const start = html.indexOf(openTag);
  if (start < 0) throw new Error('caps-row element not found in document');
  // Scan tags (not raw text) so an apostrophe or angle bracket in content
  // can't desync the depth counter.
  const tagRe = /<div\b|<\/div>/g;
  tagRe.lastIndex = start + openTag.length;
  let depth = 1;
  let innerEnd = -1;  // index of the </div> that closes caps-row itself
  let m;
  while ((m = tagRe.exec(html))) {
    depth += m[0] === '</div>' ? -1 : 1;
    if (depth === 0) { innerEnd = m.index; break; }
  }
  if (innerEnd < 0) throw new Error('unbalanced div while scanning caps-row');
  // Keep the row's own closing </div> — slicing to m.index + length would drop
  // it and leave the row open, which silently turns later callouts into flex
  // columns. (That bug shipped once; validate() now guards it.)
  return html.slice(0, start + openTag.length) + '\n' + inner + '\n' + html.slice(innerEnd);
}

// Replace the region between an <h2 id="..."> heading and the next <h2>, keeping
// the heading line itself (its "（并集 N 款）" count is rewritten).
function replaceSection(html, id, newBody, newHeading) {
  const start = html.indexOf(`<h2 id="${id}"`);
  if (start < 0) throw new Error(`section #${id} not found in document`);
  const afterHeading = html.indexOf('</h2>', start) + '</h2>'.length;
  const nextH2 = html.indexOf('<h2 id=', afterHeading);
  const end = nextH2 < 0 ? html.indexOf('<div class="footer">', afterHeading) : nextH2;
  if (end < 0) throw new Error(`end of section #${id} not found`);
  const heading = newHeading ? `<h2 id="${id}">${newHeading}</h2>` : html.slice(start, afterHeading);
  return html.slice(0, start) + heading + '\n' + newBody + '\n\n' + html.slice(end);
}

// Like replaceSection, but a missing section is inserted just before `beforeId`
// instead of throwing. Needed for the eMMC chapter: on the very first build
// after this chapter was introduced the document has no #ch4 at all, and on
// every later build it does. Both cases have to work off the same code path.
function upsertSection(html, id, newHeading, newBody, beforeId) {
  if (html.includes(`<h2 id="${id}"`)) return replaceSection(html, id, newBody, newHeading);
  const at = html.indexOf(`<h2 id="${beforeId}"`);
  if (at < 0) throw new Error(`cannot insert section #${id}: anchor #${beforeId} not found`);
  return html.slice(0, at) + `<h2 id="${id}">${newHeading}</h2>\n` + newBody + '\n\n' + html.slice(at);
}

function renderDoc(tpl, data, opts = {}) {
  const { recent = null } = opts;
  const nor = buildRows(data, 'nor');
  const nand = buildRows(data, 'nand');
  const emmc = loadEmmc();
  const nc = counts(data, 'nor'), ndc = counts(data, 'nand');

  let html = tpl;

  // --- coverage cards (inside .caps-row) ---
  const cards = SDKS.map((s) => {
    const n = nc[s.key], d = ndc[s.key];
    return `<div class="caps-node"><div class="caps-badge">${s.badge}</div>` +
      `<div class="caps-title">${s.label}</div>` +
      `<div class="caps-feat">NOR: <strong>${n.union}</strong> 款（U ${n.u} / L ${n.l}）</div>` +
      `<div class="caps-feat">NAND: <strong>${d.union}</strong> 款（U ${d.u} / L ${d.l}）</div>` +
      `<div class="caps-feat">eMMC: <strong>${emmc.length}</strong> 款（兼容）</div></div>`;
  }).join('\n');
  html = replaceCapsRow(html, '<div class="caps-row">', cards);

  // --- template migration: the document being rewritten is itself the driver's
  //     previous output, so it can arrive in an older chapter layout. Rather
  //     than hand-editing HTML out of band, normalise it here, once, before any
  //     section is spliced in. Each rewrite is guarded by "skip if already
  //     done", which makes the whole preamble idempotent.
  const migrate = [
    // The differences chapter moved from 四 (ch4) to 五 (ch5) when eMMC was
    // inserted as the new chapter 四.
    ['<h2 id="ch4">四、SDK 间差异要点</h2>', '<h2 id="ch5">五、SDK 间差异要点</h2>'],
    ['<h3 id="ch4-1">4.1 NOR 差异</h3>', '<h3 id="ch5-1">5.1 NOR 差异</h3>'],
    ['<h3 id="ch4-2">4.2 NAND 差异</h3>', '<h3 id="ch5-2">5.2 NAND 差异</h3>'],
    ['<a href="#ch4">四、SDK 间差异要点</a>', '<a href="#ch5">五、SDK 间差异要点</a>'],
    ['<a href="#ch4-1" class="toc-h3">4.1 NOR 差异</a>', '<a href="#ch5-1" class="toc-h3">5.1 NOR 差异</a>'],
    ['<a href="#ch4-2" class="toc-h3">4.2 NAND 差异</a>', '<a href="#ch5-2" class="toc-h3">5.2 NAND 差异</a>'],
  ];
  for (const [from, to] of migrate) {
    if (html.includes(to)) continue;              // already migrated
    if (html.includes(from)) { html = html.replace(from, to); continue; }
    // Absent on both sides: the template had neither, which means this is a
    // document the migration was never meant for. Fail loudly rather than
    // produce a chapter layout nobody has checked.
    throw new Error(`template is missing both the old and new form of: ${from}`);
  }
  // eMMC nav entry, inserted once, after the NAND chapter link.
  if (!html.includes('<a href="#ch4">四、eMMC 支持列表</a>')) {
    const anchor = '<a href="#ch3">三、SPI NAND Flash 支持列表</a>';
    if (!html.includes(anchor)) throw new Error('nav entry for #ch3 not found');
    html = html.replace(anchor, `${anchor}\n <a href="#ch4">四、eMMC 支持列表</a>`);
  }
  // Cosmetic: keep the inserted nav line's leading space in sync with its
  // siblings, including in documents written before this rule existed.
  html = html.replace(/\n<a href="#ch4">四、eMMC 支持列表<\/a>/, '\n <a href="#ch4">四、eMMC 支持列表</a>');
  // Title / h1 now cover three flash families.
  html = html.replace('<title>CVITEK SDK Flash 支持列表汇总</title>',
    '<title>CVITEK SDK Flash / eMMC 支持列表汇总</title>');
  html = html.replace('<h1>CVITEK / SOPHGO SDK<br>NOR &amp; NAND Flash 支持列表汇总</h1>',
    '<h1>CVITEK / SOPHGO SDK<br>NOR / NAND Flash &amp; eMMC 支持列表汇总</h1>');
  // Intro prose and the §1.1 legend both described only two families; eMMC is a
  // third with a different provenance (hand-kept, not parsed), so say so.
  html = html.replace(
    /<p>本文汇总 <strong>410 \/ 420 \/ Mars3<\/strong>[\s\S]*?登记情况。<\/p>/,
    '<p>本文汇总 <strong>410 / 420 / Mars3</strong> 三套 SDK 当前支持的 <strong>SPI NOR</strong>、' +
    '<strong>SPI NAND Flash</strong> 与 <strong>eMMC</strong>。NOR / NAND 数据直接取自各 SDK 的 ' +
    'bringup 型号表源码（已剔除注释掉的条目），每颗 Flash 分别统计其在 <strong>U-Boot</strong> 与 ' +
    '<strong>Linux 内核</strong> 两处 support_list 中的登记情况；eMMC 无对应源码，由人工维护。</p>');
  html = html.replace(
    /<div class="info">ℹ️ 表格中每个 SDK 列的取值含义：[\s\S]*?<\/div>/,
    '<div class="info">ℹ️ NOR / NAND 表格中每个 SDK 列的取值含义：<strong>U / L</strong> = U-Boot 与 ' +
    'Linux 均支持；<strong>U</strong> = 仅 U-Boot 支持；<strong>L</strong> = 仅 Linux 支持；' +
    '<strong>—</strong> = 该 SDK 不支持。eMMC 表格因三套 SDK 共用同一 IP，' +
    '<strong>✔</strong> = 兼容适配。</div>');

  // --- section 2: NOR ---
  html = replaceSection(html, 'ch2',
    `<p>来源：<strong>u-boot-2021.10/drivers/mtd/spi/spi-nor-ids.c</strong> 与 ` +
    `<strong>linux_5.10/drivers/mtd/spi-nor/cvitek_support_list.c</strong>。容量按 ` +
    `<code>sector_size × n_sectors</code> 计算。表格由 update-flash-matrix 自动生成。</p>\n` +
    norTableHtml(nor),
    `二、SPI NOR Flash 支持列表（并集 ${nor.length} 款）`);

  // --- section 3: NAND ---
  html = replaceSection(html, 'ch3',
    `<p>来源：<strong>u-boot-2021.10</strong> 与 <strong>linux_5.10</strong> 下 ` +
    `<strong>drivers/mtd/nand/raw/cvitek/cvsnfc_spi_ids.c</strong>。容量列为“位密度 / 字节容量”。</p>\n` +
    nandTableHtml(nand),
    `三、SPI NAND Flash 支持列表（并集 ${nand.length} 款）`);

  // --- section 4: eMMC (hand-maintained, no source list to parse) ---
  html = upsertSection(html, 'ch4', `四、eMMC 支持列表（${emmc.length} 款）`,
    `<p>eMMC 没有类似 NOR / NAND 的 bringup support_list 源码，无法从代码解析，` +
    `故本表由人工维护（源文件：<code>emmc.json</code>，随驱动一同保存）。` +
    `410、420、Mars3 使用<strong>同一套 eMMC IP</strong>，因此下列型号对三个 SDK 均兼容适配，` +
    `“适配”列以 ✔ 标记。</p>\n` +
    emmcTableHtml(emmc),
    'ch5');

  // --- section 5: differences (regenerated from the data). Renumbered from
  //     ch4 in the same pass that introduced the eMMC chapter. ---
  const bullet = (data_, kind, side, sdkKey, limit = 8) => {
    const n = exclusiveNames(data_, kind, sdkKey, side);
    if (!n.length) return '无';
    const head = n.slice(0, limit).join('、');
    return n.length > limit ? `${head} 等 ${n.length} 款` : head;
  };
  const diffNor = `<div class="think-box">` +
    SDKS.map((s) => `<strong>${s.label} 独有：</strong>` +
      `仅 U-Boot ${bullet(data, 'nor', 'u', s.key)}；仅 Linux ${bullet(data, 'nor', 'l', s.key)}。`).join('<br>\n') +
    `</div>`;
  const diffNand = `<div class="think-box">` +
    SDKS.map((s) => `<strong>${s.label} 独有：</strong>` +
      `仅 U-Boot ${bullet(data, 'nand', 'u', s.key)}；仅 Linux ${bullet(data, 'nand', 'l', s.key)}。`).join('<br>\n') +
    `</div>`;

  // Both §5 bodies stop at the trailing .note callout. Anchoring on the note
  // (rather than on "</div><!-- /main-content -->") matters for §5.2, the last
  // section: a lookahead that only accepts <h2> or the main-content close runs
  // straight over the .note *and* the .footer, silently deleting both.
  html = html.replace(/(<h3 id="ch5-1">[\s\S]*?<\/h3>\s*)[\s\S]*?(?=\n<div class="note">|<h3 id="ch5-2">)/,
    `$1${diffNor}\n`);
  html = html.replace(/(<h3 id="ch5-2">[\s\S]*?<\/h3>\s*)[\s\S]*?(?=\n<div class="note">|<div class="footer">|<\/div><!-- \/main-content -->)/,
    `$1${diffNand}\n`);

  // The note callout names the most recent bringups; rewrite it from the same
  // data so it can't go stale relative to the tables above it. The callout is
  // anchored to the §5.2 heading on purpose: a bare /<div class="note">/ also
  // matches the §1.1 legend callout, which is static prose and must not be
  // overwritten with a flash-name dump.
  const noteNames = (opts.recent || [])
    .map((r) => r.name)
    .filter((n, i, a) => a.indexOf(n) === i)
    .filter((n) => nor.some((r) => r.name === n) || nand.some((r) => r.name === n));
  const noteBody = noteNames.length
    ? `✅ 最近新增：${noteNames.slice(0, 6).join('、')}` +
      `${noteNames.length > 6 ? ` 等 ${noteNames.length} 款` : ''}，已体现在上表中。`
    : '✅ 本表由各 SDK 的 bringup support_list 源码直接生成，与代码保持一致。';
  html = html.replace(
    /(<h3 id="ch5-2">[\s\S]*?<\/h3>[\s\S]*?<div class="note">)[\s\S]*?(<\/div>)/,
    `$1${noteBody}$2`);

  return { html, nor, nand, emmc, nc, ndc };
}

// ------------------------------------------------------------------ cmds
function cmdFetch(args) {
  console.log(`DEVICE_ROOT=${DEVICE_ROOT}`);
  for (const s of SDKS) {
    for (const repo of ['u-boot-2021.10', 'linux_5.10']) {
      const dir = join(DEVICE_ROOT, s.dir, repo);
      const label = `${s.key}/${repo}`;
      const r = gitq(dir, ['fetch', '--quiet', 'origin', `+refs/heads/${s.branch}:refs/remotes/origin/${s.branch}`]);
      if (!r.ok) { console.log(`  ${label.padEnd(28)} FETCH FAILED — ${r.out.trim().split('\n').pop()}`); continue; }

      const behind = Number(git(dir, ['rev-list', '--count', `HEAD..origin/${s.branch}`]));
      const ahead = Number(git(dir, ['rev-list', '--count', `origin/${s.branch}..HEAD`]));
      const dirty = git(dir, ['status', '--porcelain', '--untracked-files=no']).trim();
      let note = `behind ${behind}, ahead ${ahead}`;

      if (args['update-checkout']) {
        if (dirty) { note += ' — SKIP (uncommitted tracked changes)'; }
        else if (ahead && !args['keep-local']) {
          // Local-only commits would be destroyed. Archive them to a patch
          // bundle first; resetting is opt-in for a reason.
          const dirOut = mkdtempSync(join(tmpdir(), 'flashlocal-'));
          const patch = join(dirOut, `${s.key}-${repo}-local.patch`);
          try {
            writeFileSync(patch, git(dir, ['format-patch', `origin/${s.branch}..HEAD`, '--stdout']));
            git(dir, ['checkout', '--quiet', '--detach', `origin/${s.branch}`]);
            note += ` — RESET to origin/${s.branch} (local commits archived: ${patch})`;
          } catch (e) { note += ` — RESET FAILED: ${e.message}`; }
        } else if (ahead) {
          const r2 = gitq(dir, ['rebase', `origin/${s.branch}`]);
          note += r2.ok ? ` — rebased onto origin/${s.branch}` : ` — REBASE FAILED (resolve manually)`;
        } else if (behind) {
          git(dir, ['checkout', '--quiet', '--detach', `origin/${s.branch}`]);
          note += ` — updated to origin/${s.branch}`;
        } else note += ' — up to date';
      }
      console.log(`  ${label.padEnd(28)} ${note}`);
    }
  }
  if (!args['update-checkout']) {
    console.log('\n(remote-tracking refs updated only; working trees untouched — pass --update-checkout to move HEADs)');
  }
}

function cmdReport() {
  const data = collect('remote');
  const prev = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : null;
  const cur = flashSet(data);

  console.log('SDK            NOR(u/l/union)      NAND(u/l/union)');
  for (const s of SDKS) {
    const nc = counts(data, 'nor')[s.key], nd = counts(data, 'nand')[s.key];
    console.log(`  ${s.key.padEnd(12)} ${String(nc.u).padStart(3)}/${String(nc.l).padStart(3)}/${String(nc.union).padStart(3)}` +
      `          ${String(nd.u).padStart(3)}/${String(nd.l).padStart(3)}/${String(nd.union).padStart(3)}`);
  }
  const nor = buildRows(data, 'nor'), nand = buildRows(data, 'nand');
  console.log(`\nUNION  NOR ${nor.length}   NAND ${nand.length}`);

  if (!prev) { console.log('\nNo state.json yet — run `build` to record a baseline.'); return 0; }
  let changes = 0;
  console.log('\nChanges since last build:');
  for (const k of Object.keys(cur).sort()) {
    const before = new Set(prev.flash?.[k] || []);
    const added = cur[k].filter((n) => !before.has(n));
    const removed = [...before].filter((n) => !cur[k].includes(n));
    if (added.length || removed.length) {
      changes++;
      const [sdk, kind, src] = k.split(':');
      console.log(`  ${sdk.padEnd(12)} ${kind.padEnd(5)} ${src.padEnd(6)}` +
        (added.length ? ` +${added.join(', ')}` : '') + (removed.length ? ` -${removed.join(', ')}` : ''));
    }
  }
  if (!changes) console.log('  (none — document is already current)');
  return 0;
}

function cmdBuild(args) {
  const out = resolve(args.out || DOC);
  const data = collect('remote');
  const tpl = readFileSync(out, 'utf8');
  const before = tpl;

  // Diff against the previous build for the report at the end. This is a
  // build-to-build delta only — it must not feed the "最近新增" note, which is
  // sourced from git history instead.
  const prev = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : { flash: {} };
  const cur = flashSet(data);
  const added = [];
  for (const k of Object.keys(cur)) {
    const b = new Set(prev.flash?.[k] || []);
    for (const n of cur[k]) if (!b.has(n)) added.push({ where: k, name: n });
  }

  const res = renderDoc(tpl, data, { recent: recentlyAdded() });

  if (!res.html.includes('<div id="main-content">')) throw new Error('refusing to write: #main-content missing');
  if (res.html.length < before.length * 0.8) throw new Error('refusing to write: output shrank suspiciously');
  const problems = validate(res.html);
  if (problems.length) {
    throw new Error('refusing to write — structural check failed:\n  - ' + problems.join('\n  - '));
  }

  writeFileSync(out, res.html);
  writeFileSync(STATE, JSON.stringify({
    generated: new Date().toISOString().slice(0, 10),
    branch: Object.fromEntries(SDKS.map((s) => [s.key, s.branch])),
    flash: cur,
  }, null, 1) + '\n');

  console.log(`wrote ${out} (${res.html.length} bytes, was ${before.length})`);
  console.log(`  NOR 并集 ${res.nor.length} 款   NAND 并集 ${res.nand.length} 款   eMMC ${res.emmc.length} 款（人工维护）`);
  if (added.length) {
    console.log('\nNewly recorded since last build:');
    for (const a of added) {
      const [sdk, kind, src] = a.where.split(':');
      console.log(`  + ${sdk.padEnd(12)} ${kind.padEnd(5)} ${src.padEnd(6)} ${a.name}`);
    }
  } else {
    console.log('  (no new flash entries)');
  }
  return 0;
}

function cmdRender(args) {
  // args._[0] is the subcommand name itself ("render"); positionals start at 1.
  const html = resolve(args._[1] || DOC);
  const png = resolve(args._[2] || '/tmp/flash-matrix.png');
  const w = args._[3] || '1280', h = args._[4] || '1600';
  if (!existsSync(RENDER_SH)) throw new Error(`render.sh not found at ${RENDER_SH}`);
  execSync(`bash "${RENDER_SH}" "${html}" "${png}" ${w} ${h}`, { stdio: 'inherit' });
  return 0;
}

// -------------------------------------------------------------------- main
const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];
const table = { fetch: cmdFetch, report: cmdReport, build: cmdBuild, render: cmdRender };
if (!cmd || !table[cmd]) {
  console.log(`usage: driver.mjs <fetch|report|build|render> [options]

  fetch  [--update-checkout] [--keep-local]   fetch all 6 repos (2 per SDK)
  report                                      per-SDK counts + changes since last build
  build  [--out <html>]                       regenerate the document
  render [<html> [out.png] [w] [h]]           screenshot via generate-styled-html/render.sh

env: DEVICE_ROOT (default ${DEVICE_ROOT})`);
  process.exit(cmd ? 1 : 0);
}
process.exit(table[cmd](args) ?? 0);
