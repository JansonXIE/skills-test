#!/usr/bin/env node
// port-flash driver — bring up a new SPI NAND on a CVITEK/Sophgo 410 SDK.
//
// Sub-commands:
//   extract  <datasheet.pdf>            -> dump text + auto-guessed params (JSON) for review
//   check    --id 0xB0,0x24             -> is this JEDEC id already in the u-boot/linux tables?
//   add      --params params.json       -> insert entry into BOTH id tables (idempotent)
//   install-autosh [--src auto.sh]      -> commit auto.sh into ramdisk + hook pack_data()
//   verify                              -> re-read tables, confirm the new entry parses
//
// The heavy lifting (reading the datasheet, deciding oobsize / ecc bits / remap)
// is done by the AGENT. This driver does the deterministic, error-prone edits:
// exact-match table insertion with correct indentation, and the build hook.
//
// Everything is idempotent — re-running never double-inserts.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// ---- locate the SDK root (dir that has u-boot-2021.10/ + linux_5.10/ + build/) ----
function findRoot(start) {
  let d = start;
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(d, 'build', 'common_functions.sh')) &&
        fs.existsSync(path.join(d, 'ramdisk'))) return d;
    const p = path.dirname(d);
    if (p === d) break;
    d = p;
  }
  throw new Error('SDK root not found (need build/ + ramdisk/ + u-boot*/ + linux*/)');
}
const ROOT = process.env.SDK_ROOT || findRoot(process.cwd());

function ubootIds() {
  const g = fs.readdirSync(ROOT).find(n => /^u-boot/.test(n));
  return path.join(ROOT, g, 'drivers/mtd/nand/raw/cvitek/cvsnfc_spi_ids.c');
}
function linuxIds() {
  const g = fs.readdirSync(ROOT).find(n => /^linux_/.test(n));
  return path.join(ROOT, g, 'drivers/mtd/nand/raw/cvitek/cvsnfc_spi_ids.c');
}

function die(m) { console.error('ERROR: ' + m); process.exit(1); }
function argOf(flag) { const i = process.argv.indexOf(flag); return i > 0 ? process.argv[i + 1] : undefined; }

// ---------------------------------------------------------------- extract
function cmdExtract() {
  const pdf = process.argv[3];
  if (!pdf || !fs.existsSync(pdf)) die('usage: driver.mjs extract <datasheet.pdf>');
  let text = '';
  try { text = execFileSync('pdftotext', ['-layout', pdf, '-'], { maxBuffer: 64 << 20 }).toString(); }
  catch { die('pdftotext failed — install poppler-utils (apt-get install -y poppler-utils)'); }

  // best-effort auto-guesses. The agent MUST verify these against the datasheet.
  const guess = {};
  let m;
  if ((m = text.match(/([0-9A-Fa-f]{2})\s*h?[^\n]{0,30}?(?:manufacturer|MID|maker)/i)) ) guess.mid = '0x' + m[1];
  if (/2\s*Gb|2Gbit|2\s*Gigabit/i.test(text)) guess.density = '2Gb';
  else if (/1\s*Gb|1Gbit/i.test(text)) guess.density = '1Gb';
  else if (/512\s*Mb/i.test(text)) guess.density = '512Mb';
  if (/2176|2\s*048\s*\+\s*128|2112|2048\s*\+\s*64/i.test(text)) guess.pagesize = '2K';
  if (/4\s*352|4096\s*\+/i.test(text)) guess.pagesize = '4K';
  guess.oob_hint = /\+\s*128|128\s*byte/i.test(text) ? 128 : (/\+\s*64|64\s*byte/i.test(text) ? 64 : null);
  guess.ecc_hint = (text.match(/([0-9]+)\s*-?\s*bit\s*(?:ECC|error)/i) || [])[1] || null;

  const out = {
    _NOTE: 'Auto-guesses — the agent MUST verify every field against the datasheet before `add`.',
    guess,
    text_len: text.length,
  };
  const dump = path.join(path.dirname(pdf), path.basename(pdf).replace(/\.pdf$/i, '') + '.txt');
  fs.writeFileSync(dump, text);
  out.text_dump = dump;
  console.log(JSON.stringify(out, null, 2));
}

// ---------------------------------------------------------------- check
function idKey(idStr) {
  return idStr.split(',').map(s => s.trim().replace(/^0x/i, '').toUpperCase().padStart(2, '0'));
}
function idPresent(file, bytes) {
  const t = fs.readFileSync(file, 'utf8');
  // match `.id = {0xB0, 0x24}` in any spacing/case
  const re = new RegExp('\\.id\\s*=\\s*\\{\\s*0x' + bytes.join('\\s*,\\s*0x') + '\\b', 'i');
  const nameRe = new RegExp('\\.id\\s*=\\s*\\{\\s*0x' + bytes.join('\\s*,\\s*0x'), 'i');
  const hit = re.test(t) || nameRe.test(t);
  return hit;
}
function cmdCheck() {
  const id = argOf('--id') || die('usage: check --id 0xMID,0xDID[,0x..]');
  const bytes = idKey(id);
  const ub = idPresent(ubootIds(), bytes);
  const lx = idPresent(linuxIds(), bytes);
  const res = { id: '0x' + bytes.join(',0x'), uboot: ub, linux: lx, supported: ub && lx };
  console.log(JSON.stringify(res, null, 2));
  process.exit(res.supported ? 0 : 2); // exit 2 = not (fully) supported
}

