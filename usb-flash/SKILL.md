---
name: usb-flash
description: Flash firmware to a board over USB by power-cycling a SmartUSBHub port and running usb_dl, retrying until "USB download complete". Use when the user asks to flash/burn/烧录 a board, mentions usbctl + usb_dl, a hub port, a chip type (-c, e.g. cv184x / cv190x), and a firmware path (-i). Known presets: cv190x (Phobos3 / p3 / cv1900b wevb; hub port + UART given per request), cv184x (mars3).
---

# USB Flash

Automates the manual two-terminal flashing workflow into one retry loop.

## Inputs you need from the user

- **Hub port** — the SmartUSBHub port to power-cycle (e.g. `3`). 0-based.
- **Chip / board** — passed to `usb_dl -c` (e.g. `cv184x`).
- **Firmware path** — passed to `usb_dl -i` (e.g. `~/usb_dl/mars3/`).

If any are missing, ask before running.

## Why the order matters

The chip's boot ROM only exposes a USB-download **device** for about **1 second
right after power-on** — that is the only window in which `usb_dl` can grab the
board. So `usb_dl` MUST already be started and waiting while the board is
powered **off**, then the board is powered **on** a moment later so it
enumerates straight into `usb_dl`'s hands. The script handles this ordering:

1. `usbctl off <port>` — power off
2. start `sudo ./usb_dl -c <chip> -i <fw>` (background, logging to a temp file)
   so it is already waiting on the bus
3. `usbctl on <port>` — power on; the ROM opens its ~1s USB-download window
4. **catch phase**: within `-w` seconds (catch-timeout, default 8s) check
   whether `usb_dl` grabbed the device — signalled by the log starting to
   produce output (primary) or `lsusb` seeing the Cvitek device (secondary).
   If the window is missed, abort this attempt immediately and power-cycle
   again to create a fresh window (instead of waiting out the full timeout).
5. **transfer phase**: once grabbed, wait for `USB download complete` = success,
   `USB download failed` / `-t` timeout = failure → retry (up to `-r`).


## How to run it

Run the helper script with the user's values:

```bash
~/.claude/skills/usb-flash/flash.sh -p <port> -c <chip> -i <firmware_path>
```

Example matching the user's usual command:

```bash
~/.claude/skills/usb-flash/flash.sh -p 3 -c cv184x -i ~/usb_dl/mars3/
```

## Known board presets

Use these exact values unless the user overrides them.

### cv190x (Phobos3 / p3 / cv1900b wevb, spinor)

SDK root: `/home/jianxingxie/Public/p3_sdk`. Default board defconfig:
`cv1900b_wevb_0019a_spinor` (RISC-V, musl, 8MB SPI NOR; little core = RT-Thread,
packed into `fip.bin`).

**Hub port and UART are NOT fixed for Phobos3** — the user states both each
time. Use the values from the current request; if either is missing, ask (do
not reuse an old value or scan `/dev/ttyUSB*`). Current wiring for reference
only (may change): hub port `0`, Linux console `/dev/ttyUSB4`.

Manual equivalent (what the script automates):

```bash
cd ~/usb_dl
sudo ./usb_dl -c cv190x -i /home/jianxingxie/Public/p3_sdk/install/soc_cv1900b_wevb_0019a_spinor/
# while usb_dl is waiting, in another terminal: usbctl off <port>; usbctl on <port>
```

The `~/usb_dl/usb_dl` binary already supports `-c cv190x`, so the default
`-d ~/usb_dl` is correct.

| field | value |
|---|---|
| chip (`-c`) | `cv190x` |
| hub port (`-p`) | **from the user each time** (currently `0`) |
| firmware (`-i`) | `/home/jianxingxie/Public/p3_sdk/install/soc_cv1900b_wevb_0019a_spinor/` |
| usb_dl dir (`-d`) | `~/usb_dl` (default) |
| Linux console UART | **from the user each time** (currently `/dev/ttyUSB4`) → `SERIAL_DEV=` here, `--dev` / `MARS3_UART_DEV=` for uart_agent.py |
| serial re-plug | set `SERIAL_PORT=<uart hub port>` if known, otherwise `RESET_SERIAL=0`; auto-skipped when `SERIAL_PORT` equals `-p` |

```bash
SERIAL_DEV=<uart> ~/.claude/skills/usb-flash/flash.sh -p <port> -c cv190x \
  -i /home/jianxingxie/Public/p3_sdk/install/soc_cv1900b_wevb_0019a_spinor/
# e.g. with the current wiring:
SERIAL_DEV=/dev/ttyUSB4 ~/.claude/skills/usb-flash/flash.sh -p 0 -c cv190x \
  -i /home/jianxingxie/Public/p3_sdk/install/soc_cv1900b_wevb_0019a_spinor/
```

