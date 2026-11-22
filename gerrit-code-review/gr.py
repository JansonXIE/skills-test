#!/usr/bin/env python3
"""Mechanical helpers for the gerrit-code-review skill.

Subcommands (all print JSON to stdout, diagnostics to stderr):
  info     <target>...            change metadata, parent status, siblings, my earlier reviews
  fetch    <target>...            fetch patch sets into refs/review/<change>-<ps> of the local repo
  apply    <target>...            cherry-pick the changes (plus any unmerged ancestors) onto the
                                  local SDK checkout; run rtt-sync-master first
  post     <target> <review.json> [--dry-run]   validate and publish message + inline comments + vote
  cleanup                         delete refs/review/* refs (the cherry-picks stay in place)

<target> is anything that names a change: a Gerrit URL, "refs/changes/58/172258/7",
"172258,7", "172258/7" or a bare change number (latest patch set).

Run with `python3 -I`; it only needs the standard library.
"""

import argparse
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time

HOST = os.environ.get("GERRIT_HOST", "gerrit-ai.sophgo.vip")
PORT = os.environ.get("GERRIT_PORT", "29418")
USER = os.environ.get("GERRIT_USER", "jianxing.xie")
SSH = ["ssh", "-p", PORT, "-o", "BatchMode=yes", f"{USER}@{HOST}"]
FETCH_BASE = f"ssh://{USER}@{HOST}:{PORT}/"

HOME = os.path.expanduser("~")
RTT_MAIN = os.environ.get("RTT_ROOT", os.path.join(HOME, "Public/rtt_master/rt-thread"))
REPO_MAP = {
    "oss/rt-thread": RTT_MAIN,
    "cvitek/cvi_rtt": os.path.join(RTT_MAIN, "cvi_rtt"),
}
SDK_PROJECTS = set(REPO_MAP)          # projects `apply` cherry-picks into the local SDK
SEARCH_ROOTS = [os.path.join(HOME, "Public")]
STATE_DIR = os.path.join(tempfile.gettempdir(), "gerrit-cr")
STATE_FILE = os.path.join(STATE_DIR, "applied.json")
MEMMAP_REL = "bsp/cvitek/c906_little/board/script/memmap"
MEMMAP_GLOB = os.path.join(HOME, "Public/p3_sdk/build/output/*/cvi_board_memmap.ld")
ALLOWED_VOTES = {-1, 0, 1}


def log(msg):
    print(msg, file=sys.stderr)


def die(msg):
    log(f"[ERROR] {msg}")
    sys.exit(1)


def run(cmd, check=True, **kw):
    res = subprocess.run(cmd, capture_output=True, text=True, **kw)
    if check and res.returncode != 0:
        die(f"{' '.join(cmd)}\n{res.stdout}{res.stderr}")
    return res


def git(repo, *args, check=True):
    return run(["git", "-C", repo, *args], check=check)


# ---------------------------------------------------------------- targets ---

def parse_target(text):
    """Return (change_number, patchset_or_None)."""
    s = text.strip()
    pats = [
        r"refs/changes/\d+/(\d+)/(\d+)",
        r"/c/(?:[^#]*?/\+/)?(\d+)(?:/(\d+))?",
        r"#/c/(\d+)(?:/(\d+))?",
        r"^(\d+)[,/](\d+)$",
        r"^(\d+)$",
        r"://[^/]+/(\d+)/?(?:(\d+))?/?$",
    ]
    for p in pats:
        m = re.search(p, s)
        if m:
            ps = m.group(2) if m.lastindex and m.lastindex >= 2 else None
            return int(m.group(1)), (int(ps) if ps else None)
    die(f"cannot parse a Gerrit change from: {text}")


def gerrit_query(query, *flags):
    res = run(SSH + ["gerrit", "query", "--format=JSON", *flags, f"'{query}'"])
    rows = []
    for line in res.stdout.splitlines():
        if not line.strip():
            continue
        d = json.loads(line)
        if d.get("type") == "stats":
            continue
        rows.append(d)
    return rows


