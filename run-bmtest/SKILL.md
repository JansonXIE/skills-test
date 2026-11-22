---
name: run-bmtest
description: Build, flash, and verify the Mars3 bmtest bare-metal firmware on the cv1842cp dev board. Use when asked to build bmtest, compile/pack fip.bin, flash/burn/烧录 bmtest to the board, run the TPU (or other) testcase on hardware, or check whether bmtest passes on the board. Drives build_tpu.sh -> build_fsbl -> usb_dl -> serial console (uart_agent.py).
---

# run-bmtest

`bmtest` is a bare-metal test firmware (`~/Public/cvi_bmtest/mars3`). It is
packed as the **BL31/monitor** slot of `fip.bin` (built in
`~/Public/mars3_repo`), RAM-booted onto the cv1842cp board over USB by
`usb_dl`, and it prints its results (`... PASS` / `... FAIL`) straight to the
serial console. There is **no GUI and no OS** — the "app" is the console
output, so the driver drives it by capturing `/dev/ttyUSB1` while `usb_dl`
downloads.

All paths below are relative to the **cvi_bmtest repo root**
(`~/Public/cvi_bmtest`). The driver is
[.claude/skills/run-bmtest/driver.sh](driver.sh).

## Run (agent path) — the driver

The driver does the whole loop. Prefer it over the manual steps.

```bash
# full loop: build bmtest.bin -> pack fip.bin -> flash + verify on board
bash .claude/skills/run-bmtest/driver.sh all
```

Individual stages (each is idempotent):

```bash
bash .claude/skills/run-bmtest/driver.sh build   # -> mars3/out/bmtest.bin
bash .claude/skills/run-bmtest/driver.sh fip     # -> install/.../fip.bin
bash .claude/skills/run-bmtest/driver.sh flash   # download + capture console + PASS/FAIL check
```

Success looks like (verified this container, 2026-08-13):

```
[driver] SUCCESS: bmtest ran, 12 PASS / 0 FAIL
```

The `flash` step often takes a couple of attempts — `usb_dl` misses the
board's ~1s ROM download window, the driver fast-fails after `CATCH_SECONDS`
and power-cycles again. That's expected; a run typically catches on attempt 1
or 2.

The driver **fails loudly** (non-zero exit) if bmtest never boots, if any
`FAIL` line appears, or if zero `PASS` lines are captured. The full console
capture is saved to `/home/jianxingxie/Public/cvi_bmtest/log/bmtest_console.log`; `usb_dl`'s own log to
`/tmp/bmtest_usbdl.log`.

### Knobs (env vars, defaults match this machine)

| var | default | meaning |
|---|---|---|
| `BUILD_ARGS` | *(empty)* | passed to `build_tpu.sh`, e.g. `"asic 2"` for a single case, `"pld"` for SRAM |
| `HUB_PORT` | `2` | SmartUSBHub port powering the board |
| `CONSOLE` | `/dev/ttyUSB1` | **board console — NOT ttyUSB0** (see Gotchas) |
| `CHIP` | `cv184x` | `usb_dl -c` value |
| `BOARD` | `cv1842cp_wevb_0015a_spinor` | mars3_repo defconfig |
| `FLASH_RETRIES` | `6` | usb_dl is flaky; retry download+boot this many times |
| `CATCH_SECONDS` | `20` | fast-fail a retry if no banner within this (banner lands ~13s after power-on) |
| `PER_ATTEMPT_SECONDS` | `45` | total console-capture window once caught |
| `USB_DL_SUDO_PASS` | *(baked-in)* | sudo password for `usb_dl` |

To flash a *different* testcase, build it first then flash:

```bash
BUILD_ARGS="asic 2" bash .claude/skills/run-bmtest/driver.sh build
bash .claude/skills/run-bmtest/driver.sh fip
bash .claude/skills/run-bmtest/driver.sh flash
```

## Prerequisites

Toolchain (`~/Public/host-tools`), `usb_dl` (`~/usb_dl/usb_dl`), `usbctl` (on
`PATH`), and `uart_agent.py` (`~/Public/mars3_repo`) are already present on
this machine. No `apt-get` was needed. The board and SmartUSBHub must be
plugged in — check with `usbctl status` (port 2 is the board).

## Build (what the driver runs, for reference)