Note: `flash.sh` defaults `SERIAL_PORT=0` / `SERIAL_DEV=/dev/ttyUSB0` (mars3
wiring). With the P3 board on hub port 0 the re-plug step is skipped
automatically, so it neither double-cycles the board nor waits on `/dev/ttyUSB0`.

The firmware path is the p3_sdk `install/soc_<board>/` output dir; if a
different board is built (e.g. `cv1900b_wevb_0019a_emmc`, `cv1901c_wevb_0018a_spinor`),
point `-i` at that dir instead. Always pass an **absolute** path — `usb_dl` runs
from `~/usb_dl`, so a relative `install/...` fails with
`unable to open ... fip.bin` / `scandir: No such file or directory`.

Phobos3 end-to-end steps:

1. **Build** (from the p3_sdk root, in one shell):
   `bash -c "source build/envsetup_soc.sh && defconfig cv1900b_wevb_0019a_spinor && build_all"`
   (use `clean_all && build_all` after switching board / partition / memmap / Kconfig).
2. **Check the install dir** contains the images usb_dl needs:
   `ls /home/jianxingxie/Public/p3_sdk/install/soc_cv1900b_wevb_0019a_spinor/`
   should list `fip.bin`, `fip_spl.bin`, `boot.spinor`, `rootfs.spinor`,
   `data.spinor`, `partition_spinor.xml`.
3. **Flash** (wrap in the board lock if other agents share the board):
   ```bash
   ~/.claude/skills/parallel-dev-setup/board-lock.sh -- \
     env SERIAL_DEV=<uart> ~/.claude/skills/usb-flash/flash.sh -p <port> -c cv190x \
       -i /home/jianxingxie/Public/p3_sdk/install/soc_cv1900b_wevb_0019a_spinor/
   ```
4. **Confirm boot** on the user-given Linux console UART (uart_agent.py
   defaults to `/dev/ttyUSB0`, which is NOT the P3 console — always pass `--dev`):
   `python3 /home/jianxingxie/Public/p3_sdk/uart_agent.py expect --dev <uart> "login:|# " --timeout 60`
   then e.g. `python3 /home/jianxingxie/Public/p3_sdk/uart_agent.py exec --dev <uart> "uname -a"`.

### cv184x (mars3 / cv1842cp wevb, spinor)

| field | value |
|---|---|
| chip (`-c`) | `cv184x` |
| hub port (`-p`) | `2` |
| board defconfig | `cv1842cp_wevb_0015a_spinor` |
| firmware (`-i`) | `/home/jianxingxie/Public/mars3_repo/install/soc_cv1842cp_wevb_0015a_spinor/` |
| big-core UART | `/dev/ttyUSB0` (Linux console) |
| little-core UART | `/dev/ttyUSB1` (AliOS Things / YoC CLI, prompt `ME(cli-uart)#`) |

```bash
~/.claude/skills/usb-flash/flash.sh -p 2 -c cv184x \
  -i /home/jianxingxie/Public/mars3_repo/install/soc_cv1842cp_wevb_0015a_spinor/
```

Device PIDs (do not confuse): `3346:1000` = ROM USB-download/Com-Port device
(what `usb_dl -r` scans for, only ~1s after power-on); `3346:0001` = a booted
Linux board's UVC camera gadget (class Video), NOT download mode. udev rules at
`/etc/udev/rules.d/99-mars3-dev.rules` map CVITEK `3346:*` + FTDI `0403:6001`
to plugdev, so usb_dl and uart_agent.py run without sudo. `usbctl` needs pyserial
(`python3 -m pip install pyserial colorlog` if "No module named serial").

Optional flags: `-r <retries>` (default 4), `-t <timeout_seconds>` (hard cap once
the transfer started, default 60), `-w <catch_timeout_seconds>` (how long after
power-on to catch the ~1s ROM window before fast-failing, default 8),
`-d <usb_dl_dir>` (default `~/usb_dl`).

Because a missed power-on window now fast-fails in ~8s instead of waiting out a
long timeout, the worst case is roughly `retries × (catch + cycle) ≈ under 1
minute`, rather than several minutes of dead waiting.

Report the final result to the user: SUCCESS (with attempt count) or FAILED
(with the tail of the log). Exit code 0 = success, non-zero = failure.

## sudo password

The script needs root for `usb_dl`. It reads the password from the
`USB_DL_SUDO_PASS` env var, defaulting to the user's known password baked into
the script. Prefer passing it via env to avoid running with a hardcoded secret:

```bash
USB_DL_SUDO_PASS='...' ~/.claude/skills/usb-flash/flash.sh -p 3 -c cv184x -i ~/usb_dl/mars3/
```

Note: a plaintext sudo password lives in `flash.sh`. This is convenient but a
security risk — anyone with read access to the file can see it. Consider
configuring passwordless sudo for `usb_dl` (NOPASSWD in sudoers) instead.
