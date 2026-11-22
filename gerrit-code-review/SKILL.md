---
name: gerrit-code-review
description: 对 Gerrit（gerrit-ai.sophgo.vip）上的代码提交做中文 code review：先用 rtt-sync-master 把本地 RTT SDK 更新到最新，再把要评审的 change 直接 cherry-pick 到本地 SDK，在 SDK 里编译验证，给了板卡、USB 下载口和 UART 日志口时还会上板测试；最后写中文总评 + 行内评论，判断能否合入，打 Code-Review -1/+1 发布到 Gerrit。用户发来 Gerrit 链接、change 号、refs/changes/... 或 "git fetch ... && git cherry-pick FETCH_HEAD" 命令并要求 review 时使用。触发词：review、代码review、code review、帮我review、评审、审一下这笔提交、看看能不能合入、gerrit 链接。
---

# gerrit-code-review

用户发来一个或多笔 Gerrit change，要求 review。产出是：

- 发布在 Gerrit 上的**中文总评 + 行内评论 + Code-Review 投票（-1 或 +1）**；
- 会话里给用户的一段简短中文汇报。

验证直接在本地 RTT SDK `~/Public/rtt_master/rt-thread`（含嵌套的 `cvi_rtt` 仓库）里做：先同步到最新，再 cherry-pick，再编译，有条件时上板。

辅助脚本（都用 `python3 -I` 运行，只依赖标准库）：

```bash
G=~/.claude/skills/gerrit-code-review
python3 -I $G/gr.py info    <target>...          # 元信息、父 change 状态、配套 change、我以前的评审
python3 -I $G/gr.py apply   <target>...          # 把 change 连同未合入的依赖 cherry-pick 到本地 SDK
python3 -I $G/gr.py fetch   <target>...          # 只拉 patch set 到 refs/review/<change>-<ps>，不 pick
python3 -I $G/gr.py post    <target> review.json [--dry-run]   # 校验后发布评论和投票
python3 -I $G/gr.py cleanup                      # 删掉 refs/review/* 引用（cherry-pick 保留）
python3 -I $G/kconfig_check.py <solution_dir> <customization/*/.config>... [--show SYM...]
```

`<target>` 可以是 Gerrit 网页链接、`refs/changes/58/172258/7`、`172258,7`、`172258/7` 或裸 change 号（取最新 patch set）。用户贴的 `git fetch ... refs/changes/.. && git cherry-pick FETCH_HEAD` 命令也能直接当 target。

## 授权与边界

用户发来链接要求 review，就等于授权下面这些操作，不用再逐项确认：

- 运行 rtt-sync-master，把本地 SDK 对齐到远程 master。
- 把要评审的 change 及其依赖 cherry-pick 到本地 master，并在 SDK 里编译。
- prompt 里给了板卡、USB 下载口和 UART 日志口时，烧录这块板子、抓日志、在 msh 里敲测试命令。
- 以 jianxing.xie 身份发布评论，并投 -1 或 +1。

边界：

- 用户说"先看看 / 先别发 / 只在这里说"时，只在会话里给结论，不调用 `post`。
- **永远不投 +2/-2，不 Submit、不 Abandon、不 Rebase、不 push**。`post` 会拒绝 ±2。
- 不要用 `git fetch ... && git cherry-pick FETCH_HEAD`：`FETCH_HEAD` 在多个会话间共享，随时会被覆盖。一律用 `gr.py apply` 或 `gr.py fetch`，它们把 patch set 固定拉到 `refs/review/<change>-<ps>`。
- 板卡的下载口和日志口每次接线都可能变。**只用当次 prompt 里给的值**，不要沿用记忆、CLAUDE.md 或上一次 review 里的端口。

## 流程

### 1. 摸清 change

```bash
python3 -I $G/gr.py info <target>... > /tmp/cr_info.json
```

逐笔看下面这些字段：

- `status` 不是 `NEW`（已合入或已放弃）时，告诉用户并停止，不发评论。
- `ps` 和 `current_ps` 不同，说明用户给的是旧 patch set。默认评审最新 PS，并在汇报里说明。
- `parent.outdated` 为真，说明它基于父 change 的旧 PS。处理方法见第 2 步。
- `siblings` 是同 topic 或同 JIRA 的其它未合入 change，常常就是配套提交。commit message 的 `[side effects]` 也会写"需要配套的 xxx"。配套 change 没一起给时，把它也加进 `apply`，否则编译验证不成立。
- `my_history.last_reviewed_ps` 不为空就是**复审**，按第 7 节处理。

