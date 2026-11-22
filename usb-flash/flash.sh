#!/usr/bin/env bash
# usb-flash helper: power-cycle a board on a SmartUSBHub port and run usb_dl,
# retrying automatically until the log shows "USB download complete".
#
# Sequence per attempt:
#   1) usbctl off <port>           -> board power off
#   2) start sudo ./usb_dl ...     -> waits for USB device to enumerate
#   3) usbctl on  <port>           -> board powers up in USB download mode
#   4) watch log for success / failure / timeout
set -uo pipefail

# ---- defaults (override via flags or env) -----------------------------------
# The ROM only exposes a USB-download device for ~1s right after power-on.
# usb_dl must grab it inside that window; if it doesn't, the window is gone
# for good and the only fix is to power-cycle again to create a fresh window.
# So we use a SHORT "catch window": if usb_dl has not started producing output
# (i.e. has not grabbed the device) within CATCH_TIMEOUT seconds after power-on,
# this attempt is hopeless -> abort it immediately and retry with a new cycle.
HUB_PORT=""
BOARD=""
FW=""
MAX_RETRIES="${USB_DL_MAX_RETRIES:-4}"
TIMEOUT="${USB_DL_TIMEOUT:-180}"           # hard cap for one full attempt once download has started
CATCH_TIMEOUT="${USB_DL_CATCH_TIMEOUT:-8}" # seconds after power-on to catch the ROM USB-download window
# Every usbctl call is wrapped in `timeout USBCTL_TIMEOUT` so that a hung hub
# control channel (serial port stuck/occupied) can NEVER block the whole flow.
USBCTL_TIMEOUT="${USBCTL_TIMEOUT:-10}"    # hard cap (s) for any single usbctl invocation
# Before flashing, power-cycle the board's UART (FTDI) on its own hub port to
# recover a flaky/stuck serial link, so that uart_agent.py commands work after
# boot. This simulates a physical re-plug of the serial cable.
RESET_SERIAL="${RESET_SERIAL:-1}"          # 1=do the UART re-plug, 0=skip it
SERIAL_PORT="${SERIAL_PORT:-0}"            # SmartUSBHub port the UART (FTDI) is on
SERIAL_DEV="${SERIAL_DEV:-/dev/ttyUSB0}"   # serial node to wait for after re-plug
SERIAL_WAIT="${SERIAL_WAIT:-15}"           # max seconds to wait for SERIAL_DEV to reappear
USB_DL_DIR="${USB_DL_DIR:-$HOME/usb_dl}"
SUDO_PASS="${USB_DL_SUDO_PASS:-123456}"
SUCCESS_RE="USB download complete"
FAIL_RE="USB download failed"
# VID/keywords used to detect the Cvitek/CVITEK ROM USB-download device via lsusb
ENUM_RE="${USB_DL_ENUM_RE:-3346:|cvitek|Cadence|eaef}"

usage() {
  cat <<EOF
Usage: flash.sh -p <hub_port> -c <board> -i <firmware_path> [-r retries] [-t timeout]

  -p, --port      SmartUSBHub port to power-cycle (e.g. 3)   [required]
  -c, --chip      board/chip type passed to usb_dl (e.g. cv184x)  [required]
  -i, --image     firmware directory passed to usb_dl (e.g. ~/Public/mars3_repo/install/soc_cv1842hp_wevb_0014a_emmc/) [required]
  -r, --retries   max attempts before giving up (default: $MAX_RETRIES)
  -t, --timeout   hard cap (s) for one attempt once download started (default: $TIMEOUT)
  -w, --catch-timeout  seconds after power-on to catch the ~1s ROM USB-download window (default: $CATCH_TIMEOUT)
  -d, --dir       usb_dl working directory (default: $USB_DL_DIR)
  -h, --help      show this help

Env overrides: USB_DL_SUDO_PASS, USB_DL_MAX_RETRIES, USB_DL_TIMEOUT, USB_DL_CATCH_TIMEOUT, USBCTL_TIMEOUT, USB_DL_DIR, USB_DL_ENUM_RE
                RESET_SERIAL(1=re-plug UART before flash, default 1), SERIAL_PORT(hub port of UART, default 0),
                SERIAL_DEV(serial node to wait for, default /dev/ttyUSB0), SERIAL_WAIT(max s to wait, default 15)
EOF
}

# ---- arg parsing ------------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    -p|--port)    HUB_PORT="$2"; shift 2;;
    -c|--chip)    BOARD="$2";    shift 2;;
    -i|--image)   FW="$2";       shift 2;;
    -r|--retries) MAX_RETRIES="$2"; shift 2;;
    -t|--timeout) TIMEOUT="$2";  shift 2;;
    -w|--catch-timeout) CATCH_TIMEOUT="$2"; shift 2;;
    -d|--dir)     USB_DL_DIR="$2"; shift 2;;
    -h|--help)    usage; exit 0;;
    *) echo "[ERR] unknown argument: $1" >&2; usage; exit 2;;
  esac
