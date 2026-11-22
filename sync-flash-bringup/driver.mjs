#!/usr/bin/env node
// sync-flash-bringup driver
// Sync a SPI-NAND flash bringup done on the 410 SDK (branch v4.1.0) to the
// 420 (v4.2.0) and Mars3 (master, v6.3.2) branches.
//
// A bringup touches exactly one file per repo:
//   drivers/mtd/nand/raw/cvitek/cvsnfc_spi_ids.c   (u-boot AND linux)
// The unique signal that a flash is already adapted on a branch is its
// `name` string appearing in that file.
//
// Commands:
//   check --name <FLASH> [--repo u-boot|linux]
//       Read-only. For each repo x target branch, report present/absent.
//       exit 0 = present on every (repo,target); exit 2 = missing somewhere.
//
//   sync  --name <FLASH> [--uboot <SRC>] [--linux <SRC>]
//         [--targets 420,mars3-master,mars3-v632] [--no-push] [--dry-run]
//       For each repo that has a --<repo> source and each target branch:
//         fetch branch -> if flash already present, skip
//         else: cherry-pick the source into a throwaway worktree, resolve
//         additive conflicts (supplement strategy), verify, push refs/for/<b>.
//       --dry-run  : do everything except push (worktree still built+verified)
//       --no-push  : alias of --dry-run for a partial run
//
//   <SRC> forms accepted for --uboot / --linux:
//     * a pasted Gerrit command:
//         "git fetch ssh://host/cvitek/u-boot-2021.10 refs/changes/12/34/1 && git cherry-pick FETCH_HEAD"
//       -> the fetch ref is run in each target repo, source = FETCH_HEAD
//     * a bare change ref:  refs/changes/12/34/1
//     * a committish reachable from origin (e.g. a SHA on origin/v4.1.0)
//       -> --source-branch (default v4.1.0) is fetched so the SHA is present
//
// No deps, Node >= 18.