def load_change(target):
    num, ps = parse_target(target)
    rows = gerrit_query(f"change:{num}", "--current-patch-set", "--patch-sets",
                        "--files", "--comments", "--commit-message",
                        "--submit-records", "--dependencies", "--all-approvals")
    if not rows:
        die(f"change {num} not found")
    d = rows[0]
    cur = int(d["currentPatchSet"]["number"])
    ps = ps or cur
    pso = next((p for p in d["patchSets"] if int(p["number"]) == ps), None)
    if pso is None:
        die(f"change {num} has no patch set {ps} (current is {cur})")
    return d, ps, pso


def describe_parent(project, parent_sha):
    rows = gerrit_query(f"project:{project} commit:{parent_sha}", "--patch-sets",
                        "--current-patch-set")
    if not rows:
        return {"sha": parent_sha[:12], "change": None,
                "note": "not a Gerrit change (direct commit on the branch)"}
    p = rows[0]
    cur = int(p["currentPatchSet"]["number"])
    at = next((int(x["number"]) for x in p["patchSets"] if x["revision"] == parent_sha), None)
    return {"sha": parent_sha[:12], "change": int(p["number"]), "status": p["status"],
            "parent_ps": at, "parent_current_ps": cur,
            "outdated": (p["status"] == "NEW" and at is not None and at != cur),
            "subject": p["subject"]}


def find_siblings(d):
    terms = []
    if d.get("topic"):
        terms.append(f"topic:{d['topic']}")
    m = re.search(r"\[JIRA\s+ID\]\s*:\s*([A-Za-z][A-Za-z0-9]*-\d+)", d.get("commitMessage", ""))
    if m:
        terms.append(f"message:{m.group(1)}")
    if not terms:
        return []
    rows = gerrit_query(f"status:open ({' OR '.join(terms)})", "--current-patch-set")
    out = []
    for r in rows:
        if int(r["number"]) == int(d["number"]):
            continue
        out.append({"change": int(r["number"]), "project": r["project"],
                    "ps": int(r["currentPatchSet"]["number"]),
                    "parent": r["currentPatchSet"]["parents"][0][:12],
                    "subject": r["subject"]})
    return out


def my_history(d):
    msgs = [c for c in d.get("comments", []) if c["reviewer"].get("username") == USER]
    reviewed = []
    for c in msgs:
        m = re.match(r"Patch Set (\d+):", c["message"])
        if m:
            reviewed.append(int(m.group(1)))
    inline = []
    for p in d["patchSets"]:
        for c in p.get("comments", []):
            if c["reviewer"].get("username") == USER:
                inline.append({"ps": int(p["number"]), "file": c["file"],
                               "line": c.get("line"), "message": c["message"]})
    votes = []
    for p in d["patchSets"]:
        for a in p.get("approvals", []):
            if a["by"].get("username") == USER and a["type"] == "Code-Review":
                votes.append({"ps": int(p["number"]), "value": int(a["value"])})
    return {"reviewed_ps": sorted(set(reviewed)),
            "last_reviewed_ps": max(reviewed) if reviewed else None,
            "messages": [c["message"] for c in msgs],
            "inline": inline, "votes": votes}


def change_info(target):
    d, ps, pso = load_change(target)
    files = [{"file": f["file"], "type": f["type"], "ins": f.get("insertions"),
              "del": f.get("deletions")}
             for f in pso.get("files", []) if f["file"] != "/COMMIT_MSG"]
    approvals = [{"type": a["type"], "value": int(a["value"]), "by": a["by"].get("username")}
                 for a in pso.get("approvals", [])]
    return {
        "change": int(d["number"]), "project": d["project"], "branch": d["branch"],
        "status": d["status"], "topic": d.get("topic"), "owner": d["owner"].get("username"),
        "subject": d["subject"], "url": d.get("url"),
        "ps": ps, "current_ps": int(d["currentPatchSet"]["number"]),
        "revision": pso["revision"], "ref": pso["ref"],
        "parent": describe_parent(d["project"], pso["parents"][0]),
        "depends_on": [int(x["number"]) for x in d.get("dependsOn", []) if "number" in x],
        "needed_by": [int(x["number"]) for x in d.get("neededBy", []) if "number" in x],
        "submit_records": d.get("submitRecords", []),
        "approvals": approvals,
        "files": files,
        "commit_message": d.get("commitMessage", ""),
        "siblings": find_siblings(d),
        "my_history": my_history(d),
    }