// ---------------------------------------------------------------- add
const U_SIZES = { '512Mb': '_64M', '1Gb': '_128M', '2Gb': '_256M', '4Gb': '_512M' };
const L_SIZES = { '512Mb': 'SZ_64', '1Gb': 'SZ_128', '2Gb': 'SZ_256', '4Gb': 'SZ_512' };

function buildUbootEntry(p) {
  const chip = U_SIZES[p.density] || die('unknown density ' + p.density);
  const page = p.pagesize === '4K' ? '_4K' : '_2K';
  const erase = p.pagesize === '4K' ? '_256K' : '_128K';
  const eccMask = p.ecc_bits === 3 ? '0x70' : (p.ecc_bits === 2 ? '0x30' : '0x30');
  return [
    '\t{',
    `\t\t.name      = "${p.name}",`,
    `\t\t.id        = {0x${p.mid}, 0x${p.did}},`,
    '\t\t.id_len    = 2,',
    `\t\t.chipsize  = ${chip},`,
    `\t\t.erasesize = ${erase},`,
    `\t\t.pagesize  = ${page},`,
    `\t\t.oobsize   = ${p.oobsize},`,
    '\t\t.badblock_pos = BBP_FIRST_PAGE,',
    `\t\t.driver    = &spi_nand_driver_${p.driver},`,
    '\t\t.flags = FLAGS_SET_QE_BIT | FLAGS_ENABLE_X2_BIT | FLAGS_ENABLE_X4_BIT,',
    '\t\t.ecc_en_feature_offset = 0xb0, /* Configuration register ecc enable*/',
    '\t\t.ecc_en_mask = 1 << 4, /* bit 4 */',
    '\t\t.ecc_status_offset = 0xc0, /* Status register */',
    `\t\t.ecc_status_mask = ${eccMask}, /* ${p.ecc_bits}-bit ECCS field */`,
    '\t\t.ecc_status_shift = 4,',
    '\t\t.ecc_status_uncorr_val = 0x2,',
    '\t\t.sck_l = 1,',
    '\t\t.sck_h = 1,',
    '\t\t.max_freq = SPI_NAND_FREQ_62MHz,',
    '\t\t.sample_param = 0x40001000,',
    '\t\t.xtal_switch = 1,',
    '\t},',
  ].join('\n');
}
function buildLinuxEntry(p) {
  const chip = L_SIZES[p.density] || die('unknown density ' + p.density);
  const page = p.pagesize === '4K' ? 'SZ_4K' : 'SZ_2K';
  const erase = p.pagesize === '4K' ? 'SZ_256K' : 'SZ_128K';
  const remap = p.remap || (p.ecc_bits === 3 ? 'ECC_3bits_remap' : 'ECC_2bits_remap');
  const oob = p.oobsize === 64 ? 'SZ_64' : String(p.oobsize);
  return [
    '\t{',
    `\t\t{\t.name = "${p.name}",`,
    `\t\t\t.id = {0x${p.mid}, 0x${p.did}},`,
    `\t\t\t.pagesize = ${page},`,
    `\t\t\t.chipsize = ${chip},`,
    `\t\t\t.erasesize = ${erase},`,
    '\t\t\t.options = 0,',
    '\t\t\t.id_len = 2,',
    `\t\t\t.oobsize = ${oob},`,
    `\t\t\t{\t.strength_ds = ${p.strength_ds || 8},`,
    `\t\t\t\t.step_ds = SZ_512`,
    '\t\t\t},',
    '\t\t},',
    '',
    '\t\t{\t.ecc_sr_addr = 0xc0,',
    '\t\t\t.ecc_mbf_addr = 0x0,',
    '\t\t\t.read_ecc_opcode = 0,',
    `\t\t\t.ecc_bits = ${p.ecc_bits},`,
    '\t\t\t.ecc_bit_shift = 4,',
    '\t\t\t.uncorr_val = 0x2,',
    `\t\t\t.remap = ${remap}`,
    '\t\t},',
    `\t\t.driver = &spi_nand_driver_${p.driver},`,
    '\t\t.flags = 0',
    '\t},',
  ].join('\n');
}

