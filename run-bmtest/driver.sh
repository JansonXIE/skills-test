#!/bin/bash
# run-bmtest driver — build bmtest, pack it into fip.bin, flash the board, and
# verify bmtest ran by watching the serial console live.
#
# Verified working 2026-08-13 on this container (cv1842cp_wevb_0015a_spinor,
# TEST_CASE=tpu): 12 PASS / 0 FAIL captured live on /dev/ttyUSB1.
#
# Usage:
#   driver.sh build            # cvi_bmtest: build out/bmtest.bin
#   driver.sh fip              # mars3_repo: defconfig + build_fsbl -> fip.bin
#   driver.sh flash            # usb_dl download + live console capture + PASS/FAIL check
#   driver.sh all              # build -> fip -> flash   (the full loop)
#
# Env overrides (defaults match this machine):
#   BMTEST_DIR      ~/Public/cvi_bmtest/mars3
#   REPO_DIR        ~/Public/mars3_repo
#   BOARD           cv1842cp_wevb_0015a_spinor
#   INSTALL_DIR     $REPO_DIR/install/soc_<BOARD>
#   USB_DL_DIR      ~/usb_dl
#   CHIP            cv184x
#   HUB_PORT        2                 # SmartUSBHub port powering the board
#   CONSOLE         /dev/ttyUSB1      # board console (NOT ttyUSB0)
#   UART_AGENT      $REPO_DIR/uart_agent.py
#   USB_DL_SUDO_PASS  (sudo password for usb_dl; defaults to the known one)
#   BUILD_ARGS      ""                # extra args to build_tpu.sh e.g. "asic 2"
#   FLASH_RETRIES   6                 # usb_dl is flaky; retry the download+boot
#   CATCH_SECONDS   20                # fast-fail a retry if no banner within this (banner ~13s after power-on)
#   PER_ATTEMPT_SECONDS 45            # total console-capture window per attempt

set -u

BMTEST_DIR="${BMTEST_DIR:-$HOME/Public/cvi_bmtest/mars3}"
REPO_DIR="${REPO_DIR:-$HOME/Public/mars3_repo}"
BOARD="${BOARD:-cv1842cp_wevb_0015a_spinor}"
INSTALL_DIR="${INSTALL_DIR:-$REPO_DIR/install/soc_$BOARD}"
USB_DL_DIR="${USB_DL_DIR:-$HOME/usb_dl}"
CHIP="${CHIP:-cv184x}"
HUB_PORT="${HUB_PORT:-2}"
CONSOLE="${CONSOLE:-/dev/ttyUSB1}"
UART_AGENT="${UART_AGENT:-$REPO_DIR/uart_agent.py}"
USB_DL_SUDO_PASS="${USB_DL_SUDO_PASS:-Xie123456}"
BUILD_ARGS="${BUILD_ARGS:-}"

log() { echo "[driver] $*"; }
die() { echo "[driver][FAIL] $*" >&2; exit 1; }

step_build() {
  log "building bmtest.bin in $BMTEST_DIR (build_tpu.sh $BUILD_ARGS)"
  cd "$BMTEST_DIR" || die "no $BMTEST_DIR"
  ./build_scripts/build_tpu.sh $BUILD_ARGS || die "build_tpu.sh failed"
  [ -f out/bmtest.bin ] || die "out/bmtest.bin not produced"
  log "bmtest.bin = $(stat -c%s out/bmtest.bin) bytes"
}

step_fip() {
  # CRITICAL #1: defconfig exports OUTPUT_DIR into the *current* shell. Piping it
  # (| tee/tail) runs it in a subshell and the export is lost, after which
  # build_fsbl dies with "Please execute defconfig/menuconfig/oldconfig first".
  # So source + defconfig + build_fsbl must all run in ONE un-piped shell.
  #
  # CRITICAL #2: sourcing envsetup_soc.sh + defconfig CLOBBERS shell vars named
  # CHIP and BOARD (it sets CHIP=cv1842cp, BOARD=wevb_0015a_spinor). If that
  # leaks into the parent, step_flash later runs `usb_dl -c cv1842cp` (invalid)
  # -> "no chip specified". So we do the whole env phase in a SUBSHELL; only
  # the file artifact (fip.bin) escapes, never the mutated vars.
  log "packing fip.bin in $REPO_DIR (board=$BOARD)"
  (
    cd "$REPO_DIR" || exit 1
    # envsetup_soc.sh + the kconfig helper functions reference unset vars, so
    # `set -u` makes `source` bail out before defconfig() is even defined
    # ("defconfig: command not found"). Relax nounset for the whole env phase.
    set +u
    # shellcheck disable=SC1091
    source build/envsetup_soc.sh >/tmp/bmtest_env.log 2>&1 || exit 2
    defconfig "$BOARD" >/tmp/bmtest_defconfig.log 2>&1 || exit 3
    [ -n "${OUTPUT_DIR:-}" ] || exit 4
    echo "[driver] OUTPUT_DIR=$OUTPUT_DIR"
    build_fsbl >/tmp/bmtest_fsbl.log 2>&1 || exit 5
  )
  local rc=$?
  case "$rc" in
    0) : ;;
    2) die "source envsetup failed" ;;
    3) die "defconfig failed (see /tmp/bmtest_defconfig.log)" ;;
    4) die "defconfig did not export OUTPUT_DIR (was it piped?)" ;;
    5) tail -20 /tmp/bmtest_fsbl.log; die "build_fsbl failed" ;;
    *) die "fip step failed (rc=$rc)" ;;
  esac
  grep -q "MONITOR='$BMTEST_DIR/out/bmtest.bin'" /tmp/bmtest_fsbl.log \
    || log "WARN: fsbl log did not confirm bmtest.bin as MONITOR (check fsbl/make_helpers/fip.mk:14)"
  [ -f "$INSTALL_DIR/fip.bin" ] || die "$INSTALL_DIR/fip.bin missing"
  log "fip.bin = $(stat -c%s "$INSTALL_DIR/fip.bin") bytes"
}

