---
name: parallel-dev-setup
description: "为 Mars3 SDK 搭建多 Agent 并行开发环境：用 git worktree（或完整副本）给每个终端里的 Claude 实例分配一份物理隔离的工作区，避免源码/编译产物冲突，并生成对共享开发板（烧录口 + 串口）加 flock 串行锁的封装脚本。触发词：多开 Agent、并行开发、worktree、多终端跑 claude、避免代码冲突、隔离工作区、烧录加锁、串口加锁。"
argument-hint: "提供要开的 Agent 数量或名称、各自要改的子仓（如 linux_5.10 / cvi_alios / osdrv），以及是否共用同一块开发板"
user-invocable: true
---

# Parallel Dev Setup (Mars3 SDK 多 Agent 并行开发)

## 作用

在同一台服务器上，用多个终端各跑一个 Claude Code 实例做并行开发时，帮助用户
一次性把「防冲突」的环境搭好。它解决三类冲突：

1. **源码冲突** — 每个 Agent 一份物理隔离的工作区（git worktree 或完整副本）。
2. **编译产物冲突** — SDK 的 `TOP_DIR` / `BUILD_PATH` / `OUTPUT_DIR` 全部由
   `gettop`（当前目录）派生（见 `build/envsetup_soc.sh` 第 1281-1283、1085 行），
   所以只要工作区物理隔离，`install/soc_*`、`build/output/` 自动隔离，无需额外配置。
3. **硬件冲突** — 共享的一块开发板 / 一个 USB 烧录口 / 一路串口无法靠软件隔离，
   用 `flock` 串行化访问；有条件则一板一 Agent。

> 这是一套**一次性搭建流程**，不是每次对话都要跑的。日常每次都必须遵守的红线
> （待在自己目录内、不跨目录 source、烧录/串口必须加锁）写在 `CLAUDE.md` 的
> 「并行开发约束」一节，是常驻硬规则。

## 何时使用

- 用户要「多开 Agent / 多终端跑 claude / 并行开发多个功能」。
- 用户担心多个 Claude 实例在同一份 SDK 上互相踩踏（源码、install 产物、开发板）。
- 需要把 worktree 创建、锁脚本封装、USB/串口分配表一次性配好。

## 输入要求

优先从用户提示中提取：

- **Agent 数量 / 名称** — 例如 A、B、C，或 `wiegand` / `uart` / `gpio`。
- **各 Agent 要改的子仓** — 本 SDK 是多子仓（`linux_5.10`、`u-boot-2021.10`、
  `cvi_alios`、`osdrv`、`fsbl`、`cvi_mpi` 各自是独立 git 仓），worktree 是逐仓的。
- **是否共用同一块开发板** — 决定烧录 / 串口是否必须串行化。

若信息缺失，先问清楚再动手，不要盲目创建。

## 搭建步骤

### 1. 判断隔离粒度

- **多个 Agent 改不同子仓** → 只需对各自子仓做 worktree（或就在主树里改，靠分支隔离）。
- **多个 Agent 改同一子仓的不同文件** → 对该子仓分别建 worktree，避免同目录互相覆盖。
- **磁盘不紧张、想最省心** → 直接给每个 Agent 一份完整独立 SDK 副本（`cp -a` 或各自
  clone），多子仓 + 编译产物 + hooks 全部天然隔离，代价是磁盘占用高。

### 2. 用 git worktree 创建物理隔离工作区（首选）

在 SDK 根目录（顶层仓）执行；每个 Agent 一个独立目录 + 独立 feature 分支：

```bash
cd /home/jianxingxie/Public/mars3_repo
git worktree add ../mars3_agentA -b feature/agentA
git worktree add ../mars3_agentB -b feature/agentB
```

若某个子仓也需要隔离，对该子仓重复同样操作：

```bash
cd /home/jianxingxie/Public/mars3_repo/linux_5.10
git worktree add ../../linux_agentA -b feature/agentA-kernel
```

清理：`git worktree remove ../mars3_agentA`（先确认无未提交改动）。

### 3. 每个终端进入各自目录再启动 claude（物理兜底）

让每个 Claude 实例的工作目录天然就是独立 worktree，物理上跨不出去：

```bash
cd /home/jianxingxie/Public/mars3_agentA && claude
```

- 每个实例在**自己目录内**独立 `source build/envsetup_soc.sh`。
- **禁止跨目录复用已 source 的 shell**，否则 `TOP_DIR` / `OUTPUT_DIR` 仍指向旧目录，
  会把产物写错地方、覆盖别的 Agent。

### 4. 生成开发板互斥锁封装脚本

共享同一块板 / 同一 USB 口 / 同一路串口时，烧录与串口测试必须串行。用本 skill 附带的
helper 生成一个带 `flock` 的封装，任何 Agent 烧录/测试前先抢锁，抢不到就等待：

```bash
~/.claude/skills/parallel-dev-setup/board-lock.sh -- <要串行执行的命令>
```

示例（烧录 + 串口测试整体串行占用板子）：

```bash
~/.claude/skills/parallel-dev-setup/board-lock.sh -- \
  bash -c "~/.claude/skills/usb-flash/flash.sh -p 3 -c cv184x -i /abs/install/soc_<board>/ \
           && cd /abs/mars3_agentA && python3 ./uart_agent.py --cmd '<test>'"
```

锁文件默认 `/tmp/mars3_board.lock`，可用 `-l <lockfile>` 覆盖（例如一板一锁时给每块
板一个不同锁文件）。

### 5. 有条件则一板一 Agent（真正全链路并行）

若能给每个 Agent 分配独立开发板，用不同 USB 口 + 不同串口设备 + 不同锁文件，
即可把「编译 + 烧录 + 测试」整条链路并行起来。维护一张分配表，例如：

| Agent | worktree 目录          | USB 烧录口 (-p) | 串口设备      | 锁文件                   |
|-------|------------------------|-----------------|---------------|--------------------------|
| A     | ../mars3_agentA        | 3               | /dev/ttyUSB0  | /tmp/mars3_board_a.lock  |
| B     | ../mars3_agentB        | 5               | /dev/ttyUSB1  | /tmp/mars3_board_b.lock  |

（`uart_agent.py` 若需指定串口设备，请按其实际参数/环境变量配置。）

### 6. 提交阶段

每个 Agent 在独立 feature 分支开发，提交走 `gerrit-submit` skill 推到各自
`refs/for/*`，真正的合并冲突交给 Gerrit review 处理，不在文件系统层面解决。

## 完成后汇报

- 创建了哪些 worktree / 副本及对应分支；
- 生成的锁脚本路径与默认锁文件；
- 建议的每个终端启动命令（`cd <worktree> && claude`）；
- 若共用一块板：提醒烧录/串口必须走 `board-lock.sh`；若一板一 Agent：给出分配表。