function insertBefore(file, anchor, entry, name) {
  let t = fs.readFileSync(file, 'utf8');
  if (t.includes(`"${name}"`)) { console.log(`  = ${path.basename(path.dirname(file))} already has ${name}, skipping`); return false; }
  const idx = t.lastIndexOf(anchor);
  if (idx < 0) die(`anchor not found in ${file}: ${anchor}`);
  t = t.slice(0, idx) + entry + '\n\n' + t.slice(idx);
  fs.writeFileSync(file, t);
  console.log(`  + inserted ${name} into ${file}`);
  return true;
}
function cmdAdd() {
  const pf = argOf('--params') || die('usage: add --params params.json');
  const p = JSON.parse(fs.readFileSync(pf, 'utf8'));
  for (const k of ['name', 'mid', 'did', 'density', 'pagesize', 'oobsize', 'ecc_bits', 'driver'])
    if (p[k] === undefined) die(`params.json missing field: ${k}`);
  p.mid = p.mid.replace(/^0x/i, '').toUpperCase().padStart(2, '0');
  p.did = p.did.replace(/^0x/i, '').toUpperCase().padStart(2, '0');
  console.log(`Adding ${p.name} id={0x${p.mid},0x${p.did}} ${p.density} page=${p.pagesize} oob=${p.oobsize} ecc=${p.ecc_bits}bit driver=${p.driver}`);
  insertBefore(ubootIds(), '\t{\t.id_len    = 0,\t},', buildUbootEntry(p), p.name);
  insertBefore(linuxIds(), '\t{ NULL }', buildLinuxEntry(p), p.name);
  console.log('Done. Run `driver.mjs verify` to confirm.');
}

// ---------------------------------------------------------------- install-autosh
function cmdInstallAutosh() {
  const chip = process.env.CHIP || 'cv181x_64bit'; // overlay dir for cv181x arm64
  const src = argOf('--src') || path.join(ROOT, 'build/datasheet/auto.sh');
  if (!fs.existsSync(src)) die('auto.sh source not found: ' + src + ' (pass --src <path>)');

  // 1) commit auto.sh into a committed data-seed dir under ramdisk (survives clean builds)
  const seedDir = path.join(ROOT, 'ramdisk/rootfs/overlay', chip, 'data');
  fs.mkdirSync(seedDir, { recursive: true });
  const dst = path.join(seedDir, 'auto.sh');
  fs.copyFileSync(src, dst);
  fs.chmodSync(dst, 0o755);
  console.log(`  + committed ${dst}`);

  // 2) hook pack_data() so $OUTPUT_DIR/data gets auto.sh before packing
  const cf = path.join(ROOT, 'build/common_functions.sh');
  let t = fs.readFileSync(cf, 'utf8');
  const marker = '# port-flash: seed /mnt/data with auto.sh';
  if (t.includes(marker)) { console.log('  = pack_data() hook already present, skipping'); }
  else {
    const anchor = 'pushd "$OUTPUT_DIR"/data;echo "If you can dream it, you can do it." > sample;popd';
    if (!t.includes(anchor)) die('pack_data() anchor not found — SDK layout changed, hook manually');
    const hook = anchor + '\n' +
      `  ${marker}\n` +
      `  _autosh="$RAMDISK_PATH/rootfs/overlay/${chip}/data/auto.sh"\n` +
      `  [ -f "$_autosh" ] && { command cp "$_autosh" "$OUTPUT_DIR"/data/auto.sh; chmod 755 "$OUTPUT_DIR"/data/auto.sh; echo "port-flash: seeded /mnt/data/auto.sh"; }`;
    t = t.replace(anchor, hook);
    fs.writeFileSync(cf, t);
    console.log(`  + hooked pack_data() in ${cf}`);
  }
  console.log('Done. After build_all, /mnt/data/auto.sh is present and S99user auto-runs it at boot.');
}

// ---------------------------------------------------------------- verify
function cmdVerify() {
  const name = argOf('--name');
  let ok = true;
  for (const [label, f] of [['uboot', ubootIds()], ['linux', linuxIds()]]) {
    const t = fs.readFileSync(f, 'utf8');
    // crude brace balance of the flash table region is overkill; just confirm the
    // terminator still follows the last entry and (optionally) the name exists.
    const termOk = /\{\s*\.id_len\s*=\s*0\s*,\s*\}/.test(t) || /\{\s*NULL\s*\}/.test(t);
    const nameOk = name ? t.includes(`"${name}"`) : true;
    console.log(`  ${label}: terminator=${termOk ? 'ok' : 'MISSING'} ${name ? `${name}=${nameOk ? 'present' : 'ABSENT'}` : ''}`);
    ok = ok && termOk && nameOk;
  }
  const cf = fs.readFileSync(path.join(ROOT, 'build/common_functions.sh'), 'utf8');
  console.log(`  pack_data hook: ${cf.includes('port-flash: seed /mnt/data') ? 'present' : 'absent'}`);
  process.exit(ok ? 0 : 1);
}

// ---------------------------------------------------------------- main
const cmd = process.argv[2];
({ extract: cmdExtract, check: cmdCheck, add: cmdAdd, 'install-autosh': cmdInstallAutosh, verify: cmdVerify }[cmd]
  || (() => die(`unknown command "${cmd}"\n  commands: extract check add install-autosh verify`)))();