import { execFileSync, execSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RESOLVE = join(HERE, 'scripts', 'resolve_conflicts.sh');

const DEVICE_ROOT = process.env.DEVICE_ROOT || '/media/cvitek/jianxing.xie/device';
const FILE = 'drivers/mtd/nand/raw/cvitek/cvsnfc_spi_ids.c';
// terminator line (last, empty, table element) that a new entry must sit before
const TERMINATOR = { 'u-boot': '.id_len', linux: 'NULL' };

const REPOS = [
  { name: 'u-boot', sub: 'u-boot-2021.10' },
  { name: 'linux', sub: 'linux_5.10' },
];
const ALL_TARGETS = [
  { alias: '420', root: `${DEVICE_ROOT}/420_2`, branch: 'v4.2.0' },
  { alias: 'mars3-master', root: `${DEVICE_ROOT}/mars3_repo`, branch: 'master' },
  { alias: 'mars3-v632', root: `${DEVICE_ROOT}/mars3_repo`, branch: 'v6.3.2' },
];
const SOURCE_BRANCH_DEFAULT = 'v4.1.0';

// ---- tiny arg parser ----------------------------------------------------
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

function sh(cmd, cwd, { quiet = false } = {}) {
  try {
    const o = execSync(cmd, { cwd, stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'pipe' });
    return { ok: true, out: o.toString() };
  } catch (e) {
    return { ok: false, out: (e.stdout ? e.stdout.toString() : '') + (e.stderr ? e.stderr.toString() : ''), code: e.status };
  }
}

// fetch a branch's head precisely into its remote-tracking ref, sidestepping
// the v6.3.2 branch-vs-tag ambiguity by using an explicit refspec.
function fetchBranch(repoDir, branch) {
  return sh(`git fetch --quiet origin +refs/heads/${branch}:refs/remotes/origin/${branch}`, repoDir);
}

function showFile(repoDir, ref) {
  const r = sh(`git show ${ref}:${FILE}`, repoDir, { quiet: true });
  return r.ok ? r.out : null;
}

function nameCount(content, name) {
  if (!content) return 0;
  const re = new RegExp('"' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"', 'g');
  const m = content.match(re);
  return m ? m.length : 0;
}

// ---- check --------------------------------------------------------------
function cmdCheck(args) {
  const name = args.name;
  if (!name) die('check needs --name <FLASH>');
  const repos = args.repo ? REPOS.filter(r => r.name === args.repo) : REPOS;
  let missing = 0;
  const rows = [];
  for (const repo of repos) {
    for (const t of ALL_TARGETS) {
      const dir = join(t.root, repo.sub);
      if (!existsSync(dir)) { rows.push([repo.name, t.alias, t.branch, 'NO-REPO']); missing++; continue; }
      const f = fetchBranch(dir, t.branch);
      if (!f.ok) { rows.push([repo.name, t.alias, t.branch, 'FETCH-FAIL']); missing++; continue; }
      const c = nameCount(showFile(dir, `origin/${t.branch}`), name);
      if (c > 0) rows.push([repo.name, t.alias, t.branch, `present (x${c})`]);
      else { rows.push([repo.name, t.alias, t.branch, 'ABSENT']); missing++; }
    }
  }
  console.log(`\nFlash: ${name}\n`);
  console.log(pad('REPO', 8) + pad('TARGET', 16) + pad('BRANCH', 12) + 'STATUS');
  console.log('-'.repeat(52));
  for (const r of rows) console.log(pad(r[0], 8) + pad(r[1], 16) + pad(r[2], 12) + r[3]);
  console.log('');
  if (missing) { console.log(`=> ${missing} (repo,branch) still need syncing.`); process.exit(2); }
  console.log('=> already adapted on every target. Nothing to sync.');
  process.exit(0);
}

// ---- sync ---------------------------------------------------------------
// Returns {fetchRef|null, committish}
function parseSrc(src) {
  if (src === true || !src) return null;
  // pasted "git fetch <remote> <ref> && git cherry-pick FETCH_HEAD"
  const m = src.match(/git\s+fetch\s+\S+\s+(refs\/changes\/\S+)/);
  if (m) return { fetchRef: m[1], committish: 'FETCH_HEAD' };
  if (/^refs\/changes\//.test(src.trim())) return { fetchRef: src.trim(), committish: 'FETCH_HEAD' };
  // otherwise a committish reachable from origin (SHA / tag / branch)
  return { fetchRef: null, committish: src.trim() };
}

function syncOne(repo, src, t, opts, name) {
  const dir = join(t.root, repo.sub);
  const label = `${repo.name}/${t.alias}(${t.branch})`;
  if (!existsSync(dir)) return { label, status: 'skip', detail: 'repo dir missing' };

  if (!fetchBranch(dir, t.branch).ok) return { label, status: 'error', detail: 'fetch branch failed' };

  // already adapted?
  if (nameCount(showFile(dir, `origin/${t.branch}`), name) > 0)
    return { label, status: 'present', detail: 'already adapted, skipped' };

  // make the source commit reachable
  let committish = src.committish;
  if (src.fetchRef) {
    const f = sh(`git fetch --quiet origin ${src.fetchRef}`, dir);
    if (!f.ok) return { label, status: 'error', detail: `fetch source ${src.fetchRef} failed` };
    committish = 'FETCH_HEAD';
  } else {
    // ensure a SHA/committish is present by fetching the source branch too
    sh(`git fetch --quiet origin +refs/heads/${opts.sourceBranch}:refs/remotes/origin/${opts.sourceBranch}`, dir);
  }
  // resolve committish to a stable sha (FETCH_HEAD moves)
  const rev = sh(`git rev-parse ${committish}`, dir);
  if (!rev.ok) return { label, status: 'error', detail: `cannot resolve source ${committish}` };
  const sha = rev.out.trim();

  // throwaway worktree at the branch tip -> never touches the user's checkout
  const wt = mkdtempSync(join(tmpdir(), `sfb-${repo.name}-${t.alias}-`));
  try {
    const add = sh(`git worktree add --quiet --detach "${wt}" origin/${t.branch}`, dir);
    if (!add.ok) return { label, status: 'error', detail: 'worktree add failed: ' + add.out.trim() };

    // Force rerere off so the outcome is deterministic regardless of the
    // user's global git config (a stale rerere cache could silently apply a
    // wrong resolution to the conflict).
    const NR = '-c rerere.enabled=false';
    let resolved = false;
    let cp = sh(`git ${NR} cherry-pick -x ${sha}`, wt);
    if (!cp.ok) {
      // additive conflict -> supplement strategy on the id table file
      const conflicts = sh('git diff --name-only --diff-filter=U', wt).out.split('\n').filter(Boolean);
      if (conflicts.length === 0) {
        sh(`git ${NR} cherry-pick --abort`, wt);
        return { label, status: 'error', detail: 'cherry-pick failed (not a conflict): ' + cp.out.trim() };
      }
      for (const cf of conflicts) sh(`bash "${RESOLVE}" "${cf}" ${sha}`, wt);
      // any file the resolver left with markers is a non-additive conflict -> bail
      const stillMarked = sh(`grep -rl '^<<<<<<< ' ${conflicts.map(c => `"${c}"`).join(' ')}`, wt).out.trim();
      if (stillMarked) { sh(`git ${NR} cherry-pick --abort`, wt); return { label, status: 'error', detail: 'non-additive conflict, resolve by hand: ' + stillMarked }; }
      sh('git add -A', wt);
      cp = sh(`git ${NR} -c core.editor=true cherry-pick --continue`, wt);
      if (!cp.ok) { sh(`git ${NR} cherry-pick --abort`, wt); return { label, status: 'error', detail: 'continue failed: ' + cp.out.trim() }; }
      resolved = true;
    }
    const how = resolved ? 'conflict resolved (supplement)' : 'cherry-pick clean';

    // verify: flash entry now present AND sits before the table terminator
    const body = sh(`git show HEAD:${FILE}`, wt, { quiet: true }).out;
    if (nameCount(body, name) === 0) return { label, status: 'error', detail: 'entry not present after cherry-pick' };
    if (!terminatorOk(body, name, repo.name)) return { label, status: 'error', detail: 'entry landed AFTER table terminator - resolve by hand' };

    if (opts.push) {
      const p = sh(`git push origin HEAD:refs/for/${t.branch}`, wt);
      if (!p.ok) return { label, status: 'error', detail: 'push failed: ' + p.out.trim() };
      const url = (p.out.match(/https?:\/\/\S+/) || [''])[0];
      return { label, status: 'pushed', detail: `${how} -> ${url || 'refs/for/' + t.branch}` };
    }
    return { label, status: 'ready', detail: `dry-run OK (${how}, entry verified)` };
  } finally {
    if (opts.push || opts.cleanup) {
      sh(`git worktree remove --force "${wt}"`, dir);
      try { rmSync(wt, { recursive: true, force: true }); } catch {}
    }
  }
}

// The new flash entry must sit INSIDE the table, i.e. before the terminator
// (the last, empty table element). We check the entry's `"name"` appears
// before the last terminator token in the file.
function terminatorOk(body, name, repoName) {
  const idx = body.indexOf(`"${name}"`);
  if (idx < 0) return false;
  let termIdx;
  if (repoName === 'u-boot') {
    // u-boot terminator: { .id_len = 0, }
    const re = /\.id_len\s*=\s*0\s*,/g;
    let m, last = -1;
    while ((m = re.exec(body)) !== null) last = m.index;
    termIdx = last;
  } else {
    // linux terminator: { NULL }
    termIdx = body.lastIndexOf('NULL');
  }
  return termIdx > idx;
}

function cmdSync(args) {
  const name = args.name;
  if (!name) die('sync needs --name <FLASH>');
  const srcs = {};
  if (args.uboot) srcs['u-boot'] = parseSrc(args.uboot);
  if (args.linux) srcs['linux'] = parseSrc(args.linux);
  if (Object.keys(srcs).length === 0) die('sync needs at least one of --uboot <SRC> / --linux <SRC>');

  const targets = args.targets
    ? ALL_TARGETS.filter(t => String(args.targets).split(',').includes(t.alias))
    : ALL_TARGETS;
  if (targets.length === 0) die('no matching --targets (valid: ' + ALL_TARGETS.map(t => t.alias).join(',') + ')');

  const push = !(args['dry-run'] || args['no-push']);
  const opts = { push, cleanup: true, sourceBranch: args['source-branch'] || SOURCE_BRANCH_DEFAULT };

  console.log(`\nSync flash "${name}"  mode=${push ? 'PUSH' : 'DRY-RUN'}  targets=${targets.map(t => t.alias).join(',')}\n`);
  const results = [];
  for (const repo of REPOS) {
    const src = srcs[repo.name];
    if (!src) continue;
    for (const t of targets) results.push(syncOne(repo, src, t, opts, name));
  }
  console.log(pad('WHAT', 26) + pad('STATUS', 10) + 'DETAIL');
  console.log('-'.repeat(72));
  for (const r of results) console.log(pad(r.label, 26) + pad(r.status, 10) + r.detail);
  console.log('');
  const bad = results.filter(r => r.status === 'error');
  if (bad.length) process.exit(2);
  process.exit(0);
}

function pad(s, n) { s = String(s); return s.length >= n ? s + ' ' : s + ' '.repeat(n - s.length); }
function die(m) { console.error('error: ' + m); process.exit(1); }

// ---- main ---------------------------------------------------------------
const argv = process.argv.slice(2);
const cmd = argv[0];
const args = parseArgs(argv.slice(1));
if (cmd === 'check') cmdCheck(args);
else if (cmd === 'sync') cmdSync(args);
else {
  console.log(`usage:
  node driver.mjs check --name <FLASH> [--repo u-boot|linux]
  node driver.mjs sync  --name <FLASH> [--uboot <SRC>] [--linux <SRC>]
        [--targets 420,mars3-master,mars3-v632] [--source-branch v4.1.0]
        [--dry-run | --no-push]`);
  process.exit(cmd ? 1 : 0);
}
