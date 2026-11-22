#!/usr/bin/env bash
#
# save_test_log.sh - Run board-side functional tests via uart_agent.py and
# archive the serial log into <TOP_DIR>/log/, named by the JIRA ID.
#
# Usage:
#   save_test_log.sh -j <JIRA_ID> -c "<test cmd>" [-c "<test cmd>" ...] \
#                    [-d "<description>"] [-r <TOP_DIR>]
#
# The exit code reflects the LAST test command's result: 0 = all PASS,
# non-zero = at least one command failed (see uart_agent.py exit codes).

set -u

usage() {
    cat <<'EOF'
Usage: save_test_log.sh -j <JIRA_ID> -c "<test cmd>" [-c "<test cmd>" ...]
                        [-d "<description>"] [-r <TOP_DIR>]

  -j <JIRA_ID>      JIRA ID, used as the log file name (required).
  -c "<cmd>"        Board-side test command; may be repeated for multiple
                    sequential commands (at least one required).
  -d "<desc>"       Optional description of the feature under test.
  -r <TOP_DIR>      SDK root dir (default: current directory $PWD).
                    Log is written to <TOP_DIR>/log/.
  -h                Show this help.
EOF
}

JIRA_ID=""
DESC=""
TOP_DIR="$PWD"
CMDS=()

while getopts ":j:c:d:r:h" opt; do
    case "$opt" in
        j) JIRA_ID="$OPTARG" ;;
        c) CMDS+=("$OPTARG") ;;
        d) DESC="$OPTARG" ;;
        r) TOP_DIR="$OPTARG" ;;
        h) usage; exit 0 ;;
        :) echo "ERROR: option -$OPTARG requires an argument" >&2; usage; exit 1 ;;
        \?) echo "ERROR: unknown option -$OPTARG" >&2; usage; exit 1 ;;
    esac
done

if [ -z "$JIRA_ID" ]; then
    echo "ERROR: JIRA ID (-j) is required." >&2
    usage
    exit 1
fi

if [ "${#CMDS[@]}" -eq 0 ]; then
    echo "ERROR: at least one test command (-c) is required." >&2
    usage
    exit 1
fi

# Sanitize JIRA ID for use as a file name (keep letters, digits, _, -).
# Use printf (no trailing newline) so the trailing char is not turned into '_'.
SAFE_JIRA="$(printf '%s' "$JIRA_ID" | tr -c 'A-Za-z0-9_-' '_')"

UART_AGENT="$TOP_DIR/uart_agent.py"
if [ ! -f "$UART_AGENT" ]; then
    echo "ERROR: uart_agent.py not found at $UART_AGENT" >&2
    echo "       Run this from the SDK root, or pass -r <TOP_DIR>." >&2
    exit 1
fi

LOG_DIR="$TOP_DIR/log"
mkdir -p "$LOG_DIR"

# Choose the log file name: <JIRA>.log, else append a timestamp to avoid
# clobbering earlier runs of the same JIRA ID.
LOG_FILE="$LOG_DIR/${SAFE_JIRA}.log"
if [ -e "$LOG_FILE" ]; then
    TS="$(date +%Y%m%d_%H%M%S)"
    LOG_FILE="$LOG_DIR/${SAFE_JIRA}_${TS}.log"
fi

RUN_TIME="$(date '+%Y-%m-%d %H:%M:%S')"

{
    echo "========================================================"
    echo "JIRA ID     : $JIRA_ID"
    echo "Description : ${DESC:-N/A}"
    echo "Test time   : $RUN_TIME"
    echo "TOP_DIR     : $TOP_DIR"
    echo "Test count  : ${#CMDS[@]}"
    echo "========================================================"
    echo
} > "$LOG_FILE"

overall_rc=0
idx=0
for cmd in "${CMDS[@]}"; do
    idx=$((idx + 1))
    {
        echo "--------------------------------------------------------"
        echo "[CMD $idx/${#CMDS[@]}] $cmd"
        echo "--------------------------------------------------------"
    } >> "$LOG_FILE"

    # Run the test on the board and tee output into the log.
    python3 "$UART_AGENT" --cmd "$cmd" 2>&1 | tee -a "$LOG_FILE"
    rc=${PIPESTATUS[0]}

    {
        echo
        echo "[EXIT CODE] $rc ($( [ "$rc" -eq 0 ] && echo PASS || echo FAIL ))"
        echo
    } >> "$LOG_FILE"

    # Overall result tracks the last command; also fail-fast is avoided so
    # every command is logged even if an earlier one failed.
    overall_rc="$rc"
done

{
    echo "========================================================"
    echo "OVERALL RESULT: $( [ "$overall_rc" -eq 0 ] && echo PASS || echo FAIL ) (last RC=$overall_rc)"
    echo "========================================================"
} >> "$LOG_FILE"

echo
echo "[save-test-log] Test log saved to: $LOG_FILE"
exit "$overall_rc"
