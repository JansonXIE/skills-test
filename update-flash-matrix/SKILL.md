---
name: update-flash-matrix
description: "更新 CVITEK SDK Flash 支持列表汇总.html：先 fetch 410/420/Mars3 六份 u-boot-2021.10 与 linux_5.10 仓库到远程最新，再从 NOR/NAND 的 bringup support_list 解析 flash 型号，重新生成汇总表格与统计。Use when: 更新 flash 支持列表, 刷新 Flash 汇总 html, 汇总新增 nor/nand flash, 有新 flash 合入了把汇总表更新一下, update flash matrix, 同步 SDK 代码后更新支持列表。触发词: flash 支持列表, flash 汇总, 支持列表汇总, update-flash-matrix"
argument-hint: "（无参数）直接运行即可；可选 `report` 先看各 SDK 款数与变更，`build` 只重新生成不 fetch"
user-invocable: true
---

# update-flash-matrix — 刷新 SDK Flash 支持列表汇总

把 `/media/cvitek/jianxing.xie/device/CVITEK_SDK_Flash支持列表汇总.html` 更新到
三套 SDK 的最新 flash 支持状态。

这个技能只做两件事：**拉最新代码** → **重算表格**。NOR / NAND 表格里的每一行都是从源码解析出来的，
没有手工维护的数据；**eMMC 是例外**——它没有 support_list 源码，型号放在技能目录的
`emmc.json` 里人工维护（要新增 eMMC 就改这个文件，然后跑一次 `build`）。

## 涉及的文件

| SDK | 代码路径 | 跟踪分支 |
|---|---|---|
| 410 (CV181x) | `/media/cvitek/jianxing.xie/device/410` | `v4.1.0` |
| 420 (CV180x) | `/media/cvitek/jianxing.xie/device/420_2` | `v4.2.0` |
| Mars3 | `/media/cvitek/jianxing.xie/device/mars3_repo` | `master` |

每个 SDK 下取 4 个 support_list（6 个仓库 × 2 个文件）：

```
<sdk>/u-boot-2021.10/drivers/mtd/spi/spi-nor-ids.c              ← NOR, U-Boot
<sdk>/linux_5.10/drivers/mtd/spi/spi-nor/cvitek_support_list.c  ← NOR, Linux
<sdk>/u-boot-2021.10/drivers/mtd/nand/raw/cvitek/cvsnfc_spi_ids.c ← NAND, U-Boot
<sdk>/linux_5.10/drivers/mtd/nand/raw/cvitek/cvsnfc_spi_ids.c     ← NAND, Linux
```

注意 linux NOR 列表在 **`spi-nor/`**（带横线），不是 `spi/nor/`。

## Agent 执行路径（从这里开始）

```bash
DRV=~/.claude/skills/update-flash-matrix/driver.mjs
```

### 1. 拉取最新代码

```bash
node "$DRV" fetch
```

对 6 个仓库分别 `git fetch origin +refs/heads/<branch>:refs/remotes/origin/<branch>`，
然后打印每个仓库的 `behind / ahead`。

**默认不动工作区**——只更新 `origin/<branch>` 远程引用，解析全部走
`git show origin/<branch>:<file>`，所以你当前检出的代码原样不动。

如果确实要把工作区也切到最新（会 detach HEAD）：

```bash
node "$DRV" fetch --update-checkout
```

有**本地未推送提交**的仓库会在切换前自动 `format-patch` 存到 `/tmp/flashlocal-*/`，
然后才 reset —— 万一丢了可从 patch 恢复。若想保留本地提交改为 rebase 上去，加 `--keep-local`。

### 2. 看变更（先看再写）

```bash
node "$DRV" report
```

打印各 SDK 的 NOR/NAND 款数（`U / L / 并集`），以及与上一次 `build` 相比
新增/删除了哪些型号。**先跑这个**，确认变更符合预期（比如刚合入的那颗 flash 确实出现了）
再执行 build。

### 3. 重新生成 HTML

```bash
node "$DRV" build
```

就地更新 `/media/cvitek/jianxing.xie/device/CVITEK_SDK_Flash支持列表汇总.html`，
并打印本次新增的 flash。会用 `--out <file>` 指定其他输出路径。

### 4. 看一眼渲染结果

```bash
node "$DRV" render                    # → /tmp/flash-matrix.png
```

也可以指定输入/输出和尺寸（位置参数，**不是** `--` 选项）：

```bash
node "$DRV" render <html> <out.png> <宽> <高>
```

截图后再 Read 那个 png 确认没渲染坏。改完 HTML 一定要看，不要只信 diff。

## 生成器会改哪些部分

`build` 是**就地手术式替换**，不是整篇重写。它保留你手写的所有散文、图例、
样式和脚本，只重算这几块：

- `.caps-row` 里的三张概览卡（各 SDK 的款数；eMMC 行固定显示 `emmc.json` 的条目数）
- `#ch2` 的 NOR 表格与标题里的「并集 N 款」
- `#ch3` 的 NAND 表格与标题里的「并集 N 款」
- `#ch4` 的 eMMC 表格（从 `emmc.json` 渲染；改完 json 跑 `build` 即生效）
- `#ch5-1` / `#ch5-2` 的独有型号差异
- `#ch5-2` 下方那条 `.note` 里「最近新增」的型号名
- `<title>` / `<h1>` / 第一章导语 / §1.1 图例 —— eMMC 加入后的措辞由驱动统一维护

「最近新增」的名字取自**这四个 support_list 文件的 git log**（近 20 条提交的
subject 里抽型号），不是 `state.json` 的差集 —— 后者只记得「本驱动上次运行时
是什么」，第一次跑会把全表几百个型号都当成新增。