# ------------------------------------------------------------------ repos ---

def repo_for(project):
    path = REPO_MAP.get(project)
    if path and os.path.exists(os.path.join(path, ".git")):
        return path
    want = re.compile(rf"[:/]{re.escape(project)}(\.git)?$")
    for root in SEARCH_ROOTS:
        for gitdir in glob.glob(os.path.join(root, "*/.git")) + glob.glob(os.path.join(root, "*/*/.git")) \
                + glob.glob(os.path.join(root, "*/*/*/.git")):
            repo = os.path.dirname(gitdir)
            res = git(repo, "remote", "-v", check=False)
            if any(want.search(line.split()[1]) for line in res.stdout.splitlines() if len(line.split()) > 1):
                return repo
    # No local clone: keep a scratch repo that only holds fetched review refs (read-only use).
    scratch = os.path.join(STATE_DIR, "repos", project.replace("/", "__"))
    if not os.path.isdir(scratch):
        os.makedirs(scratch)
        git(scratch, "init", "-q")
        log(f"[INFO] no local clone of {project}; using scratch repo {scratch}")
    return scratch


def fetch_ps(info):
    repo = repo_for(info["project"])
    dst = f"refs/review/{info['change']}-{info['ps']}"
    have = git(repo, "rev-parse", "-q", "--verify", dst + "^{commit}", check=False)
    if have.returncode != 0 or have.stdout.strip() != info["revision"]:
        args = ["fetch", "-q"]
        if repo.startswith(os.path.join(STATE_DIR, "repos") + os.sep):
            args.append("--depth=200")
        git(repo, *args, FETCH_BASE + info["project"], f"+{info['ref']}:{dst}")
    return {"change": info["change"], "ps": info["ps"], "project": info["project"],
            "repo": repo, "ref": dst, "revision": info["revision"]}


def change_id(repo, rev):
    body = git(repo, "log", "-1", "--format=%B", rev).stdout
    m = re.findall(r"^Change-Id:\s*(I[0-9a-f]{40})\s*$", body, flags=re.M)
    return m[-1] if m else None


def load_state():
    if os.path.exists(STATE_FILE):
        with open(STATE_FILE) as f:
            return json.load(f)
    return {"refs": [], "applied": []}


def save_state(state):
    os.makedirs(STATE_DIR, exist_ok=True)
    with open(STATE_FILE, "w") as f:
        json.dump(state, f, indent=2)


# ------------------------------------------------------------- commands ---

def cmd_info(a):
    print(json.dumps([change_info(t) for t in a.targets], indent=2, ensure_ascii=False))


def cmd_fetch(a):
    state = load_state()
    out = []
    for t in a.targets:
        f = fetch_ps(change_info(t))
        out.append(f)
        state["refs"].append([f["repo"], f["ref"]])
    save_state(state)
    print(json.dumps(out, indent=2))


