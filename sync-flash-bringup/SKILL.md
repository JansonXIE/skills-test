---
name: sync-flash-bringup
description: "Flash bringup 后，把在 410 SDK 适配好的一款 SPI-NAND flash 的 Gerrit 改动同步到 420(v4.2.0)、Mars3 master、Mars3 v6.3.2 分支。先检查各分支是否已适配该 flash，未适配则 cherry-pick 改动、解决增量冲突并推送到 refs/for/<branch>。Use when: 适配了一款 nand flash 需要同步到其他分支/SDK；flash 移植后同步代码；把 cvsnfc_spi_ids.c 的新增 flash 条目同步到 420/Mars3。触发词: 同步 flash, flash bringup 同步, sync flash, 适配 nand 同步到 420/Mars3, 同步 spinand"
argument-hint: "flash 名称（cvsnfc 表里的 .name，如 EM73D044VCU），以及 u-boot / linux 两个 Gerrit change 的 cherry-pick 命令或 commit"
user-invocable: true
---

# sync-flash-bringup — 把一款 flash 的适配同步到 420 / Mars3 各分支

在 **410 SDK（分支 v4.1.0）** 上完成一款 SPI-NAND flash 的 bringup 后，用这个技能把改动同步到其余分支：

| 目标别名 | 工作树 | 分支 | 推送目标 |
|---|---|---|---|
| `420` | `420_2/{u-boot-2021.10,linux_5.10}` | `v4.2.0` | `refs/for/v4.2.0` |
| `mars3-master` | `mars3_repo/{u-boot-2021.10,linux_5.10}` | `master` | `refs/for/master` |
| `mars3-v632` | `mars3_repo/{u-boot-2021.10,linux_5.10}` | `v6.3.2` | `refs/for/v6.3.2` |

一次 bringup 只改两个文件（u-boot 与 linux 各一份）：
`drivers/mtd/nand/raw/cvitek/cvsnfc_spi_ids.c`。判断“某分支是否已适配该 flash”的唯一可靠信号，就是该文件里出现这颗 flash 的 `.name` 字符串。

所有工作都通过一个脚本完成：
`~/.claude/skills/sync-flash-bringup/driver.mjs`（Node ≥ 18，无依赖）。
它对每个 (repo, 分支) 用**临时 `git worktree`** 操作，**绝不动用户当前的检出**，dry-run 下不推送。默认 `DEVICE_ROOT=/media/cvitek/jianxing.xie/device`，可用环境变量覆盖。

## Agent 执行路径（从这里开始）

设一个变量指向 driver：

```bash
DRV=~/.claude/skills/sync-flash-bringup/driver.mjs
```

### 1. 先查各分支是否已适配（只读，不改任何东西）

```bash
node "$DRV" check --name EM73D044VCU
```

会 `git fetch` 每个分支后读取 `origin/<branch>:cvsnfc_spi_ids.c` 并统计 `.name`。
输出一张 repo × 分支 的矩阵；退出码 `0` = 所有目标都已适配（无需同步），`2` = 还有缺失。

### 2. 同步（先 dry-run，确认无误再真推）

用户提供两个 Gerrit change 的 cherry-pick 命令（u-boot 一个、linux 一个）。把它们分别传给 `--uboot` / `--linux`。**先 `--dry-run`**：它会 fetch、建临时 worktree、cherry-pick、解决增量冲突、校验条目落位，但**不推送**：

```bash
node "$DRV" sync --name EM73D044VCU \
  --uboot "git fetch ssh://10.132.3.76:29418/cvitek/u-boot-2021.10 refs/changes/12/34/1 && git cherry-pick FETCH_HEAD" \
  --linux "git fetch ssh://10.132.3.76:29418/cvitek/linux_5.10 refs/changes/56/78/1 && git cherry-pick FETCH_HEAD" \
  --dry-run
```

`--uboot` / `--linux` 也接受**裸 change ref**（`refs/changes/12/34/1`）或**任何 origin 上可达的 committish**（如 410 已推送分支上的 commit SHA）。

dry-run 输出每个 (repo, 分支) 的状态：
- `present` = 该分支已适配，跳过
- `ready`   = cherry-pick 干净或增量冲突已解决，条目已校验，可推送
- `error`   = 需人工介入（详见 DETAIL）

### 3. 确认无误后真正推送

去掉 `--dry-run`（其余参数完全一致）即会 `git push origin HEAD:refs/for/<branch>`：

```bash
node "$DRV" sync --name EM73D044VCU --uboot "<...>" --linux "<...>"
```

可用 `--targets 420,mars3-master,mars3-v632` 只同步部分目标（逗号分隔）；
用 `--source-branch v4.1.0` 指定当传入 SHA 时用于让该 commit 可达的源分支（默认 `v4.1.0`）。

