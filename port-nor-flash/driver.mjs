#!/usr/bin/env node
// port-nor-flash driver — bring up a new SPI NOR flash on a CVITEK/Sophgo SDK
// (cv18x family, e.g. board cv1812h_wevb_0007a_spinor). Sibling of `port-flash`
// (which does SPI NAND). NOR detection is runtime JEDEC-ID probing (0x9F ->
// 3-byte id matched against two ID tables): u-boot for SPL/boot/env, linux for
// the rootfs MTD. Bringing up a NOR part = one entry in EACH table.
//
// Sub-commands:
//   extract   <datasheet.pdf>          -> dump text + rough JEDEC-ID/density guesses (UNRELIABLE)
//   check     --id 0x684019            -> is this JEDEC id already in the u-boot + linux tables?
//   add       --params params.json     -> insert entry into BOTH NOR id tables (idempotent)
//   partition --board <b> --die-mb 32  -> compute (and --write) the DATA fill-the-die size
//   verify    [--name NAME]            -> re-read tables, confirm terminators + the new entry
//
// The AGENT reads the datasheet and decides params (jedec, density, quad, fixups).
// This driver does the deterministic, error-prone edits: exact-match table
// insertion with the surrounding indentation, and the fill-the-die partition math
// (which has a non-obvious ROOTFS-auto-grow trap — see `partition`).
//
// Everything is idempotent — re-running never double-inserts.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// ---- locate the SDK root (dir that has build/common_functions.sh + u-boot*/ + linux_*/) ----
function findRoot(start) {
  let d = start;
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(d, 'build', 'common_functions.sh')) &&
        fs.readdirSync(d).some(n => /^u-boot/.test(n)) &&
        fs.readdirSync(d).some(n => /^linux_/.test(n))) return d;
    const p = path.dirname(d);
    if (p === d) break;
    d = p;
  }
  throw new Error('SDK root not found (need build/common_functions.sh + u-boot*/ + linux_*/)');
}
const ROOT = process.env.SDK_ROOT || findRoot(process.cwd());

// Allow overriding the two target files (used by the sandbox self-test).
function ubootIds() {
  if (process.env.NOR_UBOOT_IDS) return process.env.NOR_UBOOT_IDS;
  const g = fs.readdirSync(ROOT).find(n => /^u-boot/.test(n));
  return path.join(ROOT, g, 'drivers/mtd/spi/spi-nor-ids.c');
}
function linuxIds() {
  if (process.env.NOR_LINUX_IDS) return process.env.NOR_LINUX_IDS;
  const g = fs.readdirSync(ROOT).find(n => /^linux_/.test(n));
  return path.join(ROOT, g, 'drivers/mtd/spi-nor/cvitek_support_list.c');
}

function die(m) { console.error('ERROR: ' + m); process.exit(1); }
function argOf(flag) { const i = process.argv.indexOf(flag); return i > 0 ? process.argv[i + 1] : undefined; }
function hasFlag(flag) { return process.argv.includes(flag); }

// density string -> { mb, nsectors(64KB), fourByte }
const DENSITY = {
  '16Mb': 2, '32Mb': 4, '64Mb': 8, '128Mb': 16,
  '256Mb': 32, '512Mb': 64, '1Gb': 128, '2Gb': 256,
};
function geom(density) {
  const mb = DENSITY[density];
  if (mb === undefined) die(`unknown density "${density}" (use one of ${Object.keys(DENSITY).join(', ')})`);
  return { mb, nsectors: (mb * 1024) / 64, fourByte: mb > 16 };
}
function normJedec(j) {
  const h = String(j).replace(/^0x/i, '').toUpperCase();
  if (!/^[0-9A-F]{6}$/.test(h)) die(`jedec must be a 3-byte hex like 0x684019 (got "${j}")`);
  return '0x' + h;
}