### 2. 同步本地 SDK 并 cherry-pick

```bash
bash ~/.claude/skills/rtt-sync-master/sync-master.sh
python3 -I $G/gr.py apply <target>... > /tmp/cr_apply.json
```

- 同步脚本会把 rt-thread 和 cvi_rtt 都对齐到 origin/master。本地已跟踪的改动会 stash 起来，没进上游的本地提交会备份到 `backup/master-<时间>`。新建了 stash 或备份分支时，汇报里要告诉用户。同步报 ERROR 时按 rtt-sync-master 的"失败处理"来，不要强行继续。
- `apply` 只 pick `oss/rt-thread` 和 `cvitek/cvi_rtt` 的 change。它会把每笔 change 在目标分支上还没有的祖先提交按顺序一起 pick 进来，所以依赖的未合入 change 会自动带上，这些在输出里标为 `dependency`。已经在 HEAD 上的提交按 Change-Id 跳过，重复运行不会重复 pick。
- 其它仓库（build、osdrv、linux、u-boot 等）只拉到 `refs/review/...` 供阅读，列在 `not_applied` 里，用 `git -C <repo> show <ref>` 看。
- `conflict` 不为空时，说明这笔无法干净地应用到最新 master 上，算必须修，写进总评。冲突时 `apply` 已经自动 abort，工作区是干净的。
- `parent.outdated` 时，先 pick 父 change 的最新 PS，再 pick 这笔：`gr.py apply <父 change>,<最新 PS> <这笔>`。旧 PS 的父提交和新 PS 的 Change-Id 相同，会被跳过。有冲突算必须修；没冲突就在总评里提醒"合入前 rebase"。
- `notes` 里会提示环境问题。
  - 小核需要的 memmap 被 git 忽略，缺失时会从 `~/Public/p3_sdk/build/output/` 复制场景 A 的布局，其中 `RTOS_ION_SIZE` 为 0。要验证场景 B 或 ION，就得按 wiki 布局改 memmap，或者用 build 仓生成的版本。
  - `cvi_rtt/components` 下有悬空软链时，说明媒体头文件指向 SDK 的 `build/media/include/release/`，而本机 rt-thread 旁边没有这个 build 目录。依赖它们的 solution（smart_doorbell、mpi_* 等）在这里编不了。不要自己建软链去补，在总评里写"未编译验证"及原因，并在汇报里提醒用户。

pick 进来的提交会**留在本地 master 上**，方便用户接着测。下次运行 rtt-sync-master 时会自动清掉：已合入的直接丢弃，没合入的备份到 `backup/master-*`。

### 3. 读代码

先读 commit message，再读完整 diff。要评审的提交在本地 SDK 里，用 `git -C <repo> show <new sha>` 看，sha 取自 `apply` 输出的 `picked[].new`。必要时读被改函数的上下文和调用方，别只看 diff 片段。逐条过下面的清单，结合 CLAUDE.md 里的仓库规则。

**正确性（RT-Thread / 多核 / 驱动）**
- FreeRTOS 移植残留：`rt_mq_create(name, msg_size, max_msgs, flag)` 的第三参是条数，不是字节数；`xQueue*`、`portTICK`、`taskENTER_CRITICAL` 等写法是否改对。
- 线程入口里的 `return` 会让线程退出，常驻任务里出现就是 bug。
- printf 类函数的格式串和实参个数、类型要对得上；`%s` 配 int 会崩。
- 锁：
  - 持锁区间里的每条返回路径都要解锁。
  - `rt_spin_lock` 会关调度，持锁时不能调用会睡眠的函数。
  - 中断里也会拿的锁，线程侧要用 `rt_spin_lock_irqsave`，否则 SMP 下会死锁。
  - 失败路径要恢复中断、释放资源。
- 中断：数据和指针要在 `umask` 之前初始化；ISR 里不能用 mutex 或阻塞调用；关中断区间里不能 `rt_sem_take` 或长时间自旋。
- 共享内存和 mailbox：读之前 invalidate、写之后 flush；设备内存要 volatile 或加 fence；rv64 上 32 位 `param_ptr` 和指针互转要看截断。
- 越界：数组下标、`IRQ_MAX_NR` 边界（`>` 和 `>=`）、位图字数要向上取整。

