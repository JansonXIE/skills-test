#!/bin/bash
# build-boot-firmware driver — build/update boot0 or fip.bin for a CVITEK
# CV18xx SDK v4.1.0 boot-firmware tree (rtt_boot_firmware), for the RT-Thread
# single-OS flow (cvi_rtt). The on-flash "boot" (mini-boot) is NOT built here —
# it comes from `make cv18xx_boot` in cvi_rtt (see SKILL.md).
#
# Usage:
#   bash driver.sh <target> [BOARD]
#   target = boot0 | fip | all        ("boot" = legacy cvirtos, dual-OS flow only)
#   BOARD  = board defconfig name (default: cv1812h_wevb_0007a_spinor, or $BOARD)
#
# Examples:
#   bash driver.sh boot0                       # FSBL for the board's flash
#   bash driver.sh fip                         # fip.bin for USB flashing (RTT flavor)
#   bash driver.sh all cv1812h_wevb_0007a_spinor
#   BOARD=cv1810c_wevb_0006a_spinor bash driver.sh fip
#
# Design notes / gotchas encoded here (all hit in real builds):
#  - defconfig/setconfig are shell FUNCTIONS that export OUTPUT_DIR / FREERTOS_PATH
#    into the current shell. NEVER pipe them (| tail): the exports vanish in the
#    subshell and the build dies with "Makefile:38 Please execute defconfig first".
#    -> we redirect with > instead of piping.
#  - boot0 and fip.bin are mutually exclusive per build_uboot pass
#    (CONFIG_ENABLE_BOOT0 switches fsbl output). "all" runs two passes.
#  - a boot0 pass's clean_uboot runs `rm -f OUTPUT_DIR/fip.bin` -> back up and
#    restore fip.bin/fip_spl.bin around it so an existing fip survives.
#  - RTT flow: fip MUST be built with ENABLE_FREERTOS=n ENABLE_RTT_UPDATE=y.
#    * FREERTOS=n keeps cvirtos out of the fip (blcp_2nd) and out of the flash chain;
#    * RTT_UPDATE=y makes the fip's u-boot run "sf probe" BEFORE the USB receive
#      loop (cvi_update_rtos.c). Without it every sf erase/write silently fails
#      ("No SPI flash selected") while usb_dl still reports success.
#  - 4K-erase trap: u-boot spi_nor_erase() rejects len%erasesize!=0 and the error
#    is swallowed, so if the board's SDK defconfig lacks
#    CONFIG_USE_4K_ERASE_SIZE_FOR_JFFS2=y (cv1812h originally didn't), ALL flash
#    writes silently fail. We check for it and fail loudly with the fix hint.

set -o pipefail

# --- locate repo root ---------------------------------------------------------
# The skill lives at <repo>/.claude/skills/build-boot-firmware/driver.sh when
# copied into a repo, but it may also live under ~/.claude/skills. Resolve the
# firmware tree by walking up for build/envsetup_soc.sh, else fall back to the
# known default.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_TOP="/home/jianxingxie/Public/rtt_boot_firmware"

find_top() {
  # 1) explicit override
  if [ -n "$TOP_DIR" ] && [ -f "$TOP_DIR/build/envsetup_soc.sh" ]; then
    echo "$TOP_DIR"; return 0
  fi
  # 2) walk up from the script location (handles .claude/skills/... inside repo)
  local d="$SCRIPT_DIR"
  while [ "$d" != "/" ]; do
    if [ -f "$d/build/envsetup_soc.sh" ]; then echo "$d"; return 0; fi
    d="$(dirname "$d")"
  done
  # 3) walk up from cwd
  d="$PWD"
  while [ "$d" != "/" ]; do
    if [ -f "$d/build/envsetup_soc.sh" ]; then echo "$d"; return 0; fi
    d="$(dirname "$d")"
  done
  # 4) fallback
  if [ -f "$DEFAULT_TOP/build/envsetup_soc.sh" ]; then echo "$DEFAULT_TOP"; return 0; fi
  return 1
}

TARGET="${1:?usage: driver.sh <boot|boot0|fip|all> [BOARD]}"
BOARD="${2:-${BOARD:-cv1812h_wevb_0007a_spinor}}"

REPO_TOP="$(find_top)" || { echo "[driver] ERROR: cannot find a firmware tree (build/envsetup_soc.sh). Set TOP_DIR."; exit 2; }
LOG_DIR="${LOG_DIR:-/tmp/build-boot-firmware}"
mkdir -p "$LOG_DIR"

echo "[driver] repo   : $REPO_TOP"
echo "[driver] board  : $BOARD"
echo "[driver] target : $TARGET"
echo "[driver] logs   : $LOG_DIR"

