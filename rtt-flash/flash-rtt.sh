#!/usr/bin/env bash
# rtt-flash: flash the RT-Thread (CVITEK cv181x) build over USB.
#
# The manual workflow this replaces is:
#   1) sudo ./usb_dl -c cv181x -i ~/Public/rtt_master/rt-thread/cvi_rtt/generated/image/
#   2) usbctl off 3
#   3) usbctl on 3
#
# That is exactly the generic "start usb_dl, then power-cycle the hub port so the
# board enumerates into it" dance already implemented (with retries, catch-window
# handling, and stale-usbctl recovery) in ~/.claude/skills/usb-flash/flash.sh.
# So this is a thin wrapper that pins the RTT defaults and delegates to it.
set -uo pipefail

# ---- RTT defaults (override via flags or env) -------------------------------
HUB_PORT="${RTT_HUB_PORT:-3}"
CHIP="${RTT_CHIP:-cv181x}"
IMAGE="${RTT_IMAGE:-$HOME/Public/rtt_master/rt-thread/cvi_rtt/generated/image/}"

FLASH_SH="${FLASH_SH:-$HOME/.claude/skills/usb-flash/flash.sh}"

usage() {
  cat <<EOF
Usage: flash-rtt.sh [-p hub_port] [-c chip] [-i image_dir] [-- <extra flash.sh flags>]

Flashes the RT-Thread build over USB (start usb_dl, power-cycle the hub port,
retry until "USB download complete"). Defaults match the standard RTT setup:

  -p, --port    SmartUSBHub port to power-cycle   (default: $HUB_PORT)
  -c, --chip    board/chip passed to usb_dl -c    (default: $CHIP)
  -i, --image   firmware dir passed to usb_dl -i  (default: $IMAGE)
  -h, --help    show this help

Anything after '--' is forwarded verbatim to flash.sh (e.g. -r retries,
-t timeout, -w catch-timeout, -d usb_dl_dir). Env overrides: RTT_HUB_PORT,
RTT_CHIP, RTT_IMAGE, plus every env var flash.sh honours (USB_DL_SUDO_PASS,
USB_DL_MAX_RETRIES, RESET_SERIAL, SERIAL_PORT, ...).
EOF
}

EXTRA=()
while [ $# -gt 0 ]; do
  case "$1" in
    -p|--port)  HUB_PORT="$2"; shift 2;;
    -c|--chip)  CHIP="$2";     shift 2;;
    -i|--image) IMAGE="$2";    shift 2;;
    -h|--help)  usage; exit 0;;
    --)         shift; EXTRA=("$@"); break;;
    *) echo "[ERR] unknown argument: $1" >&2; usage; exit 2;;
  esac
done

# expand a leading ~ in the image path
IMAGE="${IMAGE/#\~/$HOME}"

# invoked via `bash "$FLASH_SH"`, so it only needs to be readable (usb-flash's
# flash.sh ships mode 644, no +x) — check -r, not -x.
[ -r "$FLASH_SH" ] || { echo "[ERR] flash.sh not found/readable at $FLASH_SH (need the usb-flash skill)" >&2; exit 1; }
[ -d "$IMAGE" ]    || { echo "[ERR] image dir not found: $IMAGE" >&2; exit 1; }

echo "[*] rtt-flash: port=$HUB_PORT chip=$CHIP image=$IMAGE"
exec bash "$FLASH_SH" -p "$HUB_PORT" -c "$CHIP" -i "$IMAGE" "${EXTRA[@]}"