def cmd_apply(a):
    infos = [change_info(t) for t in a.targets]
    state = load_state()
    result = {"repos": {}, "not_applied": [], "notes": []}
    by_repo = {}
    for i in infos:
        if i["status"] != "NEW":
            log(f"[WARN] change {i['change']} is {i['status']}")
        f = fetch_ps(i)
        state["refs"].append([f["repo"], f["ref"]])
        if i["project"] not in SDK_PROJECTS:
            result["not_applied"].append({"change": i["change"], "project": i["project"],
                                          "repo": f["repo"], "ref": f["ref"],
                                          "why": "not part of the RTT SDK checkout; read-only"})
            continue
        by_repo.setdefault(f["repo"], {"branch": i["branch"], "revs": []})["revs"].append(f["revision"])

    for repo, g in by_repo.items():
        branch = g["branch"]
        rep = {"branch": branch, "picked": [], "skipped": [], "conflict": None}
        result["repos"][repo] = rep
        cur = git(repo, "symbolic-ref", "-q", "--short", "HEAD", check=False).stdout.strip()
        if cur != branch:
            rep["conflict"] = f"checkout is on '{cur or 'detached'}', expected '{branch}'; run rtt-sync-master first"
            continue
        if git(repo, "status", "--porcelain", "--untracked-files=no").stdout.strip():
            rep["conflict"] = "tracked files have local changes; run rtt-sync-master first"
            continue
        git(repo, "fetch", "-q", "origin", f"+refs/heads/{branch}:refs/remotes/origin/{branch}")
        base = f"origin/{branch}"
        rep["base"] = git(repo, "rev-parse", "--short", base).stdout.strip()
        rep["head_before"] = git(repo, "rev-parse", "--short", "HEAD").stdout.strip()
        # Change-Ids already on HEAD above origin (an earlier apply or the user's own picks).
        present = {change_id(repo, c) for c in
                   git(repo, "rev-list", f"{base}..HEAD").stdout.split()} - {None}
        # Every commit the changes need that is not on the branch yet, oldest first.
        todo = git(repo, "rev-list", "--reverse", "--topo-order", *g["revs"], f"^{base}").stdout.split()
        for c in todo:
            cid = change_id(repo, c)
            subj = git(repo, "log", "-1", "--format=%s", c).stdout.strip()
            if cid and cid in present:
                rep["skipped"].append({"commit": c[:12], "subject": subj, "why": "already on HEAD"})
                continue
            res = git(repo, "cherry-pick", "--allow-empty", c, check=False)
            if res.returncode != 0:
                files = git(repo, "diff", "--name-only", "--diff-filter=U", check=False).stdout.split()
                git(repo, "cherry-pick", "--abort", check=False)
                rep["conflict"] = {"commit": c[:12], "subject": subj, "files": files}
                break
            new = git(repo, "rev-parse", "HEAD").stdout.strip()
            rep["picked"].append({"commit": c[:12], "new": new[:12], "subject": subj,
                                  "is_review_target": c in g["revs"],
                                  "dependency": c not in g["revs"]})
            state["applied"].append({"repo": repo, "commit": new, "change_id": cid,
                                     "time": time.strftime("%Y-%m-%d %H:%M:%S")})
            if cid:
                present.add(cid)
        rep["head_after"] = git(repo, "rev-parse", "--short", "HEAD").stdout.strip()

    if REPO_MAP["oss/rt-thread"] in by_repo or REPO_MAP["cvitek/cvi_rtt"] in by_repo:
        mm = os.path.join(RTT_MAIN, MEMMAP_REL)
        if os.path.isdir(mm) and not glob.glob(os.path.join(mm, "cvi_board_memmap.ld")):
            cands = sorted(glob.glob(MEMMAP_GLOB))
            if cands:
                src_dir = os.path.dirname(cands[0])
                for ext in ("ld", "h"):
                    shutil.copy(os.path.join(src_dir, f"cvi_board_memmap.{ext}"), mm)
                result["notes"].append(f"copied c906_little memmap from {src_dir} "
                                       "(scenario-A layout; RTOS_ION_SIZE may be 0)")
        dangling = run(["find", os.path.join(RTT_MAIN, "cvi_rtt", "components"), "-xtype", "l"],
                       check=False).stdout.split()
        if dangling:
            result["notes"].append(
                f"{len(dangling)} dangling symlinks under cvi_rtt/components (e.g. "
                f"{os.path.relpath(dangling[0], RTT_MAIN)} -> {os.readlink(dangling[0])}); "
                "solutions that use them (smart_doorbell, mpi_*) will not build here")
    save_state(state)
    print(json.dumps(result, indent=2))


def file_lines(repo, rev, path):
    res = git(repo, "show", f"{rev}:{path}", check=False)
    if res.returncode != 0:
        return None
    return res.stdout.count("\n") + (0 if res.stdout.endswith("\n") or not res.stdout else 1)


