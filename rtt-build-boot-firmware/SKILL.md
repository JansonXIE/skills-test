---
name: rtt-build-boot-firmware
description: Build the boot0 / boot (mini-boot) / fip.bin firmware images for CVITEK CV18xx RT-Thread single-OS boards (cv181xc/cv1812h spinor). Use when asked to compile/rebuild/更新/编译 boot, boot0, or fip.bin for a cv181x/cv180x board, or after a boot-firmware flashing failure. Covers which image is what (boot0=FSBL, boot=mini-boot from cvi_rtt, fip=USB-flashing-session u-boot carrier), the per-board defconfig recipe, and the 4K-erase / RTT-flavor flashing traps. 触发词：编译boot、编译boot0、编译fip、更新固件、build boot firmware、rebuild fip.bin。
---

# rtt-build-boot-firmware

Builds the three boot-firmware images for CVITEK CV18xx boards running the
**RT-Thread single-OS** flow (cvi_rtt repo), using the SDK v4.1.0 boot tree
(`~/Public/rtt_boot_firmware`).

## ⚠️ What each image REALLY is (2026-09-01 verified, supersedes old notes)

The RT-Thread flash layout is **BOOT0 / BOOT / PRIM** — there is **no fip
partition on flash**. On-board boot chain:

```
flash@0x00000  boot0   = FSBL (DDR init + USB download). "ENABLE_BOOT0" flavor:
                         DDR init → read 0xc000 (128KB) to 0x8000c000 → jump_to_monitor
                         with opensbi-style handoff. Printed as "loadaddr_alios:0xc000".
flash@0x0c000  boot    = mini-boot (an RT-Thread app!), NOT cvirtos, NOT opensbi.
                         Built in the cvi_rtt repo: `make cv18xx_boot`.
                         It probes spinor ("spinor: ID = ..."), reads the CIMG/imtb at
                         PRIM@0x2c000, jumps to 0x80050000 (rtt.bin on big core).
flash@0x2c000  rtt.bin = the application (smart_doorbell etc.), built by cvi_rtt.
fip.bin        (RAM only!) Used ONLY inside the USB flashing session: usb_dl
                         feeds fip's bl2+opensbi+u-boot into RAM; that u-boot is
                         what actually erases/writes the three flash partitions.
                         Never lands on flash in this flow.
```

| image | built where | build command | deployed to |
|---|---|---|---|
| **boot0** | rtt_boot_firmware | `ENABLE_BOOT0=y` pass (driver.sh boot0) | `cvi_rtt/boards/<soc>/bootimgs/boot0` |
| **boot** (mini-boot) | **cvi_rtt** | `make cv18xx_boot` (board type in its rtconfig.h) | `cvi_rtt/boards/<soc>/bootimgs/boot` |
| **fip.bin** | rtt_boot_firmware | `ENABLE_RTT_UPDATE=y ENABLE_FREERTOS=n` pass | `cvi_rtt/tools/fip/<soc>/fip.bin` |

So "boot" in the RT-Thread flow is **not** `cvirtos.bin` — that old note applied
to the Linux/dual-OS flow only. If the BOOT partition holds cvirtos, the board
boots the small-core FreeRTOS and panics — that was the 8/31 cv1812h failure.

## Run — the driver

```bash
# boot0 (raw FSBL for the board's flash):
bash ~/.claude/skills/rtt-build-boot-firmware/driver.sh boot0

# fip.bin for USB flashing (RTT flavor):
bash ~/.claude/skills/rtt-build-boot-firmware/driver.sh fip

# both:
bash ~/.claude/skills/rtt-build-boot-firmware/driver.sh all

# another board:
BOARD=cv1810c_wevb_0006a_spinor bash ~/.claude/skills/rtt-build-boot-firmware/driver.sh fip
```

- The `fip` target already applies the correct RTT flavor
  (`ENABLE_FREERTOS=n ENABLE_RTT_UPDATE=y`) and refuses to produce a
  cvirtos-carrying fip (size check ≈410KB vs ≈491KB, plus string check).