**构建与配置**
- 新 solution 要在这几处登记：`cvi_rtt/Makefile` 的 `VALID_SOLUTIONS`（漏掉时 `make <sol>` 静默返回 0，什么都不编）、`rtconfig.py` 的 `SOLUTION_MACRO_MAP`、`tools/ci/ci_sdk.py` 的构建列表。新芯片还有 `boards/chip_list.json`、`SOC_MACRO_MAP` 和 `boards/Kconfig.chips`。
- 驱动的 Kconfig 依赖要写全。例如 TPU 驱动用到 pthread，`BSP_USING_TPU` 却没有依赖 `RT_USING_PTHREADS`。
- `customization/*/.config` 要用 `kconfig_check.py` 检查：
  - `unknown` 表示 Kconfig 里不存在的符号，多半是从别的 solution 拷来的残留，生成 rtconfig.h 时不会报错。
  - `drift` 表示 menuconfig 重存后值会变，比如板型和芯片对不上、不可见的 `int` 默认值覆盖了 `.config`。
- customization 目录里不应提交 `rtconfig.h`；PINMUX 白名单不能搬回驱动里，这些见 CLAUDE.md。
- 被 `.gitignore` 掉的生成文件（memmap 等）在干净 checkout 上缺失时，构建要能编过，或者给出明确报错。独立 BSP（如 `bsp/cvitek/c906_little`）的默认配置要能直接 `scons`。
- 发布机制以**父提交那一刻的分支内容**为准。有 `rls_info.txt` 和 `release/gen_rls_info.sh` 时，新增或删除文件要同步白名单。master 上 cvi_rtt 从 2026-11-18（43d2fb6）起改用 `release.sh` 的 rsync 排除规则，没有白名单，只需检查有没有把构建产物或大二进制提交进来。

**提交说明**
- 6 个字段要齐全：`[description ]`、`[root   cause]`、`[JIRA      ID]`、`[chip project]`、`[side effects]`、`[Affected *.ko/*.so/*.a]`。JIRA 号要真实。
- 说明里的数据要和实测一致：镜像大小、验证板型、存储介质（spinor 还是 spinand）、"默认关闭"之类的说法。不一致的写进 Nit；如果它掩盖了根本没跑到的代码路径，升级为建议修。
- 说明里没写怎么验证的，在总评里请作者补充。

### 4. 编译验证

在 `~/Public/rtt_master/rt-thread/cvi_rtt` 下编，至少覆盖改动涉及的目标：

| 改动位置 | 至少要编 |
|---|---|
| `cvi_rtt/solutions/<sol>/**` | `make <sol> PROJECT=<改到的每个 customization>`，没改 customization 就编第一个 |
| `bsp/cvitek/c906_little/**`、mailbox、小核相关 | `make c906l_audio PROJECT=cv1900b_wevb_0019a`；存在时加 `c906l_media`；独立 BSP 在 `bsp/cvitek/c906_little` 下直接跑 `scons`（默认 milkv） |
| `bsp/cvitek/` 下 drivers、libraries、chips 的共享代码 | 再加大核回归：`make smart_doorbell PROJECT=turnkey_181xc` 和 `turnkey_180xb` |
| A53 相关（`boards/aarch*`、arm 分支） | `make smart_doorbell PROJECT=turnkey_181xha`，设置 `RTT_EXEC_PATH` 为 `~/Public/rtt_master/arm-gnu-toolchain-13.3.rel1-x86_64-{arm-none-eabi,aarch64-none-elf}/bin` 中对应架构的那个 |
| `cvi_rtt/rtconfig.py`、`SConstruct`、`Makefile` | 每种架构各编一个 |

