---
name: rtt-flash
description: Flash the RT-Thread (CVITEK cv181x) build to a board over USB — start usb_dl, then power-cycle SmartUSBHub port 3 (usbctl off 3 / on 3) so the board enumerates into usb_dl, retrying until "USB download complete". Use when asked to flash/burn/烧录 the RTT / rt-thread build, or mentions usb_dl -c cv181x with the cvi_rtt generated/image dir. 触发词：烧录rtt、烧录rt-thread、rtt烧录、flash rtt、usb_dl cv181x。
---

# rtt-flash

Automates the manual RT-Thread USB flashing steps into one retry loop.

The manual workflow being replaced:

```bash
sudo ./usb_dl -c cv181x -i ~/Public/rtt_master/rt-thread/cvi_rtt/generated/image/
usbctl off 3
usbctl on 3
```

## Why the order matters

The cv181x boot ROM only exposes a USB-download **device** for about **1 second
right after power-on**. So `usb_dl` MUST already be started and waiting on the
bus *before* the board powers on — you start `usb_dl`, then `usbctl off 3` /
`usbctl on 3` power-cycles the board so it enumerates straight into `usb_dl`'s
hands. If that ~1s window is missed, the only fix is to power-cycle again for a
fresh window. The driver handles this ordering and retries automatically.

## Run

```bash
bash ~/.claude/skills/rtt-flash/flash-rtt.sh
```

That uses the standard RTT defaults:

| param | default |
|---|---|
| hub port (`usbctl`) | `3` |
| chip (`usb_dl -c`) | `cv181x` |
| image (`usb_dl -i`) | `~/Public/rtt_master/rt-thread/cvi_rtt/generated/image/` |

Override any of them, e.g. a different board or a freshly built image dir:

```bash
bash ~/.claude/skills/rtt-flash/flash-rtt.sh -p 3 -c cv181x -i ~/usb_dl/rtt/
```

Forward extra flags to the underlying engine after `--` (retries, timeouts,
etc.):

```bash
bash ~/.claude/skills/rtt-flash/flash-rtt.sh -- -r 6 -w 10
```

## How it works

`flash-rtt.sh` pins the RTT defaults and delegates to the shared, well-tested
retry engine [`usb-flash/flash.sh`](../usb-flash/flash.sh), which:

1. `usbctl off <port>` — power the board off
2. starts `sudo ./usb_dl -c <chip> -i <image>` in the background so it is already
   waiting on the bus
3. `usbctl on <port>` — power on; the ROM opens its ~1s USB-download window
4. **catch phase** — fast-fails (~8s) and power-cycles again if `usb_dl` misses
   the window, instead of dead-waiting a long timeout
5. **transfer phase** — waits for `USB download complete` (success) or
   failure/timeout → retry (default up to 4 attempts)

It also power-cycles the UART on its own hub port first (serial re-plug) and
reaps stale `usbctl` processes that could hold the hub's control channel.

Report the final result: SUCCESS (with attempt count) or FAILED (with the log
tail). Exit code 0 = success, non-zero = failure.

## Prerequisites

- `usbctl` on PATH (`~/bin/usbctl`) and `./usb_dl` present in `~/usb_dl`
  (override the usb_dl dir with `-- -d <dir>`).
- Root for `usb_dl`: the engine reads the sudo password from `USB_DL_SUDO_PASS`
  (falls back to a value baked into `flash.sh`). Prefer passing it via env:
  `USB_DL_SUDO_PASS='...' bash ~/.claude/skills/rtt-flash/flash-rtt.sh`.
  Note: a plaintext password lives in `flash.sh` — consider NOPASSWD sudo for
  `usb_dl` instead.