写回前会跑一遍结构校验（`validate()`）：caps-row 是否闭合、每个 nav 锚点是否
都有对应 heading、有没有残留 `{{占位符}}`、三张表是否都在、`#ch4`（eMMC）与
`#ch5`（差异）标题是否恰有一处、**footer / §1.1 图例 / `#gen-date-2` /
`#main-content` 闭合是否各还恰有一处**。任一条不过就拒绝写文件。

`build` 是幂等的：同一份输入连跑两次，输出 md5 相同。

## 数据是怎么算出来的

- **NOR 容量** = `sector_size × n_sectors`（源码里写作 `64 * 1024`）。
- **NAND 容量** = `chipsize`，U-Boot 写作 `_128M`，Linux 写作 `SZ_128`，都是字节数。
- **注释掉的条目不算支持**：解析前会先剥掉 `//` 整行注释和行尾注释。这一条很关键——
  第一版就是把 `KH25L12833FM2I`（三套 SDK 里都是注释状态）当成支持项写进了表里。
- **U / L 三态**：`U/L` = U-Boot 与 Linux 都有；`U` = 只有 U-Boot；`L` = 只有 Linux。
- **同款不同名**：`FM25W128` vs `FM25W128A`、`W25N01GVxxIG` vs `W25N01GV`、
  `XT26G12D` vs `XT26G12D-X/-B` 等，U-Boot 与 Linux 写法不同。表里按源码原名各列一行，
  所以会出现同厂商相邻两行、一行 `U` 一行 `L` —— 这是**真实差异**，不是 bug。

## Gotchas

- **linux NOR 路径是 `spi-nor/`**，`spi/nor/` 不存在。路径写错时 `git show` 直接报
  `does not exist in 'origin/v4.1.0'`，不会静默给空表。
- **`replaceCapsRow` 不能用 `/<div class="caps-row">[\s\S]*?<\/div>/`**。非贪婪匹配会在
  第一个 `.caps-node` 的 `</div>` 就收尾，把后面两张卡留成孤儿 `</div>`，
  整页 flex 布局崩掉。必须按 div 层数扫描。切片时要停在匹配的 `</div>` **起始位置**，
  切过它就把 row 的闭合标签吃掉了 —— 这个 bug 犯过一次，现在 `validate()` 会拦住。
- **改章节的正则的终止锚点要覆盖到「最后一个章节」**。`#ch4-2` 是全篇最后一节，
  后面跟着 `.note` 和 `.footer`。终止 lookahead 只写 `<h2 id=` 或
  `</div><!-- /main-content -->` 会一路吃到文档末尾，把 note 和 footer 一起删掉——
  文件变小 1.4KB 但 HTML 仍然「合法」，字节数合理性检查发现不了。现在终止锚点
  带上 `\n<div class="note">`，并且 `validate()` 会数 footer 的个数。
- **替换 `.note` 一定要锚定到具体章节**。文档里有两条 `.note`：第一条在 §1.1 是
  手写的图例说明，第二条在 §4.2 才是「最近新增」。用裸的 `/<div class="note">/`
  会改到第一条，把图例说明覆盖成一大串型号名。要写成
  `/(<h3 id="ch4-2">[\s\S]*?<\/h3>[\s\S]*?<div class="note">)[\s\S]*?(<\/div>)/`。
- **`report` 的数字来自 `origin/<branch>`**，所以必须先 `fetch`；不 fetch 看到的是上次的缓存。
- **不要用 `grep | paste - -` 抽 NAND 条目**——`.name` 和 `.chipsize` 之间隔了十几行，
  会错位串行。用 driver 里的正则。
- 410 的两份仓库常有本地未推送提交（ahead of origin）。`--update-checkout` 会先把它们
  存成 patch 再 reset，注意看输出里的 `archived:` 路径。

## Troubleshooting

| 症状 | 原因 / 处理 |
|---|---|
| `FETCH FAILED` | 网络/权限问题。确认 `ssh -p 29418 10.132.3.76` 通，或先手动 fetch 一次 |
| `missing repo: <path>` | SDK 路径不对，用 `DEVICE_ROOT` 环境变量覆盖根目录 |
| `refusing to write — structural check failed` | 见上面的 Gotchas；校验信息会列出具体哪一条不过 |
| `section #ch2 not found` | HTML 被改坏了（`<h2 id="ch2">` 没了）。从 git/备份恢复文档再跑 |
| `caps-row element not found` | 同上，`.caps-row` 容器被删了 |
| `emmc.json not found` / `duplicate part number` | `emmc.json` 缺失或有重复型号。改 json 后重跑 |
| `template is missing both the old and new form of:` | 文档章节结构被手动改过，章节重编号映射找不到锚点。对照 `renderDoc` 里的 `migrate` 表检查 `<h2>`/`<h3>` id |
| 表格里出现 `其他` 厂商 | 型号前缀没匹配到 `NOR_VENDORS`/`NAND_VENDORS` 表。属新厂商时把前缀加进表里 |
| `refusing to write` 报 `expected exactly 1 footer div` / `legend note` | §4.x 的正则吃到了文档尾部，把 `.note`/`.footer` 删了。见 Gotchas 第 2 条 |

## 相关技能

- `generate-styled-html` —— 本文档的样式规范（`render.sh` 由它提供）。
  要新建一份文档才用它；只是刷新数据用本技能。
- `sync-flash-bringup` —— 把某颗 flash 的适配从 410 同步到 420/Mars3 的分支。
  本技能只读代码汇总，不推任何改动。