done

[ -n "$HUB_PORT" ] || { echo "[ERR] -p/--port is required" >&2; usage; exit 2; }
[ -n "$BOARD" ]    || { echo "[ERR] -c/--chip is required" >&2; usage; exit 2; }
[ -n "$FW" ]       || { echo "[ERR] -i/--image is required" >&2; usage; exit 2; }

# expand ~ in firmware path
FW="${FW/#\~/$HOME}"

cd "$USB_DL_DIR" || { echo "[ERR] cannot cd to $USB_DL_DIR" >&2; exit 1; }
[ -x ./usb_dl ] || { echo "[ERR] ./usb_dl not found or not executable in $USB_DL_DIR" >&2; exit 1; }
command -v usbctl >/dev/null || { echo "[ERR] usbctl not on PATH" >&2; exit 1; }

# warm up sudo once so the password (piped via -S) is cached for the loop
echo "$SUDO_PASS" | sudo -S -p '' true 2>/dev/null || {
  echo "[ERR] sudo authentication failed (check USB_DL_SUDO_PASS)" >&2; exit 1; }

# ---- usbctl wrapper: never let a hung hub control channel block us ----------
# Every usbctl call is hard-capped by `timeout`. Exit 124 == it hung.
usbctl_t() {
  timeout "$USBCTL_TIMEOUT" usbctl "$@"
}

# Kill any stale/hung usbctl processes that may be holding the hub's serial
# port (e.g. /dev/ttyACM*) hostage from a previous aborted run. Without this,
# a leftover process makes every new usbctl block forever on the busy port.
reap_stale_usbctl() {
  local pids
  pids="$(pgrep -f '[u]sbctl' 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    echo "[*] reaping stale usbctl processes: $pids" >&2
    # shellcheck disable=SC2086
    kill $pids 2>/dev/null || true
    sleep 1
    pids="$(pgrep -f '[u]sbctl' 2>/dev/null || true)"
    # shellcheck disable=SC2086
    [ -n "$pids" ] && { echo "$SUDO_PASS" | sudo -S -p '' kill -9 $pids 2>/dev/null || true; }
    sleep 1
  fi
}

# ---- pre-flight: verify the hub can actually power-cycle the board ----------
# This MUST run before the flash loop. If the hub control channel is dead, we
# fail fast with a clear message instead of dead-waiting inside the loop.
preflight_usbctl() {
  echo "[*] pre-flight: checking usbctl control channel (port $HUB_PORT)..."
  # `usbctl status <port>` performs a real read from the hub, so it exercises
  # the control channel end-to-end (unlike `list`, which only scans devices).
  if usbctl_t status "$HUB_PORT" >/dev/null 2>&1; then
    echo "[OK] usbctl responsive."
    return 0
  fi
  # First failure: it likely hung (exit 124) due to a stale process holding
  # the serial port. Reap them and try once more.
  echo "[WARN] usbctl unresponsive -> reaping stale processes and retrying once" >&2
  reap_stale_usbctl
  if usbctl_t status "$HUB_PORT" >/dev/null 2>&1; then
    echo "[OK] usbctl responsive after reaping stale processes."
    return 0
  fi
  cat >&2 <<EOF
[ERR] usbctl cannot control the SmartUSBHub (port $HUB_PORT).
      The hub control channel is unresponsive even after clearing stale
      processes. Aborting BEFORE the flash loop to avoid a long dead-wait.
      Things to check:
        * Is the SmartUSBHub connected?  -> run: usbctl list
        * Is the serial device (/dev/ttyACM*) free, or held by another tool?
        * Try replugging the hub's control USB cable, or power-cycle the hub.
EOF
  return 1
}

