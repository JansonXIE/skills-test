---
name: port-flash
description: Bring up / port a new SPI NAND flash on the CVITEK/Sophgo 410 SDK from its datasheet PDF. Use when the user says "bringup flash", "port a flash", "add flash support", "移植 flash", "新焊了一颗 flash", provides a flash datasheet PDF, or wants to add a JEDEC ID to the u-boot/linux SPI NAND tables and set up NAND stress testing (auto.sh on /mnt/data).
---

# port-flash — SPI NAND bringup driver

Ports a new SPI NAND flash onto a CVITEK/Sophgo SDK (this is the **410** SDK,
chip family cv181x, e.g. board `cv1812ha_wevb_0007a_spinand`). The user hands
you a **datasheet PDF**; you decide the parameters and the driver does the
error-prone edits.

Detection is **runtime JEDEC-ID probing** (`0x9F` → `memcmp` against two ID
tables). Bringing up a flash = adding one entry to **each** table (u-boot for
SPL/boot/env, linux for rootfs/UBI). No board defconfig / dts / partition
change is needed **if** the part shares the board's geometry (2K page / 128K
block). The driver also wires a stress-test `auto.sh` onto `/mnt/data` so it
auto-runs at every boot.

**Paths below are relative to the SDK root** (the dir containing `build/`,
`u-boot-2021.10/`, `linux_5.10/`, `ramdisk/`). The driver auto-locates the
root; override with `SDK_ROOT=<path>` if you run it from elsewhere.

## The driver (agent path — start here)

Everything goes through one script: `.claude/skills/port-flash/driver.mjs`
(Node ≥ 18, no deps). It is idempotent — re-running never double-inserts.

```bash
# 0. prerequisite (pdftotext), one-time
sudo apt-get install -y poppler-utils

# 1. dump datasheet text + rough auto-guesses (guesses are UNRELIABLE — for orientation only)
node .claude/skills/port-flash/driver.mjs extract build/datasheet/<PART>.pdf

# 2. is this flash already supported? (exit 0 = yes, exit 2 = no)
node .claude/skills/port-flash/driver.mjs check --id 0x<MID>,0x<DID>

# 3. if NOT supported: write params.json (see field table), then insert into BOTH tables
node .claude/skills/port-flash/driver.mjs add --params /tmp/params.json

# 4. wire the stress-test auto.sh onto /mnt/data (committed + build hook)
node .claude/skills/port-flash/driver.mjs install-autosh --src .claude/skills/port-flash/templates/auto.sh

# 5. confirm the edits parse and the hook is in place
node .claude/skills/port-flash/driver.mjs verify --name <PART>
```

Then build & flash (needs the ARM toolchain — run on the build host):

```bash
source build/cvisetup.sh
defconfig cv1812ha_wevb_0007a_spinand
build_all
pack_prog_img 0x<DID><MID>        # nandid = 0x{DID}{MID}, e.g. 0x24b0
```

## Deciding the params (this is YOUR job, from the datasheet)

`extract`'s auto-guesses are regex heuristics and **often wrong** (it misreads
the manufacturer byte). Read the datasheet and the migration guide
`build/datasheet/Flash移植操作指南_v1.2.0.md` §3, then fill `params.json`.
Start from `.claude/skills/port-flash/templates/params.example.json`.

| field | where in datasheet | notes |
|---|---|---|
| `name` | part number | e.g. `"UM19A1HISW"` |
| `mid` | READ ID (9Fh) manufacturer byte | e.g. `"0xB0"` |
| `did` | READ ID device byte | e.g. `"0x24"`. `nandid` for pack = `0x{DID}{MID}` |
| `density` | array organization | `"512Mb"`/`"1Gb"`/`"2Gb"`/`"4Gb"` → chipsize macro |
| `pagesize` | page = main+spare | `"2K"` (2048+64/128) or `"4K"`. **4K needs board defconfig change too — see Gotchas** |
| `oobsize` | spare bytes/page | 64 (usually 1Gb) or 128 (usually 2Gb) |
| `ecc_bits` | ECC status field width (ECCSx bits) | **2 or 3** — count the ECCS bits, NOT the correction strength. Sets `ecc_status_mask` (`0x30` vs `0x70`) + remap table |
| `strength_ds` | ECC strength (bits/512B) | reported to MTD, e.g. 8 |
| `remap` | ECC status decode table | `"ECC_3bits_remap"` or `"ECC_2bits_remap"` (linux `cvsnfc_spi_ids.c`). Custom if the datasheet marks multiple ECCS codes uncorrectable — see Gotchas |
| `driver` | manufacturer | `spi_nand_driver_<X>`: `unim`(UNIM/UnilC), `gd`, `toshiba`, `general`… (guide §3.5) |

## What `add` writes (verified: gcc-compiles against the real structs)

- **u-boot** `u-boot-2021.10/drivers/mtd/nand/raw/cvitek/cvsnfc_spi_ids.c` —
  flat `struct cvsnfc_chip_info`, inserted before the `{ .id_len = 0, }` terminator.