```bash
# 1. bmtest.bin (default = ASIC/EVB + DDR, TEST_CASE=tpu)
cd ~/Public/cvi_bmtest/mars3 && ./build_scripts/build_tpu.sh

# 2. pack it into fip.bin — MUST be one un-piped shell (see Gotchas)
cd ~/Public/mars3_repo
source build/envsetup_soc.sh
defconfig cv1842cp_wevb_0015a_spinor
build_fsbl
# -> install/soc_cv1842cp_wevb_0015a_spinor/fip.bin
```

The link from bmtest to fip is hardcoded in
`~/Public/mars3_repo/fsbl/make_helpers/fip.mk:14`
(`MONITOR_PATH = .../cvi_bmtest/mars3/out/bmtest.bin`). `build_fsbl` reads
`bmtest.bin` from there, so step 1 must run before step 2.

## Gotchas (the non-obvious traps, all hit this session)

- **Console is `/dev/ttyUSB1`, not `ttyUSB0`.** `ttyUSB0` is silent for the
  boot/bmtest log (`uart_agent.py` defaults to it and captures 0 bytes). The
  boot + bmtest output only comes out on `ttyUSB1`.
- **Start the console capture BEFORE powering the board on.** `usb_dl`
  RAM-boots the fip the instant the download finishes, so bmtest prints
  *during* the download. Attach the monitor first (the driver does), or the
  PASS lines are already gone.
- **The success signal is the `bmtest` banner, not "USB download complete".**
  For cv184x in this RAM-boot flow, `usb_dl` often ends with
  `[INFO] usb device not found` / `LIBUSB_ERROR_IO` and never prints
  `USB download complete` — even on a run where bmtest actually boots and
  passes. So the generic `usb-flash` skill's success regex fails here; this
  driver instead greps the console for `bmtest` + `PASS`.
- **`usb_dl` is genuinely flaky.** Individual downloads intermittently die
  mid-transfer (`LIBUSB_ERROR_IO` / `LIBUSB_ERROR_NO_DEVICE(-4)`). The driver
  retries the whole power-cycle+download up to `FLASH_RETRIES` times until the
  console shows bmtest.
- **Never pipe `defconfig`.** `defconfig` exports `OUTPUT_DIR` into the current
  shell; `defconfig ... | tee` runs it in a subshell, the export is lost, and
  `build_fsbl` then dies with `Please execute defconfig/menuconfig/oldconfig
  first`. The driver runs it un-piped and redirects to files.
- **Don't `set -u` around `source build/envsetup_soc.sh`.** The kconfig helper
  functions reference unset vars, so nounset makes the `source` bail before
  `defconfig` is even defined (`defconfig: command not found`). The driver
  drops `set -u` for the env phase.
- **Sourcing envsetup clobbers `CHIP` and `BOARD`.** `source
  envsetup_soc.sh` + `defconfig` overwrite any shell vars named `CHIP`
  (→ `cv1842cp`) and `BOARD` (→ `wevb_0015a_spinor`). If you build fip and
  then flash in the *same* shell, the flash runs `usb_dl -c cv1842cp`
  (invalid) → `[ERR] no chip specified by -c or fip!!!` and every attempt
  misses. The driver runs the whole fip/env phase in a **subshell** so those
  mutations never leak into the flash step. If you script this by hand, isolate
  the env sourcing the same way (or re-set `CHIP=cv184x` before flashing).

## Troubleshooting

| symptom | fix |
|---|---|
| `no 'bmtest' banner after N attempts` | board not on port 2 / not powered → `usbctl status`; or bump `FLASH_RETRIES`. Check `/tmp/bmtest_usbdl.log` for `LIBUSB_ERROR_IO`. |
| capture is 0 bytes | wrong console — must be `CONSOLE=/dev/ttyUSB1`. |
| only a few PASS captured, no coverage-note tail | raise `PER_ATTEMPT_SECONDS` — the window closed before the run finished. |
| `defconfig failed` / `command not found` | you piped `defconfig`, or ran it under `set -u`. Use the driver, or run `source`+`defconfig`+`build_fsbl` in one plain shell. |
| `usb_dl` logs `no chip specified by -c or fip!!!` | you sourced envsetup in the same shell as the flash → `CHIP` got clobbered to `cv1842cp`. Use the driver (it subshells the env phase) or re-set `CHIP=cv184x` before flashing. |
| `build_fsbl` says "execute defconfig first" | `OUTPUT_DIR` was lost to a subshell — same cause as above. |

A trimmed known-good console capture is saved at
[sample-success.log](sample-success.log) for comparison.