step_flash() {
  # usb_dl RAM-boots the downloaded fip immediately, so bmtest (packed as the
  # BL31/monitor) prints on the console DURING the download. We therefore start
  # the console capture BEFORE powering the board on, or the early PASS lines
  # are gone before a monitor could attach.
  #
  # usb_dl is FLAKY: single downloads intermittently die mid-transfer
  # (LIBUSB_ERROR_IO / LIBUSB_ERROR_NO_DEVICE) and never RAM-boot bmtest. And
  # for cv184x in this RAM-boot flow usb_dl does NOT reliably print
  # "USB download complete" — the only trustworthy success signal is the
  # bmtest banner itself appearing on the console. So we retry the whole
  # power-cycle+download until we see 'bmtest' on the console.
  command -v usbctl >/dev/null || die "usbctl not on PATH"
  [ -x "$USB_DL_DIR/usb_dl" ] || die "$USB_DL_DIR/usb_dl not found"
  local caplog="/tmp/bmtest_console.log"
  local retries="${FLASH_RETRIES:-6}"
  local catch="${CATCH_SECONDS:-20}"        # fast-fail if no banner within this
  local window="${PER_ATTEMPT_SECONDS:-45}" # total capture window per attempt

  local attempt caught=0
  for attempt in $(seq 1 "$retries"); do
    log "flash attempt $attempt/$retries"
    : > "$caplog"
    # One capture window per attempt. It stays open the full `window` seconds so
    # that once bmtest boots, the whole PASS/FAIL burst is captured (bmtest runs
    # once, fast, right after download). We only *fast-fail* to a retry if the
    # banner hasn't appeared within the shorter `catch` window (usb_dl missed
    # the ~1s ROM window).
    python3 "$UART_AGENT" monitor --dev "$CONSOLE" --seconds "$window" --save "$caplog" >/dev/null 2>&1 &
    local mon_pid=$!
    sleep 1

    ( cd "$USB_DL_DIR" || exit 1
      usbctl off "$HUB_PORT" >/dev/null 2>&1
      echo "$USB_DL_SUDO_PASS" | sudo -S ./usb_dl -c "$CHIP" -i "$INSTALL_DIR/" >/tmp/bmtest_usbdl.log 2>&1 &
      sleep 2
      usbctl on "$HUB_PORT" >/dev/null 2>&1 )

    local i
    for i in $(seq 1 "$catch"); do
      if grep -aq 'bmtest' "$caplog"; then caught=1; break; fi
      kill -0 "$mon_pid" 2>/dev/null || break
      sleep 1
    done

    if [ "$caught" -eq 1 ]; then
      # banner seen — let the monitor run out its window to capture the tail
      wait "$mon_pid" 2>/dev/null
      echo "$USB_DL_SUDO_PASS" | sudo -S pkill -f "usb_dl -c $CHIP" >/dev/null 2>&1
      break
    fi

    # missed the ROM window — kill this attempt fast and retry
    kill "$mon_pid" 2>/dev/null; wait "$mon_pid" 2>/dev/null
    echo "$USB_DL_SUDO_PASS" | sudo -S pkill -f "usb_dl -c $CHIP" >/dev/null 2>&1
    log "attempt $attempt: no bmtest banner within ${catch}s (usb_dl flaky) — retrying"
  done

  local pass fail
  pass=$(tr '\r' '\n' < "$caplog" | grep -acE '\bPASS\b')
  fail=$(tr '\r' '\n' < "$caplog" | grep -acE '\bFAIL\b')
  echo "----------------------------------------------------------------"
  tr '\r' '\n' < "$caplog" | grep -aiE 'bmtest|TEST_CASE|PASS|FAIL|test done|coverage note' | grep -av '^$' | tail -40
  echo "----------------------------------------------------------------"
  log "console log: $caplog   (usb_dl log: /tmp/bmtest_usbdl.log)"
  log "result: PASS=$pass FAIL=$fail"

  if [ "$caught" -ne 1 ]; then
    die "no 'bmtest' banner after $retries attempts — check /tmp/bmtest_usbdl.log and CONSOLE=$CONSOLE"
  fi
  if [ "$fail" -gt 0 ]; then die "bmtest reported $fail FAIL line(s)"; fi
  [ "$pass" -gt 0 ] || die "bmtest ran but zero PASS lines captured (raise PER_ATTEMPT_SECONDS?)"
  log "SUCCESS: bmtest ran, $pass PASS / 0 FAIL"
}

case "${1:-all}" in
  build) step_build ;;
  fip)   step_fip ;;
  flash) step_flash ;;
  all)   step_build && step_fip && step_flash ;;
  *) echo "usage: $0 {build|fip|flash|all}"; exit 2 ;;
esac