- **linux** `linux_5.10/drivers/mtd/nand/raw/cvitek/cvsnfc_spi_ids.c` —
  nested struct (`nand_flash_dev` + `nand_ecc_info` + `.remap`), inserted before `{ NULL }`.

Both use tab indentation matching the surrounding table. `add` refuses to
double-insert (matches on `"name"`).

## What `install-autosh` does

`/mnt/data` (mtd DATA partition) is packed from `$OUTPUT_DIR/data/`, which
`pack_data()` otherwise seeds with only a `sample` file — so the script:
1. commits `auto.sh` to `ramdisk/rootfs/overlay/cv181x_64bit/data/auto.sh`
   (survives clean builds), and
2. injects a hook into `build/common_functions.sh` `pack_data()` that copies it
   into the DATA staging dir before `make data`.

At boot, `/etc/init.d/S99user` already auto-runs `/mnt/data/auto.sh` if present
(`. $USERDATAPATH/auto.sh &`), so no init change is needed. Override the chip
overlay dir with `CHIP=<overlay>` if not cv181x arm64.

## Gotchas (battle scars — most are non-obvious)

- **`extract` guesses lie.** On the real UM19A1HISW datasheet it reported
  `mid=0x32` (should be `0xB0`). Treat every guess as a hint; the ground truth
  is the READ-ID table in the datasheet.
- **`ecc_bits` is the STATUS-FIELD width, not the correction strength.** A part
  with 8-bit correction can have a **3-bit** ECCS status field. 3 bits →
  `ecc_status_mask=0x70` and an 8-entry `ECC_3bits_remap`; the common 2-bit
  default (`0x30`, 4-entry) silently mis-decodes it. This is the single most
  common bringup bug (guide §3.3.2).
- **Non-monotonic ECCS encoding.** If the datasheet's ECCS table marks *more
  than one* code as "uncorrectable" or the codes aren't in ascending
  correction order, the stock remap is wrong — you must add a custom
  `short ECC_<part>_remap[]` in linux `cvsnfc_spi_ids.c` and set `"remap"` to it.
- **chipsize unit trap.** u-boot chipsize is **bytes** (`_256M`=0x10000000);
  linux chipsize is the **MB number** (`SZ_256`=256). The driver handles this
  from `density` — don't hand-copy a numeric value between tables.
- **4K-page / non-default geometry needs MORE than the ID entry.** The driver
  only edits the ID tables. A 4K-page or different-block part also needs
  `CONFIG_NANDFLASH_PAGESIZE`/`BLOCKSIZE` in the **board defconfig** (which
  auto-switches the partition XML to `_page_4k`) and re-aligned partition
  sizes. `add` prints the geometry so you can catch this; guide §3.6.
- **Both tables or nothing.** u-boot sees it but linux doesn't (or vice-versa)
  = boots but rootfs fails, or the reverse. `check` reports each table
  separately; `supported` is the AND.
- **The last cvitek partition doesn't auto-grow.** `/mnt/data` is exactly the
  XML `size_in_kb`, not "rest of chip". For a stress test that covers the whole
  die, enlarge DATA in the partition XML (`boards/default/partition/
  partition_spinand_page_2k.xml`) — otherwise auto.sh only exercises a few MB.
- **auto.sh reads back through page cache.** The template does
  `echo 3 > /proc/sys/vm/drop_caches` between write and md5 re-read; without it
  you're checksumming RAM, not NAND, and a corrupt read passes.

## Troubleshooting

| symptom | fix |
|---|---|
| `pdftotext failed` | `apt-get install -y poppler-utils` |
| `SDK root not found` | run from inside the SDK tree, or `SDK_ROOT=<path> node driver.mjs …` |
| `check` says supported but boot still `unrecognized device id` | the DID byte is wrong — re-read READ-ID; also confirm you rebuilt (`build_uboot`) |
| `add` `anchor not found` | table terminator changed (`{ .id_len = 0, }` / `{ NULL }`) — SDK version drift; insert by hand |
| boot OK but `dmesg` spams ECC uncorrectable on good data | wrong `ecc_bits`/`remap` — see the ECCS gotchas above |
| `/mnt/data/auto.sh` absent after build | `pack_data` hook missing (`verify` shows `pack_data hook: absent`) — re-run `install-autosh`; confirm `CHIP` overlay matches your board |

## Verified in this container

`extract` (real UM19A1HISW.pdf), `check` (present + absent, exit codes), `add`
(insert + idempotent), and `install-autosh` (commit + hook + idempotent, `bash
-n` clean) were all run against the real tree / a sandbox copy. The generated
u-boot and linux entries were **compiled with gcc** against structs mirroring
`cvsnfc.h`/`cvsnfc_spi_ids.h` (oobsize reads back = 128 through the nested
init), and the `pack_data` hook was executed to confirm `auto.sh` lands
executable in the DATA staging dir. Not run here: `build_all` / on-device boot
(needs the ARM toolchain + hardware).