- RISC-V 工具链来自 SDK 的 `host-tools`，不用设置 `RTT_EXEC_PATH`。
- 编完必须确认 `install/<sol>_<proj>/` 下的产物时间戳是新的，返回 0 不算数。
- 编译失败时先看失败点在不在这笔改动里。失败在无关代码或环境（例如上面的悬空软链）时，写成"未验证"，不算这笔的问题。
- 只挑改动文件的告警：`grep -E "warning|error" build.log | grep -F -e <改动文件名>...`。新增告警写进建议修。
- 新增代码如果没有任何工程会编到（例如只有某芯片才选中的源文件），想办法单独编一次：临时打开相关 Kconfig 选项编完再用 `git checkout -- <.config>` 还原，或者直接用交叉编译器 `-c` 编那个文件。
- 同一 solution 的不同 PROJECT 不能并行编，因为它们共用 solution 目录下的 rtconfig.h。不同 solution 可以放后台并行。
- 编不了的（缺环境、其它仓库）就只读代码，并在总评里写明"未编译验证"及原因。不要声称验证过没跑的东西。

### 5. 上板测试（prompt 给了板卡和端口时）

只有当次 prompt 同时给了**板卡或工程（PROJECT）、USB 下载口（SmartUSBHub 端口号）和 UART 日志口（`/dev/ttyUSBx`）**时才上板。缺任何一项就跳过，在汇报里说明，不要猜端口。

**cv18xx 单系统 RT-Thread 板**（smart_doorbell、peripherals_test 等带 `image/` 目录的工程）：

1. 编好对应工程，镜像目录是 `~/Public/rtt_master/rt-thread/cvi_rtt/install/<sol>_<proj>/image/`。记下 `rtt.bin` 大小，用来确认换版成功。
2. 烧录。`flash-rtt.sh` 不支持 `-P`，不传 `-i` 时会退回到过时的 `generated/image/`，所以必须显式传绝对路径：
   ```bash
   RESET_SERIAL=0 bash ~/.claude/skills/rtt-flash/flash-rtt.sh -p <PORT> -c <cv180x|cv181x> \
     -i ~/Public/rtt_master/rt-thread/cvi_rtt/install/<sol>_<proj>/image/
   ```
   有其它 agent 共用这块板时，在命令前加 `~/.claude/skills/parallel-dev-setup/board-lock.sh --`。
3. 抓启动日志。串口权限每次上电后可能恢复默认，要重新 chmod；sudo 需要密码而 prompt 没给时，问用户。
   ```bash
   sudo chmod a+rw <TTY>
   stty -F <TTY> 115200 cs8 -cstopb -parenb raw -echo
   timeout 60 cat <TTY> > /tmp/cr_<change>_boot.log &
   sleep 2; usbctl off <PORT>; sleep 2; usbctl on <PORT>
   ```
4. 检查日志：
   - 有 `msh />`，说明启动成功。
   - `spinand prim payload size` 或镜像大小与这次编出来的一致，说明烧进去的就是新固件。FSBL 时间戳只在重编 boot0 时才会变。
   - 没有 assert、exception、`mcause`、panic、`bad irq` 之类的报错。
5. 针对改动设计测试。在抓日志的同时，用 `printf '<cmd>\r\n' > <TTY>` 敲 msh 命令，例如：
   - `list_device`、`list_thread`、`free`；
   - 驱动自测命令（`BSP_USING_SELFTEST`）；
   - 改动功能自带的命令。

   功能没有命令行入口时，看它的初始化打印。测试命令和关键输出要写进总评。

**cv190x（Phobos3）小核固件**要经过 SDK 打包进 fip 才能上板，需要同时满足下面两个前提：

- SDK 的 build 仓支持 RT-Thread 场景，即 172305 之后的版本。`build/scripts/rtos.mk` 里有 `RTT_SOLUTION`、Kconfig 里有 `RTOS_SCENARIO_A`。
- SDK 的 `rt-thread` 目录就是同步并 cherry-pick 过的那棵树，而且包含 `cvi_rtt`。

满足时按 Phobos3 wiki 的第 5.1 节编译打包，再用 usb-flash 的 cv190x 预设烧录。Linux 控制台在 UART 上；小核日志只有调试配置打开 uart2 时才有。

不满足时（2026-11-20 的 `~/Public/p3_sdk` 就不满足：build 仓停在 c5d4830f，rt-thread 是 9 月的旧 checkout，没有 cvi_rtt），在总评和汇报里写"cv190x 未上板验证"并说明原因。不要自己去改 p3_sdk。

上板结果的归因：问题出在这笔改动上，比如启动挂死、功能报错，就算必须修。烧录失败、串口不通这类环境问题不算，在汇报里说明即可。