# --- helpers ------------------------------------------------------------------
# Everything that must share exported env from defconfig/setconfig runs inside a
# single bash -c so the exports persist for the make step. We isolate each pass
# in its own subshell invocation so CHIP/BOARD/ENABLE_BOOT0 never leak.

_pass() {
  # $1 = human label, $2 = log file, $3 = bootstrap+make script body
  local label="$1" log="$2" body="$3"
  echo "[driver] === $label === (log: $log)"
  bash -c "
    cd '$REPO_TOP' || exit 90
    source build/envsetup_soc.sh >/dev/null 2>&1
    defconfig '$BOARD' > '$LOG_DIR/_defconfig.log' 2>&1 || { echo 'defconfig FAILED'; exit 91; }
    [ -n \"\$OUTPUT_DIR\" ] || { echo 'OUTPUT_DIR empty after defconfig (did something pipe it?)'; exit 92; }
    $body
  " > "$log" 2>&1
  local rc=$?
  if [ $rc -ne 0 ]; then
    echo "[driver] $label FAILED (rc=$rc). Tail of log:"
    tail -n 25 "$log"
  fi
  return $rc
}

_check_artifact() {
  # $1 = path, $2 = friendly name
  if [ -s "$1" ]; then
    echo "[driver]   OK  $2 -> $1 ($(stat -c%s "$1") bytes)"
    return 0
  fi
  echo "[driver]   MISSING/empty: $2 ($1)"
  return 1
}

_check_fip_flavor() {
  # RTT-flavor sanity check: fip must NOT embed cvirtos (blcp_2nd), and must be
  # the ~410KB class, not the ~491KB FREERTOS one. (grep -a: binary-safe)
  local fip="$1"
  if grep -aq "CVIRTOS Build" "$fip"; then
    echo "[driver]   BAD FLAVOR: fip.bin embeds cvirtos (built with ENABLE_FREERTOS=y?)."
    echo "[driver]   The USB-flashing fip must be ENABLE_FREERTOS=n ENABLE_RTT_UPDATE=y."
    return 1
  fi
  echo "[driver]   OK  fip flavor: no cvirtos embedded (RTT flavor)"
  return 0
}

_check_4k_erase() {
  # Trap 1 (see SKILL.md): without CONFIG_USE_4K_ERASE_SIZE_FOR_JFFS2=y in the
  # board's SDK defconfig, the fip's u-boot uses 64KB erase blocks and every
  # sf erase/write on the RT-Thread (non-64K-aligned) partitions silently fails.
  local defcfg="$REPO_TOP/build/boards/cv181x/$BOARD/${BOARD}_defconfig"
  local defcfg2="$REPO_TOP/build/boards/cv180x/$BOARD/${BOARD}_defconfig"
  local cfg=""
  [ -f "$defcfg" ] && cfg="$defcfg"
  [ -z "$cfg" ] && [ -f "$defcfg2" ] && cfg="$defcfg2"
  if [ -z "$cfg" ]; then
    echo "[driver]   WARN: SDK defconfig for '$BOARD' not found (searched build/boards/{cv181x,cv180x}); skipping 4K-erase check."
    return 0
  fi
  if ! grep -q "^CONFIG_USE_4K_ERASE_SIZE_FOR_JFFS2=y" "$cfg"; then
    echo "[driver] FAILED: $cfg lacks CONFIG_USE_4K_ERASE_SIZE_FOR_JFFS2=y."
    echo "[driver]   Without it the fip's u-boot erases in 64KB blocks and ALL flash"
    echo "[driver]   writes silently fail (usb_dl still reports success!)."
    echo "[driver]   Fix: add 'CONFIG_USE_4K_ERASE_SIZE_FOR_JFFS2=y' to that defconfig, then re-run."
    return 1
  fi
  echo "[driver]   OK  4K-erase enabled in SDK defconfig"
  return 0
}

OUT="$REPO_TOP/install/soc_$BOARD"
CVIRTOS="$REPO_TOP/freertos/cvitek/install/bin/cvirtos.bin"

# --- targets ------------------------------------------------------------------
do_boot() {
  # Standalone FreeRTOS small-core image (cvirtos.bin). No boot0/fip touched.
  _pass "boot (FreeRTOS cvirtos.bin)" "$LOG_DIR/boot.log" "
    setconfig ENABLE_FREERTOS=y > '$LOG_DIR/_setconfig.log' 2>&1 || { echo setconfig FAILED; exit 93; }
    clean_rtos > '$LOG_DIR/_clean_rtos.log' 2>&1
    build_rtos; rc=\$?
    echo \"build_rtos exit: \$rc\"
    exit \$rc
  " || return 1
  mkdir -p "$OUT"
  cp -f "$CVIRTOS" "$OUT/boot" 2>/dev/null
  _check_artifact "$CVIRTOS" "cvirtos.bin" && _check_artifact "$OUT/boot" "boot"
}

do_fip() {
  # fip.bin for the USB flashing session (RTT flavor: no cvirtos, sf probe first).
  # Does NOT remove an existing boot0 (clean_uboot only wipes fip.bin).
  _check_4k_erase || return 1
  _pass "fip.bin (RTT flavor)" "$LOG_DIR/fip.log" "
    setconfig ENABLE_BOOT0=n ENABLE_FREERTOS=n ENABLE_RTT_UPDATE=y > '$LOG_DIR/_setconfig.log' 2>&1 || { echo setconfig FAILED; exit 93; }
    rm -f '${REPO_TOP}/u-boot-2021.10/build/${BOARD}/.config'
    clean_uboot > '$LOG_DIR/_clean_uboot.log' 2>&1
    build_uboot; rc=\$?
    echo \"build_uboot exit: \$rc\"
    exit \$rc
  " || return 1
  _check_fip_flavor "$OUT/fip.bin" || return 1
  _check_artifact "$OUT/fip.bin" "fip.bin"
}

do_boot0() {
  # Raw FSBL (DDR init + USB download loader). ENABLE_BOOT0=y, no RTOS embedded.
  # clean_uboot in this pass does `rm -f OUTPUT_DIR/fip.bin` -> back up & restore.
  local bak="$LOG_DIR/fip_backup"; mkdir -p "$bak"
  local saved=0
  if [ -s "$OUT/fip.bin" ]; then
    cp -f "$OUT/fip.bin" "$bak/fip.bin" 2>/dev/null
    [ -s "$OUT/fip_spl.bin" ] && cp -f "$OUT/fip_spl.bin" "$bak/fip_spl.bin" 2>/dev/null
    saved=1
    echo "[driver]   (backed up existing fip.bin before boot0 clean)"
  fi
  _pass "boot0" "$LOG_DIR/boot0.log" "
    setconfig ENABLE_BOOT0=y ENABLE_FREERTOS=n > '$LOG_DIR/_setconfig.log' 2>&1 || { echo setconfig FAILED; exit 93; }
    clean_uboot > '$LOG_DIR/_clean_uboot.log' 2>&1
    build_uboot; rc=\$?
    echo \"build_uboot exit: \$rc\"
    exit \$rc
  "
  local rc=$?
  if [ "$saved" = 1 ]; then
    cp -f "$bak/fip.bin" "$OUT/fip.bin" 2>/dev/null
    [ -s "$bak/fip_spl.bin" ] && cp -f "$bak/fip_spl.bin" "$OUT/fip_spl.bin" 2>/dev/null
    echo "[driver]   (restored fip.bin after boot0 pass)"
  fi
  [ $rc -eq 0 ] || return 1
  _check_artifact "$OUT/boot0" "boot0"
}

# --- dispatch -----------------------------------------------------------------
rc=0
case "$TARGET" in
  boot)  do_boot  || rc=1 ;;   # legacy dual-OS cvirtos.bin — NOT for bootimgs/boot
  fip)   do_fip   || rc=1 ;;
  boot0) do_boot0 || rc=1 ;;
  all)
    # fip first, then boot0 (fip backed up/restored inside do_boot0).
    do_fip   || rc=1
    do_boot0 || rc=1
    ;;
  *) echo "[driver] unknown target '$TARGET' (want: boot0|fip|all)"; exit 2 ;;
esac

echo
if [ $rc -eq 0 ]; then
  echo "[driver] SUCCESS ($TARGET). Artifacts in: $OUT"
  ls -l "$OUT"/boot0 "$OUT"/fip.bin 2>/dev/null
  echo
  echo "[driver] Deploy to cvi_rtt:"
  echo "  cp $OUT/boot0     cvi_rtt/boards/<soc>/bootimgs/boot0"
  echo "  cp $OUT/fip.bin   cvi_rtt/tools/fip/<soc>/fip.bin"
  echo "  'boot' (mini-boot) is NOT built here: in cvi_rtt run 'make cv18xx_boot',"
  echo "  then cp solutions/cv18xx_boot/generated/boot cvi_rtt/boards/<soc>/bootimgs/boot"
else
  echo "[driver] FAILED ($TARGET). See logs in $LOG_DIR"
fi
exit $rc
