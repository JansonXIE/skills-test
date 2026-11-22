#!/usr/bin/env bash
# Align the RT-Thread SDK (rt-thread + nested cvi_rtt repo) with the remote master.
#
# For each repo: fetch origin/master explicitly, stash local changes (incl.
# skip-worktree files), back up local-only commits, then point local master
# at origin/master and check it out. Nothing is lost: stashes and
# backup/master-* branches keep the old state.
#
# Usage: sync-master.sh [-r ROOT] [-b BRANCH] [-n]
#   -r ROOT    rt-thread checkout (default ~/Public/rtt_master/rt-thread)
#   -b BRANCH  remote branch to align to (default master)
#   -n         dry run: fetch and report only, change nothing

set -uo pipefail

ROOT="${RTT_ROOT:-$HOME/Public/rtt_master/rt-thread}"
BRANCH=master
DRY=0

while [ $# -gt 0 ]; do
    case "$1" in
        -r) ROOT="$2"; shift 2 ;;
        -b) BRANCH="$2"; shift 2 ;;
        -n|--dry-run) DRY=1; shift ;;
        -h|--help) sed -n 2,15p "$0"; exit 0 ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
done

STAMP=$(date +%Y%m%d-%H%M%S)
RC=0

say() { printf '%s\n' "$*"; }
run() { if [ "$DRY" = 1 ]; then say "  [dry-run] $*"; else "$@"; fi; }

sync_repo() {
    local dir="$1" name="$2"
    say ""
    say "===== $name ($dir) ====="
    if ! git -C "$dir" rev-parse --git-dir >/dev/null 2>&1; then
        say "  SKIP: not a git repo"; return 0
    fi
    cd "$dir" || return 1

    local remote_ref="refs/remotes/origin/$BRANCH"
    local old_head old_branch
    old_head=$(git rev-parse --short HEAD)
    old_branch=$(git symbolic-ref -q --short HEAD || echo "(detached)")

    # 1. Explicit fetch: rt-thread's fetch refspec only maps cv18xx-dev, so a
    #    plain `git fetch` leaves origin/master stale.
    if ! git fetch -q origin "+refs/heads/$BRANCH:$remote_ref"; then
        say "  ERROR: fetch origin $BRANCH failed"; return 1
    fi
    local target
    target=$(git rev-parse --short "$remote_ref")
    say "  HEAD: $old_branch @ $old_head  ->  origin/$BRANCH @ $target"

    # 2. master must not be checked out in another worktree.
    local other
    other=$(git worktree list --porcelain | awk -v b="refs/heads/$BRANCH" -v me="$(pwd -P)" '
        /^worktree /{wt=substr($0,10)} $0=="branch " b && wt!=me {print wt}')
    if [ -n "$other" ]; then
        say "  ERROR: $BRANCH is checked out in another worktree: $other"; return 1
    fi

    # 3. skip-worktree / assume-unchanged files hide local edits from status
    #    and make checkout fail; clear the flag so they get stashed.
    local hidden
    hidden=$(git ls-files -v | awk '/^(S|[a-z]) /{print substr($0,3)}')
    if [ -n "$hidden" ]; then
        say "  hidden-flag files (flag cleared, re-set after sync):"
        say "$hidden" | sed 's/^/    /'
        [ "$DRY" = 1 ] || printf '%s\n' "$hidden" | git update-index --no-skip-worktree --no-assume-unchanged --stdin
    fi

    # 4. Stash tracked local changes (untracked build outputs are left alone).
    if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
        say "  local changes -> stash:"
        git status --short --untracked-files=no | sed 's/^/    /'
        run git stash push -q -m "rtt-sync-master $STAMP (was $old_branch @ $old_head)"
    fi

    # 5. Back up local commits that are not upstream (by patch-id).
    if git show-ref -q --verify "refs/heads/$BRANCH"; then
        local cherry
        cherry=$(git cherry -v "$remote_ref" "$BRANCH" 2>/dev/null)
        if [ -n "$cherry" ]; then
            say "  local commits on $BRANCH (+ = not upstream, - = already upstream):"
            say "$cherry" | cut -c1-100 | sed 's/^/    /'
            if printf '%s\n' "$cherry" | grep -q '^+'; then
                say "  backup branch: backup/$BRANCH-$STAMP"
                run git branch "backup/$BRANCH-$STAMP" "$BRANCH"
            fi
        fi
    fi

    # 6. Point local master at origin/master and check it out.
    if [ "$DRY" = 1 ]; then
        say "  [dry-run] git checkout -B $BRANCH origin/$BRANCH"
    elif ! git checkout -q -B "$BRANCH" "$remote_ref"; then
        say "  ERROR: checkout failed (untracked files in the way?). Stash/backup above are kept."
        return 1
    fi
    # Tracking via config: `--track` fails when the refspec doesn't map the branch.
    run git config "branch.$BRANCH.remote" origin
    run git config "branch.$BRANCH.merge" "refs/heads/$BRANCH"

    # 7. Re-apply skip-worktree on files that still exist.
    if [ -n "$hidden" ] && [ "$DRY" = 0 ]; then
        printf '%s\n' "$hidden" | while read -r f; do
            git ls-files --error-unmatch -- "$f" >/dev/null 2>&1 && git update-index --skip-worktree -- "$f"
        done
    fi

    [ "$DRY" = 1 ] || say "  now: $(git log --oneline -1 | cut -c1-100)"
    say "  status: $(git status -sb --untracked-files=no | head -1)"
}

sync_repo "$ROOT" "rt-thread" || RC=1
sync_repo "$ROOT/cvi_rtt" "cvi_rtt" || RC=1

say ""
if [ "$RC" != 0 ]; then say "FAILED: see ERROR lines above"
elif [ "$DRY" = 1 ]; then say "DRY RUN OK: nothing changed"
else say "DONE: both repos aligned with origin/$BRANCH"; fi
exit $RC