def cmd_post(a):
    info = change_info(a.target)
    if info["status"] != "NEW":
        die(f"change {info['change']} is {info['status']}; not posting")
    if info["ps"] != info["current_ps"]:
        log(f"[WARN] posting on PS{info['ps']} but the current patch set is PS{info['current_ps']}")
    f = fetch_ps(info)
    state = load_state()
    state["refs"].append([f["repo"], f["ref"]])
    save_state(state)
    with open(a.review_json, encoding="utf-8") as fh:
        review = json.load(fh)
    if not review.get("message", "").strip():
        die("review JSON has no message")
    labels = review.get("labels", {})
    if set(labels) - {"Code-Review"}:
        die(f"only the Code-Review label may be set, got {sorted(labels)}")
    vote = labels.get("Code-Review")
    if vote is None or int(vote) not in ALLOWED_VOTES:
        die("labels.Code-Review must be -1, 0 or +1 (never +-2)")
    changed = {x["file"] for x in info["files"]}
    problems = []
    for path, items in review.get("comments", {}).items():
        if path not in changed:
            problems.append(f"{path}: not part of PS{info['ps']}")
            continue
        n = file_lines(f["repo"], f["revision"], path)
        for c in items:
            line = c.get("line")
            if not isinstance(line, int) or line < 1 or (n is not None and line > n):
                problems.append(f"{path}:{line}: line out of range (file has {n} lines)")
            if not c.get("message", "").strip():
                problems.append(f"{path}:{line}: empty message")
    if problems:
        die("inline comment check failed:\n  " + "\n  ".join(problems))
    n_inline = sum(len(v) for v in review.get("comments", {}).values())
    summary = {"change": info["change"], "ps": info["ps"], "project": info["project"],
               "vote": int(vote), "inline_comments": n_inline}
    if a.dry_run:
        summary["dry_run"] = True
        print(json.dumps(summary, indent=2))
        return
    res = subprocess.run(SSH + ["gerrit", "review", "--json", "--project", info["project"],
                                f"{info['change']},{info['ps']}"],
                         input=json.dumps(review, ensure_ascii=False), capture_output=True,
                         text=True)
    if res.returncode != 0:
        die(f"gerrit review failed:\n{res.stdout}{res.stderr}")
    after = change_info(f"{info['change']},{info['ps']}")
    got = [v for v in after["my_history"]["votes"] if v["ps"] == info["ps"]]
    summary["posted"] = True
    summary["vote_on_server"] = got[-1]["value"] if got else None
    summary["url"] = after["url"]
    print(json.dumps(summary, indent=2))


def cmd_cleanup(a):
    state = load_state()
    removed = []
    seen = set()
    for repo, ref in state.get("refs", []):
        if (repo, ref) in seen:
            continue
        seen.add((repo, ref))
        if git(repo, "update-ref", "-d", ref, check=False).returncode == 0:
            removed.append(f"{repo}:{ref}")
    # Also sweep refs left by earlier runs without state.
    for repo in set(REPO_MAP.values()):
        if not os.path.exists(os.path.join(repo, ".git")):
            continue
        for ref in git(repo, "for-each-ref", "--format=%(refname)", "refs/review/").stdout.split():
            git(repo, "update-ref", "-d", ref, check=False)
            removed.append(f"{repo}:{ref}")
    applied = state.get("applied", [])
    if os.path.exists(STATE_FILE):
        os.remove(STATE_FILE)
    shutil.rmtree(os.path.join(STATE_DIR, "repos"), ignore_errors=True)
    print(json.dumps({"removed_refs": removed,
                      "cherry_picks_left_in_place": [
                          {"repo": x["repo"], "commit": x["commit"][:12]} for x in applied]},
                     indent=2))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name, fn in (("info", cmd_info), ("fetch", cmd_fetch), ("apply", cmd_apply)):
        p = sub.add_parser(name)
        p.add_argument("targets", nargs="+")
        p.set_defaults(fn=fn)
    p = sub.add_parser("post")
    p.add_argument("target")
    p.add_argument("review_json")
    p.add_argument("--dry-run", action="store_true")
    p.set_defaults(fn=cmd_post)
    p = sub.add_parser("cleanup")
    p.set_defaults(fn=cmd_cleanup)
    a = ap.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