# ---- recover the board UART by simulating a serial cable re-plug ------------
# The FTDI UART occasionally gets into a stuck/flaky state, so that after the
# board boots, commands sent via uart_agent.py silently do nothing. Power-
# cycling the UART's own hub port (SERIAL_PORT, default 0) forces the FTDI to
# re-enumerate, which clears the stuck state -- exactly like physically
# unplugging and replugging the serial cable. We then wait (bounded by
# SERIAL_WAIT) for the serial node (SERIAL_DEV) to reappear so we know the
# link is back before we proceed to flashing.
reset_serial() {
  [ "$RESET_SERIAL" = "1" ] || { echo "[*] serial re-plug disabled (RESET_SERIAL=0), skipping."; return 0; }
  # If the UART shares the board's hub port, re-plugging it would just be an
  # extra board power-cycle (and the default SERIAL_DEV may belong to another board).
  if [ "$SERIAL_PORT" = "$HUB_PORT" ]; then
    echo "[*] SERIAL_PORT ($SERIAL_PORT) == board hub port, skipping serial re-plug."
    return 0
  fi
  echo "[*] serial re-plug: power-cycling UART on hub port $SERIAL_PORT (dev: $SERIAL_DEV)..."
  usbctl_t off "$SERIAL_PORT" || true
  sleep 1
  usbctl_t on "$SERIAL_PORT" || true

  # Wait (bounded) for the serial node to re-enumerate. Not fatal if it does
  # not show up -- the FTDI node name can differ -- but we warn loudly so a
  # later uart_agent.py failure is easy to explain.
  local waited=0
  while [ "$waited" -lt "$SERIAL_WAIT" ]; do
    if [ -e "$SERIAL_DEV" ]; then
      echo "[OK] serial device $SERIAL_DEV is back (after ${waited}s)."
      return 0
    fi
    sleep 1; waited=$((waited+1))
  done
  echo "[WARN] $SERIAL_DEV did not reappear within ${SERIAL_WAIT}s after re-plug." >&2
  echo "[WARN] uart_agent.py may not work; check SERIAL_PORT/SERIAL_DEV." >&2
  return 0
}

if ! preflight_usbctl; then
  exit 1
fi

reset_serial

flash_once() {
  local attempt="$1"
  local logf; logf="$(mktemp /tmp/usb_dl.XXXXXX.log)"
  echo "==> attempt $attempt/$MAX_RETRIES  (log: $logf)"

  echo "[*] power OFF  -> usbctl off $HUB_PORT"
  usbctl_t off "$HUB_PORT" || true
  sleep 1

  # Launch usb_dl FIRST so it is already waiting on the bus when the ROM's
  # ~1s USB-download window opens right after power-on.
  echo "[*] launching  -> sudo ./usb_dl -c $BOARD -i $FW"
  echo "$SUDO_PASS" | sudo -S -p '' timeout "$TIMEOUT" ./usb_dl -c "$BOARD" -i "$FW" >"$logf" 2>&1 &
  local pid=$!
  sleep 1

  echo "[*] power ON   -> usbctl on $HUB_PORT  (catch window: ${CATCH_TIMEOUT}s)"
  usbctl_t on "$HUB_PORT" || true

  # ---- phase 1: catch the ROM USB-download window ---------------------------
  # The download device only appears for ~1s after power-on. If usb_dl has not
  # grabbed it (no log output AND no lsusb match) within CATCH_TIMEOUT seconds,
  # this attempt missed the window -> abort fast and power-cycle again.
  local caught=0
  local waited=0
  while [ "$waited" -lt "$CATCH_TIMEOUT" ]; do
    if ! kill -0 "$pid" 2>/dev/null; then break; fi          # usb_dl already exited
    if grep -qa "$SUCCESS_RE" "$logf"; then caught=1; break; fi
    if grep -qa "$FAIL_RE" "$logf"; then break; fi
    # primary signal: usb_dl started producing output => it grabbed the device
    if [ -s "$logf" ]; then caught=1; echo "[*] usb_dl grabbed the device (log active)."; break; fi
    # secondary signal: lsusb sees the Cvitek download device
    if lsusb 2>/dev/null | grep -qiE "$ENUM_RE"; then caught=1; echo "[*] USB download device enumerated."; break; fi
    sleep 1; waited=$((waited+1))
  done

  if [ "$caught" -eq 0 ] && ! grep -qa "$SUCCESS_RE" "$logf"; then
    echo "[WARN] missed the ROM USB-download window within ${CATCH_TIMEOUT}s -> fast-fail, will power-cycle" >&2
    echo "$SUDO_PASS" | sudo -S -p '' kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
    return 1
  fi

  # ---- phase 2: transfer in progress, wait for completion -------------------
  while kill -0 "$pid" 2>/dev/null; do
    if grep -qa "$SUCCESS_RE" "$logf"; then break; fi
    if grep -qa "$FAIL_RE" "$logf"; then break; fi
    sleep 1
  done
  wait "$pid" 2>/dev/null || true

  if grep -qa "$SUCCESS_RE" "$logf"; then
    echo "[OK] $SUCCESS_RE"
    tail -n 5 "$logf"
    return 0
  fi
  echo "[FAIL] attempt $attempt did not complete. Last log lines:" >&2
  tail -n 12 "$logf" >&2
  return 1
}

for ((i=1; i<=MAX_RETRIES; i++)); do
  if flash_once "$i"; then
    echo "==================================================="
    echo " FLASH SUCCESS on port $HUB_PORT (attempt $i)"
    echo "==================================================="
    exit 0
  fi
  echo "[*] retrying..." >&2
  sleep 2
done

echo "===================================================" >&2
echo " FLASH FAILED after $MAX_RETRIES attempts on port $HUB_PORT" >&2
echo "===================================================" >&2
exit 1
