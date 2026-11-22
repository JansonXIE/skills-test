#!/usr/bin/env bash
# board-lock.sh: serialize access to a SHARED development board (single USB
# download port + single UART) across multiple parallel Claude/Agent sessions.
#
# The Mars3 dev board, its USB flashing port and its serial line are physical
# resources that cannot be isolated in software. When several Agents run in
# parallel, concurrent flashing or serial I/O corrupts each other. This wrapper
# takes an exclusive flock before running the given command and releases it when
# the command finishes, so only one Agent can own the board at a time.
#
# Usage:
#   board-lock.sh [-l <lockfile>] [-t <wait_seconds>] -- <command> [args...]
#
# Examples:
#   board-lock.sh -- ~/.claude/skills/usb-flash/flash.sh -p 3 -c cv184x -i /abs/install/soc_x/
#   board-lock.sh -l /tmp/mars3_board_b.lock -- python3 ./uart_agent.py --cmd "ls"
set -uo pipefail

LOCKFILE="${MARS3_BOARD_LOCK:-/tmp/mars3_board.lock}"
WAIT_SECONDS="${MARS3_BOARD_LOCK_WAIT:-0}"   # 0 = wait forever until the lock is free

usage() {
  echo "Usage: $0 [-l <lockfile>] [-t <wait_seconds>] -- <command> [args...]" >&2
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    -l) LOCKFILE="$2"; shift 2 ;;
    -t) WAIT_SECONDS="$2"; shift 2 ;;
    --) shift; break ;;
    -h|--help) usage ;;
    *) echo "board-lock: unknown option: $1" >&2; usage ;;
  esac
done

if [ $# -eq 0 ]; then
  echo "board-lock: no command given after --" >&2
  usage
fi

if ! command -v flock >/dev/null 2>&1; then
  echo "board-lock: 'flock' not found; install util-linux or run the command manually" >&2
  exit 3
fi

# Open the lock file on fd 9 (creating it if needed) and take an exclusive lock.
exec 9>"$LOCKFILE" || { echo "board-lock: cannot open lockfile: $LOCKFILE" >&2; exit 4; }

if [ "$WAIT_SECONDS" -gt 0 ] 2>/dev/null; then
  if ! flock -w "$WAIT_SECONDS" 9; then
    echo "board-lock: timed out after ${WAIT_SECONDS}s waiting for $LOCKFILE" >&2
    exit 5
  fi
else
  echo "board-lock: waiting for exclusive board lock ($LOCKFILE) ..." >&2
  flock 9
fi

echo "board-lock: acquired $LOCKFILE, running: $*" >&2
"$@"
STATUS=$?
echo "board-lock: released $LOCKFILE (exit $STATUS)" >&2
exit "$STATUS"
