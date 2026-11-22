---
name: port-nor-flash
description: Bring up / port / bringup a new SPI NOR flash on a CVITEK/Sophgo cv18x SDK (e.g. board cv1812h_wevb_0007a_spinor). Adds the JEDEC-ID entry to the u-boot + linux NOR tables and resizes the DATA partition to fill the die. Use when adding support for a NOR part like BY25FQ256ES, GD25, W25Q, MX25L, etc.
---

# port-nor-flash — SPI NOR flash bringup driver

Ports a new **SPI NOR** flash onto a CVITEK/Sophgo SDK (chip family cv181x/cv180x,
e.g. board `cv1812h_wevb_0007a_spinor`). Sibling of `port-flash` (which does SPI
**NAND**). You hand it a **datasheet PDF**; you decide the params from the READ-ID
(9Fh) table; the driver does the error-prone edits.

Detection is **runtime JEDEC-ID probing** (`0x9F` → 3-byte id matched against two ID
tables). Bringing up a NOR part = adding one entry to **each** table:
- **u-boot** `spi-nor-ids.c` (SPL/boot/env sees the flash), and
- **linux** `cvitek_support_list.c` (rootfs MTD).

No board defconfig / dts change is needed **if** the part is a standard uniform-64K-sector
NOR. A part **>16 MB** additionally needs 4-byte addressing (the driver sets this) and,
if you want `/mnt/data` to cover the whole die, a **DATA partition resize** (the driver
computes it — and this is where the one real footgun lives, see Gotchas).

**Paths below are relative to the SDK root** (the dir with `build/`, `u-boot-2021.10/`,
`linux_5.10/`). The driver auto-locates the root; override with `SDK_ROOT=<path>`.

## The driver (agent path — start here)

Everything goes through `~/.claude/skills/port-nor-flash/driver.mjs` (Node ≥ 18, no
deps). Idempotent — re-running never double-inserts. Every command below was run
against this SDK.

```bash
# 0. prerequisite (pdftotext), one-time
sudo apt-get install -y poppler-utils

# 1. dump datasheet text + rough guesses (guesses are UNRELIABLE — orientation only)
node ~/.claude/skills/port-nor-flash/driver.mjs extract ../datasheet/BY25FQ256ES_v1.4_QA-DT-033.pdf

# 2. already supported? (exit 0 = yes in BOTH tables, exit 2 = no)
node ~/.claude/skills/port-nor-flash/driver.mjs check --id 0x684019

# 3. if NOT supported: write params.json (see field table), insert into BOTH tables
node ~/.claude/skills/port-nor-flash/driver.mjs add --params /tmp/params.json

# 4. if the part is >16 MB and you want /mnt/data to fill the die: resize DATA
#    (dry-run first; add --write to apply). Board is the *_spinor board name.
node ~/.claude/skills/port-nor-flash/driver.mjs partition --board cv1812h_wevb_0007a_spinor --die-mb 32
node ~/.claude/skills/port-nor-flash/driver.mjs partition --board cv1812h_wevb_0007a_spinor --die-mb 32 --write

# 5. confirm both entries parse and the terminators survived
node ~/.claude/skills/port-nor-flash/driver.mjs verify --name BY25FQ256ES
```

Then build & flash — **downstream, needs the ARM/RISC-V toolchain + hardware, NOT run
in this container** (source of truth is the SDK, not this skill):

```bash
source build/cvisetup.sh
defconfig cv1812h_wevb_0007a_spinor
build_all
```

## Deciding the params (this is YOUR job, from the datasheet)

`extract` guesses are regex heuristics and often wrong — read the READ-ID (9Fh) table.
Start from `~/.claude/skills/port-nor-flash/templates/params.example.json`.

| field | where in datasheet | notes |
|---|---|---|
| `name` | part number | e.g. `"BY25FQ256ES"` |
| `jedec` | 9Fh READ-ID: `M7-M0`,`ID15-8`,`ID7-0` | concatenate the 3 bytes → `0x684019`. This is the single detection key. |
| `density` | capacity / array organization | `"64Mb"`/`"128Mb"`/`"256Mb"`/`"512Mb"`/`"1Gb"`. Sets n_sectors (`density_MB*1024/64`) and, if >16 MB, `SPI_NOR_4B_OPCODES`. |
| `fixups` | Status-Register / Quad-Enable description | which QE-bit routine: `sr_bit1_qe_fixups` (QE=SR2 bit1, most Boya/GD/Winbond), `sr1_bit6_qe_fixups`, `sr2_bit1_qe_fixups`, `no_qe_fixups`. Default `sr_bit1_qe_fixups`. |

The driver derives sector geometry (uniform 64 KB sectors, `SECT_4K` sub-sector) and
4-byte addressing from `density`. If the part is NOT uniform-64K, the ID entry is
wrong — stop and read guide/datasheet.

## What `add` writes (verified: gcc-compiles against the real macro arity)

- **u-boot** `u-boot-2021.10/drivers/mtd/spi/spi-nor-ids.c` — flat
  `{ INFO("name", 0xJEDEC, 0x0, 64 * 1024, N, SPI_NOR_QUAD_READ | SECT_4K [| SPI_NOR_4B_OPCODES]) },`
  inserted before the `{ },` terminator.