// ---------------------------------------------------------------- extract
function cmdExtract() {
  const pdf = process.argv[3];
  if (!pdf || !fs.existsSync(pdf)) die('usage: driver.mjs extract <datasheet.pdf>');
  let text = '';
  try { text = execFileSync('pdftotext', ['-layout', pdf, '-'], { maxBuffer: 128 << 20 }).toString(); }
  catch { die('pdftotext failed — install poppler-utils (apt-get install -y poppler-utils)'); }

  // Best-effort guesses. The READ-ID (9Fh) table in the datasheet is ground truth.
  const guess = {};
  // density keywords — first "<n> M/G bit" hit near the top wins (title line usually states it)
  const dm = text.match(/\b(2|1)\s*G[\s-]?bit|\b(\d{2,4})\s*M[\s-]?bit|\b(2|1)\s*G\b|\b(\d{2,4})\s*M\b/i);
  if (dm) {
    const g = dm[1] || dm[3], m = dm[2] || dm[4];
    if (g) guess.density = g + 'Gb';
    else if (m && DENSITY[m + 'Mb']) guess.density = m + 'Mb';
  }
  guess.four_byte = /4[\s-]?byte\s+address|Enter\s+4-?Byte|B7H/i.test(text);
  guess.quad = /quad/i.test(text);
  // scan the JEDEC/9F region for candidate hex bytes
  const near = (text.match(/(?:JEDEC|9F\s*H|Manufacture|Device\s*ID|Identification)[\s\S]{0,400}/i) || [''])[0];
  guess.hex_bytes_near_id = (near.match(/\b[0-9A-Fa-f]{2}\b/g) || []).slice(0, 12);
  guess._id_note = 'Build jedec = 0x{M7-M0}{ID15-8}{ID7-0} from the 9Fh READ-ID table, e.g. 68 40 19 -> 0x684019';

  const dump = path.join(path.dirname(pdf), path.basename(pdf).replace(/\.pdf$/i, '') + '.txt');
  fs.writeFileSync(dump, text);
  console.log(JSON.stringify({
    _NOTE: 'Auto-guesses are UNRELIABLE — verify jedec/density against the 9Fh READ-ID table before `add`.',
    guess, text_len: text.length, text_dump: dump,
  }, null, 2));
}

// ---------------------------------------------------------------- check
function idPresent(file, jedec) {
  const t = fs.readFileSync(file, 'utf8');
  // match the jedec as the first INFO/CVI_INFO arg, any case, with/without spaces
  const re = new RegExp('(?:INFO|CVI_INFO)\\s*\\(\\s*' + jedec.replace(/^0x/i, '0[xX]'), 'i');
  return re.test(t) || new RegExp(jedec, 'i').test(t);
}
function cmdCheck() {
  const jedec = normJedec(argOf('--id') || die('usage: check --id 0x684019'));
  const ub = idPresent(ubootIds(), jedec);
  const lx = idPresent(linuxIds(), jedec);
  const res = { id: jedec, uboot: ub, linux: lx, supported: ub && lx };
  console.log(JSON.stringify(res, null, 2));
  process.exit(res.supported ? 0 : 2); // exit 2 = not (fully) supported
}

// ---------------------------------------------------------------- add
function ubootFlags(g) {
  return 'SPI_NOR_QUAD_READ | SECT_4K' + (g.fourByte ? ' | SPI_NOR_4B_OPCODES' : '');
}
function buildUbootEntry(p, g) {
  return [
    `\t{ INFO("${p.name}", ${p.jedec}, 0x0, 64 * 1024, ${g.nsectors},`,
    `\t\t${ubootFlags(g)}) },`,
  ].join('\n');
}
function buildLinuxEntry(p, g) {
  const fix = p.fixups || 'sr_bit1_qe_fixups';
  const base = 'SECT_4K | SPI_NOR_DUAL_READ | SPI_NOR_QUAD_OP';
  if (g.fourByte) {
    return [
      `\t{ "${p.name}", CVI_INFO(${p.jedec}, 0x0, 64 * 1024, ${g.nsectors}, 0, 0,`,
      `\t\t\t${base} |`,
      `\t\t\tSPI_NOR_4B_OPCODES)`,
      `\t\t.fixups = &${fix} },`,
    ].join('\n');
  }
  return [
    `\t{ "${p.name}", CVI_INFO(${p.jedec}, 0x0, 64 * 1024, ${g.nsectors}, 0, 0,`,
    `\t\t\t${base})`,
    `\t\t.fixups = &${fix} },`,
  ].join('\n');
}

function insert(file, label, re, mk, name) {
  let t = fs.readFileSync(file, 'utf8');
  if (t.includes(`"${name}"`)) { console.log(`  = ${label} already has ${name}, skipping`); return false; }
  if (!re.test(t)) die(`anchor (table terminator) not found in ${file} — SDK drift, insert by hand`);
  t = t.replace(re, mk);
  fs.writeFileSync(file, t);
  console.log(`  + inserted ${name} into ${file}`);
  return true;
}
function cmdAdd() {
  const pf = argOf('--params') || die('usage: add --params params.json');
  const p = JSON.parse(fs.readFileSync(pf, 'utf8'));
  for (const k of ['name', 'jedec', 'density']) if (p[k] === undefined) die(`params.json missing field: ${k}`);
  p.jedec = normJedec(p.jedec);
  const g = geom(p.density);
  console.log(`Adding ${p.name} jedec=${p.jedec} ${p.density} (${g.mb}MB, ${g.nsectors}x64K sectors)` +
    ` 4byte=${g.fourByte} fixups=${p.fixups || 'sr_bit1_qe_fixups'}`);

  // u-boot: insert before  \t{ },\n};
  insert(ubootIds(), 'uboot', /\n\t\{ \},\n\};/,
    (m) => '\n' + buildUbootEntry(p, g) + '\n\t{ },\n};', p.name);
  // linux: insert before the empty terminator  \t{}\n...\n};
  insert(linuxIds(), 'linux', /\n\t\{\}\s*\n+\};/,
    (m) => '\n' + buildLinuxEntry(p, g) + '\n' + m.replace(/^\n/, ''), p.name);

  console.log('Done. `driver.mjs verify --name ' + p.name + '` to confirm. If >16MB, DATA partition may need `partition`.');
}