- The `boot` target (standalone cvirtos.bin) is kept only for the legacy
  dual-OS flow; **do not put its output into bootimgs/boot**.
- Logs: `/tmp/build-boot-firmware/<target>.log` (override `LOG_DIR=`).

### mini-boot ("boot") — built in cvi_rtt, NOT here

```bash
cd cvi_rtt
# one-time: switch solutions/cv18xx_boot to the target board by editing BOTH
# solutions/cv18xx_boot/rtconfig.h AND .config (see gotcha below)
make cv18xx_boot                     # -> solutions/cv18xx_boot/generated/boot
cp solutions/cv18xx_boot/generated/boot boards/<soc>/bootimgs/boot
```

Board macros to set in both files (`solutions/cv18xx_boot/`):

| board | BOARD_TYPE_* | SOC_TYPE_* / arch macro |
|---|---|---|
| cv1810c_wevb_0006a_spinor | `BOARD_TYPE_CV1810C_WEVB_0006A_SPINOR` | `SOC_TYPE_CV181XC_QFN`, `__CV181X__` |
| cv1812h_wevb_0007a_spinor | `BOARD_TYPE_CV1812H_WEVB_0007A_SPINOR` | `SOC_TYPE_CV181XH_BGA`, `__CV181X__` |
| cv180zb_wevb_0008a_spinor | `BOARD_TYPE_CV180ZB_WEVB_0008A_SPINOR` | `SOC_TYPE_CV180XB_QFN`, `__CV180X__` |

**Gotcha:** `scons --genconfig` regenerates `.config` FROM `rtconfig.h`, so edit
`rtconfig.h` first (or both manually) — editing only `.config` gets reverted.

## Per-board boot-firmware matrix (all verified 2026-09-01)

| board | boot0 defconfig | fip defconfig + flavor | notes |
|---|---|---|---|
| **cv1810c/cv181xc** (cv181xc_qfn) | cv1810c_wevb_0006a_spinor, `ENABLE_BOOT0=y` | same defconfig, `ENABLE_RTT_UPDATE=y ENABLE_FREERTOS=n` (≈410KB) | factory boot0 (2025-07-30) also works; factory fip has no backup but the rebuilt one is equivalent |
| **cv1812h** (cv181xh_bga) | cv1812h_wevb_0007a_spinor, `ENABLE_BOOT0=y` (DDR3-1866) | same defconfig, RTT flavor — **requires USE_4K fix below** | DDR params are board-specific; never cross-flash |

**Never mix boards' firmware**: a cv1810c boot0 on cv1812h → `E:param1_cksum /
PARAM1 magic / Boot failed (8)` boot loop (fip-mode bl2 can't find param1, and
DDR params differ). A cv1812h fip on cv181xc (or vice versa) → usb_dl stalls in
the first fip-feeding stage (bl2 DDR mismatch, never enumerates).

## The three flashing traps (cost half a day on 2026-09-01 — read this first)

### 1. `USE_4K_ERASE_SIZE_FOR_JFFS2` must be set, or EVERY flash write silently fails

u-boot's `spi_nor_erase()` requires `len % erasesize == 0` and returns `-EINVAL`
otherwise; `_prgImage()` swallows the error, so **usb_dl reports
"USB download complete" / FLASH SUCCESS while nothing (or garbage) was written.**

- RT-Thread partition layout is NOT 64KB-aligned: BOOT0=48KB(0xc000),
  BOOT=128KB@0xc000, PRIM@0x2c000.
- cv1810c defconfig already has `CONFIG_USE_4K_ERASE_SIZE_FOR_JFFS2=y`
  (→ u-boot `CONFIG_SPI_FLASH_USE_4K_SECTORS=y`, erasesize=4KB, everything divides).
- **cv1812h defconfig did NOT** → 64KB erasesize → every erase failed.
- Fix: add `CONFIG_USE_4K_ERASE_SIZE_FOR_JFFS2=y` to
  `build/boards/cv181x/<board>/<board>_defconfig` (the SDK defconfig — NOT the
  u-boot sub-defconfig; `uboot_erasesize_set` in build/Makefile re-seds the
  u-boot `.config` from the SDK config and would revert a direct edit), then
  rebuild fip (`driver.sh fip`).

### 2. fip.bin must be RTT flavor (`ENABLE_RTT_UPDATE=y`, `ENABLE_FREERTOS=n`)

The non-RTT `do_cvi_update/_usb_update` only runs `sf probe` AFTER the utask
receive loop (i.e. never) → `_prgImage`'s `sf erase/write` all fail with "No SPI
flash selected" — again silently. The RTT flavor (`cvi_update_rtos.c` /
`#ifdef CONFIG_ENABLE_RTT_UPDATE` in cvi_update.c) probes BEFORE the loop.
The driver's `fip`/`all` targets apply this automatically. Quick check of a
built fip: `strings fip.bin | grep -c "CVIRTOS Build"` → 0 is correct;
a correct RTT fip is ≈410–412KB, a FREERTOS one ≈491KB.