- **linux** `linux_5.10/drivers/mtd/spi-nor/cvitek_support_list.c` — positional-name +
  `CVI_INFO(0xJEDEC, 0x0, 64 * 1024, N, 0, 0, SECT_4K | SPI_NOR_DUAL_READ | SPI_NOR_QUAD_OP [| SPI_NOR_4B_OPCODES]) .fixups = &<fixups>`
  inserted before the `{}` terminator.

Both use tab indentation matching the table. `add` refuses to double-insert (matches on `"name"`).

## What `partition` does

`/mnt/data` (the last cvitek partition) is **exactly** its XML `size_in_kb` — it does
not auto-grow to the rest of the die. `partition` reads
`build/boards/<soc>/<board>/partition/partition_spinor.xml`, sums every non-DATA
partition, and sets `DATA = die_KB − sum` (64 KB-aligned) so the layout fills the flash
exactly, ending at the die boundary. Dry-run by default; `--write` applies.

## Gotchas (battle scars — most are non-obvious)

- **`extract` guesses lie.** On the real BY25FQ256ES datasheet the `hex_bytes_near_id`
  were page-number artifacts (`15 17 19`), not the ID. Ground truth is the 9Fh table:
  `M7-M0=68, ID15-8=40, ID7-0=19` → `0x684019` (NOT `0x684919`, which is the *different*
  part BY25Q256FS already in the table).
- **The ROOTFS-auto-grow → DATA-overflow trap (the actual bringup failure).** The build
  **rewrites `ROOTFS size_in_kb` in place** to fit the real rootfs image. So if you size
  DATA to fill the die *before* a build, the post-build ROOTFS is larger, DATA's start
  shifts up, and DATA runs off the end of the die → u-boot flashing dies with
  `attempting erase past flash size (0x2000000)` / `Size exceeds partition or device
  limit`. **Run `partition` AFTER a build** (so the ROOTFS size in the XML is final),
  then rebuild. If a later build regrows ROOTFS again, re-run `partition` and shrink DATA.
- **>16 MB ⇒ 4-byte addressing is mandatory.** A 256 Mb (32 MB) part needs
  `SPI_NOR_4B_OPCODES` in *both* tables or reads above 16 MB return garbage. The driver
  sets it automatically from `density`; a hand-written entry that omits it boots but
  corrupts the upper half.
- **fsbl/BL2 needs NO change.** BL2 reads only the `fip` partition (first ~1 MB, inside
  the 3-byte-address window) with generic read commands + FIP-supplied timing — it has no
  per-part ID table. Don't go looking for a NOR ID list in `fsbl/`.
- **Both tables or nothing.** u-boot-only = boots but rootfs MTD unrecognized; linux-only
  = SPL can't load. `check` reports each table separately; `supported` is the AND.
- **`jedec` is the whole 3-byte id, not just the manufacturer.** `check --id` and the
  entry both key on all 3 bytes; a right-manufacturer/wrong-capacity part won't match.
- **`config.json` `board_information` is cosmetic.** It may say "SPINOR 16MB" on a 32 MB
  build — the real size comes from the runtime 9Fh probe. Update it for humans, but it
  changes nothing functional.

## Troubleshooting

| symptom | fix |
|---|---|
| `pdftotext failed` | `apt-get install -y poppler-utils` |
| `SDK root not found` | run from inside the SDK tree, or `SDK_ROOT=<path> node driver.mjs …` |
| flashing: `attempting erase past flash size` / `Size exceeds partition` | DATA overflows the die — the ROOTFS-auto-grow trap. Re-run `partition` after a build, `--write`, rebuild. |
| boot: `unrecognized` / wrong size | `jedec` wrong (re-read 9Fh) or you rebuilt only one of u-boot/linux |
| reads above 16 MB corrupt on a >16 MB part | `SPI_NOR_4B_OPCODES` missing — re-run `add` (it sets it from `density`) |
| `add` `anchor not found` | table terminator changed (`{ },` / `{}`) — SDK drift; insert by hand |
| `partition` `partitions already exceed the die` | a non-DATA partition is too big for `--die-mb`; shrink it first |

## Verified in this container

`extract` (real BY25FQ256ES.pdf → correct 256Mb density guess), `check` (present exit 0,
absent exit 2), `add` (sandbox insert of a 4-byte and a non-4-byte part + idempotent
re-run; generated u-boot + linux entries **gcc-compiled** against mock structs mirroring
the real `INFO`/`CVI_INFO` macro arity), `partition` (dry-run reproduced the hand-derived
DATA=19264 KB fill for the real board; `--write` filled a sandbox 16 MB die exactly to
16384 KB; no-op safe on the already-correct real board), and `verify` (present + broken-
terminator detection, exit codes) were all run. **Not run here:** `build_all` / on-device
flash + boot (needs the ARM/RISC-V toolchain + hardware). The BY25FQ256ES entry itself is
already live in this tree's tables (added during the bringup this skill was distilled from).