### 6. 判定与投票

**-1（不能合入）**，命中任意一条即可：
- 编译失败，或者新目标编不出产物（包括 make 静默跳过）。
- 确定性的运行时 bug：崩溃、死锁、线程退出、越界、中断风暴、数据在多核间不一致。
- 上板测试中由这笔改动引起的启动失败或功能错误。
- 声明的功能实际不可用，或者配套 change 之间对不上，合入后会把构建搞坏。
- CI 或发布检查一定会失败。
- 无法干净地 cherry-pick 到最新 master，或者 rebase 到父 change 最新 PS 时有冲突。

**+1（可以合入）**：上面都没有。可以带建议修和 Nit，但要写清楚哪些建议合入后跟进。

不确定时自己判断，不弃权、不投 0。对拿不准的点写"请作者确认"，它不影响投票，除非风险本身足够大。

### 7. 复审（之前评过这笔）

- 用 `gr.py fetch <change>,<上次评审的 PS>` 把旧 PS 拉下来。父提交没变时用 `git diff`，父提交变过就用 `git range-diff <old>^..<old> <new>^..<new>`，只看作者这次改了什么。
- 上一轮的每条意见（`my_history.messages` 和 `inline`）都要逐条标明**已修 / 部分修 / 未修**，写进总评的【上轮问题跟踪】。
- 新 PS 里引入的新问题照常评审。上轮必须修的问题全部修好、也没有新的必须修，就投 +1。

### 8. 写评论并发布

评论 JSON 写到 `/tmp/cr_<change>.json`，格式：

```json
{
  "message": "总评正文",
  "labels": {"Code-Review": -1},
  "comments": {
    "path/in/repo.c": [{"line": 123, "message": "行内评论"}]
  }
}
```

- 全部用中文。Gerrit 2.14 按纯文本渲染：空行分段，`- ` 开头的行是列表，不支持 Markdown 加粗和表格。
- `line` 是该 PS 版本**新文件**中的行号。在本地 SDK 里用 `git -C <repo> show <new sha>:<path> | grep -n` 核对，`post` 还会再按 Gerrit 上的版本校验一遍文件和行号。
- 每个问题对应一条行内评论，要写出现象、后果和改法。总评只放汇总，不要把行内评论原样重复一遍。
- 一次 review 涉及几个仓库，就每笔各写一个 JSON、各发一次。

总评模板：

```
Review（PS<n>）：-1，<一句话说明不能合入的主要原因>。
（或：Review（PS<n>）：+1，可以合入，<一句话说明>。）

验证（基于 master <sha> cherry-pick）：
- <编译目标>：通过/失败，<关键数据，如 yoc.bin 28,860 B>
- 上板：<板卡>，<结果和关键日志>（没上板就写原因）
- <未验证的项>：未验证，<原因>

【必须修】
1. <文件:行> <问题>，<后果>。建议<改法>。

【建议修】
1. ...

【Nit】
- ...

【上轮问题跟踪】（复审时才写）
- <上轮第 1 条>：已修 / 部分修 / 未修，<说明>

【做得好的地方】（可选，一两句）
```

没有内容的小节直接省略。发布前先 dry-run，再正式发：

```bash
python3 -I $G/gr.py post <change>,<ps> /tmp/cr_<change>.json --dry-run
python3 -I $G/gr.py post <change>,<ps> /tmp/cr_<change>.json
```

`post` 会回查服务器，确认投票已经生效（`vote_on_server`）。

### 9. 收尾与汇报

```bash
python3 -I $G/gr.py cleanup
```

`cleanup` 只删 `refs/review/*` 引用，cherry-pick 进 master 的提交保留。

给用户的中文汇报要短：

- 第一句写每笔 change 的结论和投票，并附 Gerrit 链接。
- 必须修的问题每条一两句。建议修只列标题。
- 编译和上板验证用一个小表格，并写明哪些没验证、为什么。
- 告诉用户本地 SDK 的状态：
  - 同步时新建的 stash 或备份分支；
  - master 上现在多了哪几笔评审提交；
  - 下次运行 rtt-sync-master 会清掉它们。
- 过程中发现的环境问题也要说，比如悬空软链、memmap 是手工改的、端口没给所以没上板。