### 3. Verify writes via the board's own prints (don't trust usb_dl "SUCCESS")

- FSBL banner timestamp (e.g. `FSBL Jb2829:ga8e8de0:2026-09-01T19:29:27`) must
  equal the boot0 build time — if it stays old, boot0 wasn't written.
- bl2's `image_buf:0x...` line = first 8 bytes read back from flash@0xc000.
  mini-boot header = `0x594b53430001a805` (05a80100+"CSKY"); old cvirtos =
  `0x...732540f1`. Use a "probe" boot (overwrite its first 8 bytes with a magic,
  flash, read image_buf) to prove the write path end-to-end.

## Prerequisites

- Toolchain via the repo's `host-tools` (`host-tools/gcc/riscv64-elf-x86_64` etc.).
- `cvi_mpi` middleware present only if you need the legacy cvirtos (`boot`)
  target; boot0 and RTT-flavor fip don't need it.

## Gotchas (build mechanics)

- **Never pipe `defconfig`/`setconfig`** — they are shell functions exporting
  OUTPUT_DIR etc. into the current shell; piping runs them in a subshell and the
  exports vanish → `Makefile:38 Please execute defconfig first`. The driver
  redirects with `>` and keeps defconfig+setconfig+build in one `bash -c`.
- **boot0 and fip are mutually exclusive per `build_uboot` pass**
  (`CONFIG_ENABLE_BOOT0` switches the fsbl output). `all` runs two passes.
- **A boot0 pass destroys an existing fip.bin** — `clean_uboot` runs
  `rm -f ${OUTPUT_DIR}/fip.bin`. The driver backs up and restores fip around
  the boot0 pass.
- After switching boards or configs, `rm -f
  u-boot-2021.10/build/<board>/.config` so the new defconfig is actually
  re-copied (cmp-based copy may otherwise keep the stale config).
- Benign noise: `Makefile:105 No configuration exists` on fresh trees; literal
  `-Werror` strings in gcc command lines. Trust `build_uboot exit: 0` plus the
  artifact size checks.

## Troubleshooting

| symptom | fix |
|---|---|
| usb_dl "FLASH SUCCESS" but board unchanged / `E:PARAM1 magic` boot loop | Trap 1: 4K erase config missing on that board's SDK defconfig → add `CONFIG_USE_4K_ERASE_SIZE_FOR_JFFS2=y`, rebuild fip, re-flash. |
| Board boots `RT: CVIRTOS Build Date...` then `E:RESET:panic` | BOOT partition holds cvirtos.bin (old mistake) → replace with mini-boot (`make cv18xx_boot`). |
| usb_dl stuck in first stage, never prints fip_tx_offset | fip's bl2 DDR params don't match the board → rebuild fip with the board's own defconfig. |
| `Please execute defconfig first` | you piped defconfig/setconfig — use the driver. |
| fip.bin vanished after building boot0 | expected; driver backs up/restores. Manual: rebuild fip. |
| mini-boot built for wrong board | `scons --genconfig` reverted your .config edit — set board macros in rtconfig.h (both files), rebuild. |
| Write-verify needed | check FSBL timestamp + `image_buf:` after reboot (see trap 3). |