推送采用 cherry-pick 原提交（含原 `Change-Id`）。同一个 Change-Id 推到不同分支，Gerrit 会为每个分支生成独立 review，便于追踪。

## 冲突解决策略（补充式）

flash 条目是**纯新增**，cherry-pick 到分叉的分支常在表尾/表头 anchor 处冲突。
`scripts/resolve_conflicts.sh`（沿用 `sync-v632` 的补充策略并修了空行 bug）：保留目标分支现有内容，只把 theirs 里目标没有的行追加进来，从不删改现有代码。driver 强制 `-c rerere.enabled=false`，避免用户全局 rerere 缓存导致的非确定性结果；解决后若仍残留 `<<<<<<<` 标记（说明是非增量冲突），driver 会 `error` 退出让人工处理，不会盲目推送。

## Gotchas（真实踩到的坑）

- **`v6.3.2` 同时是分支和 tag，且指向不同 commit**（`refs/heads/v6.3.2` ≠ `refs/tags/v6.3.2`）。`git checkout v6.3.2` / `git show v6.3.2:` 会拿到 **tag**（错的）。driver 一律用 `origin/v6.3.2`，并用显式 refspec `+refs/heads/v6.3.2:refs/remotes/origin/v6.3.2` fetch。
- **必须先 fetch 再判断**。本地 remote-tracking ref 可能是旧的，直接读会误判“已适配”。`check`/`sync` 每次都先 fetch 目标分支。
- **rerere 非确定性**。若用户开了 `rerere.enabled`，同一个冲突可能被旧缓存悄悄“自动解决”成错误内容，且工作树里看不到冲突标记却仍是 unmerged 状态。driver 显式关掉 rerere。
- **两个仓库缺一不可**。只有 u-boot 有、linux 没有 → 能启动但 rootfs 挂载失败（`UBI error: cannot open mtd ROOTFS`）；反之亦然。所以 `check` 分别报告 u-boot 和 linux，`sync` 两个都要传。
- **Mars3 的 master 和 v632 共用同一个 `mars3_repo` 工作树**。driver 用临时 worktree 分别处理，不需要来回 checkout，也不会弄脏用户的检出。
- **linux 侧改动往往是多 hunk**（除条目外还有自定义 remap 表、BBT maxblocks、parse_status_info 逻辑）。所以要 **cherry-pick 整个 commit**，而不是只挪那段 struct 条目——补充式解冲突会把所有新增 hunk 一起带过去。
- **条目落位校验**。driver 会确认 `.name` 出现在表终止符（u-boot `{ .id_len = 0, }` / linux `{ NULL }`）之前，防止补充策略把条目错误地追加到表尾之后。

## Troubleshooting

| 现象 | 处理 |
|---|---|
| `check` 全 `ABSENT` 但你确信已同步 | 大概率读了旧 tracking ref；driver 已强制 fetch，若仍异常检查网络到 `10.132.3.76:29418` |
| `FETCH-FAIL` / `fetch branch failed` | Gerrit 不通或无权限：`git ls-remote origin refs/heads/<branch>` 自测 |
| `sync` 报 `non-additive conflict, resolve by hand` | 该改动不是纯新增（改了现有行），需人工 cherry-pick 解决 |
| `sync` 报 `entry landed AFTER table terminator` | 补充策略落位异常，人工检查 `cvsnfc_spi_ids.c` 表结构 |
| `cannot resolve source` | 传的 SHA 在 origin 上不可达，改传 change ref，或用 `--source-branch` 指定其所在分支 |
| push 报权限/网络 | 检查 Gerrit 账号与 `refs/for/<branch>` 推送权限 |

## 在本机验证过

- `check`：对真实三分支跑通——`EM73D044VCU`（三分支均 `ABSENT`，退出 2）、`XCSP1AXPK-IT`（均 `present`，退出 0）。
- `sync --dry-run`：用真实 commit（410 已推送到 `origin/v4.1.0` 的 `EM73D044VCU` u-boot+linux 提交）作源，向 `v4.2.0`/`master`/`v6.3.2` 各建临时 worktree，cherry-pick + 校验通过；u-boot 及 linux 的 420/master 干净 cherry-pick，linux v632 触发增量冲突并由补充策略解决。
- **正确性对拍**：把同步后 commit 的新增行与源 commit 的新增行逐行比对，源的 25 条非空新增**全部落地，0 缺失**，无残留冲突标记。
- 跑完后 `git worktree prune` + `git status` 确认三个 SDK 工作树**零改动、无残留 worktree**。
- 未在本机执行的：真正 `git push`（会推到 Gerrit，仅在用户确认后去掉 `--dry-run` 执行）。