// ---------------------------------------------------------------- partition (fill-the-die)
function boardXml(board) {
  const hits = [];
  for (const soc of ['cv181x', 'cv180x']) {
    const f = path.join(ROOT, 'build/boards', soc, board, 'partition/partition_spinor.xml');
    if (fs.existsSync(f)) hits.push(f);
  }
  if (!hits.length) die(`partition_spinor.xml not found for board "${board}" under build/boards/*/`);
  return hits[0];
}
function cmdPartition() {
  const board = argOf('--board') || die('usage: partition --board <board> --die-mb <N> [--write]');
  const dieMb = parseInt(argOf('--die-mb') || die('--die-mb required (flash size in MB, e.g. 32)'), 10);
  const xml = boardXml(board);
  let t = fs.readFileSync(xml, 'utf8');
  const parts = [...t.matchAll(/label="(\w+)"\s+size_in_kb="(\d+)"/g)].map(m => [m[1], parseInt(m[2], 10)]);
  if (!parts.some(([l]) => l === 'DATA')) die('no DATA partition in ' + xml);
  const dieKb = dieMb * 1024;
  const nonData = parts.filter(([l]) => l !== 'DATA').reduce((s, [, v]) => s + v, 0);
  const curData = parts.find(([l]) => l === 'DATA')[1];
  let fill = dieKb - nonData;
  const aligned = fill - (fill % 64);
  console.log(`board=${board} die=${dieMb}MB (${dieKb}KB)  xml=${xml}`);
  let off = 0;
  for (const [l, v] of parts) { console.log(`  ${l.padEnd(10)} off=0x${(off*1024).toString(16).padStart(8,'0')}  ${String(v).padStart(7)} KB${l==='DATA'?'  <- resize target':''}`); off += v; }
  console.log(`  non-DATA sum = ${nonData} KB;  DATA current = ${curData} KB;  fill-the-die DATA = ${aligned} KB (${dieKb}-${nonData}, 64K-aligned)`);
  if (fill <= 0) die(`partitions already exceed the die by ${-fill} KB — shrink something first`);
  if (fill !== aligned) console.log(`  (rounded down ${fill}->${aligned} KB for 64K block alignment)`);
  console.log('  !! ROOTFS auto-grows to the real rootfs image during build. Run this AFTER a build so the');
  console.log('     ROOTFS size_in_kb here is final; if a later build regrows ROOTFS, re-run + shrink DATA.');
  if (hasFlag('--write')) {
    if (aligned === curData) { console.log('  = DATA already ' + aligned + ' KB, no change'); return; }
    t = t.replace(/(label="DATA"\s+size_in_kb=")\d+(")/, `$1${aligned}$2`);
    fs.writeFileSync(xml, t);
    console.log(`  + set DATA size_in_kb=${aligned} in ${xml}`);
  } else {
    console.log('  (dry-run — pass --write to apply)');
  }
}

// ---------------------------------------------------------------- verify
function cmdVerify() {
  const name = argOf('--name');
  let ok = true;
  const checks = [
    ['uboot', ubootIds(), /\n\t\{ \},\n\};/],
    ['linux', linuxIds(), /\n\t\{\}\s*\n+\};/],
  ];
  for (const [label, f, term] of checks) {
    const t = fs.readFileSync(f, 'utf8');
    const termOk = term.test(t);
    const nameOk = name ? t.includes(`"${name}"`) : true;
    console.log(`  ${label}: terminator=${termOk ? 'ok' : 'MISSING'} ${name ? `${name}=${nameOk ? 'present' : 'ABSENT'}` : ''}`);
    ok = ok && termOk && nameOk;
  }
  process.exit(ok ? 0 : 1);
}

// ---------------------------------------------------------------- main
const cmd = process.argv[2];
({ extract: cmdExtract, check: cmdCheck, add: cmdAdd, partition: cmdPartition, verify: cmdVerify }[cmd]
  || (() => die(`unknown command "${cmd}"\n  commands: extract check add partition verify`)))();
